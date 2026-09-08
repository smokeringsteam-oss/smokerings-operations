// The weekly recurring cadence Daily View renders — one row per task in
// `scheduled_task`, grouped into the seven days.
//
// Migrated off Tasks/schedule.csv, which had been the live source: edit the
// sheet, reload Daily View, see it there. Editing is now a matter of updating
// the table (`npm run db -- "update scheduled_task ..."`) rather than a
// spreadsheet, and the ids, days and labels are unchanged.
//
// id comes straight from task_id (WS-xx) — stable across edits (reordered,
// renamed, reworded rows) since it doesn't depend on the task's day or label
// text. That's what keeps a week's "done" status pinned to the right task
// after someone edits the schedule mid-week; see server/sprint/weeklyScheduleStatusLog.js.
import { insert, nextId, remove, select, selectOne, transaction, update } from '../core/repo.js';
import { mirrorCsv } from '../core/csvMirror.js';

const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The schedule was kept as "9:00 AM" in the sheet and normalised to "09:00:00"
// when it was loaded into the database. Daily View just prints this next to
// the task, so it is turned back into the form the kitchen reads — anything
// that isn't a plain clock time (a hand-written "after the delivery") is
// passed through untouched.
function displayTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value || '');
  if (!match) return value || '';
  const hour24 = Number(match[1]);
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

// Always includes all seven days (even with zero tasks) so "Open — no
// mandatory tasks" still renders.
function getRecurringSchedule() {
  const byDay = new Map(WEEKDAY_ORDER.map((day) => [day, []]));

  // sort_order — where Daily View's edit mode last dragged each task to,
  // seeded from the order the schedule was originally written in: the sheet
  // listed each day's tasks in the order they happen, and sorting by task_id
  // or time would lose the ones with no time set. rowid breaks ties, so rows
  // written by hand without a rank still come out in a stable order.
  select('scheduled_task', {}, { orderBy: 'sort_order, rowid' }).forEach((row) => {
    const day = (row.day || '').trim();
    const label = (row.task || '').trim();
    if (!day || !label || !row.task_id) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id: row.task_id,
      label,
      defaultTime: displayTime(row.time_of_day),
      defaultAssignee: row.assigned_to || '',
      // Daily View gives the Marketing rows their own card, so the category
      // has to travel with the task rather than stay behind in the table.
      category: (row.category || '').trim(),
    });
  });

  return Array.from(byDay.entries()).map(([day, tasks]) => ({ day, tasks }));
}


// ---- Editing the cadence ------------------------------------------------
//
// Daily View edits this table directly now: rename a task, retime it, hand it
// to someone else, retire it, add one, drag it up its day or across to another.
// Changing the schedule used to mean a `npm run db --` one-liner, so it only
// happened when whoever knew that command was at a keyboard.
//
// task_id is never rewritten by any of this. It is the key a week's completion
// status hangs off (see weeklyScheduleStatusLog.js), so a task renamed or moved
// to another day mid-week keeps the tick someone already gave it.

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normaliseDay(value) {
  const day = String(value || '').trim();
  const match = WEEKDAY_ORDER.find((name) => name.toLowerCase() === day.toLowerCase());
  if (!match) throw badRequest(`"${day}" is not a day of the week.`);
  return match;
}

// The inverse of displayTime(): the form the table holds. "9:00 AM" and the
// "09:00" an <input type="time"> produces both land on "09:00:00". Anything
// that isn't a clock time ("after the delivery") is kept verbatim, the same way
// displayTime passes it back out untouched. Blank means no time, which is a
// real answer here -- a task that happens when the one above it is done, not at
// an hour anyone agreed to.
function storeTime(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  // Minutes optional, because a person typing into Daily View's time field
  // writes "9am" far more often than "9:00 AM". A bare number with neither
  // minutes nor a meridiem is left alone rather than guessed at — "6" on this
  // schedule is as likely to mean the evening as the morning.
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (!match) return text;
  const meridiem = (match[4] || '').toLowerCase();
  if (match[2] === undefined && !meridiem) return text;
  let hour = Number(match[1]);
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const minutes = match[2] || '00';
  if (hour > 23 || Number(minutes) > 59) return text;
  return `${String(hour).padStart(2, '0')}:${minutes}:${match[3] || '00'}`;
}

