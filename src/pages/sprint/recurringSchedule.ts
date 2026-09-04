// Shared schedule + persistence for the mandatory weekly cadence (all 7 days).
// The task LIST (which tasks exist, default time/assignee) is read live from
// the `scheduled_task` table via fetchRecurringSchedule() — add a row there and
// reload Daily View to see it. (It used to be schedule.csv in the knowledge-base
// repo; the CSVs stopped being the source of truth at the SQLite cutover, and
// server/sprint/recurringSchedule.js is what reads the table now.)
// DEFAULT_RECURRING_SCHEDULE below is only a fallback for when the server isn't
// reachable.
// The per-week completion/edits (done, assignee overrides, time overrides) are logged
// server-side in weekly_schedule_status_log.csv (see server/sprint/weeklyScheduleStatusLog.js), keyed
// by ISO week — so the checklist is shared across whoever opens the dashboard, and a new
// week has no rows yet and simply starts fresh while past weeks stay behind as a log.

// category is scheduled_task.category — Daily View splits 'Marketing' out into
// its own card, and everything else stays in the ops list.
export type RecurringTaskDef = {
  id: string;
  label: string;
  defaultTime: string;
  defaultAssignee: string;
  category?: string;
};

export const MARKETING_CATEGORY = 'Marketing';

export const isMarketingTask = (task: RecurringTaskDef): boolean =>
  (task.category || '').trim().toLowerCase() === MARKETING_CATEGORY.toLowerCase();
export type RecurringDay = { day: string; tasks: RecurringTaskDef[] };

export type RecurringTaskState = { done: boolean; assignedTo: string; time: string };
export type RecurringWeekState = Record<string, RecurringTaskState>;

