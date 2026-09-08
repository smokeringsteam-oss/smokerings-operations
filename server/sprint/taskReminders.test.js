// When a task reminder fires, and — more importantly — when it doesn't.
//
// The firing rules are the part of this that can go wrong quietly. A reminder
// that never arrives looks exactly like a quiet day, and one that arrives
// sixty times looks like a bug in the phone. So the rules are exercised
// directly here against a real schedule in a real database, at fixed times.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

let dir;
let reminders;
let repo;

// A Tuesday, so "today" is a weekday with tasks and Monday's rows are there to
// prove they are not picked up.
const TUESDAY = '2026-09-08';
const at = (hhmm) => new Date(`${TUESDAY}T${hhmm}:00`);

beforeAll(async () => {
  ({ dir } = createTestDb());
  // After createTestDb, which is what points KB_SQLITE_PATH at the temp
  // database — importing earlier would open the real one.
  repo = await import('../core/repo.js');
  reminders = await import('./taskReminders.js');
});

afterAll(() => removeTestDb(dir));

// Seeded fresh per test: several tests write completions, and a leaked tick
// from one would silently change what the next one is measuring.
beforeEach(() => {
  repo.select('task_completion').forEach((row) =>
    repo.remove('task_completion', { week_key: row.week_key, task_id: row.task_id }),
  );
  repo.select('scheduled_task').forEach((row) => repo.remove('scheduled_task', { task_id: row.task_id }));
  // Claims outlive the schedule that produced them — they are keyed by date,
  // not by week — so a tick in one test would otherwise suppress the same
  // reminder in the next and make a broken claim look like a working one.
  repo.select('push_delivery').forEach((row) => repo.remove('push_delivery', { notify_key: row.notify_key }));
  repo.select('push_subscription').forEach((row) => repo.remove('push_subscription', { endpoint: row.endpoint }));

  const tasks = [
    { task_id: 'WS-01', day: 'Tuesday', time_of_day: '07:30:00', task: 'Vendor run', assigned_to: 'Adarsh' },
    { task_id: 'WS-02', day: 'Tuesday', time_of_day: '15:00:00', task: 'Brine pork', assigned_to: 'Adarsh' },
    // No clock time at all — the "after the delivery" case.
    { task_id: 'WS-03', day: 'Tuesday', time_of_day: 'after the delivery', task: 'Stock count' },
    // Another day entirely, and must never show up on a Tuesday.
    { task_id: 'WS-04', day: 'Monday', time_of_day: '09:00:00', task: 'Order packaging' },
  ];
  tasks.forEach((row, i) => repo.insert('scheduled_task', { ...row, sort_order: i }));
});

describe('parseClockMinutes', () => {
  // Both formats genuinely occur: the table stores "15:00:00", but a task
  // retimed in Daily View comes back through task_completion as "3:00 PM".
  // Reading only one of them would silently stop reminding retimed tasks.
  it.each([
    ['07:30:00', 450],
    ['07:30', 450],
    ['7:30 AM', 450],
    ['3:00 PM', 900],
    ['12:00 AM', 0],
    ['12:30 PM', 750],
  ])('reads %s as %i minutes past midnight', (input, expected) => {
    expect(reminders.parseClockMinutes(input)).toBe(expected);
  });

  it.each([['after the delivery'], [''], [null], ['25:00'], ['9:70'], ['13:00 PM']])(
    'has no opinion about %s',
    (input) => {
      expect(reminders.parseClockMinutes(input)).toBeNull();
    },
  );
});

describe('getTodayPending', () => {
  it('returns only this weekday, and only what is unticked', () => {
    const pending = reminders.getTodayPending(at('06:00'));
    expect(pending.weekday).toBe('Tuesday');
    expect(pending.tasks.map((t) => t.id)).toEqual(['WS-01', 'WS-02', 'WS-03']);
  });

  it('drops a task once this week has ticked it', () => {
    const { weekKey } = reminders.getTodayPending(at('06:00'));
    repo.insert('task_completion', { week_key: weekKey, task_id: 'WS-01', done: 1 });
    expect(reminders.getTodayPending(at('06:00')).tasks.map((t) => t.id)).toEqual(['WS-02', 'WS-03']);
  });

  // The key is what pins a tick to a week. If the server computed it
  // differently from the browser, it would read a week nothing has ever
  // ticked and every task would look pending forever.
  it('ignores a tick filed under a different week', () => {
    repo.insert('task_completion', { week_key: '2020-W01', task_id: 'WS-01', done: 1 });
    expect(reminders.getTodayPending(at('06:00')).tasks.map((t) => t.id)).toContain('WS-01');
  });

  it('prefers the time and assignee this week logged over the cadence default', () => {
    const { weekKey } = reminders.getTodayPending(at('06:00'));
    repo.insert('task_completion', {
      week_key: weekKey,
      task_id: 'WS-02',
      done: 0,
      time_of_day: '5:00 PM',
      assigned_to: 'Sneha',
    });
    const task = reminders.getTodayPending(at('06:00')).tasks.find((t) => t.id === 'WS-02');
    expect(task).toMatchObject({ time: '5:00 PM', assignedTo: 'Sneha', dueMinutes: 17 * 60 });
  });
});