function requireTask(taskId) {
  const row = selectOne('scheduled_task', { task_id: String(taskId || '').trim() });
  if (!row) {
    const err = new Error(`No scheduled task ${JSON.stringify(taskId)}.`);
    err.status = 404;
    throw err;
  }
  return row;
}

// One past the day's current last, so a new task lands at the bottom of the day
// someone is looking at rather than in the middle of it.
function nextRank(day) {
  return select('scheduled_task', { day }).reduce((max, row) => Math.max(max, Number(row.sort_order) || 0), 0) + 1;
}

function createTask({ day, label, time, assignedTo, category }) {
  const text = String(label || '').trim();
  if (!text) throw badRequest('A task needs a name.');
  const targetDay = normaliseDay(day);
  const taskId = nextId('scheduled_task', 'task_id', 'WS');
  insert('scheduled_task', {
    task_id: taskId,
    day: targetDay,
    time_of_day: storeTime(time),
    task: text,
    // Adarsh unless someone says otherwise: the pitmaster picks up whatever
    // gets added on the fly, and an unassigned row falls out of the person
    // filter Daily View is usually read through.
    assigned_to: String(assignedTo || '').trim() || 'Adarsh',
    category: String(category || '').trim() || null,
    sort_order: nextRank(targetDay),
  });
  return { taskId, csv: mirrorScheduleCsv() };
}

// A patch, not a replacement: only the fields the caller actually sent are
// touched, so a rename doesn't blank the time it said nothing about. Moving
// between days goes through moveTask() instead, which has the day's ordering to
// keep straight as well.
function updateTask({ taskId, label, time, assignedTo, category }) {
  const row = requireTask(taskId);
  const patch = {};
  if (label !== undefined) {
    const text = String(label).trim();
    if (!text) throw badRequest('A task needs a name.');
    patch.task = text;
  }
  if (time !== undefined) patch.time_of_day = storeTime(time);
  if (assignedTo !== undefined) patch.assigned_to = String(assignedTo).trim() || null;
  if (category !== undefined) patch.category = String(category).trim() || null;
  if (!Object.keys(patch).length) throw badRequest('Nothing to change.');
  update('scheduled_task', { task_id: row.task_id }, patch);
  return { taskId: row.task_id, csv: mirrorScheduleCsv() };
}

// Takes the task's completion history with it, through the foreign key's ON
// DELETE CASCADE -- see the note in weeklyScheduleStatusLog.js. That is the
// deliberate trade: a status row pinned to a task_id nothing resolves is worse
// than a lost tick.
function deleteTask({ taskId }) {
  const row = requireTask(taskId);
  remove('scheduled_task', { task_id: row.task_id });
  return { taskId: row.task_id, csv: mirrorScheduleCsv() };
}

