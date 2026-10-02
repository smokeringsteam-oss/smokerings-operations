// When the WhatsApp alarm fires, and — the part that actually matters — when
// it stays quiet.
//
// An alarm is the loudest thing this dashboard does, so the two failure modes
// are both worse than usual: one that never fires looks like a quiet day, and
// one that fires repeatedly for a message from last week teaches whoever
// carries the phone to ignore it. Both rules are exercised directly here.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// Hoisted so the vi.mock factory below can close over it — the mock is
// evaluated before anything else in this file runs.
const odoo = vi.hoisted(() => ({ inbox: null }));

vi.mock('./odooWhatsapp.js', () => ({
  fetchWhatsappThreads: async () => odoo.inbox,
}));

// Legion's own speakers, stubbed. Without this the tick would spawn a real
// PowerShell and the test suite would laugh at whoever ran it — and `enabled`
// has to be steerable anyway, because it is now half of the rule deciding
// whether a tick claims anything at all.
const legion = vi.hoisted(() => ({ enabled: false, started: [] }));

vi.mock('./localAlarm.js', () => ({
  isLocalAlarmEnabled: () => legion.enabled,
  startLocalAlarm: (detail) => {
    legion.started.push(detail);
    return { started: true, sound: 'file' };
  },
}));

let dir;
let alerts;
let repo;

const NOW = new Date('2026-09-20T14:00:00Z');
const agoMinutes = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();

// The shape fetchWhatsappThreads() returns, pared down to the fields dueAlerts
// actually reads.
function inbox(threads) {
  return {
    configured: true,
    available: true,
    fetchedAt: NOW.toISOString(),
    counts: { threads: threads.length, needsAttention: 0, awaitingReply: 0, failedSend: 0, unread: 0 },
    threads,
  };
}

function thread(channelId, customer, messages) {
  return { channelId, customer, messages, needsAttention: true };
}

function inbound(id, text, at) {
  return { id, at, from: 'customer', author: customerAuthor, text, state: null, failureReason: null };
}

function outbound(id, text, at) {
  return { id, at, from: 'us', author: 'Smoke Rings', text, state: 'sent', failureReason: null };
}

const customerAuthor = 'Eric Savage';

beforeAll(async () => {
  ({ dir } = createTestDb());
  // After createTestDb, which points KB_SQLITE_PATH at the temp database —
  // importing earlier would open the real one.
  repo = await import('../core/repo.js');
  alerts = await import('./whatsappAlerts.js');
});

afterAll(() => removeTestDb(dir));

beforeEach(() => {
  // Claims and subscriptions both leak between tests otherwise, and a leaked
  // claim is exactly the thing these tests are trying to detect.
  repo.select('push_delivery').forEach((row) => repo.remove('push_delivery', { notify_key: row.notify_key }));
  repo.select('push_subscription').forEach((row) => repo.remove('push_subscription', { endpoint: row.endpoint }));
  odoo.inbox = inbox([]);
  legion.enabled = false;
  legion.started = [];
});

describe('dueAlerts', () => {
  it('alerts on a customer message that just landed', () => {
    const due = alerts.dueAlerts(
      inbox([thread(10, 'Eric Savage', [inbound(501, 'Is the brisket ready?', agoMinutes(2))])]),
      NOW,
    );

    expect(due).toHaveLength(1);
    expect(due[0].channelId).toBe(10);
    expect(due[0].keys).toEqual(['wa-msg:501']);
    expect(due[0].payload.title).toBe('Eric Savage');
    expect(due[0].payload.body).toBe('Is the brisket ready?');
    // The flag the worker and the page both key off — without it this is a
    // silent notification like any other.
    expect(due[0].payload.alarm).toBe('whatsapp');
    expect(due[0].payload.url).toContain('alarm=whatsapp');
    expect(due[0].payload.url).toContain('channel=10');
  });

  it('ignores our own outbound messages', () => {
    const due = alerts.dueAlerts(
      inbox([thread(10, 'Eric Savage', [outbound(502, 'On its way!', agoMinutes(1))])]),
      NOW,
    );
    expect(due).toEqual([]);
  });

  it('ignores anything older than the grace window', () => {
    // The cold-start guard. Without it, a database with no claims would find
    // every message in the inbox new and set off a dozen alarms at once.
    const due = alerts.dueAlerts(
      inbox([thread(10, 'Eric Savage', [inbound(503, 'Sent last night', agoMinutes(240))])]),
      NOW,
    );
    expect(due).toEqual([]);
  });

  it('respects a custom grace window', () => {
    const stale = inbox([thread(10, 'Eric Savage', [inbound(504, 'Half an hour ago', agoMinutes(30))])]);
    expect(alerts.dueAlerts(stale, NOW)).toEqual([]);
    expect(alerts.dueAlerts(stale, NOW, { graceMinutes: 45 })).toHaveLength(1);
  });

  it('collapses several new messages in one thread into one alert', () => {
    const due = alerts.dueAlerts(
      inbox([
        thread(10, 'Eric Savage', [
          inbound(505, 'Hi', agoMinutes(4)),
          inbound(506, 'Are you open today?', agoMinutes(3)),
          inbound(507, 'Sorry — Sunday I mean', agoMinutes(1)),
        ]),
      ]),
      NOW,
    );

    // One buzz for one customer typing three times...
    expect(due).toHaveLength(1);
    expect(due[0].payload.body).toContain('Sorry — Sunday I mean');
    expect(due[0].payload.body).toContain('+ 2 more messages');
    // ...but all three ids claimed, so none can come back as its own alarm.
    expect(due[0].keys).toEqual(['wa-msg:505', 'wa-msg:506', 'wa-msg:507']);
  });

  it('gives each conversation its own alert and its own tag', () => {
    const due = alerts.dueAlerts(
      inbox([
        thread(10, 'Eric Savage', [inbound(508, 'One', agoMinutes(2))]),
        thread(11, 'Priya R', [inbound(509, 'Two', agoMinutes(2))]),
      ]),
      NOW,
    );

    expect(due).toHaveLength(2);
    // Distinct tags: two customers must not overwrite each other in the shade.
    expect(due.map((alert) => alert.payload.tag)).toEqual(['whatsapp-10', 'whatsapp-11']);
  });

  it('skips a message with an unreadable timestamp rather than assuming it is new', () => {
    const due = alerts.dueAlerts(
      inbox([thread(10, 'Eric Savage', [inbound(510, 'When?', null)])]),
      NOW,
    );
    expect(due).toEqual([]);
  });

  it('returns nothing when the WhatsApp module is unavailable', () => {
    expect(alerts.dueAlerts({ available: false, threads: [] }, NOW)).toEqual([]);
    expect(alerts.dueAlerts(null, NOW)).toEqual([]);
  });
});

