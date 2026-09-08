import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readNotesAuthor, useSharedNotes, writeNotesAuthor, type SharedNote } from '../lib/useSharedNotes';
import { usePersistedState } from '../lib/usePersistedState';
import { useTodayTasks, type TodayTask } from '../lib/useTodayTasks';
import {
  createScheduleTask,
  fetchRecurringSchedule,
  getCategoryNames,
  MARKETING_CATEGORY,
} from '../pages/sprint/recurringSchedule';

// The note bubble that sits in the top bar of every screen, and the panel it
// opens: one shared to-do board, readable and writable from every device that
// can reach the dashboard.
//
// It lives at the app shell rather than inside a screen for the same reason
// the WhatsApp badge does — the thing you need to write down almost never
// occurs to you on the screen it belongs to. "Order more gas" turns up halfway
// through a smoking session; "call the vendor back" turns up at the tablet.
// Somewhere to put either, from wherever you are.
//
// Every note is a to-do with a tick box. Most of what gets left on a board
// like this is something that has to happen rather than something to know, and
// separating the two would mean a decision at the moment of typing — which is
// the moment you least want one. A remark nobody needs to act on just never
// gets ticked, which costs one empty box.
//
// Nothing is edited in place. The tick is a column, not a rewrite, so two
// devices working the board at once cannot clobber each other's text — see the
// note at the top of server/core/sharedNotes.js.
//
// Pinned above the board is today's row of the weekly cadence, which is the
// other half of "what needs doing". The cadence is what was always going to
// happen today and the board is what came up since; keeping them a screen
// apart meant the tick box for hosing down the smoker lived nowhere near the
// note saying the hose is broken. Those tick boxes write to the same table
// Daily View writes to — see server/sprint/todayTasks.js — so a job ticked
// here is ticked there, and neither screen can claim it is still open.

// Same threshold the sidebar badge uses, so the two bubbles never disagree
// about what a big number looks like.
const MAX_BADGE = 99;

