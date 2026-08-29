// Shared schedule + persistence for the mandatory weekly cadence (all 7 days).
// The task LIST (which tasks exist, default time/assignee) is read live from
// schedule.csv in the knowledge-base repo via fetchRecurringSchedule() — edit
// that sheet and reload Daily View to see the change. DEFAULT_RECURRING_SCHEDULE below
// is only a fallback for when the server/CSV isn't reachable.
// The per-week completion/edits (done, assignee overrides, time overrides) are logged
// server-side in weekly_schedule_status_log.csv (see server/sprint/weeklyScheduleStatusLog.js), keyed
// by ISO week — so the checklist is shared across whoever opens the dashboard, and a new
// week has no rows yet and simply starts fresh while past weeks stay behind as a log.

export type RecurringTaskDef = { id: string; label: string; defaultTime: string; defaultAssignee: string };
export type RecurringDay = { day: string; tasks: RecurringTaskDef[] };

export type RecurringTaskState = { done: boolean; assignedTo: string; time: string };
export type RecurringWeekState = Record<string, RecurringTaskState>;

// Weekend order-execution planning still lives in its own Kitchen Prep Automation
// planner — this is just the mandatory checklist cadence, which now spans all 7 days.
// Kept in sync with schedule.csv by hand as a fallback for when the CSV can't be
// read. Ids match that CSV's task_id (WS-xx) column so a temporary CSV outage doesn't
// switch which status-log key a task's done state gets saved/read under.
export const DEFAULT_RECURRING_SCHEDULE: RecurringDay[] = [
  {
    day: 'Monday',
    tasks: [
      { id: 'WS-01', label: 'Review weekend sales & orders', defaultTime: '9:00 AM', defaultAssignee: 'Adarsh' },
      {
        id: 'WS-02',
        label: 'Sprint retro — carry over unfinished tasks',
        defaultTime: '10:00 AM',
        defaultAssignee: 'Adarsh',
      },
    ],
  },
  {
    day: 'Tuesday',
    tasks: [
      { id: 'WS-03', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh' },
      { id: 'WS-04', label: 'LinkedIn post', defaultTime: '12:00 PM', defaultAssignee: 'Adarsh' },
    ],
  },
  { day: 'Wednesday', tasks: [] },
  {
    day: 'Thursday',
    tasks: [
      { id: 'WS-05', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh' },
      { id: 'WS-06', label: 'LinkedIn post', defaultTime: '12:00 PM', defaultAssignee: 'Adarsh' },
      {
        id: 'WS-07',
        label: 'Inventory check & place order',
        defaultTime: '2:00 PM',
        defaultAssignee: 'Sowmya',
      },
    ],
  },
  {
    day: 'Friday',
    tasks: [
      { id: 'WS-08', label: 'Order consolidation', defaultTime: '10:00 AM', defaultAssignee: 'Adarsh' },
      {
        id: 'WS-09',
        label: 'Place order to Bread Time Stories',
        defaultTime: '11:00 AM',
        defaultAssignee: 'Adarsh',
      },
      { id: 'WS-10', label: 'Make BBQ sauce', defaultTime: '12:00 PM', defaultAssignee: 'Sowmya' },
      { id: 'WS-11', label: 'Make sour cream', defaultTime: '1:00 PM', defaultAssignee: 'Sowmya' },
    ],
  },
  { day: 'Saturday', tasks: [] },
  { day: 'Sunday', tasks: [] },
];

// Fetches the live task list from the CSV-backed endpoint; falls back to the hardcoded
// default (and logs why) if the server or the CSV isn't reachable, so the page still works.
export async function fetchRecurringSchedule(): Promise<RecurringDay[]> {
  try {
    const resp = await fetch('/api/recurring-schedule');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !Array.isArray(data.schedule)) {
      throw new Error(data.error || resp.statusText || 'Malformed response');
    }
    return data.schedule as RecurringDay[];
  } catch (err) {
    console.warn('Falling back to the built-in recurring schedule —', (err as Error).message || err);
    return DEFAULT_RECURRING_SCHEDULE;
  }
}

export const getAllTasks = (schedule: RecurringDay[]): RecurringTaskDef[] => schedule.flatMap((day) => day.tasks);

// ISO week key (e.g. "2026-W33") so the checklist resets automatically each week
// without needing a manual "start new week" action.
export const getIsoWeekKey = (date: Date): string => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};

export const getTaskDefaultState = (schedule: RecurringDay[], taskId: string): RecurringTaskState => {
  const task = getAllTasks(schedule).find((t) => t.id === taskId);
  return {
    done: false,
    assignedTo: task?.defaultAssignee || '',
    time: task?.defaultTime || '',
  };
};

// Fetches this week's logged task states from the server. A week nobody has touched
// yet (including a brand-new week) comes back empty — callers fall back to
// getTaskDefaultState/getEffectiveTaskState below, which is the "starts fresh" behavior.
export async function fetchWeekState(weekKey: string): Promise<RecurringWeekState> {
  try {
    const resp = await fetch(`/api/recurring-schedule/status?week=${encodeURIComponent(weekKey)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || resp.statusText || 'Malformed response');
    return (data.weekState as RecurringWeekState) || {};
  } catch (err) {
    console.warn(`Couldn't load this week's task status —`, (err as Error).message || err);
    return {};
  }
}

export const getEffectiveTaskState = (
  schedule: RecurringDay[],
  weekState: RecurringWeekState,
  taskId: string,
): RecurringTaskState => weekState[taskId] || getTaskDefaultState(schedule, taskId);

// Unique, non-empty assignee names currently in play this week (defaults + any edits), for filter dropdowns.
export const getAssigneeNames = (schedule: RecurringDay[], weekState: RecurringWeekState): string[] => {
  const names = new Set<string>();
  getAllTasks(schedule).forEach((task) => {
    const name = getEffectiveTaskState(schedule, weekState, task.id).assignedTo.trim();
    if (name) names.add(name);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
};

// Upserts one task's state for one week on the server. The first save for a given
// (week, task) pair creates that week's row — nothing to reset when a new week starts.
export async function saveTaskState(weekKey: string, taskId: string, state: RecurringTaskState): Promise<void> {
  const resp = await fetch('/api/recurring-schedule/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ week: weekKey, taskId, done: state.done, assignedTo: state.assignedTo, time: state.time }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.statusText || 'Request failed');
}
