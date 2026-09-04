import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_RECURRING_SCHEDULE,
  fetchRecurringSchedule,
  fetchWeekState,
  getAssigneeNames,
  getEffectiveTaskState,
  getIsoWeekKey,
  isMarketingTask,
  saveTaskState,
  type RecurringDay,
  type RecurringTaskDef,
  type RecurringTaskState,
  type RecurringWeekState,
} from './recurringSchedule';

type SprintItem = {
  id: string;
  status: string | null;
  assignedTo: string;
  day: string | null;
  isDraft: boolean;
  title: string;
  number: number | null;
  url: string | null;
  assignees: string[];
};

const STATUS_COLUMNS = ['Backlog', 'In Progress', 'Done'];

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.statusText || 'Request failed');
  return data as T;
}

// A focused "what's left today" view: pick a day and a person, see only what's still pending.
// Shares the same week state as This Week's Tasks — checking something off here checks it off there too.
// Also pulls in Sprint Board cards scheduled for that same day (via the board's own "Day" field),
// so the recurring weekly cadence and the sprint's day-by-day plan show up in one place.
const DailyView: React.FC = () => {
  const weekKey = useMemo(() => getIsoWeekKey(new Date()), []);
  const todayName = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long' }), []);

  // Task list starts as the hardcoded fallback so the page renders instantly, then gets
  // replaced by the live CSV version once fetchRecurringSchedule() resolves — that's the
  // "refresh from the sheet" behavior: every time this page loads, it re-reads the CSV.
  const [schedule, setSchedule] = useState<RecurringDay[]>(DEFAULT_RECURRING_SCHEDULE);
  const [weekState, setWeekState] = useState<RecurringWeekState>({});
  const [selectedDay, setSelectedDay] = useState(
    DEFAULT_RECURRING_SCHEDULE.some((d) => d.day === todayName) ? todayName : DEFAULT_RECURRING_SCHEDULE[0].day,
  );
  const [selectedAssignee, setSelectedAssignee] = useState('all');

  const [sprintItems, setSprintItems] = useState<SprintItem[]>([]);
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);
  const [sprintLoading, setSprintLoading] = useState(false);
  const [sprintError, setSprintError] = useState('');
  const [taskStatusError, setTaskStatusError] = useState('');
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchRecurringSchedule().then(setSchedule);
  }, []);

  // Re-fetches from the server every time the week changes (including on a fresh page
  // load) — a week nobody has touched yet just comes back empty, which is the "starts
  // fresh" behavior for a new week.
  useEffect(() => {
    fetchWeekState(weekKey).then(setWeekState);
  }, [weekKey]);

  const loadSprintItems = useCallback(async () => {
    setSprintLoading(true);
    setSprintError('');
    try {
      const status = await fetchJSON<{ configured: boolean }>('/api/github/status');
      setGithubConfigured(status.configured);
      if (status.configured) {
        const board = await fetchJSON<{ items: SprintItem[] }>('/api/github/sprint-board');
        setSprintItems(board.items);
      }
    } catch (err) {
      setSprintError(String((err as Error).message || err));
    } finally {
      setSprintLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSprintItems();
  }, [loadSprintItems]);

  const toggleDone = (taskId: string) => {
    const previous = getEffectiveTaskState(schedule, weekState, taskId);
    const next = { ...previous, done: !previous.done };
    setTaskStatusError('');
    setWeekState((current) => ({ ...current, [taskId]: next }));
    saveTaskState(weekKey, taskId, next).catch((err) => {
      setWeekState((current) => ({ ...current, [taskId]: previous }));
      setTaskStatusError(`Couldn't save that — ${String((err as Error).message || err)}`);
    });
  };

  const handleSprintStatusChange = async (item: SprintItem, nextStatus: string) => {
    const previous = item.status;
    setSprintItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: nextStatus } : it)));
    setSavingIds((current) => ({ ...current, [item.id]: true }));
    try {
      await fetchJSON(`/api/github/sprint-board/${encodeURIComponent(item.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (err) {
      setSprintItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: previous } : it)));
      setSprintError(`Couldn't update "${item.title}": ${String((err as Error).message || err)}`);
    } finally {
      setSavingIds((current) => ({ ...current, [item.id]: false }));
    }
  };

  const assigneeNames = useMemo(() => getAssigneeNames(schedule, weekState), [schedule, weekState]);

  const scheduledTasks = schedule.find((d) => d.day === selectedDay)?.tasks || [];
  const visibleTasks = scheduledTasks
    .map((task) => ({ task, state: getEffectiveTaskState(schedule, weekState, task.id) }))
    .filter(
      ({ state }) =>
        selectedAssignee === 'all' || state.assignedTo.toLowerCase() === selectedAssignee.toLowerCase(),
    );

  // The content cadence runs on its own rhythm and usually its own person, so it
  // gets its own card rather than sitting between the kitchen and procurement
  // tasks — a posting day is easy to lose in a list you scan for what to cook.
  const opsTasks = visibleTasks.filter(({ task }) => !isMarketingTask(task));
  const marketingTasks = visibleTasks.filter(({ task }) => isMarketingTask(task));

  const sprintItemsForDay = sprintItems
    .filter((item) => item.day === selectedDay)
    .filter(
      ({ assignedTo, assignees }) =>
        selectedAssignee === 'all' ||
        assignedTo.toLowerCase() === selectedAssignee.toLowerCase() ||
        assignees.some((a) => a.toLowerCase() === selectedAssignee.toLowerCase()),
    );

  // Both cards render the same row; only the empty-state wording differs.
  const renderTaskList = (
    entries: { task: RecurringTaskDef; state: RecurringTaskState }[],
    kind: 'recurring' | 'marketing',
  ) => {
    if (entries.length === 0) {
      const what = kind === 'marketing' ? 'marketing tasks' : 'recurring tasks';
      return (
        <div className="empty-state">
          <div className="empty-state-icon">{kind === 'marketing' ? '📣' : '🗓️'}</div>
          <h3>Nothing scheduled</h3>
          <p>
            {selectedAssignee === 'all'
              ? `No ${what} for ${selectedDay}.`
              : `${selectedAssignee} has no ${what} for ${selectedDay}.`}
          </p>
        </div>
      );
    }
    return (
      <div className="group-list">
        {entries.map(({ task, state }) => (
          <div className="group-item-row" key={task.id}>
            <div className="group-item">
              <input type="checkbox" checked={state.done} onChange={() => toggleDone(task.id)} />
              <label className={state.done ? 'daily-view-task-done' : ''}>{task.label}</label>
            </div>
            <div className="daily-view-meta">
              <span className="daily-view-badge daily-view-badge-time">{state.time || '—'}</span>
              <span className="daily-view-badge">{state.assignedTo || 'Unassigned'}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Daily View</h1>
        <p>What's still left to do — pick a day and, optionally, a person.</p>
      </div>

      <div className="wizard-shell">
        <div className="wizard-card">
          <div className="daily-view-filters">
            <div className="daily-view-day-tabs">
              {schedule.map(({ day }) => (
                <button
                  key={day}
                  type="button"
                  className={`tab-button${day === selectedDay ? ' active' : ''}`}
                  onClick={() => setSelectedDay(day)}
                >
                  {day}
                  {day === todayName ? ' · Today' : ''}
                </button>
              ))}
            </div>

            <select
              className="daily-view-select"
              value={selectedAssignee}
              onChange={(event) => setSelectedAssignee(event.target.value)}
              aria-label="Filter by assignee"
            >
              <option value="all">Everyone</option>
              {assigneeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {taskStatusError && <p className="chat-error">{taskStatusError}</p>}

          {renderTaskList(opsTasks, 'recurring')}
        </div>

        <div className="wizard-card">
          <div className="daily-view-section-header">
            <h2>Marketing — {selectedDay}</h2>
          </div>
          <p className="inv-section-hint">
            The weekly content cadence: what goes out today and where. Same checklist as the rest — ticking
            it here ticks it off in This Week's Tasks too.
          </p>

          {renderTaskList(marketingTasks, 'marketing')}
        </div>

        {githubConfigured && (
          <div className="wizard-card">
            <div className="daily-view-section-header">
              <h2>Sprint tasks — {selectedDay}</h2>
              <button type="button" className="secondary-button small" onClick={loadSprintItems} disabled={sprintLoading}>
                {sprintLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <p className="inv-section-hint">
              Pulled from the Sprint Board's "Day" field — set it there (or here) to plan which day each card
              gets worked on.
            </p>

            {sprintError && <p className="chat-error">{sprintError}</p>}

            {!sprintLoading && sprintItemsForDay.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🗓️</div>
                <h3>Nothing scheduled</h3>
                <p>
                  {selectedAssignee === 'all'
                    ? `No sprint cards are set to ${selectedDay} yet.`
                    : `${selectedAssignee} has no sprint cards set to ${selectedDay}.`}
                </p>
              </div>
            ) : (
              <div className="group-list">
                {sprintItemsForDay.map((item) => (
                  <div className="group-item-row" key={item.id}>
                    <div className="group-item">
                      <label>
                        {item.title}
                        {item.url && (
                          <>
                            {' '}
                            <a href={item.url} target="_blank" rel="noreferrer" className="sprint-card-link">
                              #{item.number} ↗
                            </a>
                          </>
                        )}
                      </label>
                    </div>
                    <div className="daily-view-meta">
                      <span className="daily-view-badge">{item.assignedTo || item.assignees[0] || 'Unassigned'}</span>
                      <select
                        className="daily-view-status-select"
                        value={item.status || 'Backlog'}
                        disabled={savingIds[item.id]}
                        onChange={(event) => handleSprintStatusChange(item, event.target.value)}
                      >
                        {STATUS_COLUMNS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DailyView;