describe('runWhatsappAlertTick', () => {
  // A subscription has to exist for a claim to be taken at all — see the note
  // at the top of the tick.
  function subscribe() {
    repo.upsert('push_subscription', ['endpoint'], {
      endpoint: 'https://push.example/test-endpoint',
      p256dh: 'p256dh-test',
      auth: 'auth-test',
      label: 'Test phone',
    });
  }

  it('takes no claim when there is nowhere at all to deliver', async () => {
    // No subscriptions AND no speakers on legion.
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(601, 'Hello?', agoMinutes(1))])]);

    const result = await alerts.runWhatsappAlertTick(NOW);

    expect(result.skipped).toBe('no subscriptions');
    // The important half: the message is NOT marked as alerted. A phone that
    // subscribes a minute from now still gets told about it.
    expect(repo.count('push_delivery')).toBe(0);
  });

  it('still alarms with no subscriptions at all, when legion can make a noise', async () => {
    // The case the local alarm exists for, and the one the old guard would
    // have short-circuited: no phone subscribed, or every browser shut so no
    // push can be received, and a customer waiting.
    legion.enabled = true;
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(605, 'Hello?', agoMinutes(1))])]);

    const result = await alerts.runWhatsappAlertTick(NOW);

    expect(result.skipped).toBeUndefined();
    expect(result.announced).toBe(1);
    expect(legion.started).toHaveLength(1);
    expect(legion.started[0]).toMatchObject({ customer: 'Eric Savage', body: 'Hello?' });
    // Claimed, so the next tick a minute later does not sound it again.
    expect(repo.count('push_delivery', { notify_key: 'wa-msg:605' })).toBe(1);
  });

  it('sounds legion alongside the push, not instead of it', async () => {
    legion.enabled = true;
    subscribe();
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(606, 'Are you open?', agoMinutes(1))])]);

    const result = await alerts.runWhatsappAlertTick(NOW);

    // Both halves fire for one message. Which of them reaches anybody depends
    // on where they are standing, and this process cannot know that.
    expect(result.announced).toBe(1);
    expect(legion.started).toHaveLength(1);
  });

  it('does not sound legion for a message it has already announced', async () => {
    legion.enabled = true;
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(607, 'Hello?', agoMinutes(1))])]);

    await alerts.runWhatsappAlertTick(NOW);
    legion.started = [];
    await alerts.runWhatsappAlertTick(new Date(NOW.getTime() + 60000));

    // The claim governs the local alarm exactly as it governs the push — a
    // once-a-minute timer must not restart the laugh sixty times.
    expect(legion.started).toEqual([]);
  });

  it('claims each message once, so a one-minute timer cannot repeat itself', async () => {
    subscribe();
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(602, 'Hello?', agoMinutes(1))])]);

    const first = await alerts.runWhatsappAlertTick(NOW);
    expect(first.announced).toBe(1);
    expect(repo.count('push_delivery', { notify_key: 'wa-msg:602' })).toBe(1);

    // The same message, one tick later. Nothing new has happened.
    const second = await alerts.runWhatsappAlertTick(new Date(NOW.getTime() + 60000));
    expect(second.announced ?? 0).toBe(0);
  });

  it('still announces a thread where only one of several messages is new', async () => {
    subscribe();
    odoo.inbox = inbox([thread(10, 'Eric Savage', [inbound(603, 'Hi', agoMinutes(3))])]);
    await alerts.runWhatsappAlertTick(NOW);

    // The customer types again a minute later; the first message is still in
    // the thread tail and still inside the grace window.
    odoo.inbox = inbox([
      thread(10, 'Eric Savage', [inbound(603, 'Hi', agoMinutes(3)), inbound(604, 'Are you open?', agoMinutes(1))]),
    ]);
    const second = await alerts.runWhatsappAlertTick(NOW);

    expect(second.announced).toBe(1);
    expect(repo.count('push_delivery', { notify_key: 'wa-msg:604' })).toBe(1);
  });

  it('reports rather than throws when Odoo has no WhatsApp module', async () => {
    subscribe();
    odoo.inbox = { configured: true, available: false, reason: 'not installed', threads: [] };

    const result = await alerts.runWhatsappAlertTick(NOW);

    expect(result.skipped).toBe('not installed');
    expect(result.sent).toBe(0);
  });
});
