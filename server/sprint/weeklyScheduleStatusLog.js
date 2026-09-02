// Daily View / "This Week's Tasks" per-task completion — one row per
// (week_key, task_id) in `task_completion`, shared rather than kept in
// localStorage, same spirit as server/ops/b2c/weekendStatus.js, so the
// checklist is visible to whoever opens the dashboard next and not just to
// the browser that clicked it.
//
// week_key is the ISO week (e.g. "2026-W33") computed by the frontend's
// getIsoWeekKey(). A task is only written here the first time someone touches
// it in a given week — untouched tasks fall back to the schedule's defaults
// (see getTaskDefaultState in recurringSchedule.ts). That's what gives every
// new week a fresh start automatically: there's nothing to reset, last week's
// rows just stay behind as a log and a new week's tasks get their own new
// rows the first time they're touched.
//
// Migrated off Tasks/weekly_schedule_status_log.csv. task_id is a foreign key
// to `scheduled_task` with ON DELETE CASCADE, so dropping a task from the
// cadence takes its completion history with it rather than leaving rows
// pinned to an id nothing resolves.
import { select, upsert } from '../core/repo.js';

// Returns every logged task state for one week, keyed by task_id — the shape
// DailyView's RecurringWeekState already expects.
function getWeekStatus({ weekKey }) {
  if (!weekKey) {
    const err = new Error('weekKey is required.');
    err.status = 400;
    throw err;
  }
  const weekState = {};
  select('task_completion', { week_key: weekKey }).forEach((row) => {
    weekState[row.task_id] = {
      done: !!row.done,
      assignedTo: row.assigned_to || '',
      time: row.time_of_day || '',
    };
  });
  return { weekState };
}

// Upserts one task's state for one week. A week/task pair that hasn't been
// saved before creates a new row — that's the "new week starts fresh, but
// still gets logged" behavior; nothing is ever deleted.
function setTaskStatus({ weekKey, taskId, done, assignedTo, time }) {
  if (!weekKey || !taskId) {
    const err = new Error('weekKey and taskId are required.');
    err.status = 400;
    throw err;
  }
  const updatedAt = new Date().toISOString();
  upsert('task_completion', ['week_key', 'task_id'], {
    week_key: weekKey,
    task_id: taskId,
    done: done ? 1 : 0,
    assigned_to: assignedTo || null,
    time_of_day: time || null,
    updated_at: updatedAt,
  });
  return { weekKey, taskId, done: !!done, assignedTo: assignedTo || '', time: time || '', updatedAt };
}

export { getWeekStatus, setTaskStatus };
