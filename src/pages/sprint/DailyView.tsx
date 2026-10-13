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
  ISSUE_URL,
  moveScheduleTask,
  saveTaskState,
  updateScheduleTask,
  type RecurringDay,
  type RecurringTaskDef,
  type RecurringTaskState,
  type RecurringWeekState,
} from './recurringSchedule';
import { TEAM } from '../../components/NotesBubble';
import { addDays, dateInThisWeek, formatDay, todayIso, weekdayOf } from '../../lib/localDay';
import { readNotesAuthor, useSharedNotes, type SharedNote } from '../../lib/useSharedNotes';

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
//
// To-dos are the third thing: one-off notes from the shared board that were
// given a day ("call the gas vendor tomorrow", "order brisket on the 15th").
// All of it — weekly tasks (marketing included), to-dos and sprint cards — is
// one list for the day, each row tagged with what it is. The list follows a
// calendar date: the selected tab's date this week, or any date picked above
// it, months out if need be (then only the to-dos apply).
//
// `focus` is a day asked for from outside — "show me pending tasks
// for today" — and lands the page on it. `at` changes on every ask, so the
// same day asked for twice still jumps back to it.
type DailyViewProps = { focus?: { date: string; at: number } | null };

// How many dated to-dos after the selected day to list under "Coming up". The
// day itself is the page's job; this is only a glance at what is next.
const COMING_UP = 8;

