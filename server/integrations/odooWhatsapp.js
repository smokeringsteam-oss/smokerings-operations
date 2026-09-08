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
// Also surfaced, because it silently governs what a reply can even be: the
// 24-hour customer service window. WhatsApp only allows free-form replies
// within 24h of the customer's last message (Odoo tracks the deadline on
// `whatsapp_channel_valid_until`); after that only an approved template can go
// out. A thread with 40 minutes left is a different kind of urgent from one
// with 20 hours, so `replyWindow` carries the time remaining.
//
// Read-only. Nothing here writes to Odoo or sends a message — the deep link on
// each thread opens the real conversation in Odoo Discuss to reply there.
import { execute, getConfig, htmlToText } from './odoo.js';

// Outbound states that mean the message actually left. Anything else is either
// still in flight or failed.
const DELIVERED_STATES = new Set(['sent', 'delivered', 'read']);

// How much back-and-forth each thread carries for the preview: enough to see
// what was asked and what we last said, not the whole history.
const THREAD_TAIL = 8;

// Cheap guards so a mistyped request can't ask Odoo for the whole database.
const MAX_CHANNELS = 100;
const DEFAULT_CHANNELS = 30;

// Each resolved once per process — see the notes on each.
let selfPartnerIdCache;
let commentSubtypeIdCache;
let whatsappAvailableCache;

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
async function resolveWhatsappAvailable() {
  if (whatsappAvailableCache !== undefined) return whatsappAvailableCache;
  const fields = await execute('discuss.channel', 'fields_get', [[], ['type']]);
  whatsappAvailableCache = Boolean(fields.whatsapp_number && fields.whatsapp_partner_id);
  return whatsappAvailableCache;
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

// One line of a message, for the collapsed row. The full text stays on the
// thread tail underneath it.
function previewOf(text, max = 160) {
  if (!text) return '';
  const oneLine = text.replace(/\s*\n+\s*/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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
  const channels = await execute(
    'discuss.channel',
    'search_read',
    [
      [['channel_type', '=', 'whatsapp']],
      [
        'name',
        'whatsapp_number',
        'whatsapp_partner_id',
        'whatsapp_channel_valid_until',
        'last_interest_dt',
      ],
    ],
    // last_interest_dt is Odoo's own "when did anything last happen here"
    // stamp, so ordering by it means the limit drops the deadest threads and
    // never a live one.
    { order: 'last_interest_dt desc', limit: channelLimit },
  );

  if (!channels.length) return { ...empty, configured: true, available: true };

  const channelIds = channels.map((channel) => channel.id);
  const commentSubtypeId = await resolveCommentSubtypeId();
  const messageDomain = [
    ['model', '=', 'discuss.channel'],
    ['res_id', 'in', channelIds],
  ];
  if (commentSubtypeId) messageDomain.push(['subtype_id', '=', commentSubtypeId]);

  // Newest first and capped: only the tail of each thread is ever shown, and
  // the verdict itself depends on nothing but the last message in each.
  const messages = await execute(
    'mail.message',
    'search_read',
    [messageDomain, ['id', 'res_id', 'date', 'author_id', 'body']],
    { order: 'id desc', limit: channelIds.length * THREAD_TAIL * 3 },
  );

  const messageIds = messages.map((message) => message.id);
  // The delivery half of each message: direction and state, keyed by the
  // mail.message it belongs to.
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
  const waByMessageId = new Map(waRows.map((row) => [row.mail_message_id?.[0], row]));

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

    const history = raw.map((message) => {
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
    });

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
      // Opens the real conversation in Odoo Discuss, which is where a reply is
      // actually written — this view surfaces, it doesn't send.
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

export { fetchWhatsappThreads };