// Drop a task at position `index` of `day` -- the same call whether it moved
// within its own day or across to another, because from the target day's point
// of view those are the same thing.
//
// `index` counts the day's tasks with the moved one already taken out, which is
// what a drag actually is: pull it out, put it back somewhere. Past the end
// simply lands last. The whole day is renumbered 1..n rather than squeezed into
// a gap, so the ranks can't drift into collisions after enough moves.
function moveTask({ taskId, day, index }) {
  const row = requireTask(taskId);
  const targetDay = day === undefined || day === null || day === '' ? row.day : normaliseDay(day);

  const moved = transaction(() => {
    const others = select('scheduled_task', { day: targetDay }, { orderBy: 'sort_order, rowid' }).filter(
      (other) => other.task_id !== row.task_id,
    );
    const requested = Number(index);
    const at = Number.isFinite(requested)
      ? Math.max(0, Math.min(Math.trunc(requested), others.length))
      : others.length;
    const ordered = [...others.slice(0, at), row, ...others.slice(at)];

    ordered.forEach((task, position) => {
      const patch = { sort_order: position + 1 };
      if (task.task_id === row.task_id) patch.day = targetDay;
      update('scheduled_task', { task_id: task.task_id }, patch);
    });

    // The day it left has a gap in its ranks now. Harmless -- ordering only
    // needs them to sort right, not to be contiguous -- but renumbering keeps a
    // hand-read of the table honest.
    if (targetDay !== row.day) {
      select('scheduled_task', { day: row.day }, { orderBy: 'sort_order, rowid' }).forEach((task, position) => {
        update('scheduled_task', { task_id: task.task_id }, { sort_order: position + 1 });
      });
    }

    return { taskId: row.task_id, day: targetDay, index: at };
  });

  // Outside the transaction: the mirror reads the table back, and it has to
  // read the ranks as they finally landed, not mid-renumber.
  return { ...moved, csv: mirrorScheduleCsv() };
}


// ---- The CSV mirror -----------------------------------------------------
//
// Every edit above is written back out to the knowledge-base's Tasks/schedule.csv
// once the table has taken it. The database is still the only thing read back
// (getRecurringSchedule above reads the table, not this file) -- the CSV is
// there so the cadence stays legible in a spreadsheet, and diffable if the
// knowledge-base repo starts tracking Data/Tasks, which it currently doesn't.
//
// Best-effort by design: see the note at the top of server/core/csvMirror.js.
// A save that reached the table and not the file is a stale CSV, and the next
// edit rewrites it whole; a save rejected because the file was open in Excel
// would be worse.
const CSV_PATH = 'Tasks/schedule.csv';

// The columns the committed file already has, in its order. sort_order is
// deliberately not among them: the rows are written in the order Daily View
// renders them, so the file carries the ordering the way it always did --
// by being in it.
const CSV_HEADER = [
  'task_id',
  'day',
  'time',
  'task',
  'assigned_to',
  'category',
  'related_vendor_id',
  'related_recipe_id',
  'related_sop',
  'notes',
];

// Day by day in week order, each day in its own rank order -- the same shape
// getRecurringSchedule hands the page, so the file reads as the week does. A
// row on some day that isn't a weekday name (which only a hand-written INSERT
// can make) sorts to the end rather than being dropped: the mirror's job is to
// show the table, including the parts of it nobody meant to put there.
function mirrorScheduleCsv() {
  const rows = select('scheduled_task', {}, { orderBy: 'sort_order, rowid' })
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const dayA = WEEKDAY_ORDER.indexOf((a.row.day || '').trim());
      const dayB = WEEKDAY_ORDER.indexOf((b.row.day || '').trim());
      const rankA = dayA === -1 ? WEEKDAY_ORDER.length : dayA;
      const rankB = dayB === -1 ? WEEKDAY_ORDER.length : dayB;
      // Ties keep the select's order, which is the day's own ranking --
      // Array.prototype.sort is stable, but the index keeps that explicit.
      return rankA - rankB || a.index - b.index;
    })
    .map(({ row }) => ({
      task_id: row.task_id,
      day: row.day || '',
      // Written the way the sheet held it ("9:00 AM"), not the way the column
      // stores it, so the mirrored file matches the one already in git rather
      // than reformatting every row on the first save.
      time: displayTime(row.time_of_day),
      task: row.task || '',
      assigned_to: row.assigned_to || '',
      category: row.category || '',
      related_vendor_id: row.related_vendor_id || '',
      related_recipe_id: row.related_recipe_id || '',
      related_sop: row.related_sop || '',
      notes: row.notes || '',
    }));

  return mirrorCsv(CSV_PATH, CSV_HEADER, rows);
}

export { getRecurringSchedule, mirrorScheduleCsv, createTask, updateTask, deleteTask, moveTask, storeTime, displayTime };
