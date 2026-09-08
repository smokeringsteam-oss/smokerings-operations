// "What's still pending today" — as a push notification rather than as a page
// someone has to remember to open.
//
// This reads exactly what Daily View reads and applies the same rules, so a
// reminder can never disagree with the screen: today's rows from
// `scheduled_task`, minus whatever this ISO week's `task_completion` says is
// already ticked. A task nobody has touched has no completion row at all —
// absence means not-done, which is the same "every week starts fresh" behavior
// weeklyScheduleStatusLog.js describes.
//
// Two kinds of notification come out of it:
//
//   - a morning digest, once, listing everything still open today;
//   - a nudge at a task's own time_of_day, if it is still open when that
//     time arrives.
//
// Both are claimed in push_delivery before they are sent (see pushNotify.js),
// which is what lets the caller be a one-minute timer without sending sixty
// copies of the same reminder.
import { select } from '../core/repo.js';
import { claimDelivery, sendToAll, subscriptionCount } from '../core/pushNotify.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// How late a reminder may still fire. The server is not always up — legion
// sleeps, and `node server/index.js` gets restarted after every backend edit —
// so a tick that starts at 09:40 should still send the 09:30 nudge it missed.
// Without a bound, though, a restart at 22:00 would deliver the whole day at
// once, so anything older than this is considered water under the bridge.
const DEFAULT_GRACE_MINUTES = 120;

// When the digest goes out, as minutes past midnight. 07:00 by default —
// early enough to be a plan for the day rather than a report on it.
const DEFAULT_DIGEST_MINUTES = 7 * 60;

