// Covers the one judgement odooWhatsapp.js makes: which WhatsApp conversation
// is still waiting on us. That verdict drives a notification badge, so the two
// failure modes both matter and pull in opposite directions — a thread that
// needs a reply and doesn't show up is a customer left hanging, and a badge
// that can never reach zero is one people stop looking at.
//
// Odoo is mocked. Nothing here is about RPC plumbing; it's about the rules
// applied to what comes back.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CUSTOMER_PARTNER = 57;
const SELF_PARTNER = 3;
const COMMENT_SUBTYPE = 1;

// The fixture each test bends to its case: one channel, and a conversation in
// it built from the compact `[from, state]` shape below.
let channels;
let messages;
let waRows;
let unreadCounter;

const execute = vi.fn((model, method, args, kwargs) => fakeOdoo(model, method, args, kwargs));
vi.mock('./odoo.js', () => ({
  execute: (...call) => execute(...call),
  getConfig: () => ({
    configured: true,
    url: 'https://smokerings.odoo.com',
    username: 'smokerings.team@gmail.com',
  }),
  htmlToText: (html) => String(html || '').replace(/<[^>]*>/g, ''),
}));

const { fetchWhatsappThreads } = await import('./odooWhatsapp.js');

function fakeOdoo(model, method, args = []) {
  if (model === 'discuss.channel' && method === 'fields_get') {
    return { whatsapp_number: { type: 'char' }, whatsapp_partner_id: { type: 'many2one' } };
  }
  if (model === 'discuss.channel' && method === 'search_read') return channels;
  if (model === 'ir.model.data' && method === 'check_object_reference') return ['mail.message.subtype', COMMENT_SUBTYPE];
  if (model === 'res.users' && method === 'search_read') return [{ id: 2, partner_id: [SELF_PARTNER, 'us'] }];
  if (model === 'mail.message' && method === 'search_read') return messages.slice().reverse();
  if (model === 'whatsapp.message' && method === 'search_read') return waRows;
  if (model === 'discuss.channel.member' && method === 'search_read') {
    return [{ channel_id: [10, 'chan'], message_unread_counter: unreadCounter }];
  }
  throw new Error(`unexpected call ${model}.${method} ${JSON.stringify(args)}`);
}

// Builds the two parallel records Odoo keeps per message — the mail.message
// and the whatsapp.message beside it — from one line of intent.
// `state` of null means no whatsapp.message row at all, which is how a
// template send that was only ever logged as a comment arrives.
function conversation(entries) {
  messages = [];
  waRows = [];
  entries.forEach(([from, state, minutesAgo, body = 'hello'], index) => {
    const id = 100 + index;
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    messages.push({
      id,
      res_id: 10,
      date: at,
      author_id: from === 'customer' ? [CUSTOMER_PARTNER, 'Eric Savage'] : [SELF_PARTNER, 'us'],
      body: `<p>${body}</p>`,
    });
    if (state) {
      waRows.push({
        mail_message_id: [id, false],
        message_type: from === 'customer' ? 'inbound' : 'outbound',
        state,
        failure_type: state === 'error' ? 'whatsapp_unrecoverable' : false,
        failure_reason: state === 'error' ? 'Account not registered' : false,
      });
    }
  });
}

// 24h from now — the customer service window still wide open.
function windowOpen(hoursFromNow = 20) {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

beforeEach(() => {
  execute.mockClear();
  unreadCounter = 0;
  channels = [
    {
      id: 10,
      name: 'Eric Savage (919886751428)',
      whatsapp_number: '919886751428',
      whatsapp_partner_id: [CUSTOMER_PARTNER, 'Eric Savage'],
      whatsapp_channel_valid_until: windowOpen(),
      last_interest_dt: '2026-09-06 08:10:08',
    },
  ];
  conversation([['customer', 'received', 60], ['us', 'read', 30]]);
});

describe('what needs attention', () => {
  it('flags a thread whose last message came from the customer', async () => {
    conversation([['us', 'read', 90], ['customer', 'received', 45, 'is it out for delivery?']]);

    const { threads, counts } = await fetchWhatsappThreads();

    expect(threads[0].needsAttention).toBe(true);
    expect(threads[0].awaitingReply).toBe(true);
    expect(threads[0].lastMessagePreview).toBe('is it out for delivery?');
    expect(counts.needsAttention).toBe(1);
    expect(counts.awaitingReply).toBe(1);
  });

  it('clears once we reply', async () => {
    conversation([['customer', 'received', 45], ['us', 'sent', 5]]);

    const { threads, counts } = await fetchWhatsappThreads();

    expect(threads[0].needsAttention).toBe(false);
    expect(threads[0].waitingMinutes).toBeNull();
    expect(counts.needsAttention).toBe(0);
  });

  it('measures the wait from the customer message, not from the thread start', async () => {
    conversation([['customer', 'received', 600], ['us', 'read', 300], ['customer', 'received', 90]]);

    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].waitingMinutes).toBeGreaterThanOrEqual(89);
    expect(threads[0].waitingMinutes).toBeLessThanOrEqual(91);
  });

  it('does not treat an unanswered thread as handled just because it was read', async () => {
    // The whole reason unread isn't the trigger: opening Discuss zeroes the
    // counter, and the customer is still waiting.
    conversation([['us', 'read', 90], ['customer', 'received', 45]]);
    unreadCounter = 0;

    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].unreadCount).toBe(0);
    expect(threads[0].needsAttention).toBe(true);
  });
});

