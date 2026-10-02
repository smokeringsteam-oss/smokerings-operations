// WhatsApp inbox — the customer conversations in Odoo that are still waiting
// on us.
//
// Odoo's WhatsApp module (installed on this database, saas~19.3 Enterprise)
// models a conversation as a `discuss.channel` with channel_type='whatsapp',
// one per customer number, and every customer-visible message in it as a
// `mail.message`. A parallel `whatsapp.message` row carries the delivery side
// of each one — direction (inbound/outbound) and state (received / sent /
// delivered / read / error).
//
// The dashboard only wants the subset that needs a human, so the whole module
// is really one judgement: what counts as "needs attention"? Two things do,
// and both are self-clearing — nothing here has to be ticked off by hand:
//
//   1. AWAITING REPLY — the last customer-visible message in the thread came
//      from the customer. Replying is what clears it. Deliberately not
//      "unread": Odoo's unread counter is cleared just by opening Discuss, so
//      a message glanced at on a phone and then forgotten would drop off the
//      list while still being unanswered. Unread is still reported per thread
//      (as `unreadCount`) because it is useful context; it just isn't the
//      trigger.
//
//   2. FAILED SEND — our most recent outbound attempt errored, so the customer
//      never got what we think we sent. Scoped to the *last* attempt on
//      purpose: this database carries a dozen historical errors from when the
//      Meta account was still being wired up, and counting those forever would
//      leave a badge nobody could ever clear. A later successful send in the
//      same thread means the problem is over.
//
// MORE THAN ONE BUSINESS NUMBER. Odoo models each of our own WhatsApp numbers
// as a `whatsapp.account`, and every channel points at the one it arrived on
// via `wa_account_id`. Two numbers on the same WABA are two account records,
// not one. The list here is deliberately NOT scoped to a single account — an
// inbox that silently hid one of our numbers would be the worst possible
// failure for a screen whose only job is "who is still waiting" — so both
// land in one list and each thread carries `account` so the screen can label
// and filter them. With one account configured, that label is noise and the
// client hides it; the server behaves identically either way.
//
// Also surfaced, because it silently governs what a reply can even be: the
// 24-hour customer service window. WhatsApp only allows free-form replies
// within 24h of the customer's last message (Odoo tracks the deadline on
// `whatsapp_channel_valid_until`); after that only an approved template can go
// out. A thread with 40 minutes left is a different kind of urgent from one
// with 20 hours, so `replyWindow` carries the time remaining.
//
// The list is read-only. The one write is `sendWhatsappReply` at the bottom,
// which posts a free-form reply into the channel exactly the way Odoo Discuss
// does — so a reply sent from the dashboard is indistinguishable in Odoo from
// one typed there, and goes out through the same WhatsApp account.
import { execute, getConfig, htmlToText } from './odoo.js';

// Outbound states that mean the message actually left. Anything else is either
// still in flight or failed.
const DELIVERED_STATES = new Set(['sent', 'delivered', 'read']);

// How much back-and-forth each thread carries for the preview: enough to see
// what was asked and what we last said, not the whole history.
const THREAD_TAIL = 8;

// One open conversation in the chat pane: enough scroll-back to read the order
// that started it, capped so a years-old regular doesn't pull everything.
const DEFAULT_HISTORY = 60;
const MAX_HISTORY = 200;

// WhatsApp's own ceiling on a text message body.
const MAX_REPLY_LENGTH = 4096;

// Cheap guards so a mistyped request can't ask Odoo for the whole database.
const MAX_CHANNELS = 100;
const DEFAULT_CHANNELS = 30;

// Each resolved once per process — see the notes on each.
let selfPartnerIdCache;
let commentSubtypeIdCache;
let whatsappSchemaCache;

// The partner behind ODOO_USERNAME. Needed because "unread" in Odoo is
// per-member: the counter lives on the discuss.channel.member row for *our*
// partner, not on the channel itself.
async function resolveSelfPartnerId() {
  if (selfPartnerIdCache !== undefined) return selfPartnerIdCache;
  const { username } = getConfig();
  const users = await execute('res.users', 'search_read', [[['login', '=', username]], ['partner_id']], {
    limit: 1,
  });
  selfPartnerIdCache = users[0]?.partner_id?.[0] ?? null;
  return selfPartnerIdCache;
}