const DailyView: React.FC<DailyViewProps> = ({ focus }) => {
  const weekKey = useMemo(() => getIsoWeekKey(new Date()), []);
  const todayName = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long' }), []);
  const today = useMemo(() => todayIso(), []);

  // Task list starts as the hardcoded fallback so the page renders instantly, then gets
  // replaced by the live version once fetchRecurringSchedule() resolves — that's the
  // "refresh from the table" behavior: every time this page loads, it re-reads it.
  const [schedule, setSchedule] = useState<RecurringDay[]>(DEFAULT_RECURRING_SCHEDULE);
  const [weekState, setWeekState] = useState<RecurringWeekState>({});
  const [selectedDay, setSelectedDay] = useState(
    DEFAULT_RECURRING_SCHEDULE.some((d) => d.day === todayName) ? todayName : DEFAULT_RECURRING_SCHEDULE[0].day,
  );
  const [selectedAssignee, setSelectedAssignee] = useState('all');
  // The calendar day the To-dos card shows. Follows the tabs (each tab is its
  // date this week) but can also be any date, picked in the card itself.
  const [selectedDate, setSelectedDate] = useState(today);

  const { addNote, assignNote, setDone: setNoteDone } = useSharedNotes();
  const [datedNotes, setDatedNotes] = useState<SharedNote[]>([]);
  const [datedError, setDatedError] = useState('');
  const [newTodo, setNewTodo] = useState({ body: '', dueDate: '', assignee: '' });
  const [addingTodo, setAddingTodo] = useState(false);

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({});
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [newTask, setNewTask] = useState({ label: '', category: '' });
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

  // Everything dated from today on, plus anything older still open — see
  // listDatedNotes on the server. One read covers every tab and the Coming up
  // list, and it is a small table.
  const loadDatedNotes = useCallback(async () => {
    try {
      const data = await fetchJSON<{ notes: SharedNote[] }>(`/api/notes/dated?from=${today}`);
      setDatedNotes(data.notes);
      setDatedError('');
    } catch (err) {
      setDatedError(`Couldn't load the dated to-dos — ${errorText(err)}`);
    }
  }, [today]);

  useEffect(() => {
    loadDatedNotes();
    // Back from the phone's lock screen or another tab, someone may well have
    // ticked something off from the note bubble in the meantime.
    window.addEventListener('focus', loadDatedNotes);
    return () => window.removeEventListener('focus', loadDatedNotes);
  }, [loadDatedNotes]);

  // A tab is a weekday of this week; picking a date only moves the tabs when
  // it falls in this week, because the weekly list under them is this week's
  // ticks and would be the wrong answer for a Monday a month away.
  const showDate = useCallback(
    (date: string) => {
      setSelectedDate(date);
      const day = weekdayOf(date);
      if (dateInThisWeek(day) === date && schedule.some((d) => d.day === day)) setSelectedDay(day);
    },
    [schedule],
  );

  useEffect(() => {
    if (!focus) return;
    showDate(focus.date);
    setEditing(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Keyed on `at` alone: showDate changes when the schedule loads, and that
    // must not yank the page back to a day asked for minutes ago.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at]);

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

  const addTask = () => {
    const label = newTask.label.trim();
    if (!label) return;
    applyScheduleChange(
      () =>
        createScheduleTask({
          day: selectedDay,
          label,
          category: newTask.category.trim(),
          // Whoever the list is filtered to, so a task added while looking at
          // Sowmya's day doesn't immediately vanish from it. Unfiltered, the
          // server's own default (Adarsh) applies.
          assignedTo: selectedAssignee === 'all' ? '' : selectedAssignee,
        }),
      () => setNewTask((current) => ({ ...current, label: '' })),
    );
  };

  // ---- Dated to-dos -----------------------------------------------------

  // The same tick the note bubble makes, so the two can never disagree. The
  // row moves first; the server's answer replaces the list a moment later.
  const toggleTodo = async (note: SharedNote) => {
    setDatedError('');
    setDatedNotes((current) => current.map((n) => (n.id === note.id ? { ...n, done: !note.done } : n)));
    try {
      await setNoteDone(note.id, !note.done, readNotesAuthor());
    } catch (err) {
      setDatedError(`Couldn't save that — ${errorText(err)}`);
    }
    loadDatedNotes();
  };

  // Moves a to-do to another day — "not today, do it Saturday" — or, cleared,
  // back to the board as a for-whenever note.
  const moveTodo = async (note: SharedNote, dueDate: string) => {
    setDatedError('');
    try {
      await fetchJSON(`/api/notes/${note.id}/due`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate }),
      });
    } catch (err) {
      setDatedError(`Couldn't move that — ${errorText(err)}`);
    }
    loadDatedNotes();
  };

  const addTodo = async () => {
    const body = newTodo.body.trim();
    if (!body || addingTodo) return;
    setAddingTodo(true);
    setDatedError('');
    try {
      const note = await addNote(body, readNotesAuthor(), newTodo.dueDate || selectedDate);
      const assignee = newTodo.assignee || (selectedAssignee === 'all' ? '' : selectedAssignee);
      if (assignee) await assignNote(note.id, assignee);
      setNewTodo((current) => ({ ...current, body: '', dueDate: '' }));
      await loadDatedNotes();
    } catch (err) {
      setDatedError(`Couldn't add that — ${errorText(err)}`);
    } finally {
      setAddingTodo(false);
    }
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

  const sprintItemsForDay = sprintItems
    .filter((item) => item.day === selectedDay)
    .filter(
      ({ assignedTo, assignees }) =>
        selectedAssignee === 'all' ||
        assignedTo.toLowerCase() === selectedAssignee.toLowerCase() ||
        assignees.some((a) => a.toLowerCase() === selectedAssignee.toLowerCase()),
    );

  // A to-do is someone's if it was handed to them, or — handed to nobody — if
  // they wrote it. The same rule as the note bubble's name chip.
  const forSelected = (note: SharedNote) =>
    selectedAssignee === 'all' || (note.assignedTo || note.author).toLowerCase() === selectedAssignee.toLowerCase();

  // The selected day's to-dos, and on today also whatever is overdue and still
  // open — yesterday's undone job is today's job, not a missed one.
  const todosForDay = datedNotes
    .filter(forSelected)
    .filter((note) => note.dueDate === selectedDate || (selectedDate === today && !note.done && note.dueDate < today));
  const comingUp = datedNotes
    .filter(forSelected)
    .filter((note) => !note.done && note.dueDate > selectedDate)
    .slice(0, COMING_UP);
  const dayWord = formatDay(selectedDate, today);
  const dayPhrase = /^(Today|Tomorrow|Yesterday)$/.test(dayWord) ? dayWord.toLowerCase() : dayWord;

  // The weekly ticks and the sprint's Day field are this week's, so they only
  // join the list when the date on screen is a day of this week. A date picked
  // a month out shows that day's to-dos alone, not this week's Monday again.
  const inThisWeek = dateInThisWeek(weekdayOf(selectedDate)) === selectedDate && weekdayOf(selectedDate) === selectedDay;
  const weeklyRows = inThisWeek ? visibleTasks : [];
  const sprintRows = inThisWeek ? sprintItemsForDay : [];
  const doneCount =
    weeklyRows.filter(({ state }) => state.done).length +
    todosForDay.filter((note) => note.done).length +
    sprintRows.filter((item) => item.status === 'Done').length;
  const totalCount = weeklyRows.length + todosForDay.length + sprintRows.length;
  // Overdue to-dos lead — yesterday's undone job is the first thing to see —
  // then the weekly cadence in its own order, the day's to-dos, sprint cards.
  const overdueTodos = todosForDay.filter((note) => note.dueDate < selectedDate);
  const dayTodos = todosForDay.filter((note) => note.dueDate >= selectedDate);

  const renderTodoRow = (note: SharedNote, compact = false) => {
    const overdue = !note.done && note.dueDate < today;
    return (
      <div className="group-item-row" key={note.id}>
        <div className="group-item">
          <input
            type="checkbox"
            checked={note.done}
            aria-label={`Mark "${note.body.slice(0, 60)}" as ${note.done ? 'not done' : 'done'}`}
            onChange={() => toggleTodo(note)}
          />
          <label className={note.done ? 'daily-view-task-done' : ''}>{note.body}</label>
        </div>
        <div className="daily-view-meta">
          {compact || overdue ? (
            <span className={`daily-view-badge ${overdue ? 'daily-view-badge-overdue' : 'daily-view-badge-time'}`}>
              {overdue ? `Overdue · ${formatDay(note.dueDate, today)}` : formatDay(note.dueDate, today)}
            </span>
          ) : null}
          {compact ? null : <span className="daily-view-badge daily-view-badge-kind">To-do</span>}
          <span className="daily-view-badge">{note.assignedTo || note.author || 'Unassigned'}</span>
          {compact ? null : (
            <input
              type="date"
              className="daily-view-input daily-view-input-date"
              value={note.dueDate}
              aria-label={`Move "${note.body.slice(0, 60)}" to another day`}
              title="Move to another day — clear it to send it back to the notes board"
              onChange={(event) => moveTodo(note, event.target.value)}
            />
          )}
        </div>
      </div>
    );
  };

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
            title={task.alarm ? 'Sounds the alarm at its time — click for a plain reminder' : 'Sound the alarm at its time'}
            aria-label={`${task.alarm ? 'Turn off' : 'Turn on'} the alarm for ${task.label}`}
            aria-pressed={!!task.alarm}
            disabled={scheduleBusy}
            onClick={() => applyScheduleChange(() => updateScheduleTask(task.id, { alarm: !task.alarm }))}
          >
            {task.alarm ? '⏰' : '🔕'}
          </button>
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

  const renderWeeklyRow = ({ task, state }: { task: RecurringTaskDef; state: RecurringTaskState }) => (
    <div className="group-item-row" key={task.id}>
      <div className="group-item">
        <input type="checkbox" checked={state.done} onChange={() => toggleDone(task.id)} />
        <label className={state.done ? 'daily-view-task-done' : ''}>{task.label}</label>
      </div>
      <div className="daily-view-meta">
        <span className="daily-view-badge daily-view-badge-time">
          {task.alarm ? <span title="Sounds the alarm at this time">⏰ </span> : null}
          {state.time || '—'}
        </span>
        {isMarketingTask(task) && <span className="daily-view-badge daily-view-badge-kind">Marketing</span>}
        {task.githubIssue ? (
          <a
            className="daily-view-badge"
            href={`${ISSUE_URL}${task.githubIssue}`}
            target="_blank"
            rel="noreferrer"
            title="Its standing item on the sprint board"
          >
            #{task.githubIssue}
          </a>
        ) : null}
        <span className="daily-view-badge">{state.assignedTo || 'Unassigned'}</span>
      </div>
    </div>
  );

  const renderSprintRow = (item: SprintItem) => (
    <div className="group-item-row" key={item.id}>
      <div className="group-item">
        <label className={item.status === 'Done' ? 'daily-view-task-done' : ''}>
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
        <span className="daily-view-badge daily-view-badge-kind">Sprint</span>
        <span className="daily-view-badge">{item.assignedTo || item.assignees[0] || 'Unassigned'}</span>
        <select
          className="daily-view-status-select"
          value={item.status || 'Backlog'}
          disabled={savingIds[item.id]}
          aria-label={`Status of ${item.title}`}
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
  );

  // One add row for the cadence. The category picks from the ones in use, so
  // a marketing task is "Marketing" in that box rather than a separate list.
  const renderAddTaskRow = () => (
    <div className="daily-view-add-row">
      <input
        className="daily-view-input daily-view-input-label"
        value={newTask.label}
        placeholder={`New weekly task for ${selectedDay}`}
        aria-label="New task"
        disabled={scheduleBusy}
        onChange={(event) => setNewTask((current) => ({ ...current, label: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') addTask();
        }}
      />
      <input
        className="daily-view-input daily-view-input-category"
        value={newTask.category}
        list="daily-view-categories"
        placeholder="Category"
        aria-label="New task category"
        disabled={scheduleBusy}
        onChange={(event) => setNewTask((current) => ({ ...current, category: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') addTask();
        }}
      />
      <button
        type="button"
        className="secondary-button small"
        disabled={scheduleBusy || !newTask.label.trim()}
        onClick={addTask}
      >
        Add
      </button>
    </div>
  );

  // Always open, not behind Edit schedule: a one-off is not the cadence, and
  // adding "call the vendor Friday" should not feel like editing the week.
  const renderAddTodoRow = () => (
    <div className="daily-view-add-row">
      <input
        className="daily-view-input daily-view-input-label"
        value={newTodo.body}
        placeholder="New to-do…"
        aria-label="New to-do"
        maxLength={2000}
        disabled={addingTodo}
        onChange={(event) => setNewTodo((current) => ({ ...current, body: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') addTodo();
        }}
      />
      <input
        type="date"
        className="daily-view-input daily-view-input-date"
        value={newTodo.dueDate || selectedDate}
        min={today}
        aria-label="Due on"
        disabled={addingTodo}
        onChange={(event) => setNewTodo((current) => ({ ...current, dueDate: event.target.value }))}
      />
      <select
        className="daily-view-input daily-view-input-person"
        value={newTodo.assignee || (selectedAssignee === 'all' ? '' : selectedAssignee)}
        aria-label="Assigned to"
        disabled={addingTodo}
        onChange={(event) => setNewTodo((current) => ({ ...current, assignee: event.target.value }))}
      >
        <option value="">Anyone</option>
        {TEAM.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button type="button" className="secondary-button small" disabled={addingTodo || !newTodo.body.trim()} onClick={addTodo}>
        {addingTodo ? 'Adding…' : 'Add'}
      </button>
    </div>
  );

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Daily View</h1>
        <p>Everything on for the day in one list — the weekly cadence, one-off to-dos and sprint cards.</p>
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
                  onClick={() => {
                    setSelectedDay(day);
                    setSelectedDate(dateInThisWeek(day));
                  }}
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

              {githubConfigured && (
                <button type="button" className="secondary-button small" onClick={loadSprintItems} disabled={sprintLoading}>
                  {sprintLoading ? 'Refreshing…' : 'Refresh sprint'}
                </button>
              )}

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

          {editing ? (
            <>
              <div className="daily-view-section-header">
                <h2>Weekly schedule — {selectedDay}</h2>
              </div>
              <p className="inv-section-hint">
                You are editing the weekly cadence itself — a change here holds for every week from now on, not
                just this one. Drag a row to reorder it within the day, or onto another day's tab to move it
                there. Everyone's tasks stay visible while editing so the order reads straight.
              </p>
            </>
          ) : (
            <>
              <div className="daily-view-section-header">
                <h2>{dayWord}</h2>
                <div className="daily-view-filter-actions">
                  <button
                    type="button"
                    className="daily-view-icon-button"
                    aria-label="Previous day"
                    onClick={() => showDate(addDays(selectedDate, -1))}
                  >
                    ‹
                  </button>
                  <input
                    type="date"
                    className="daily-view-input daily-view-input-date"
                    value={selectedDate}
                    aria-label="Show the list for"
                    onChange={(event) => event.target.value && showDate(event.target.value)}
                  />
                  <button
                    type="button"
                    className="daily-view-icon-button"
                    aria-label="Next day"
                    onClick={() => showDate(addDays(selectedDate, 1))}
                  >
                    ›
                  </button>
                </div>
              </div>
              <p className="inv-section-hint">
                {totalCount ? `${totalCount - doneCount} of ${totalCount} still pending. ` : ''}
                Ticking a weekly task here ticks it off in This Week's Tasks too; to-dos come from the notes
                board — add one below, or tap the mic and say “remind Sowmya to call the gas vendor tomorrow”.
                {inThisWeek ? '' : ' Weekly and sprint tasks only show for the days of this week.'}
              </p>
            </>
          )}

          {scheduleError && <p className="chat-error">{scheduleError}</p>}
          {taskStatusError && <p className="chat-error">{taskStatusError}</p>}
          {datedError && <p className="chat-error">{datedError}</p>}
          {sprintError && <p className="chat-error">{sprintError}</p>}

          {editing ? (
            <div className="group-list">
              {visibleTasks.map(({ task }) => renderEditRow(task))}
              {renderAddTaskRow()}
            </div>
          ) : (
            <div className="group-list">
              {totalCount === 0 && !sprintLoading ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🗓️</div>
                  <h3>Nothing on</h3>
                  <p>
                    {selectedAssignee === 'all'
                      ? `Nothing scheduled for ${dayPhrase}.`
                      : `${selectedAssignee} has nothing scheduled for ${dayPhrase}.`}
                  </p>
                </div>
              ) : null}
              {overdueTodos.map((note) => renderTodoRow(note))}
              {weeklyRows.map(renderWeeklyRow)}
              {dayTodos.map((note) => renderTodoRow(note))}
              {sprintRows.map(renderSprintRow)}
              {renderAddTodoRow()}
            </div>
          )}

          {!editing && comingUp.length ? (
            <>
              <h3 className="inv-section-title">Coming up</h3>
              <div className="group-list">{comingUp.map((note) => renderTodoRow(note, true))}</div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default DailyView;