describe('failed sends', () => {
  it('flags a thread whose last send attempt errored', async () => {
    conversation([['customer', 'received', 120], ['us', 'error', 60]]);

    const { threads, counts } = await fetchWhatsappThreads();

    expect(threads[0].needsAttention).toBe(true);
    expect(threads[0].failedSend?.reason).toBe('Account not registered');
    expect(counts.failedSend).toBe(1);
    // Nothing is owed a reply here — the error is the whole reason it's listed.
    expect(threads[0].awaitingReply).toBe(false);
  });

  it('stops flagging an old error once a later send worked', async () => {
    // This is what keeps the badge reachable: the live database carries a dozen
    // errors from when the Meta account was being wired up, all long since
    // followed by sends that went through.
    conversation([['us', 'error', 5000], ['us', 'error', 4000], ['us', 'delivered', 30]]);

    const { threads, counts } = await fetchWhatsappThreads();

    expect(threads[0].failedSend).toBeNull();
    expect(threads[0].needsAttention).toBe(false);
    expect(counts.failedSend).toBe(0);
  });
});

describe('reading the conversation', () => {
  it('attributes a template send with no whatsapp.message row to us, not the customer', async () => {
    // Odoo logs some outbound templates as a bare comment. Falling back to the
    // author is what stops one reading as an inbound message and inventing a
    // thread that needs a reply.
    conversation([['customer', 'received', 60], ['us', null, 10, 'Your order is packed']]);

    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].messages.at(-1).from).toBe('us');
    expect(threads[0].needsAttention).toBe(false);
  });

  it('leaves internal notes out of the query', async () => {
    await fetchWhatsappThreads();

    const call = execute.mock.calls.find(([model]) => model === 'mail.message');
    expect(call[2][0]).toContainEqual(['subtype_id', '=', COMMENT_SUBTYPE]);
  });

  it('strips the number Odoo appends to the channel name', async () => {
    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].customer).toBe('Eric Savage');
    expect(threads[0].phone).toBe('919886751428');
  });

  it('links straight to the conversation in Odoo Discuss', async () => {
    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].odooUrl).toBe('https://smokerings.odoo.com/odoo/discuss/10');
  });
});

describe('the 24h reply window', () => {
  it('reports the time left while it is open', async () => {
    channels[0].whatsapp_channel_valid_until = windowOpen(2);

    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].replyWindow.open).toBe(true);
    expect(threads[0].replyWindow.minutesLeft).toBeGreaterThan(110);
    expect(threads[0].replyWindow.minutesLeft).toBeLessThanOrEqual(120);
  });

  it('reports it closed once the deadline has passed', async () => {
    channels[0].whatsapp_channel_valid_until = windowOpen(-3);

    const { threads } = await fetchWhatsappThreads();

    expect(threads[0].replyWindow.open).toBe(false);
    expect(threads[0].replyWindow.minutesLeft).toBe(0);
  });
});

describe('ordering', () => {
  it('puts waiting threads first, longest wait at the top', async () => {
    channels = [
      { ...channels[0], id: 10 },
      { ...channels[0], id: 11, whatsapp_partner_id: [CUSTOMER_PARTNER, 'Manjunath D K'], name: 'Manjunath D K (918105470046)' },
      { ...channels[0], id: 12, whatsapp_partner_id: [CUSTOMER_PARTNER, 'Adarsh Lalraj'], name: 'Adarsh Lalraj (919487772181)' },
    ];
    // ch10 answered, ch11 waiting 20 min, ch12 waiting 300 min.
    conversation([['customer', 'received', 60], ['us', 'read', 30]]);
    const answered = { messages, waRows };
    conversation([['customer', 'received', 20]]);
    const shortWait = { messages: messages.map((m) => ({ ...m, id: m.id + 50, res_id: 11 })), waRows: waRows.map((r) => ({ ...r, mail_message_id: [r.mail_message_id[0] + 50, false] })) };
    conversation([['customer', 'received', 300]]);
    const longWait = { messages: messages.map((m) => ({ ...m, id: m.id + 80, res_id: 12 })), waRows: waRows.map((r) => ({ ...r, mail_message_id: [r.mail_message_id[0] + 80, false] })) };
    messages = [...answered.messages, ...shortWait.messages, ...longWait.messages];
    waRows = [...answered.waRows, ...shortWait.waRows, ...longWait.waRows];

    const { threads } = await fetchWhatsappThreads();

    expect(threads.map((thread) => thread.channelId)).toEqual([12, 11, 10]);
  });
});

describe('when Odoo is not set up', () => {
  it('answers with an empty inbox rather than throwing, so a polling badge stays quiet', async () => {
    // A database without the whatsapp module: discuss.channel exists but has
    // none of its columns. The schema answer is cached for the life of the
    // process, so this needs a module that hasn't asked yet.
    vi.resetModules();
    execute.mockImplementationOnce(() => ({ name: { type: 'char' } }));
    const { fetchWhatsappThreads: fresh } = await import('./odooWhatsapp.js');

    const result = await fresh();

    expect(result.available).toBe(false);
    expect(result.threads).toEqual([]);
    expect(result.counts.needsAttention).toBe(0);
    expect(result.reason).toMatch(/WhatsApp module/);
  });
});