// mail.mt_comment is the "Messages" subtype — the customer-visible ones.
// Filtering on it is what keeps internal chatter out of the inbox: Odoo logs
// notes into the very same channel ("Related Journal Entry: Draft Invoice …"
// from OdooBot), and those carry the Notes subtype. Looked up by external id
// rather than hardcoded, since a subtype's database id isn't guaranteed.
async function resolveCommentSubtypeId() {
  if (commentSubtypeIdCache !== undefined) return commentSubtypeIdCache;
  try {
    const ref = await execute('ir.model.data', 'check_object_reference', ['mail', 'mt_comment']);
    commentSubtypeIdCache = Array.isArray(ref) ? ref[1] : null;
  } catch {
    // Not fatal — without it a thread just includes internal notes too.
    commentSubtypeIdCache = null;
  }
  return commentSubtypeIdCache;
}

// Is the WhatsApp module actually installed here? discuss.channel exists on
// every Odoo, but its WhatsApp columns only appear with the `whatsapp` module,
// and asking for a field that isn't there fails the whole search_read. So the
// schema is checked once rather than assumed — the same reasoning as the
// Fulfilment Status field in odoo.js.
//
// `wa_account_id` — which of OUR numbers a conversation belongs to — is
// probed separately rather than folded into the availability verdict. It is
// only needed to label threads once a second whatsapp.account exists, so an
// Odoo that somehow lacks the column should lose the labels, not the inbox.
async function resolveWhatsappSchema() {
  if (whatsappSchemaCache !== undefined) return whatsappSchemaCache;
  const fields = await execute('discuss.channel', 'fields_get', [[], ['type']]);
  whatsappSchemaCache = {
    available: Boolean(fields.whatsapp_number && fields.whatsapp_partner_id),
    hasAccount: Boolean(fields.wa_account_id),
  };
  return whatsappSchemaCache;
}

async function resolveWhatsappAvailable() {
  return (await resolveWhatsappSchema()).available;
}