describe('dueReminders', () => {
  const keys = (now, options) => reminders.dueReminders(now, options).map((r) => r.key);

  it('sends nothing before the digest hour', () => {
    expect(keys(at('05:00'))).toEqual([]);
  });

  it('sends the digest at 07:00, listing what is open as bullets', () => {
    const due = reminders.dueReminders(at('07:00'));
    expect(due).toHaveLength(1);
    expect(due[0].key).toBe(`${TUESDAY}:digest`);
    expect(due[0].payload.title).toBe('3 tasks pending — Tuesday');
    // Names only. Times were deliberately dropped from the body — they are on
    // the screen this links to, and three short lines read faster in a hurry.
    expect(due[0].payload.body).toBe('• Vendor run\n• Brine pork\n• Stock count');
  });

  it('nudges a task at its own time', () => {
    expect(keys(at('15:00'))).toEqual([`${TUESDAY}:WS-02`]);
  });

  it('puts the rest of the day under a nudge, without repeating the task itself', () => {
    const nudge = reminders.dueReminders(at('15:00'))[0].payload;
    expect(nudge.title).toBe('Brine pork');
    expect(nudge.body).toBe('Also still open:\n• Vendor run\n• Stock count');
    expect(nudge.body).not.toContain('Brine pork');
  });

  it('says so when a nudge is the last thing left', () => {
    const { weekKey } = reminders.getTodayPending(at('06:00'));
    ['WS-01', 'WS-03'].forEach((task_id) =>
      repo.insert('task_completion', { week_key: weekKey, task_id, done: 1 }),
    );
    expect(reminders.dueReminders(at('15:00'))[0].payload.body).toBe('Nothing else left today.');
  });

  // The server is not always up, so a tick that starts late still has to send
  // what it missed — but not the entire day at once.
  it('still sends a nudge within the grace window', () => {
    expect(keys(at('16:30'))).toEqual([`${TUESDAY}:WS-02`]);
  });

  it('gives up on a nudge once the grace window has passed', () => {
    expect(keys(at('18:00'))).toEqual([]);
  });

  it('never nudges a task with no clock time', () => {
    // WS-03 has none, so no time of day produces a key for it — but it is
    // still counted in the digest above.
    const allDay = ['07:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
    const everyKey = allDay.flatMap((t) => keys(at(t)));
    expect(everyKey.some((k) => k.endsWith('WS-03'))).toBe(false);
  });

  it('says nothing at all on a day with nothing left', () => {
    const { weekKey } = reminders.getTodayPending(at('06:00'));
    ['WS-01', 'WS-02', 'WS-03'].forEach((task_id) =>
      repo.insert('task_completion', { week_key: weekKey, task_id, done: 1 }),
    );
    expect(keys(at('07:00'))).toEqual([]);
    expect(keys(at('15:00'))).toEqual([]);
  });

  it('keys every reminder to the local date, not UTC', () => {
    // An evening reminder in IST is already tomorrow in UTC. Keying off
    // toISOString() would file it under the next day and let it collide with
    // the next morning's digest.
    const evening = reminders.dueReminders(at('15:00'))[0];
    expect(evening.key.startsWith(TUESDAY)).toBe(true);
  });
});

describe('runReminderTick', () => {
  const DEVICE = 'https://example.test/endpoint';

  // A tick does nothing at all without a subscribed device, so these need one
  // on the books. Nothing is actually pushed to it — there are no VAPID keys,
  // so sendToAll short-circuits before it would reach the network.
  beforeEach(() => {
    repo.upsert('push_subscription', ['endpoint'], { endpoint: DEVICE, p256dh: 'key', auth: 'auth' });
  });

  // A claim is a record that something was delivered. With no phone subscribed
  // nothing can be, so claiming would mark today's digest as sent to nobody —
  // and the first phone to subscribe an hour later would never receive it.
  // This is the state the server sits in between being set up and the first
  // phone opting in, which is exactly when it would be least noticed.
  it('claims nothing while no device is subscribed', async () => {
    repo.remove('push_subscription', { endpoint: DEVICE });

    const result = await reminders.runReminderTick(at('12:00'), { digestMinutes: 12 * 60 });
    expect(result.skipped).toBe('no subscriptions');
    expect(repo.select('push_delivery')).toHaveLength(0);

    // And once a phone is subscribed, that same moment does claim it — the
    // reminder was still waiting rather than spent.
    repo.insert('push_subscription', { endpoint: DEVICE, p256dh: 'key', auth: 'auth' });
    const after = await reminders.runReminderTick(at('12:00'), { digestMinutes: 12 * 60 });
    expect(after.claimed).toBe(1);
  });

  it('claims a reminder once and never again', async () => {
    const first = await reminders.runReminderTick(at('07:00'));
    expect(first.claimed).toBe(1);

    const second = await reminders.runReminderTick(at('07:00'));
    expect(second.claimed ?? 0).toBe(0);

    // Still nothing at 07:15: the digest is spent and WS-01 is not due until
    // 07:30, which is the case a one-minute timer spends most of its day in.
    const third = await reminders.runReminderTick(at('07:15'));
    expect(third.claimed ?? 0).toBe(0);

    // And when 07:30 does arrive, that is a different key, so it does fire.
    const fourth = await reminders.runReminderTick(at('07:30'));
    expect(fourth.claimed).toBe(1);
  });

  it('claims each task separately from the digest', async () => {
    await reminders.runReminderTick(at('07:00'));
    const nudge = await reminders.runReminderTick(at('15:00'));
    expect(nudge.claimed).toBe(1);
    expect(repo.select('push_delivery').map((r) => r.notify_key).sort()).toEqual([
      `${TUESDAY}:WS-02`,
      `${TUESDAY}:digest`,
    ]);
  });
});
