// Shared schedule + persistence for the mandatory Mon–Fri cadence.
// The task LIST (which tasks exist, default time/assignee) is read live from
// daily_view.csv in the knowledge-base repo via fetchRecurringSchedule() — edit that
// sheet and reload Daily View to see the change. DEFAULT_RECURRING_SCHEDULE below is
// only a fallback for when the server/CSV isn't reachable.
// The per-week completion/edits (done, assignee overrides, time overrides) stay in
// localStorage regardless of where the task list came from.

export const RECURRING_STORAGE_KEY = 'recurring-weekly-tasks-v1';
export const RECURRING_WEEKS_TO_KEEP = 4;

export type RecurringTaskDef = { id: string; label: string; defaultTime: string; defaultAssignee: string };
export type RecurringDay = { day: string; tasks: RecurringTaskDef[] };

export type RecurringTaskState = { done: boolean; assignedTo: string; time: string };
export type RecurringWeekState = Record<string, RecurringTaskState>;

// Weekend prep/order execution lives in the Kitchen Prep Automation section,
// so this stays scoped to the work week. Kept in sync with daily_view.csv by hand
// as a fallback for when the CSV can't be read.
export const DEFAULT_RECURRING_SCHEDULE: RecurringDay[] = [
  {
    day: 'Monday',
    tasks: [
      { id: 'monday-review-weekend-sales-orders', label: 'Review weekend sales & orders', defaultTime: '9:00 AM', defaultAssignee: 'Adarsh' },
      {
        id: 'monday-sprint-retro-carry-over-unfinished-tasks',
        label: 'Sprint retro — carry over unfinished tasks',
        defaultTime: '10:00 AM',
        defaultAssignee: 'Adarsh',
      },
    ],
  },
  {
    day: 'Tuesday',
    tasks: [
      { id: 'tuesday-reddit-automation-post', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh' },
      { id: 'tuesday-linkedin-post', label: 'LinkedIn post', defaultTime: '12:00 PM', defaultAssignee: 'Adarsh' },
    ],
  },
  { day: 'Wednesday', tasks: [] },
  {
    day: 'Thursday',
    tasks: [
      { id: 'thursday-reddit-automation-post', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh' },
      { id: 'thursday-linkedin-post', label: 'LinkedIn post', defaultTime: '12:00 PM', defaultAssignee: 'Adarsh' },
      {
        id: 'thursday-inventory-check-place-order',
        label: 'Inventory check & place order',
        defaultTime: '2:00 PM',
        defaultAssignee: 'Sowmya',
      },
    ],
  },
  {
    day: 'Friday',
    tasks: [
      { id: 'friday-order-consolidation', label: 'Order consolidation', defaultTime: '10:00 AM', defaultAssignee: 'Adarsh' },
      {
        id: 'friday-place-order-to-bread-time-stories',
        label: 'Place order to Bread Time Stories',
        defaultTime: '11:00 AM',
        defaultAssignee: 'Adarsh',
      },
      { id: 'friday-make-bbq-sauce', label: 'Make BBQ sauce', defaultTime: '12:00 PM', defaultAssignee: 'Sowmya' },
      { id: 'friday-make-sour-cream', label: 'Make sour cream', defaultTime: '1:00 PM', defaultAssignee: 'Sowmya' },
    ],
  },
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

const readAllWeeks = (): Record<string, RecurringWeekState> => {
  const stored = window.localStorage.getItem(RECURRING_STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) || {};
  } catch {
    return {};
  }
};

export const loadWeekState = (weekKey: string): RecurringWeekState => readAllWeeks()[weekKey] || {};

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

export const saveWeekState = (weekKey: string, weekState: RecurringWeekState): void => {
  const allWeeks = readAllWeeks();
  allWeeks[weekKey] = weekState;
  // Keep only the most recent weeks so this doesn't grow forever.
  const trimmed = Object.fromEntries(
    Object.entries(allWeeks)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, RECURRING_WEEKS_TO_KEEP),
  );
  window.localStorage.setItem(RECURRING_STORAGE_KEY, JSON.stringify(trimmed));
};