// Odoo hands back naive UTC ('2026-09-06 08:03:18'). Everything downstream
// wants a real instant, and the client formats it in the viewer's own zone.
function parseOdooUtc(value) {
  if (!value) return null;
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoOrNull(date) {
  return date ? date.toISOString() : null;
}

function minutesBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

// The channel name Odoo generates is "Eric Savage (919886751428)" — the number
// already has its own field, so strip it back to just the person.
function customerNameOf(channel) {
  const partnerName = channel.whatsapp_partner_id?.[1];
  if (partnerName) return partnerName;
  const name = channel.name || '';
  return name.replace(/\s*\(\+?\d[\d\s-]*\)\s*$/, '').trim() || name || 'Unknown';
}

// The business number a conversation arrived on, as Odoo's many2one gives it:
// [id, "Smokerings BBQ"]. Null on an Odoo whose discuss.channel has no
// wa_account_id column, and on the odd channel Odoo left unattached — the
// client treats both the same way, as "no label to show".
function accountOf(channel) {
  const account = channel.wa_account_id;
  if (!Array.isArray(account) || !account[0]) return null;
  return { id: account[0], name: account[1] || `Account ${account[0]}` };
}

/**
 * The distinct business numbers across the given threads, each with its own
 * counts — what the inbox builds its number filter out of.
 *
 * Derived from the threads rather than read from whatsapp.account so the
 * filter can only ever offer a number that has conversations behind it: an
 * account added in Odoo but not yet live would otherwise show as a pill that
 * always filters to nothing.
 */
function accountsOf(threads) {
  const byId = new Map();
  for (const thread of threads) {
    if (!thread.account) continue;
    const seen = byId.get(thread.account.id) || { ...thread.account, threads: 0, needsAttention: 0 };
    seen.threads += 1;
    if (thread.needsAttention) seen.needsAttention += 1;
    byId.set(thread.account.id, seen);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// One line of a message, for the collapsed row. The full text stays on the
// thread tail underneath it.
function previewOf(text, max = 160) {
  if (!text) return '';
  const oneLine = text.replace(/\s*\n+\s*/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

// The customer-visible messages in the given channels, newest first, plus the
// delivery half of each (direction and state) keyed by its mail.message id.
async function fetchChannelMessages(channelIds, limit) {
  const commentSubtypeId = await resolveCommentSubtypeId();
  const messageDomain = [
    ['model', '=', 'discuss.channel'],
    ['res_id', 'in', channelIds],
  ];
  if (commentSubtypeId) messageDomain.push(['subtype_id', '=', commentSubtypeId]);

  const messages = await execute(
    'mail.message',
    'search_read',
    [messageDomain, ['id', 'res_id', 'date', 'author_id', 'body']],
    { order: 'id desc', limit },
  );

  const messageIds = messages.map((message) => message.id);
  const waRows = messageIds.length
    ? await execute(
        'whatsapp.message',
        'search_read',
        [
          [['mail_message_id', 'in', messageIds]],
          ['mail_message_id', 'message_type', 'state', 'failure_type', 'failure_reason'],
        ],
      )
    : [];
  return { messages, waByMessageId: new Map(waRows.map((row) => [row.mail_message_id?.[0], row])) };
}

// One mail.message as the client reads it. `atDate` is kept for the verdict
// maths and stripped before anything leaves the server.
function toHistoryEntry(message, waByMessageId, customerPartnerId) {
  const wa = waByMessageId.get(message.id);
  // whatsapp.message states the direction outright. Where there's no row
  // (a template send logged only as a comment), the author decides it: the
  // customer's own partner is the only inbound author there can be.
  const fromCustomer = wa
    ? wa.message_type === 'inbound'
    : Boolean(customerPartnerId) && message.author_id?.[0] === customerPartnerId;
  const at = parseOdooUtc(message.date);
  return {
    id: message.id,
    at: isoOrNull(at),
    atDate: at,
    from: fromCustomer ? 'customer' : 'us',
    author: message.author_id?.[1] || null,
    text: htmlToText(message.body) || '',
    state: wa?.state || null,
    failureReason: wa?.state === 'error' ? wa.failure_reason || null : null,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// The channel behind a reply or a history request, checked to really be a
// WhatsApp conversation — a mistyped id must not post into some internal
// Discuss channel instead.
async function readWhatsappChannel(channelId) {
  const id = Number(channelId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid conversation id.');
  const { configured } = getConfig();
  if (!configured) throw httpError(503, "Odoo isn't configured yet.");
  if (!(await resolveWhatsappAvailable())) throw httpError(503, "Odoo's WhatsApp module isn't installed.");
  const [channel] = await execute('discuss.channel', 'search_read', [
    [
      ['id', '=', id],
      ['channel_type', '=', 'whatsapp'],
    ],
    ['whatsapp_partner_id', 'whatsapp_channel_valid_until'],
  ]);
  if (!channel) throw httpError(404, 'That WhatsApp conversation no longer exists in Odoo.');
  return channel;
}

/**
 * The longer scroll-back for one conversation, oldest first — what the chat
 * pane shows once a thread is opened. The inbox poll only carries a short tail
 * per thread, so it stays cheap on its one-minute timer.
 */
async function fetchWhatsappConversation({ channelId, limit = DEFAULT_HISTORY }) {
  const channel = await readWhatsappChannel(channelId);
  const historyLimit = Math.min(Math.max(Number(limit) || DEFAULT_HISTORY, 1), MAX_HISTORY);
  const { messages, waByMessageId } = await fetchChannelMessages([channel.id], historyLimit);
  const customerPartnerId = channel.whatsapp_partner_id?.[0] ?? null;
  return {
    channelId: channel.id,
    messages: messages
      .slice()
      .reverse()
      .map((message) => {
        const { atDate, ...entry } = toHistoryEntry(message, waByMessageId, customerPartnerId);
        return entry;
      }),
    // A full page back means there may be older messages still in Odoo.
    truncated: messages.length === historyLimit,
  };
}

// Plain text in, the HTML Odoo stores out: escaped, line breaks kept.
function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<p>${escaped.replace(/\r?\n/g, '<br>')}</p>`;
}

/**
 * Send a free-form WhatsApp reply to a customer, through Odoo.
 *
 * Posts on the channel with message_type 'whatsapp_message' — the same call
 * Odoo Discuss makes when you press send, which is what hands the message to
 * the WhatsApp module to deliver. Any other message_type would only land as a
 * Discuss note the customer never sees.
 *
 * Refuses outright once the 24h window has shut: Meta rejects free text after
 * that, and letting it through would just produce a failed send to clean up.
 * Those customers need an approved template, which is still done in Odoo.
 */
async function sendWhatsappReply({ channelId, text }) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw httpError(400, 'Type a message first.');
  if (body.length > MAX_REPLY_LENGTH) {
    throw httpError(400, `WhatsApp messages are capped at ${MAX_REPLY_LENGTH} characters.`);
  }

  const channel = await readWhatsappChannel(channelId);
  const windowExpiresAt = parseOdooUtc(channel.whatsapp_channel_valid_until);
  if (!windowExpiresAt || windowExpiresAt <= new Date()) {
    throw httpError(
      409,
      "The 24h reply window has closed, so WhatsApp won't accept a typed message — send an approved template from Odoo instead.",
    );
  }

  const posted = await execute('discuss.channel', 'message_post', [[channel.id]], {
    body: textToHtml(body),
    body_is_html: true,
    message_type: 'whatsapp_message',
    subtype_xmlid: 'mail.mt_comment',
  });
  // RPC turns the returned mail.message record into its id list.
  const messageId = Array.isArray(posted) ? posted[0] : posted;

  // Read back what the WhatsApp module made of it, so the bubble can show
  // "sent" or the real error rather than assuming it went.
  const [wa] = messageId
    ? await execute('whatsapp.message', 'search_read', [
        [['mail_message_id', '=', messageId]],
        ['state', 'failure_reason'],
      ])
    : [];

  return {
    messageId: messageId || null,
    state: wa?.state || null,
    failureReason: wa?.state === 'error' ? wa.failure_reason || null : null,
    // No whatsapp.message row means Odoo stored the post but didn't queue it
    // for WhatsApp — surfaced rather than reported as sent.
    queued: Boolean(wa),
  };
}

/**
 * Every WhatsApp conversation in Odoo, already judged against the two rules at
 * the top of this file, needs-attention first.
 *
 * Never throws for "not set up": an unconfigured Odoo, or a database without
 * the WhatsApp module, comes back as a well-formed empty result with the
 * reason on it. The notification badge polls this on a timer, and a poll that
 * threw would mean a console full of 503s on any machine that hasn't finished
 * wiring Odoo up. Real failures (network, auth, a broken query) still throw.
 */
async function fetchWhatsappThreads({ limit = DEFAULT_CHANNELS } = {}) {
  const { configured, url } = getConfig();
  const empty = {
    threads: [],
    accounts: [],
    counts: { threads: 0, needsAttention: 0, awaitingReply: 0, failedSend: 0, unread: 0 },
    fetchedAt: new Date().toISOString(),
  };

  if (!configured) {
    return {
      ...empty,
      configured: false,
      available: false,
      reason:
        "Odoo isn't configured yet. Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY in the server's .env, then restart the server.",
    };
  }
  if (!(await resolveWhatsappAvailable())) {
    return {
      ...empty,
      configured: true,
      available: false,
      reason: "Odoo's WhatsApp module isn't installed on this database, so there are no conversations to read.",
    };
  }

  const channelLimit = Math.min(Math.max(Number(limit) || DEFAULT_CHANNELS, 1), MAX_CHANNELS);
  const { hasAccount } = await resolveWhatsappSchema();
  const channels = await execute(
    'discuss.channel',
    'search_read',
    [
      // Deliberately not scoped to one wa_account_id: with a second business
      // number on the same WABA, both inboxes are meant to land in this one
      // list. Which number a thread came to is carried per thread as
      // `account` and filtered client-side, so nothing can be silently
      // missing from a screen whose whole job is "who is still waiting".
      [['channel_type', '=', 'whatsapp']],
      [
        'name',
        'whatsapp_number',
        'whatsapp_partner_id',
        'whatsapp_channel_valid_until',
        'last_interest_dt',
        ...(hasAccount ? ['wa_account_id'] : []),
      ],
    ],
    // last_interest_dt is Odoo's own "when did anything last happen here"
    // stamp, so ordering by it means the limit drops the deadest threads and
    // never a live one.
    { order: 'last_interest_dt desc', limit: channelLimit },
  );

  if (!channels.length) return { ...empty, configured: true, available: true };

  const channelIds = channels.map((channel) => channel.id);
  // Newest first and capped: only the tail of each thread is ever shown, and
  // the verdict itself depends on nothing but the last message in each.
  const { messages, waByMessageId } = await fetchChannelMessages(channelIds, channelIds.length * THREAD_TAIL * 3);

  const selfPartnerId = await resolveSelfPartnerId();
  const members = selfPartnerId
    ? await execute(
        'discuss.channel.member',
        'search_read',
        [
          [
            ['channel_id', 'in', channelIds],
            ['partner_id', '=', selfPartnerId],
          ],
          ['channel_id', 'message_unread_counter'],
        ],
      )
    : [];
  const unreadByChannelId = new Map(
    members.map((member) => [member.channel_id?.[0], member.message_unread_counter || 0]),
  );

  const now = new Date();
  const byChannelId = new Map(channelIds.map((id) => [id, []]));
  for (const message of messages) byChannelId.get(message.res_id)?.push(message);

  const threads = channels.map((channel) => {
    const customerPartnerId = channel.whatsapp_partner_id?.[0] ?? null;
    // search_read came back newest-first; a thread reads oldest-first.
    const raw = (byChannelId.get(channel.id) || []).slice().reverse();

    const history = raw.map((message) => toHistoryEntry(message, waByMessageId, customerPartnerId));

    const last = history[history.length - 1] || null;

    // Rule 1: the conversation ends on something the customer said, and the
    // clock runs from that message.
    const awaitingReply = Boolean(last && last.from === 'customer');
    const waitingMinutes = awaitingReply ? minutesBetween(last.atDate, now) : null;

    // Rule 2: our most recent send attempt failed. Walking back to the first
    // outbound that has a delivery state at all is what scopes this to the
    // last attempt — a successful send after an error clears it.
    const lastOutboundAttempt = [...history].reverse().find((message) => message.from === 'us' && message.state) || null;
    const failedSend =
      lastOutboundAttempt && !DELIVERED_STATES.has(lastOutboundAttempt.state) && lastOutboundAttempt.state === 'error'
        ? { at: lastOutboundAttempt.at, reason: lastOutboundAttempt.failureReason }
        : null;

    // The 24h free-form reply window. Odoo keeps the deadline; whether it's
    // still open is recomputed here rather than read off Odoo's flag, which is
    // only as fresh as the last time Odoo recomputed it.
    const windowExpiresAt = parseOdooUtc(channel.whatsapp_channel_valid_until);
    const minutesLeft = windowExpiresAt ? minutesBetween(now, windowExpiresAt) : null;

    return {
      channelId: channel.id,
      customer: customerNameOf(channel),
      phone: channel.whatsapp_number || null,
      partnerId: customerPartnerId,
      // Which of OUR numbers the customer wrote to. Note `phone` above is the
      // CUSTOMER's number — before this existed there was nothing on a thread
      // that said which business line it arrived on, which only stopped being
      // invisible once there was more than one.
      account: accountOf(channel),
      // Opens the real conversation in Odoo Discuss — still needed for what
      // the dashboard can't do, like sending a template.
      odooUrl: url ? `${url}/odoo/discuss/${channel.id}` : null,
      lastMessageAt: last?.at || isoOrNull(parseOdooUtc(channel.last_interest_dt)),
      lastMessageFrom: last?.from || null,
      lastMessagePreview: previewOf(last?.text),
      awaitingReply,
      waitingMinutes,
      unreadCount: unreadByChannelId.get(channel.id) || 0,
      failedSend,
      replyWindow: {
        expiresAt: isoOrNull(windowExpiresAt),
        open: Boolean(windowExpiresAt && windowExpiresAt > now),
        minutesLeft: minutesLeft !== null && minutesLeft > 0 ? minutesLeft : 0,
      },
      needsAttention: awaitingReply || Boolean(failedSend),
      messages: history.slice(-THREAD_TAIL).map(({ atDate, ...message }) => message),
    };
  });

  // Needs-attention first, and within that the customer kept waiting longest
  // sits at the top — so the list doubles as the order to work through.
  // Everything already handled falls below, most recent first.
  threads.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.needsAttention) return (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0);
    return new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
  });

  return {
    configured: true,
    available: true,
    fetchedAt: now.toISOString(),
    accounts: accountsOf(threads),
    counts: {
      threads: threads.length,
      needsAttention: threads.filter((thread) => thread.needsAttention).length,
      awaitingReply: threads.filter((thread) => thread.awaitingReply).length,
      failedSend: threads.filter((thread) => thread.failedSend).length,
      unread: threads.reduce((total, thread) => total + thread.unreadCount, 0),
    },
    threads,
  };
}

export { fetchWhatsappThreads, fetchWhatsappConversation, sendWhatsappReply };
