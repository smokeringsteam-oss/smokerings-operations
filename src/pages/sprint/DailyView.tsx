import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createScheduleTask,
  DEFAULT_RECURRING_SCHEDULE,
  deleteScheduleTask,
  fetchRecurringSchedule,
  fetchWeekState,
  getAllTasks,
  getAssigneeNames,
  getCategoryNames,
  getEffectiveTaskState,
  getIsoWeekKey,
  isMarketingTask,
  MARKETING_CATEGORY,
  moveScheduleTask,
  saveTaskState,
  updateScheduleTask,
  type RecurringDay,
  type RecurringTaskDef,
  type RecurringTaskState,
  type RecurringWeekState,
} from './recurringSchedule';
import PushToggle from './PushToggle';

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

// The four editable columns of a scheduled_task row. Held per task while
// someone is typing, so a keystroke isn't a round trip; committed on blur.
type TaskDraft = { label: string; time: string; assignedTo: string; category: string };

const STATUS_COLUMNS = ['Backlog', 'In Progress', 'Done'];

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.statusText || 'Request failed');
  return data as T;
}

const errorText = (err: unknown) => String((err as Error).message || err);

// A focused "what's left today" view: pick a day and a person, see only what's still pending.
// Shares the same week state as This Week's Tasks — checking something off here checks it off there too.
// Also pulls in Sprint Board cards scheduled for that same day (via the board's own "Day" field),
// so the recurring weekly cadence and the sprint's day-by-day plan show up in one place.
//
// Edit mode turns the same list into the schedule editor: the rows become
// fields, and a task can be dragged up its day or dropped on another day's tab.
// Two different things get written here and they are worth keeping apart — a
// tick is this week only (task_completion), an edit changes the cadence itself
// (scheduled_task) and so every week after this one too.
const DailyView: React.FC = () => {
  const weekKey = useMemo(() => getIsoWeekKey(new Date()), []);
  const todayName = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long' }), []);

  // Task list starts as the hardcoded fallback so the page renders instantly, then gets
  // replaced by the live version once fetchRecurringSchedule() resolves — that's the
  // "refresh from the table" behavior: every time this page loads, it re-reads it.
  const [schedule, setSchedule] = useState<RecurringDay[]>(DEFAULT_RECURRING_SCHEDULE);
  const [weekState, setWeekState] = useState<RecurringWeekState>({});
  const [selectedDay, setSelectedDay] = useState(
    DEFAULT_RECURRING_SCHEDULE.some((d) => d.day === todayName) ? todayName : DEFAULT_RECURRING_SCHEDULE[0].day,
  );
  const [selectedAssignee, setSelectedAssignee] = useState('all');

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [newTaskLabels, setNewTaskLabels] = useState<Record<string, string>>({});
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTaskId, setDropTaskId] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  // A row is only draggable once the grip is held. Marked draggable the whole
  // time, the row swallows click-and-drag inside its own text fields — you'd
  // pick the task up instead of selecting the word you meant to retype.
  const [grabbedId, setGrabbedId] = useState<string | null>(null);

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
      setSprintError(errorText(err));
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
      setTaskStatusError(`Couldn't save that — ${errorText(err)}`);
    });
  };

  // ---- Editing the cadence ----------------------------------------------

  // Every schedule write goes through here. The server answers with the whole
  // schedule (a move renumbers a day, an add lands at the bottom of one), so
  // the page adopts that rather than guessing at the new order, and a failure
  // re-reads it rather than leaving the screen showing a change that never
  // landed.
  const applyScheduleChange = async (
    run: () => Promise<RecurringDay[]>,
    after?: (next: RecurringDay[]) => void,
  ) => {
    setScheduleError('');
    setScheduleBusy(true);
    try {
      const next = await run();
      setSchedule(next);
      after?.(next);
    } catch (err) {
      setScheduleError(`Couldn't save that — ${errorText(err)}`);
      fetchRecurringSchedule().then(setSchedule);
    } finally {
      setScheduleBusy(false);
    }
  };

  // A task already ticked this week has its time and assignee copied into
  // task_completion, so changing the schedule's defaults would otherwise leave
  // the row showing the old ones until next week. Those per-week values are
  // only ever captured defaults — nothing in the UI sets them independently —
  // so following the edit is the right move.
  const syncWeekState = (next: RecurringDay[], taskId: string) => {
    const logged = weekState[taskId];
    if (!logged) return;
    const def = getAllTasks(next).find((task) => task.id === taskId);
    if (!def) return;
    if (def.defaultAssignee === logged.assignedTo && def.defaultTime === logged.time) return;
    const updated = { done: logged.done, assignedTo: def.defaultAssignee, time: def.defaultTime };
    setWeekState((current) => ({ ...current, [taskId]: updated }));
    saveTaskState(weekKey, taskId, updated).catch((err) => {
      setTaskStatusError(`Couldn't carry that into this week's list — ${errorText(err)}`);
    });
  };

  const draftFor = (task: RecurringTaskDef): TaskDraft =>
    drafts[task.id] || {
      label: task.label,
      time: task.defaultTime,
      assignedTo: task.defaultAssignee,
      category: task.category || '',
    };

  const setDraftField = (task: RecurringTaskDef, field: keyof TaskDraft, value: string) => {
    setDrafts((current) => ({ ...current, [task.id]: { ...draftFor(task), [field]: value } }));
  };

  const clearDraft = (taskId: string) =>
    setDrafts((current) => {
      const { [taskId]: _dropped, ...rest } = current;
      return rest;
    });

  // Commits on blur, and only when the value actually changed — tabbing across
  // a row shouldn't fire four writes. The draft is dropped afterwards so the
  // field picks up whatever the server normalised it to ("9am" comes back as
  // "9:00 AM").
  const commitField = (task: RecurringTaskDef, field: keyof TaskDraft) => {
    const draft = draftFor(task);
    const current: TaskDraft = {
      label: task.label,
      time: task.defaultTime,
      assignedTo: task.defaultAssignee,
      category: task.category || '',
    };
    if (draft[field].trim() === current[field].trim()) {
      clearDraft(task.id);
      return;
    }
    if (field === 'label' && !draft.label.trim()) {
      setScheduleError('A task needs a name.');
      clearDraft(task.id);
      return;
    }
    applyScheduleChange(
      () => updateScheduleTask(task.id, { [field]: draft[field] }),
      (next) => {
        clearDraft(task.id);
        syncWeekState(next, task.id);
      },
    );
  };

  const removeTask = (task: RecurringTaskDef) => {
    const ok = window.confirm(
      `Remove "${task.label}" from the weekly schedule?\n\nIt goes for every week from now on, and takes its completion history with it.`,
    );
    if (!ok) return;
    applyScheduleChange(
      () => deleteScheduleTask(task.id),
      () => {
        clearDraft(task.id);
        setWeekState((current) => {
          const { [task.id]: _dropped, ...rest } = current;
          return rest;
        });
      },
    );
  };

  const dayTasks = useMemo(
    () => schedule.find((d) => d.day === selectedDay)?.tasks || [],
    [schedule, selectedDay],
  );

  // moveScheduleTask counts positions among the day's *other* tasks — the moved
  // one lifted out first, which is what a drag is — so every caller here works
  // its target out against that list rather than the one on screen.
  const moveWithinDay = (taskId: string, index: number) =>
    applyScheduleChange(() => moveScheduleTask(taskId, { index }));

  const nudge = (task: RecurringTaskDef, direction: -1 | 1) => {
    const from = dayTasks.findIndex((t) => t.id === task.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= dayTasks.length) return;
    moveWithinDay(task.id, to);
  };

  const dropOnTask = (target: RecurringTaskDef) => {
    const id = dragTaskId;
    setDragTaskId(null);
    setDropTaskId(null);
    if (!id || id === target.id) return;
    const from = dayTasks.findIndex((t) => t.id === id);
    const to = dayTasks.findIndex((t) => t.id === target.id);
    if (from < 0 || to < 0) return;
    // Dropping on a row means "take its place": above it when the task came
    // from below, below it when it came from above.
    const others = dayTasks.filter((t) => t.id !== id);
    const index = others.findIndex((t) => t.id === target.id) + (from < to ? 1 : 0);
    moveWithinDay(id, index);
  };

  const dropOnDay = (day: string) => {
    const id = dragTaskId;
    setDragTaskId(null);
    setDropDay(null);
    if (!id || day === selectedDay) return;
    applyScheduleChange(() => moveScheduleTask(id, { day }));
  };

  const addTask = (kind: 'recurring' | 'marketing') => {
    const label = (newTaskLabels[kind] || '').trim();
    if (!label) return;
    applyScheduleChange(
      () =>
        createScheduleTask({
          day: selectedDay,
          label,
          category: kind === 'marketing' ? MARKETING_CATEGORY : '',
          // Whoever the list is filtered to, so a task added while looking at
          // Sowmya's day doesn't immediately vanish from it. Unfiltered, the
          // server's own default (Adarsh) applies.
          assignedTo: selectedAssignee === 'all' ? '' : selectedAssignee,
        }),
      () => setNewTaskLabels((current) => ({ ...current, [kind]: '' })),
    );
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
      setSprintError(`Couldn't update "${item.title}": ${errorText(err)}`);
    } finally {
      setSavingIds((current) => ({ ...current, [item.id]: false }));
    }
  };

  const assigneeNames = useMemo(() => getAssigneeNames(schedule, weekState), [schedule, weekState]);
  const categoryNames = useMemo(() => getCategoryNames(schedule), [schedule]);

  // Editing shows the whole day: a person filter that hid rows would make the
  // positions a drag lands on impossible to read, and a task is often moved
  // precisely because it belongs to someone else now.
  const visibleTasks = dayTasks
    .map((task) => ({ task, state: getEffectiveTaskState(schedule, weekState, task.id) }))
    .filter(
      ({ state }) =>
        editing || selectedAssignee === 'all' || state.assignedTo.toLowerCase() === selectedAssignee.toLowerCase(),
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

  const renderEditRow = (task: RecurringTaskDef) => {
    const draft = draftFor(task);
    const position = dayTasks.findIndex((t) => t.id === task.id);
    const field = (key: keyof TaskDraft, label: string, className: string, list?: string) => (
      <input
        className={`daily-view-input ${className}`}
        value={draft[key]}
        list={list}
        aria-label={`${label} for ${task.label}`}
        placeholder={label}
        disabled={scheduleBusy}
        onChange={(event) => setDraftField(task, key, event.target.value)}
        onBlur={() => commitField(task, key)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') clearDraft(task.id);
        }}
      />
    );

    return (
      <div
        className={[
          'group-item-row',
          'daily-view-edit-row',
          dragTaskId === task.id ? 'daily-view-row-dragging' : '',
          dropTaskId === task.id ? 'daily-view-row-drop' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        key={task.id}
        draggable={grabbedId === task.id}
        onDragStart={(event) => {
          setDragTaskId(task.id);
          event.dataTransfer.effectAllowed = 'move';
          // Firefox won't start a drag at all without something on the transfer.
          event.dataTransfer.setData('text/plain', task.id);
        }}
        onDragEnd={() => {
          setDragTaskId(null);
          setDropTaskId(null);
          setDropDay(null);
          setGrabbedId(null);
        }}
        onDragOver={(event) => {
          if (!dragTaskId || dragTaskId === task.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTaskId(task.id);
        }}
        onDragLeave={() => setDropTaskId((current) => (current === task.id ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          dropOnTask(task);
        }}
      >
        <span
          className="daily-view-drag-handle"
          title="Drag to reorder, or onto another day's tab to move it there"
          onMouseDown={() => setGrabbedId(task.id)}
          onMouseUp={() => setGrabbedId(null)}
        >
          ⠿
        </span>
        <div className="daily-view-edit-fields">
          {field('label', 'Task name', 'daily-view-input-label')}
          {field('time', 'Time', 'daily-view-input-time')}
          {field('assignedTo', 'Assignee', 'daily-view-input-person', 'daily-view-people')}
          {field('category', 'Category', 'daily-view-input-category', 'daily-view-categories')}
        </div>
        <div className="daily-view-row-controls">
          <button
            type="button"
            className="daily-view-icon-button"
            title="Move up"
            aria-label={`Move ${task.label} up`}
            disabled={scheduleBusy || position <= 0}
            onClick={() => nudge(task, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="daily-view-icon-button"
            title="Move down"
            aria-label={`Move ${task.label} down`}
            disabled={scheduleBusy || position < 0 || position >= dayTasks.length - 1}
            onClick={() => nudge(task, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="daily-view-icon-button daily-view-icon-danger"
            title="Remove from the weekly schedule"
            aria-label={`Remove ${task.label}`}
            disabled={scheduleBusy}
            onClick={() => removeTask(task)}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  // The add row sits at the bottom of whichever card you're in, so a marketing
  // task added under Marketing gets that category without anyone typing it.
  const renderAddRow = (kind: 'recurring' | 'marketing') => (
    <div className="daily-view-add-row">
      <input
        className="daily-view-input daily-view-input-label"
        value={newTaskLabels[kind] || ''}
        placeholder={kind === 'marketing' ? `New marketing task for ${selectedDay}` : `New task for ${selectedDay}`}
        aria-label={kind === 'marketing' ? 'New marketing task' : 'New task'}
        disabled={scheduleBusy}
        onChange={(event) => setNewTaskLabels((current) => ({ ...current, [kind]: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') addTask(kind);
        }}
      />
      <button
        type="button"
        className="secondary-button small"
        disabled={scheduleBusy || !(newTaskLabels[kind] || '').trim()}
        onClick={() => addTask(kind)}
      >
        Add
      </button>
    </div>
  );

  const renderTaskList = (
    entries: { task: RecurringTaskDef; state: RecurringTaskState }[],
    kind: 'recurring' | 'marketing',
  ) => {
    if (entries.length === 0 && !editing) {
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
        {editing
          ? entries.map(({ task }) => renderEditRow(task))
          : entries.map(({ task, state }) => (
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
        {editing && renderAddRow(kind)}
      </div>
    );
  };

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Daily View</h1>
        <p>What's still left to do — pick a day and, optionally, a person.</p>
      </div>

      {/* Typing a name or a category that's already in use should be a pick
          rather than a spelling test — these back the edit-row inputs. */}
      <datalist id="daily-view-people">
        {assigneeNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="daily-view-categories">
        {categoryNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="wizard-shell">
        <div className="wizard-card">
          <div className="daily-view-filters">
            <div className="daily-view-day-tabs">
              {schedule.map(({ day }) => (
                <button
                  key={day}
                  type="button"
                  className={['tab-button', day === selectedDay ? 'active' : '', dropDay === day ? 'daily-view-day-drop' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setSelectedDay(day)}
                  // A day tab doubles as a drop target while editing: drag a row
                  // onto Tuesday and the task moves to Tuesday's list.
                  onDragOver={(event) => {
                    if (!dragTaskId || day === selectedDay) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropDay(day);
                  }}
                  onDragLeave={() => setDropDay((current) => (current === day ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOnDay(day);
                  }}
                >
                  {day}
                  {day === todayName ? ' · Today' : ''}
                </button>
              ))}
            </div>

            <div className="daily-view-filter-actions">
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

              <button
                type="button"
                className="secondary-button small"
                aria-pressed={editing}
                disabled={scheduleBusy}
                onClick={() => {
                  setEditing((current) => !current);
                  setDrafts({});
                  setScheduleError('');
                }}
              >
                {editing ? 'Done editing' : 'Edit schedule'}
              </button>
            </div>
          </div>

          <PushToggle />

          {editing && (
            <p className="inv-section-hint">
              You are editing the weekly cadence itself — a change here holds for every week from now on, not
              just this one. Drag a row to reorder it within the day, or onto another day's tab to move it
              there. Everyone's tasks stay visible while editing so the order reads straight.
            </p>
          )}

          {scheduleError && <p className="chat-error">{scheduleError}</p>}
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
