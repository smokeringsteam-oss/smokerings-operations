// Today's row of the weekly cadence, small enough to pin above the shared note
// board — see src/components/NotesBubble.tsx.
//
// The board and the cadence answer the same question from opposite ends. The
// cadence is what was always going to happen today; the board is what came up.
// Before this you had to open Daily View to see the first and the bubble to
// see the second, which meant the tick box for "hose down the smoker" lived
// one screen away from the note saying the hose is broken. Pinning today's
// open tasks to the top of the panel puts both in the one place people already
// have open on the kitchen tablet.
//
// Nothing here is a second copy of the schedule. It reads the same two tables
// Daily View reads, applies the same precedence, and ticks by calling the same
// setTaskStatus() Daily View calls — so a task ticked from the bubble and a
// task ticked from the page are the same write, and the CSV mirror happens
// either way. What this module adds is only "today, and only what is still
// open", which is the shape a strip four lines tall can hold.
import { select } from '../core/repo.js';
import { getIsoWeekKey } from './taskReminders.js';
import { displayTime } from './recurringSchedule.js';
import { setTaskStatus } from './weeklyScheduleStatusLog.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// One task as it stands this week: the completion row's overrides if someone
// has touched it, the cadence's defaults if nobody has. The same precedence
// getEffectiveTaskState applies in the browser, and it has to stay the same —
// two answers to "who is this assigned to" is worse than none.
//
// The time goes out in the form the kitchen reads ("9:00 AM"), never the
// "09:00:00" the column holds. That is not cosmetic: ticking writes the
// effective values back, so handing the raw column value to the tick would
// quietly restamp the task in a format Daily View would then print verbatim.
function toTask(row, logged) {
  return {
    id: row.task_id,
    label: (row.task || '').trim(),
    category: (row.category || '').trim(),
    assignedTo: (logged?.assigned_to ?? row.assigned_to) || '',
    time: logged?.time_of_day || displayTime(row.time_of_day),
    done: !!logged?.done,
  };
}

// Today's tasks in the order Daily View lists them, ticked ones included.
//
// Included rather than filtered out, because the strip has to be able to say
// "3 to do · 2 done" — a list that silently shrinks as things get ticked ends
// the day looking like a day with no tasks in it, which is the one reading
// that would make someone go and check the page anyway.
function getTodayTasks(now = new Date()) {
  const weekday = WEEKDAYS[now.getDay()];
  const weekKey = getIsoWeekKey(now);

  const logged = new Map();
  select('task_completion', { week_key: weekKey }).forEach((row) => {
    logged.set(row.task_id, row);
  });

  const tasks = select('scheduled_task', { day: weekday }, { orderBy: 'sort_order, rowid' })
    .filter((row) => row.task_id && (row.task || '').trim())
    .map((row) => toTask(row, logged.get(row.task_id)));

  const done = tasks.reduce((count, task) => (task.done ? count + 1 : count), 0);
  return {
    weekday,
    weekKey,
    tasks,
    done,
    open: tasks.length - done,
    fetchedAt: new Date().toISOString(),
  };
}

// Ticks one of today's tasks and hands back the whole strip as it now stands.
//
// The assignee and the time are read here and written straight back rather
// than taken from the caller. A completion row holds all three columns, so a
// tick that posted only `done` would blank the name someone had reassigned the
// task to in Daily View — the panel has no field for either, so the only safe
// thing for it to send is nothing and let this preserve what is already there.
function setTodayTaskDone({ taskId, done, now = new Date() } = {}) {
  const id = String(taskId || '').trim();
  if (!id) throw bad('A task id is required.');
  if (typeof done !== 'boolean') throw bad('done must be true or false.');

  const weekKey = getIsoWeekKey(now);
  const row = select('scheduled_task', { task_id: id })[0];
  if (!row) {
    const err = new Error('That task is no longer in the schedule.');
    err.status = 404;
    throw err;
  }
  const task = toTask(row, select('task_completion', { week_key: weekKey, task_id: id })[0]);
  setTaskStatus({ weekKey, taskId: id, done, assignedTo: task.assignedTo, time: task.time });
  return getTodayTasks(now);
}

// Hands one of today's tasks to someone else, for this week only — the same
// override Daily View's assignee box writes, so next week the cadence's own
// name comes back. The tick and the time are read and written straight back
// for the same reason the tick preserves the name: the row holds all three.
function reassignTodayTask({ taskId, assignedTo, now = new Date() } = {}) {
  const id = String(taskId || '').trim();
  if (!id) throw bad('A task id is required.');
  if (typeof assignedTo !== 'string') throw bad('assignedTo must be a name.');
  const name = assignedTo.trim().slice(0, 40);
  if (!name) throw bad('Give the task to someone — a name is required.');

  const weekKey = getIsoWeekKey(now);
  const row = select('scheduled_task', { task_id: id })[0];
  if (!row) {
    const err = new Error('That task is no longer in the schedule.');
    err.status = 404;
    throw err;
  }
  const task = toTask(row, select('task_completion', { week_key: weekKey, task_id: id })[0]);
  setTaskStatus({ weekKey, taskId: id, done: task.done, assignedTo: name, time: task.time });
  return getTodayTasks(now);
}

export { getTodayTasks, setTodayTaskDone, reassignTodayTask };