// Weekend order-execution planning still lives in its own Kitchen Prep Automation
// planner — this is just the mandatory checklist cadence, which now spans all 7 days.
// Kept in sync with `scheduled_task` by hand, as a fallback for when the server
// can't be reached. Ids match that table's task_id (WS-xx) column so a temporary
// outage doesn't switch which status-log key a task's done state gets saved/read
// under. (WS-04 and WS-06 are absent from both: retired, and their ids are not
// reused, so a status-log row from before they went stays attached to nothing
// rather than to a different task.)
export const DEFAULT_RECURRING_SCHEDULE: RecurringDay[] = [
  {
    day: 'Monday',
    tasks: [
      { id: 'WS-01', label: 'Review weekend sales & orders', defaultTime: '9:00 AM', defaultAssignee: 'Adarsh', category: 'Review' },
      {
        id: 'WS-02',
        label: 'Sprint retro — carry over unfinished tasks',
        defaultTime: '10:00 AM',
        defaultAssignee: 'Adarsh',
        category: 'Review',
      },
      {
        id: 'WS-17',
        label: 'Social posts - order delivered reel (IG, FB, WhatsApp, YouTube, Story)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
    ],
  },
  {
    day: 'Tuesday',
    tasks: [
      { id: 'WS-03', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh', category: 'Marketing' },
      {
        id: 'WS-18',
        label: 'Poster content post (Instagram, YouTube)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
    ],
  },
  {
    day: 'Wednesday',
    tasks: [
      {
        id: 'WS-19',
        label: 'Social posts - CTA to place orders (IG, FB, WhatsApp, YouTube, Story)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
      {
        id: 'WS-20',
        label: 'Community posts - LinkedIn, WhatsApp community, Reddit community',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
    ],
  },
  {
    day: 'Thursday',
    tasks: [
      { id: 'WS-05', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh', category: 'Marketing' },
      {
        id: 'WS-07',
        label: 'Inventory check & place order',
        defaultTime: '2:00 PM',
        defaultAssignee: 'Sowmya',
        category: 'Procurement',
      },
      {
        id: 'WS-21',
        label: 'Social posts - CTA to place orders (IG, FB, WhatsApp, YouTube, Story)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
    ],
  },
  {
    day: 'Friday',
    tasks: [
      { id: 'WS-08', label: 'Order consolidation', defaultTime: '10:00 AM', defaultAssignee: 'Adarsh', category: 'Procurement' },
      {
        id: 'WS-09',
        label: 'Place order to Bread Time Stories',
        defaultTime: '11:00 AM',
        defaultAssignee: 'Adarsh',
        category: 'Procurement',
      },
      { id: 'WS-10', label: 'Make BBQ sauce', defaultTime: '12:00 PM', defaultAssignee: 'Sowmya', category: 'Prep' },
      { id: 'WS-11', label: 'Make sour cream', defaultTime: '1:00 PM', defaultAssignee: 'Sowmya', category: 'Prep' },
      // No default time on these two — the table has none either. They happen
      // when the ones above are done, not at a clock time.
      { id: 'WS-13', label: 'Make coleslaw', defaultTime: '', defaultAssignee: 'Adarsh', category: 'Prep' },
      { id: 'WS-14', label: 'Place meat order', defaultTime: '', defaultAssignee: 'Adarsh', category: 'Procurement' },
      { id: 'WS-22', label: 'Reel content', defaultTime: '', defaultAssignee: 'Adarsh', category: 'Marketing' },
    ],
  },
  // Service days. One task each, covering both slots: pack the day's orders and
  // keep each one's live tracking current as it moves. 9:00 AM is a starting
  // point rather than a fixture — Daily View takes a per-week time override.
  {
    day: 'Saturday',
    tasks: [
      // Salsa verde and the rest of the sides are made on the day, not Friday.
      { id: 'WS-12', label: 'Make salsa verde and sides', defaultTime: '', defaultAssignee: 'Sowmya', category: 'Prep' },
      {
        id: 'WS-15',
        label: 'Prepare orders & update live tracking',
        defaultTime: '9:00 AM',
        defaultAssignee: 'Sowmya',
        category: 'Fulfilment',
      },
      {
        id: 'WS-23',
        label: 'Social posts - BTS (IG, FB, WhatsApp, YouTube, Story)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
    ],
  },
  {
    day: 'Sunday',
    tasks: [
      {
        id: 'WS-16',
        label: 'Prepare orders & update live tracking',
        defaultTime: '9:00 AM',
        defaultAssignee: 'Sowmya',
        category: 'Fulfilment',
      },
      {
        id: 'WS-24',
        label: 'Social posts - BTS (IG, FB, WhatsApp, YouTube, Story)',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
      {
        id: 'WS-25',
        label: 'Community posts - LinkedIn, WhatsApp community, Reddit community',
        defaultTime: '',
        defaultAssignee: 'Adarsh',
        category: 'Marketing',
      },
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

// ---- Editing the cadence ------------------------------------------------
//
// Daily View's edit mode writes to `scheduled_task` through these — the task
// list itself, not this week's ticks. Every one answers with the whole
// schedule as it now stands (a move renumbers a day, an add lands at the
// bottom of one), so callers replace their schedule state with what comes back
// rather than trying to reproduce the new ordering locally.
async function scheduleWrite(url: string, options: RequestInit): Promise<RecurringDay[]> {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !Array.isArray(data.schedule)) {
    throw new Error(data.error || resp.statusText || 'Request failed');
  }
  return data.schedule as RecurringDay[];
}

const asJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export type NewRecurringTask = {
  day: string;
  label: string;
  time?: string;
  assignedTo?: string;
  category?: string;
};

export const createScheduleTask = (task: NewRecurringTask): Promise<RecurringDay[]> =>
  scheduleWrite('/api/recurring-schedule/tasks', asJson('POST', task));

// A patch: fields left out keep whatever the table already has, so renaming a
// task can't quietly blank the time it said nothing about.
export const updateScheduleTask = (
  taskId: string,
  patch: { label?: string; time?: string; assignedTo?: string; category?: string },
): Promise<RecurringDay[]> =>
  scheduleWrite(`/api/recurring-schedule/tasks/${encodeURIComponent(taskId)}`, asJson('PATCH', patch));

// Retires the task and, through the database's cascade, the completion history
// hanging off its id. The id is never reused, so nothing later inherits it.
export const deleteScheduleTask = (taskId: string): Promise<RecurringDay[]> =>
  scheduleWrite(`/api/recurring-schedule/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });

// `index` is the position among the target day's *other* tasks — the moved one
// taken out first, which is what a drag is. Omit `day` to reorder within the
// task's current day; omit `index` to drop it at the end of the day.
export const moveScheduleTask = (
  taskId: string,
  target: { day?: string; index?: number },
): Promise<RecurringDay[]> =>
  scheduleWrite(`/api/recurring-schedule/tasks/${encodeURIComponent(taskId)}/move`, asJson('POST', target));

// The categories already in play, for the edit form's suggestions. Free text in
// the table, so this offers what exists rather than a fixed list — 'Marketing'
// always included, since it's the one Daily View gives its own card to and a
// schedule with no marketing rows yet still needs to be able to grow one.
export const getCategoryNames = (schedule: RecurringDay[]): string[] => {
  const names = new Set<string>([MARKETING_CATEGORY]);
  getAllTasks(schedule).forEach((task) => {
    const name = (task.category || '').trim();
    if (name) names.add(name);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
};