// "09:14" for today, "Sat 09:14" within the week, "8 Sep 09:14" beyond it.
//
// A shared board is read at a glance and mostly holds today's notes, so the
// date is only spelled out once it stops being obvious. Invalid input falls
// back to the raw string rather than rendering "Invalid Date" — a note is
// worth showing even when its stamp is not.
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return time;
  const ageDays = (now.getTime() - at.getTime()) / 86_400_000;
  if (ageDays < 7 && ageDays >= 0) {
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

// The heading above a run of notes. Grouping by day is what stops a board a
// fortnight old from reading as one undifferentiated column.
function dayLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return at.toLocaleDateString(undefined, { weekday: 'long' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// The note text with every occurrence of the search term wrapped in <mark>.
//
// Worth the twenty lines: a search that returns eight notes and leaves you to
// find the word yourself has done half the job, and on a phone the word is
// often three lines into a paragraph about a vendor call.
//
// Plain indexOf on lowercased copies rather than a RegExp: the term is typed
// by a person and would have to be escaped to be safe as a pattern, and
// getting that wrong turns a stray "(" into a crash on the whole panel.
function highlight(text: string, term: string): ReactNode {
  if (!term) return text;
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

type Group = { key: string; label: string; notes: SharedNote[] };

// Consecutive notes sharing a calendar day, in the order they arrived. The
// server already returns them oldest first, so this only has to break the run
// whenever the label changes.
//
// Ticked notes stay where they were written rather than sinking to the bottom.
// A board this size is read as a list of the last few days, and an item that
// jumped somewhere else the instant you ticked it would take the thing you had
// just been looking at out from under you.
function groupByDay(notes: SharedNote[]): Group[] {
  const groups: Group[] = [];
  for (const note of notes) {
    const label = dayLabel(note.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.notes.push(note);
    else groups.push({ key: `${label}-${note.id}`, label, notes: [note] });
  }
  return groups;
}

const NotesBubble = () => {
  const {
    notes,
    total,
    doneCount,
    openCount,
    query,
    author: filteredAuthor,
    matched,
    search,
    filterByAuthor,
    truncated,
    authors,
    unread,
    markRead,
    error,
    loading,
    addNote,
    setDone,
    deleteNote,
  } = useSharedNotes();
  const [open, setOpen] = useState(false);
  const {
    weekday,
    tasks,
    openCount: tasksOpen,
    doneCount: tasksDone,
    error: tasksError,
    setTaskDone,
    refresh: refreshTasks,
  } = useTodayTasks(open);
  const [draft, setDraft] = useState('');
  // What is in the search box right now. Separate from `query`, which is the
  // search the rows on screen actually answer: the box must respond to every
  // keystroke while the requests behind it go one per pause in typing.
  const [term, setTerm] = useState('');
  // Whose notes are on screen, or '' for everyone's. Held here as well as on
  // the server so the tapped chip lights up on the tap rather than a round
  // trip later — on kitchen wifi that delay reads as the tap not registering.
  const [only, setOnly] = useState('');
  // Read at mount rather than in an effect, so the composer never renders one
  // frame with an empty name and never writes that blank back over the stored
  // one — the trap usePersistedState.ts documents.
  const [author, setAuthor] = useState(() => readNotesAuthor());
  const [posting, setPosting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  // Ids with a tick in flight. Held as a set rather than a single id because
  // two boxes can be tapped in quick succession, and the second must not
  // cancel the first's spinner.
  const [ticking, setTicking] = useState<number[]>([]);
  // Same, for today's tasks. A separate set because the ids are strings from a
  // different table and a note and a task could otherwise collide.
  const [tickingTask, setTickingTask] = useState<string[]>([]);
  // Whether the pinned strip is expanded. Remembered, because whether today's
  // list is worth the top third of the panel is a standing preference — the
  // person who works off it wants it open every time, and the person who came
  // for the notes wants it out of the way every time.
  const [tasksShown, setTasksShown] = usePersistedState<boolean>(
    'smokerings.notesTasksShown',
    true,
    (stored) => (typeof stored === 'boolean' ? stored : undefined),
  );
  // Which composer is at the bottom: the note board, or a new job for the
  // cadence. One box would have to guess, and the two write to different
  // tables with different lifetimes — a note is gone when it is deleted, a
  // task comes back every week — so the choice is worth one visible tab.
  const [composerMode, setComposerMode] = useState<'note' | 'task'>('note');
  const [taskDraft, setTaskDraft] = useState('');
  const [taskTime, setTaskTime] = useState('');
  const [taskWho, setTaskWho] = useState('');
  // Marketing by default. That is what actually gets added on the fly here —
  // a reel to cut, a post to put out — while the prep and procurement rows
  // are the standing cadence somebody set up once.
  const [taskCategory, setTaskCategory] = useState(MARKETING_CATEGORY);
  const [addingTask, setAddingTask] = useState(false);
  const [taskAdded, setTaskAdded] = useState('');
  // The categories already in play, fetched the first time the task tab is
  // opened rather than on mount: the whole schedule is a request the note
  // board has no use for, and most opens of this panel never leave note mode.
  const [categories, setCategories] = useState<string[]>([]);
  // Where the visible strip of screen is while the on-screen keyboard is up,
  // or null when it is not. See the effect below for why this cannot be CSS.
  const [lift, setLift] = useState<{ top: number; height: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // The weekday the task tab writes to. The server's answer is the one to
  // trust — it is what picked today's rows — but it is empty until the first
  // fetch lands, and the tab must not offer to add a task to "" in the
  // meantime.
  const localWeekday = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long' }), []);
  const today = weekday || localWeekday;

  const groups = useMemo(() => groupByDay(notes), [notes]);
  const newest = notes.length ? notes[notes.length - 1].id : 0;

  // One request per pause in typing rather than one per keystroke. 220ms is
  // about the gap between words, so a whole word usually goes out as one
  // search while a fast typist's half-finished one does not go out at all.
  useEffect(() => {
    const id = setTimeout(() => void search(term), 220);
    return () => clearTimeout(id);
  }, [term, search]);

  // No debounce on the name: a chip is a tap, not typing, so there is nothing
  // to wait for a pause in.
  useEffect(() => {
    void filterByAuthor(only);
  }, [only, filterByAuthor]);

  // Closing the panel clears the search, so the board is whole again the next
  // time it is opened — and, more to the point, so the badge is counting the
  // real board rather than whatever a search left behind.
  useEffect(() => {
    if (!open) {
      setTerm('');
      setOnly('');
      // Back to the note board. Task mode is a detour taken deliberately, and
      // reopening the bubble to a half-filled task form would put the wrong
      // box under the cursor for the thing people mostly open it to do.
      setComposerMode('note');
      setTaskAdded('');
    }
  }, [open]);

  // The category chips, the first time the task tab is opened. Falls back to
  // whatever today's own rows are already tagged with, so the chips are never
  // empty even with the schedule request refused.
  useEffect(() => {
    if (composerMode !== 'task' || categories.length) return;
    let live = true;
    void fetchRecurringSchedule().then((schedule) => {
      if (live) setCategories(getCategoryNames(schedule));
    });
    return () => {
      live = false;
    };
  }, [composerMode, categories.length]);

  // Whichever composer is on screen gets the cursor. Skipped on the first
  // render of the panel, where the open effect above has already done it.
  useEffect(() => {
    if (!open) return;
    if (composerMode === 'task') taskInputRef.current?.focus();
    else inputRef.current?.focus();
  }, [composerMode, open]);

  // Everything that has to happen on open, in one effect because they are one
  // event: focus the composer, jump to the newest note, and clear the badge.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    markRead();
  }, [open, markRead]);

  // Search results are read from the top — the first match is where you start,
  // not the last one. Without this the list would still be sitting wherever
  // the board had scrolled to.
  useEffect(() => {
    if (!query && !filteredAuthor) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [query, filteredAuthor]);

  // A note that lands while you are reading is a note you have seen, so the
  // badge should not start counting again behind an open panel. Keyed on the
  // newest id rather than on the array, so a poll that changes nothing does
  // nothing.
  useEffect(() => {
    if (!open || !newest) return;
    const el = scrollRef.current;
    // Only follow the board down if you were already at the bottom of it —
    // yanking the scroll while someone reads back through the week is worse
    // than making them scroll down. Never while a search is on screen: those
    // are read from the top, and the newest match is rarely the wanted one.
    const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 80 : true;
    if (el && atBottom && !query) el.scrollTop = el.scrollHeight;
    markRead();
  }, [open, newest, markRead, query]);

  // Keep the panel inside whatever the on-screen keyboard leaves visible.
  //
  // There is no CSS unit for this. On Android the keyboard shrinks only the
  // VISUAL viewport: the layout viewport stays full height and the browser
  // scrolls it up under the keyboard to reveal the focused box. vh and dvh
  // both measure the layout viewport, and `position: fixed` is positioned
  // against it too — so the panel keeps its full height and its header ends up
  // above the top of the screen, which is what the keyboard was doing to it.
  //
  // The VisualViewport API is the only thing that reports the visible strip,
  // so while the keyboard is up the panel is pinned to it by hand: `offsetTop`
  // says where the strip starts within the layout viewport, `height` says how
  // much of it there is.
  useEffect(() => {
    if (!open) {
      setLift(null);
      return undefined;
    }
    const vv = window.visualViewport;
    // No API, no lift. Every browser this runs on has it; a browser that does
    // not simply keeps the behaviour it had before.
    if (!vv) return undefined;
    const apply = () => {
      // Comfortably more than a browser toolbar sliding away (~60-100px) and
      // comfortably less than any on-screen keyboard, so neither a toolbar nor
      // a pinch-zoom is mistaken for one.
      if (window.innerHeight - vv.height < 120) {
        setLift(null);
        return;
      }
      const next = { top: Math.round(vv.offsetTop + 8), height: Math.round(vv.height - 16) };
      // Same numbers, same object: the scroll event fires continuously while
      // the keyboard settles, and re-rendering on each one would fight the
      // list's own scrolling.
      setLift((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next));
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [open]);

  // The keyboard opening shortens the list. Put it back at the newest note, so
  // what you are about to add sits directly above what you last wrote instead
  // of the list holding its old scroll position halfway up the board. Not
  // while searching, where the top of the results is the useful end.
  useEffect(() => {
    if (!lift || query) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lift, query]);

  // Escape closes, and a click anywhere outside does too. The panel floats
  // over whatever screen you were on, so leaving it open by accident would sit
  // on top of the work it was meant to be a note about.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A search on screen is the innermost thing Escape should undo. Clearing
      // it first means one Escape gets you back to the whole board and the
      // next one closes — rather than a mistyped search taking the panel with
      // it and losing the note you were part-way through writing.
      if (term) {
        setTerm('');
        return;
      }
      // Then the name filter, for the same reason: one Escape at a time,
      // outwards, so getting back to the whole board never costs you the
      // half-written note in the composer.
      if (only) {
        setOnly('');
        return;
      }
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    // Capture, so a click on a control that re-renders itself away still
    // counts as a click outside.
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [open, term, only]);

  const rememberAuthor = (name: string) => {
    setAuthor(name);
    writeNotesAuthor(name);
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setActionError(null);
    try {
      await addNote(body, author);
      // Cleared only after the server has it. A failed post that had already
      // wiped the box would lose what you typed, which on a phone in a kitchen
      // is the one thing this must never do.
      setDraft('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  };

  const tick = async (note: SharedNote) => {
    if (ticking.includes(note.id)) return;
    setActionError(null);
    setTicking((ids) => [...ids, note.id]);
    try {
      await setDone(note.id, !note.done, author);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTicking((ids) => ids.filter((id) => id !== note.id));
    }
  };

  const tickTask = async (id: string, done: boolean) => {
    if (tickingTask.includes(id)) return;
    setActionError(null);
    setTickingTask((ids) => [...ids, id]);
    try {
      await setTaskDone(id, done);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTickingTask((ids) => ids.filter((other) => other !== id));
    }
  };

  // Adds a job to today's row of the cadence — the same write Daily View's
  // add row makes, from the panel that is already open.
  //
  // It lands in `scheduled_task`, which is the weekly cadence and not a list
  // for today only: a task added here comes back next Tuesday too. That is
  // the right default for what actually gets typed in — "Reddit automation
  // post" is a standing job someone forgot to write down — but it is not
  // guessable from a text box, so the form says so in as many words.
  const submitTask = async () => {
    const label = taskDraft.trim();
    if (!label || addingTask) return;
    setAddingTask(true);
    setActionError(null);
    try {
      await createScheduleTask({
        day: today,
        label,
        time: taskTime.trim(),
        // Left blank on purpose rather than defaulted here: the server puts
        // it on Adarsh, and one place deciding that is better than two that
        // can disagree.
        assignedTo: taskWho.trim(),
        category: taskCategory,
      });
      // The strip is the confirmation — the job appears in it — so it has to
      // be open, or a task would be added into what looks like no change.
      await refreshTasks();
      setTaskDraft('');
      setTaskTime('');
      setTaskAdded(label);
      setTasksShown(true);
      taskInputRef.current?.focus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingTask(false);
    }
  };

  const remove = async (id: number) => {
    setActionError(null);
    try {
      await deleteNote(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmingId(null);
    }
  };

  // "3 to do · 2 done", which is the summary worth having on a board of jobs.
  // An empty board says so instead, because "0 to do" reads as finished rather
  // than as never started.
  // Which of the two filters are on, and how to say so in a line the panel
  // uses twice — once when there are results and once when there are none.
  // Both read off the server's echo rather than the controls, so the line
  // never describes a filter the rows on screen have not answered yet.
  const filtering = Boolean(query || filteredAuthor);
  const filterLabel = [
    query ? `matching “${query}”` : null,
    filteredAuthor ? `from ${filteredAuthor}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  // Only what is still open. A strip that listed ticked jobs too would be the
  // whole day by evening, which is the one time the panel is least worth
  // scrolling — the count in the header is what carries the finished ones.
  // The categories the picker offers. The fetched list once it is there, and
  // until then Marketing plus whatever today's own rows are tagged with, so
  // it is never empty while a request is in flight.
  const categoryChips = useMemo(() => {
    if (categories.length) return categories;
    const found = new Set<string>([MARKETING_CATEGORY]);
    tasks.forEach((task) => {
      if (task.category) found.add(task.category);
    });
    return Array.from(found);
  }, [categories, tasks]);

  const tasksSummary =
    tasksOpen === 0
      ? 'all done'
      : [`${tasksOpen} to do`, tasksDone > 0 ? `${tasksDone} done` : null].filter(Boolean).join(' · ');

  const summary =
    total === 0
      ? 'Nothing yet'
      : [openCount > 0 ? `${openCount} to do` : null, doneCount > 0 ? `${doneCount} done` : null]
          .filter(Boolean)
          .join(' · ') || 'All done';

  // One row of the pinned strip. Pulled out of the JSX because it is rendered
  // from two lists now — what is left to do, and the ticked ones underneath
  // when they have been asked for — and two copies of a row with a tick box
  // in it is how the two quietly stop behaving the same.
  const renderTask = (task: TodayTask) => (
    <label key={task.id} className={`notes-task${task.done ? ' is-done' : ''}`}>
      {/* Ticking here is the same write Daily View makes, so this is not a
          copy of the checklist that can drift from it — see
          server/sprint/todayTasks.js. */}
      <input
        type="checkbox"
        className="notes-check"
        checked={task.done}
        disabled={tickingTask.includes(task.id)}
        aria-label={`Mark "${task.label}" as ${task.done ? 'not done' : 'done'}`}
        onChange={() => void tickTask(task.id, !task.done)}
      />
      <span className="notes-task-main">
        <span className="notes-task-label">{task.label}</span>
        <span className="notes-task-meta">
          {/* What kind of job it is. Worth a chip rather than being left
              implicit in the wording: on most days this strip is a mix of
              marketing and kitchen work, and which of the two a row is
              decides whether it is yours before the words are read. */}
          {task.category ? (
            <span
              className={`notes-task-tag${
                task.category.toLowerCase() === MARKETING_CATEGORY.toLowerCase() ? ' is-marketing' : ''
              }`}
            >
              {task.category}
            </span>
          ) : null}
          {task.time ? <span className="notes-task-time">{task.time}</span> : null}
          {/* Who it is on. The strip is read by whoever picked the tablet up,
              and half of what it has to answer is whether the job is theirs. */}
          {task.assignedTo ? <span className="notes-task-who">{task.assignedTo}</span> : null}
        </span>
      </span>
    </label>
  );

  return (
    <div className="notes-bubble-root">
      <button
        type="button"
        ref={toggleRef}
        className={`notes-toggle${open ? ' is-open' : ''}`}
        aria-label={
          unread > 0 ? `Shared notes, ${unread} new` : open ? 'Close shared notes' : 'Open shared notes'
        }
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span aria-hidden="true">💬</span>
        {unread > 0 ? (
          <span className="notes-badge" aria-hidden="true">
            {unread > MAX_BADGE ? `${MAX_BADGE}+` : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className={`notes-panel${lift ? ' is-lifted' : ''}`}
          // Set here rather than in the stylesheet because only script can
          // know these numbers — see the visual-viewport effect above.
          style={lift ? { top: lift.top, maxHeight: lift.height } : undefined}
          ref={panelRef}
          role="dialog"
          aria-label="Shared notes"
        >
          <header className="notes-panel-head">
            <div>
              <h2>Shared notes</h2>
              <p>{summary}</p>
            </div>
            <button type="button" className="notes-close" aria-label="Close shared notes" onClick={() => setOpen(false)}>
              <span aria-hidden="true">✕</span>
            </button>
          </header>

          {/* The last poll failed. Said out loud rather than left to look like
              a quiet board, because "nobody wrote anything" and "we could not
              reach the server" are the same picture otherwise. */}
          {error ? <p className="notes-alert">Could not refresh — {error}</p> : null}
          {actionError ? <p className="notes-alert">{actionError}</p> : null}
          {tasksError ? <p className="notes-alert">Could not load today's tasks — {tasksError}</p> : null}

          {/* Today's cadence, above the board rather than inside it. Two
              separate things kept visibly separate: a task comes back every
              week whether or not anyone types it, and a note is gone once it
              is deleted, so mixing them into one list would make the tick
              boxes mean two different things.

              Nothing at all on a day with no tasks in it — an empty strip
              saying so would be a permanent line on Sundays. */}
          {tasks.length > 0 ? (
            <section className={`notes-tasks${tasksShown ? '' : ' is-collapsed'}`}>
              <button
                type="button"
                className="notes-tasks-head"
                aria-expanded={tasksShown}
                onClick={() => setTasksShown((shown) => !shown)}
              >
                <span className="notes-tasks-title">Today · {today}</span>
                <span className={`notes-tasks-count${tasksOpen === 0 ? ' is-clear' : ''}`}>{tasksSummary}</span>
                <span className="notes-tasks-chevron" aria-hidden="true">
                  {tasksShown ? '▾' : '▸'}
                </span>
              </button>

              {/* The whole day, in the order the schedule holds it, ticked
                  ones included and struck through where they sit.

                  All of it rather than only what is left: a list that drops a
                  row the moment it is ticked cannot show you that you ticked
                  the wrong one, and by evening it reads as a day with nothing
                  in it. The header count is what says how much is left. */}
              {tasksShown ? (
                <div className="notes-tasks-list">{tasks.map((task) => renderTask(task))}</div>
              ) : null}
            </section>
          ) : null}

          {/* Only once there is something to search. On an empty board the row
              would be a control that cannot do anything, sitting where the
              "nothing here yet" line should be. */}
          {total > 0 ? (
            <div className="notes-search">
              <span className="notes-search-icon" aria-hidden="true">
                🔍
              </span>
              <input
                type="search"
                value={term}
                placeholder="Search notes and names…"
                aria-label="Search notes"
                onChange={(event) => setTerm(event.target.value)}
              />
              {term ? (
                <button type="button" className="notes-search-clear" aria-label="Clear search" onClick={() => setTerm('')}>
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Whose notes to show. Chips rather than a dropdown because on a
              board with three people on it this is a one-tap question — "what
              did Sowmya leave me" — and a select costs two taps and a list
              that covers the notes while it is open.

              Only once more than one person has posted: a board with a single
              name on it can only be filtered to the whole board.

              The names come from the same roster the composer's picker uses,
              so this is whoever has actually written something rather than a
              staff list nothing maintains. */}
          {authors.length > 1 ? (
            <div className="notes-people" role="group" aria-label="Show notes from">
              <button
                type="button"
                className={`notes-person${only ? '' : ' is-on'}`}
                aria-pressed={!only}
                onClick={() => setOnly('')}
              >
                Everyone
              </button>
              {authors.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`notes-person${only === name ? ' is-on' : ''}`}
                  aria-pressed={only === name}
                  // Tapping the chip that is already on turns it off, so
                  // getting back to the whole board never needs you to find
                  // "Everyone" at the far end of a scrolled row.
                  onClick={() => setOnly((current) => (current === name ? '' : name))}
                >
                  {name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="notes-scroll" ref={scrollRef}>
            {loading ? <p className="notes-empty">Loading…</p> : null}
            {!loading && notes.length === 0 && !filtering ? (
              <p className="notes-empty">
                Nothing on the board. Type below and it becomes a to-do with a tick box, on every phone and tablet
                signed in to the dashboard.
              </p>
            ) : null}
            {!loading && notes.length === 0 && filtering ? (
              <p className="notes-empty">
                Nothing {filterLabel}. Both the search and the name look at every note on the board, not just the ones
                on screen.
              </p>
            ) : null}
            {filtering && notes.length > 0 ? (
              <p className="notes-truncated">
                {matched} {matched === 1 ? 'note' : 'notes'} {filterLabel}
                {truncated ? `, showing the most recent ${notes.length}` : ''}
              </p>
            ) : null}
            {truncated && !filtering ? (
              <p className="notes-truncated">
                Showing the most recent {notes.length} of {total}.
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.key} className="notes-day">
                <h3 className="notes-day-label">{group.label}</h3>
                {group.notes.map((note) => (
                  <article key={note.id} className={`notes-item${note.done ? ' is-done' : ''}`}>
                    {/* A real checkbox, not a styled button: it is a to-do, so
                        a screen reader should hear a checkbox and the space
                        bar should tick it. */}
                    <input
                      type="checkbox"
                      className="notes-check"
                      checked={note.done}
                      disabled={ticking.includes(note.id)}
                      aria-label={`Mark "${note.body.slice(0, 60)}" as ${note.done ? 'not done' : 'done'}`}
                      onChange={() => void tick(note)}
                    />

                    <div className="notes-item-main">
                      <p className="notes-item-body">{highlight(note.body, query)}</p>
                      <div className="notes-item-meta">
                        {/* The name is highlighted too: searching a person's
                            name is how you find what they left you, and a hit
                            with nothing marked up looks like a mistake. */}
                        <span className="notes-item-author">{highlight(note.author || 'Someone', query)}</span>
                        <span className="notes-item-time">{formatWhen(note.createdAt)}</span>
                        {/* Who ticked it. The point of a shared board is that
                            "already handled" is only useful if you can tell
                            who handled it — otherwise two people both go and
                            order the gas. */}
                        {note.done && note.doneBy ? (
                          <span className="notes-item-doneby">✓ {note.doneBy}</span>
                        ) : null}

                        {confirmingId === note.id ? (
                          <span className="notes-item-confirm">
                            <button type="button" className="notes-confirm-yes" onClick={() => void remove(note.id)}>
                              Delete
                            </button>
                            <button type="button" className="notes-confirm-no" onClick={() => setConfirmingId(null)}>
                              Keep
                            </button>
                          </span>
                        ) : (
                          // Two taps to delete. One is too few for a control
                          // sitting next to the text on a phone screen, and a
                          // deleted note has nowhere to come back from.
                          <button
                            type="button"
                            className="notes-item-delete"
                            aria-label={`Delete note from ${note.author || 'someone'}`}
                            onClick={() => setConfirmingId(note.id)}
                          >
                            <span aria-hidden="true">✕</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>

          <form
            className="notes-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (composerMode === 'task') void submitTask();
              else void submit();
            }}
          >
            {/* Note or task. Two tabs rather than one clever box that guesses:
                a note is a remark that lives until someone deletes it, a task
                is a row of the weekly cadence that comes back every week, and
                getting that wrong in either direction is a nuisance to undo
                on a different screen. */}
            <div className="notes-mode" role="group" aria-label="What to add">
              <button
                type="button"
                className={`notes-mode-tab${composerMode === 'note' ? ' is-on' : ''}`}
                aria-pressed={composerMode === 'note'}
                onClick={() => setComposerMode('note')}
              >
                Note
              </button>
              <button
                type="button"
                className={`notes-mode-tab${composerMode === 'task' ? ' is-on' : ''}`}
                aria-pressed={composerMode === 'task'}
                onClick={() => setComposerMode('task')}
              >
                Task
              </button>
            </div>

            {/* Shared by both composers: the note's "posting as" and the
                task's assignee are the same handful of people, and two
                separate lists of them would drift the first time someone new
                turned up. */}
            <datalist id="notes-authors">
              {authors.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>

            {composerMode === 'note' ? (
              <>
                <label className="notes-author">
                  <span>Posting as</span>
                  {/* A free-text box with suggestions, not a fixed dropdown.
                      There is no roster anywhere in this app — Daily View
                      builds its assignee list off the schedule the same way —
                      so the names on offer are whoever has actually posted,
                      and a new one is just typed in. */}
                  <input
                    type="text"
                    value={author}
                    list="notes-authors"
                    placeholder="your name"
                    maxLength={40}
                    onChange={(event) => rememberAuthor(event.target.value)}
                  />
                </label>

                <div className="notes-composer-row">
                  <textarea
                    ref={inputRef}
                    value={draft}
                    rows={2}
                    maxLength={2000}
                    placeholder="Add a to-do…"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter sends, Shift+Enter breaks the line — the chat
                      // convention, and the one muscle memory everyone
                      // already has. Left alone on a touch keyboard, where
                      // Enter is a newline and the button is what sends.
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <button type="submit" className="notes-send" disabled={!draft.trim() || posting}>
                    {posting ? 'Saving…' : 'Add'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="notes-composer-row">
                  <input
                    ref={taskInputRef}
                    type="text"
                    value={taskDraft}
                    maxLength={140}
                    placeholder={`New ${taskCategory.toLowerCase()} task for ${today}…`}
                    aria-label={`New ${taskCategory.toLowerCase()} task for ${today}`}
                    onChange={(event) => {
                      setTaskDraft(event.target.value);
                      // The "added" line is about the last one, and it stops
                      // being about anything the moment the next is typed.
                      if (taskAdded) setTaskAdded('');
                    }}
                  />
                  <button type="submit" className="notes-send" disabled={!taskDraft.trim() || addingTask}>
                    {addingTask ? 'Adding…' : 'Add'}
                  </button>
                </div>

                {/* Category, time and who, on one row under the box. A select
                    rather than a row of chips: the categories are a closed
                    set, only one can be on, and a whole line of buttons for a
                    field that is usually left on Marketing was more of the
                    panel than the choice is worth. */}
                <div className="notes-task-fields">
                  <select
                    value={taskCategory}
                    aria-label="Category"
                    onChange={(event) => setTaskCategory(event.target.value)}
                  >
                    {categoryChips.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={taskTime}
                    maxLength={10}
                    placeholder="Time"
                    aria-label="Time of day, optional"
                    onChange={(event) => setTaskTime(event.target.value)}
                  />
                  <input
                    type="text"
                    value={taskWho}
                    list="notes-authors"
                    maxLength={40}
                    placeholder="Adarsh"
                    aria-label="Assigned to, optional"
                    onChange={(event) => setTaskWho(event.target.value)}
                  />
                </div>

                {/* Says out loud that this is the cadence and not a one-off,
                    because nothing else on screen could tell you: the strip
                    it lands in is headed "Today". */}
                <p className={`notes-task-hint${taskAdded ? ' is-added' : ''}`} role="status">
                  {taskAdded
                    ? `Added “${taskAdded}” to every ${today}.`
                    : `Joins the weekly cadence — it comes back every ${today}. Change or remove it in Daily View.`}
                </p>
              </>
            )}
          </form>
        </div>
      ) : null}
    </div>
  );
};

export default NotesBubble;
