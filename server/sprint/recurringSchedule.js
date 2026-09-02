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
import { select } from '../core/repo.js';

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

  // rowid order, which is the order the schedule was written in — the sheet
  // listed each day's tasks in the order they happen, and sorting by task_id
  // or time would lose the ones with no time set.
  select('scheduled_task', {}, { orderBy: 'rowid' }).forEach((row) => {
    const day = (row.day || '').trim();
    const label = (row.task || '').trim();
    if (!day || !label || !row.task_id) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id: row.task_id,
      label,
      defaultTime: displayTime(row.time_of_day),
      defaultAssignee: row.assigned_to || '',
    });
  });

  return Array.from(byDay.entries()).map(([day, tasks]) => ({ day, tasks }));
}

export { getRecurringSchedule };