// ISO-8601 week, the same key Daily View computes in the browser
// (getIsoWeekKey in src/pages/sprint/recurringSchedule.ts). It has to agree
// exactly: this is the key task_completion rows are written under, so a
// different answer here would read a week that nothing has ever ticked and
// every task would look pending.
function getIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Local calendar date, for the delivery key. toISOString() would be wrong here
// — it is UTC, so anything after 05:30 IST would be filed under tomorrow and
// the evening's reminders would collide with the next morning's.
function localDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Minutes past midnight, or null for anything that isn't a clock time.
//
// Two formats reach this, and it matters that both do. The table stores
// "09:00:00", but a task someone has retimed in Daily View comes back through
// task_completion in the form the kitchen reads — "9:00 AM" — because that is
// what getRecurringSchedule() hands the UI and what the UI saves back. A task
// timed "after the delivery" parses as null and simply never gets a per-task
// nudge; it still appears in the morning digest.
function parseClockMinutes(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = (match[3] || '').toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

// Everything scheduled for `now`'s weekday that this week hasn't ticked off.
//
// The per-task overrides live in task_completion alongside the tick, so time
// and assignee are read from there first and fall back to the cadence's
// defaults — the same precedence getEffectiveTaskState uses in the browser.
function getTodayPending(now = new Date()) {
  const weekday = WEEKDAYS[now.getDay()];
  const weekKey = getIsoWeekKey(now);

  const status = new Map();
  select('task_completion', { week_key: weekKey }).forEach((row) => {
    status.set(row.task_id, row);
  });

  const tasks = select('scheduled_task', { day: weekday }, { orderBy: 'sort_order, rowid' })
    .filter((row) => row.task_id && (row.task || '').trim())
    .map((row) => {
      const logged = status.get(row.task_id);
      const time = logged?.time_of_day || row.time_of_day || '';
      return {
        id: row.task_id,
        label: (row.task || '').trim(),
        category: (row.category || '').trim(),
        assignedTo: (logged?.assigned_to ?? row.assigned_to) || '',
        time,
        dueMinutes: parseClockMinutes(time),
        done: !!logged?.done,
      };
    })
    .filter((task) => !task.done);

  return { weekday, weekKey, dateKey: localDateKey(now), tasks };
}

// ---- What to send, and when --------------------------------------------

// Task names as a bulleted list.
//
// Names only — no times, no assignee. The times are on the screen this links
// to, and a notification that has to be read in a hurry is better as three
// short lines than three annotated ones. Android truncates the body when the
// notification is collapsed, so the cap is about what survives that: past
// four, the count carries more than a fourth half-visible line would.
const MAX_LISTED = 4;

function bulletList(labels) {
  const shown = labels.slice(0, MAX_LISTED);
  const rest = labels.length - shown.length;
  return shown.map((label) => `• ${label}`).join('\n') + (rest > 0 ? `\n+ ${rest} more` : '');
}

function digestPayload({ weekday, tasks }) {
  return {
    title: `${tasks.length} task${tasks.length === 1 ? '' : 's'} pending — ${weekday}`,
    body: bulletList(tasks.map((task) => task.label)),
    // One tag for the whole digest, so a second day's digest replaces the
    // first in the shade rather than stacking under it.
    tag: 'daily-digest',
    url: '/sprint/daily',
  };
}

// The nudge when one task's time arrives: that task as the title, and whatever
// else is still open listed under it, so a single glance covers the rest of the
// day rather than only the one thing that happened to be due.
function taskPayload(task, others = []) {
  return {
    title: task.label,
    body: others.length ? `Also still open:\n${bulletList(others.map((t) => t.label))}` : 'Nothing else left today.',
    // Tagged per task, so a nudge for one task never overwrites another's.
    tag: `task-${task.id}`,
    url: '/sprint/daily',
  };
}

// The notifications that are due right now, each with the key that will be
// claimed for it. Pure — it sends nothing and writes nothing, which is what
// makes the firing rules testable without a push service.
function dueReminders(now = new Date(), options = {}) {
  const {
    digestMinutes = DEFAULT_DIGEST_MINUTES,
    graceMinutes = DEFAULT_GRACE_MINUTES,
    perTask = true,
    digest = true,
  } = options;

  const pending = getTodayPending(now);
  if (!pending.tasks.length) return [];

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Due, but not so long ago that telling you now is noise rather than news.
  const isRipe = (dueMinutes) => nowMinutes >= dueMinutes && nowMinutes - dueMinutes <= graceMinutes;

  const out = [];
  if (digest && isRipe(digestMinutes)) {
    out.push({ key: `${pending.dateKey}:digest`, payload: digestPayload(pending) });
  }
  if (perTask) {
    pending.tasks.forEach((task) => {
      if (task.dueMinutes == null || !isRipe(task.dueMinutes)) return;
      const others = pending.tasks.filter((other) => other.id !== task.id);
      out.push({ key: `${pending.dateKey}:${task.id}`, payload: taskPayload(task, others) });
    });
  }
  return out;
}

// ---- The timer's entry point -------------------------------------------

// One pass: work out what is due, claim each one, send what was claimed.
//
// Claim before send, so two ticks overlapping (a slow push service, a tick
// every minute) cannot both decide to send the same reminder. Never throws —
// a timer with an unhandled rejection in it takes the process down with it.
async function runReminderTick(now = new Date(), options = {}) {
  try {
    // Nothing subscribed means nothing can be delivered, and a claim taken now
    // would be a claim on a notification nobody ever got: the reminder would
    // be marked sent, and the first phone to subscribe half an hour later
    // would never receive today's. A claim is a record of a delivery, so there
    // is nothing to record until there is somewhere to deliver to.
    if (!subscriptionCount()) return { considered: 0, sent: 0, skipped: 'no subscriptions' };

    const due = dueReminders(now, options);
    const claimed = due.filter((item) => claimDelivery(item.key));
    if (!claimed.length) return { considered: due.length, sent: 0 };
    let sent = 0;
    for (const item of claimed) {
      const result = await sendToAll(item.payload);
      sent += result.sent || 0;
    }
    return { considered: due.length, claimed: claimed.length, sent };
  } catch (err) {
    console.error('[push] reminder tick failed —', err.message);
    return { considered: 0, sent: 0, error: err.message };
  }
}

// The "remind me now" button in Daily View: today's digest, on demand, with no
// claim taken so it can be used as many times as someone wants to test it.
//
// It deliberately does NOT reuse the digest's tag. Sharing it made testing
// ambiguous in the worst way: the send would replace the digest already in the
// shade, in place and — on a channel Android has filed as silent — with nothing
// to announce it. "Sent to 1 device" and an apparently unchanged phone is not a
// result anyone can act on. Its own tag makes a test arrive as its own
// notification, and the time in the title says which send you are looking at.
async function sendPendingDigestNow(now = new Date()) {
  const pending = getTodayPending(now);
  if (!pending.tasks.length) {
    return {
      sent: 0,
      pending: 0,
      message: `Nothing pending for ${pending.weekday} — no notification sent.`,
    };
  }
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const payload = digestPayload(pending);
  const result = await sendToAll({
    ...payload,
    title: `${payload.title} (test ${clock})`,
    tag: 'daily-digest-test',
  });
  return { ...result, pending: pending.tasks.length };
}

export {
  dueReminders,
  getIsoWeekKey,
  getTodayPending,
  parseClockMinutes,
  runReminderTick,
  sendPendingDigestNow,
  DEFAULT_DIGEST_MINUTES,
  DEFAULT_GRACE_MINUTES,
};
