import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { readNotesAuthor, useSharedNotes, writeNotesAuthor, type SharedNote } from '../lib/useSharedNotes';
import { useTodayTasks, type TodayTask } from '../lib/useTodayTasks';
import { usePersistedState } from '../lib/usePersistedState';
import { useVoiceInput } from '../lib/useVoiceInput';
import { useWakeWord, wakeWordSupported } from '../lib/useWakeWord';
import VoiceOverlay from './VoiceOverlay';
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
// Today's row of the weekly cadence sits in that same list, under Today,
// rather than in a strip of its own above it. The strip was a second board
// with its own heading, its own collapse and its own tick boxes, and it took
// a third of the panel before a single note was read — on a phone it pushed
// the name filters off the screen altogether. What someone opening this wants
// is one column of everything still to do; that a row comes back every week
// is a detail of the row, marked on the row, not a reason to keep it
// somewhere else. Those tick boxes write to the same table Daily View writes
// to — see server/sprint/todayTasks.js — so a job ticked here is ticked
// there, and neither screen can claim it is still open.

// Same threshold the sidebar badge uses, so the two bubbles never disagree
// about what a big number looks like.
const MAX_BADGE = 99;

// The two people who work the board. A fixed pair rather than free text, so a
// typo ("sowmya ", "Adarsh K") never splits one person across two name chips.
const TEAM = ['Adarsh', 'Sowmya'];

// The team, plus a name already on a row or in storage that is not one of
// them — so a select never silently shows the wrong person for an old value.
function teamWith(current: string): string[] {
  const name = current.trim();
  return name && !TEAM.some((member) => member.toLowerCase() === name.toLowerCase()) ? [...TEAM, name] : TEAM;
}

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

// One row of the board. A note and a scheduled job are different records with
// different lifetimes, but they are the same thing to read — a line with a
// tick box — so they travel through the list as one type and only the row
// renderer tells them apart.
type BoardItem =
  | { kind: 'note'; key: string; note: SharedNote }
  | { kind: 'task'; key: string; task: TodayTask };

type Group = { key: string; label: string; items: BoardItem[] };

// The board as days, newest day last, with today's scheduled jobs at the head
// of Today.
//
// The server already returns notes oldest first, so the run only has to be
// broken whenever the day label changes. Tasks are not dated the same way —
// they are today's row of a weekly cadence — so they go in at the top of
// Today, ahead of the notes typed since, and Today is created for them on a
// day nobody has written anything.
//
// Ticked rows stay where they are rather than sinking to the bottom. A board
// this size is read as a list of the last few days, and an item that jumped
// somewhere else the instant you ticked it would take the thing you had just
// been looking at out from under you.
function buildGroups(notes: SharedNote[], tasks: TodayTask[]): Group[] {
  const groups: Group[] = [];
  for (const note of notes) {
    const label = dayLabel(note.createdAt);
    const item: BoardItem = { kind: 'note', key: `note-${note.id}`, note };
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ key: `${label}-note-${note.id}`, label, items: [item] });
  }
  if (tasks.length) {
    const items: BoardItem[] = tasks.map((task) => ({ kind: 'task', key: `task-${task.id}`, task }));
    const today = groups.find((group) => group.label === 'Today');
    if (today) today.items.unshift(...items);
    else groups.push({ key: 'today-tasks', label: 'Today', items });
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
    assignNote,
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
    reassignTask,
    refresh: refreshTasks,
  } = useTodayTasks(open);
  // The row whose assignee is being changed — its board key, "task-WS-01" or
  // "note-12" — and the name typed so far. One at a time: a second open picker
  // on a phone-width panel is two half-seen forms rather than two useful ones.
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  const [reassignName, setReassignName] = useState('');
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
  // Whether what is being typed joins the weekly cadence instead of being a
  // one-off note. A tick box on the composer rather than a pair of mode tabs
  // above it: there is one box, one Add button and one thing being written
  // down, and the only real question is whether it comes back next week.
  //
  // Not remembered between opens. A tab that stayed on Task was how a note
  // ended up filed as a standing job, and unpicking that means a trip to
  // Daily View.
  const [repeatWeekly, setRepeatWeekly] = useState(false);
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
  // Dictation into the composer. Each recording is added to the end of
  // whatever is already in the box, so speaking and typing mix freely — say
  // most of it, fix a word by hand, say the rest. Nothing is sent on its own:
  // a recogniser that mishears "gas" as "glass" must still pass a human eye
  // before it lands on the board.
  const voice = useVoiceInput((text) => {
    setDraft((current) => {
      const joined = current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`;
      return joined.slice(0, repeatWeekly ? 140 : 2000);
    });
    if (taskAdded) setTaskAdded('');
  });
  // "Hey Smokey" — per device, because it is the kitchen tablet that should
  // be listening and not everybody's phone. Off until someone turns it on.
  const [heySmokey, setHeySmokey] = usePersistedState<boolean>('notes.heySmokey', false, (stored) =>
    typeof stored === 'boolean' ? stored : undefined,
  );
  const [canWake] = useState(wakeWordSupported);
  const wake = useWakeWord({
    enabled: heySmokey && canWake,
    paused: voice.listening || voice.transcribing,
    onWake: (command) => {
      setOpen(true);
      if (command) {
        // "Hey Smokey, order more gas" — said in one breath, so it goes
        // straight into the box. Still waits for Add, like every voice note.
        setDraft((current) => (current.trim() ? `${current.trimEnd()} ${command}` : command));
        if (taskAdded) setTaskAdded('');
      } else {
        voice.start({ handsFree: true });
      }
    },
  });
  const stopVoice = voice.stop;
  // The panel closing is the person done with it; a mic left live behind a
  // closed panel would keep recording a kitchen nobody is talking to.
  useEffect(() => {
    if (!open) stopVoice();
  }, [open, stopVoice]);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // The weekday the task tab writes to. The server's answer is the one to
  // trust — it is what picked today's rows — but it is empty until the first
  // fetch lands, and the tab must not offer to add a task to "" in the
  // meantime.
  const localWeekday = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long' }), []);
  const today = weekday || localWeekday;

  // Today's jobs, narrowed by whatever the board is narrowed by. The search
  // and the name chips are filters on the list, and the list now has tasks in
  // it — a search that quietly left five unrelated jobs sitting at the top of
  // Today would read as five results that do not match.
  //
  // Read off `query` and `filteredAuthor` — the server's echo of the filter
  // the notes on screen actually answer — rather than off the controls, so the
  // two halves of the list never show two different searches for a frame.
  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const who = filteredAuthor.trim().toLowerCase();
    return tasks.filter((task) => {
      if (who && task.assignedTo.trim().toLowerCase() !== who) return false;
      if (!needle) return true;
      return `${task.label} ${task.assignedTo} ${task.category}`.toLowerCase().includes(needle);
    });
  }, [tasks, query, filteredAuthor]);

  const groups = useMemo(() => buildGroups(notes, visibleTasks), [notes, visibleTasks]);
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
      // Back to a plain note. Filing something under the weekly cadence is a
      // deliberate detour, and reopening the bubble with the box still armed
      // to repeat would turn the next thing typed into a standing job.
      setRepeatWeekly(false);
      setTaskAdded('');
      setReassigningId(null);
    }
  }, [open]);

  // The categories, the first time the repeat box is ticked. Falls back to
  // whatever today's own rows are already tagged with, so the picker is never
  // empty even with the schedule request refused.
  useEffect(() => {
    if (!repeatWeekly || categories.length) return;
    let live = true;
    void fetchRecurringSchedule().then((schedule) => {
      if (live) setCategories(getCategoryNames(schedule));
    });
    return () => {
      live = false;
    };
  }, [repeatWeekly, categories.length]);

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
      // An open reassign box is the innermost thing of all.
      if (reassigningId) {
        closeNameEditor();
        return;
      }
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
  }, [open, term, only, reassigningId]);

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

  // Everyone the board knows about: whoever has posted a note, plus whoever
  // today's jobs are on. Both, because the chips filter one list now — a
  // Sowmya who has three jobs today but has not typed a note would otherwise
  // be missing from the row that exists to answer "what is mine".
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    // Tolerates a missing name: a server not yet restarted onto the assignee
    // column sends notes without one.
    const add = (name: string | undefined) => {
      const trimmed = (name || '').trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
    };
    authors.forEach(add);
    tasks.forEach((task) => add(task.assignedTo));
    notes.forEach((note) => add(note.assignedTo));
    return Array.from(seen.values());
  }, [authors, tasks, notes]);

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

  // The row being edited, mirrored in a ref so Enter and the blur that follows
  // it do not both save.
  const editingRef = useRef<string | null>(null);

  const closeNameEditor = () => {
    editingRef.current = null;
    setReassigningId(null);
  };

  // The name on a row, which is also where it is changed: tap it and it
  // becomes a text box in the same spot; Enter or tapping away saves, Escape
  // puts it back. No buttons or explanation — the name just changes.
  //
  // A task needs a name; a note cleared to blank goes back to showing its
  // poster.
  const renderName = (opts: {
    key: string;
    shown: string;
    allowBlank: boolean;
    label: string;
    write: (name: string) => Promise<void>;
  }) => {
    const save = async (picked: string) => {
      if (editingRef.current !== opts.key) return;
      const name = picked.trim();
      closeNameEditor();
      if ((!name && !opts.allowBlank) || name === opts.shown.trim()) return;
      setActionError(null);
      try {
        await opts.write(name);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    };
    if (reassigningId === opts.key) {
      return (
        <select
          className="notes-name-input"
          value={reassignName}
          aria-label={`Assignee for "${opts.label}"`}
          autoFocus
          onChange={(event) => {
            setReassignName(event.target.value);
            void save(event.target.value);
          }}
          onBlur={() => closeNameEditor()}
        >
          {opts.allowBlank ? <option value="">Poster</option> : null}
          {teamWith(opts.shown).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      );
    }
    return (
      <button
        type="button"
        className="notes-item-author notes-reassign"
        aria-label={`Change who "${opts.label}" is on, now ${opts.shown || 'nobody'}`}
        onClick={() => {
          editingRef.current = opts.key;
          setReassigningId(opts.key);
          setReassignName(opts.shown);
        }}
      >
        {highlight(opts.shown || 'Someone', query)}
      </button>
    );
  };

  // Adds a job to today's row of the cadence — the same write Daily View's
  // add row makes, from the composer that is already open.
  //
  // It lands in `scheduled_task`, which is the weekly cadence and not a list
  // for today only: a task added here comes back next Tuesday too. That is
  // the right default for what actually gets typed in — "Reddit automation
  // post" is a standing job someone forgot to write down — but it is not
  // guessable from a text box, so the form says so in as many words.
  const submitTask = async () => {
    const label = draft.trim();
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
      // The list is the confirmation — the job appears under Today — so it is
      // refetched here rather than waited on at the next poll.
      await refreshTasks();
      setDraft('');
      setTaskTime('');
      setTaskAdded(label);
      inputRef.current?.focus();
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

  // One count for the whole board, now that it is one board. Two numbers in
  // the header — one for notes, one for the cadence — would put back in the
  // heading the split the list itself no longer makes.
  const openTotal = openCount + tasksOpen;
  const doneTotal = doneCount + tasksDone;

  const summary =
    total + tasks.length === 0
      ? 'Nothing yet'
      : [openTotal > 0 ? `${openTotal} to do` : null, doneTotal > 0 ? `${doneTotal} done` : null]
          .filter(Boolean)
          .join(' · ') || 'All done';

  // Nothing to show at all, as against nothing that matches. The two need
  // different words and only one of them means the board is empty.
  const boardEmpty = notes.length === 0 && visibleTasks.length === 0;
  // How many rows a filter found across the whole board: the server's count
  // for notes plus today's matching jobs, which are filtered here.
  const matchedTotal = matched + visibleTasks.length;

  // A note, rendered as a row of the board. The same card the scheduled jobs
  // above use, so a column of the two reads as one list of things to do.
  const renderNote = (note: SharedNote, key: string) => (
    <article key={key} className={`notes-item${note.done ? ' is-done' : ''}`}>
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
          {/* One name: whoever it is on, else whoever posted it. Tap to
              change it. Highlighted too, since searching a name is how you
              find what is yours. */}
          {renderName({
            key,
            shown: note.assignedTo || note.author || '',
            allowBlank: true,
            label: note.body.slice(0, 60),
            write: (name) => assignNote(note.id, name),
          })}
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
  );

  // A scheduled job, rendered as a row of the board — the same card, the same
  // tick box in the same column as a note's, because the whole point of
  // putting the two in one list is that reading it is one job and not two.
  //
  // What still marks it out is on the row itself: the ↻ that says it comes
  // back, and the category chip. No delete cross, because a row of the weekly
  // cadence is not deleted from a day — that is Daily View's to do, and a ✕
  // here would have to mean something different from the one two rows down.
  const renderTask = (task: TodayTask, key: string) => (
    <article key={key} className={`notes-item is-task${task.done ? ' is-done' : ''}`}>
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
      <div className="notes-item-main">
        <p className="notes-item-body">{highlight(task.label, query)}</p>
        <div className="notes-item-meta">
          {/* Says this one is the cadence rather than something somebody
              typed today. One glyph, because it is the only thing about the
              row a reader has to be told and the rest of the line is already
              doing work. */}
          <span className="notes-item-repeat" title={`Repeats every ${today} — change it in Daily View`}>
            <span aria-hidden="true">↻</span>
            <span className="notes-sr">Repeats every {today}</span>
          </span>
          {/* What kind of job it is. Worth a chip rather than being left
              implicit in the wording: on most days this is a mix of marketing
              and kitchen work, and which of the two a row is decides whether
              it is yours before the words are read. */}
          {task.category ? (
            <span
              className={`notes-task-tag${
                task.category.toLowerCase() === MARKETING_CATEGORY.toLowerCase() ? ' is-marketing' : ''
              }`}
            >
              {task.category}
            </span>
          ) : null}
          {/* Who it is on. The board is read by whoever picked the tablet up,
              and half of what it has to answer is whether the job is theirs.
              Tap it to change it — for this week only. */}
          {renderName({
            key,
            shown: task.assignedTo,
            allowBlank: false,
            label: task.label,
            write: (name) => reassignTask(task.id, name),
          })}
          {task.time ? <span className="notes-task-time">{task.time}</span> : null}
        </div>
      </div>
    </article>
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
        title={heySmokey && wake.state === 'listening' ? 'Listening for “Hey Smokey”' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span aria-hidden="true">💬</span>
        {/* The mic is open in the background: said on the button itself, so
            it is never live without anyone being able to see that it is. */}
        {heySmokey && (wake.state === 'listening' || wake.state === 'paused') ? (
          <span className="notes-wake-live" aria-hidden="true" />
        ) : null}
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
            {canWake ? (
              <button
                type="button"
                className={`notes-wake${heySmokey ? ' is-on' : ''}`}
                aria-pressed={heySmokey}
                title={
                  heySmokey
                    ? 'Listening for “Hey Smokey” on this device — tap to stop'
                    : 'Say “Hey Smokey” to add a note hands-free on this device'
                }
                onClick={() => setHeySmokey((on) => !on)}
              >
                <span className="notes-wake-dot" aria-hidden="true" />
                Hey Smokey
              </button>
            ) : null}
            <button type="button" className="notes-close" aria-label="Close shared notes" onClick={() => setOpen(false)}>
              <span aria-hidden="true">✕</span>
            </button>
          </header>

          {/* The last poll failed. Said out loud rather than left to look like
              a quiet board, because "nobody wrote anything" and "we could not
              reach the server" are the same picture otherwise. */}
          {error ? <p className="notes-alert">Could not refresh — {error}</p> : null}
          {actionError ? <p className="notes-alert">{actionError}</p> : null}
          {heySmokey && wake.error ? <p className="notes-alert">{wake.error}</p> : null}
          {tasksError ? <p className="notes-alert">Could not load today's tasks — {tasksError}</p> : null}

          {/* Only once there is something to search. On an empty board the row
              would be a control that cannot do anything, sitting where the
              "nothing here yet" line should be. */}
          {total > 0 || tasks.length > 0 ? (
            <div className="notes-search">
              <span className="notes-search-icon" aria-hidden="true">
                🔍
              </span>
              <input
                type="search"
                value={term}
                placeholder="Search the board…"
                aria-label="Search notes, tasks and names"
                onChange={(event) => setTerm(event.target.value)}
              />
              {term ? (
                <button type="button" className="notes-search-clear" aria-label="Clear search" onClick={() => setTerm('')}>
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Whose rows to show — notes they wrote and jobs they are on, since
              the list no longer separates the two. Chips rather than a
              dropdown because on a board with three people this is a one-tap
              question — "what is mine" — and a select costs two taps and a
              list that covers the board while it is open.

              Only once more than one name is in play: a board with a single
              name on it can only be filtered to the whole board.

              The names are whoever has actually posted or been given a job
              today, rather than a staff list nothing maintains. */}
          {people.length > 1 ? (
            <div className="notes-people" role="group" aria-label="Show rows for">
              <button
                type="button"
                className={`notes-person${only ? '' : ' is-on'}`}
                aria-pressed={!only}
                onClick={() => setOnly('')}
              >
                Everyone
              </button>
              {people.map((name) => (
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
            {!loading && boardEmpty && !filtering ? (
              <p className="notes-empty">
                Nothing on the board. Type below and it becomes a to-do with a tick box, on every phone and tablet
                signed in to the dashboard.
              </p>
            ) : null}
            {!loading && boardEmpty && filtering ? (
              <p className="notes-empty">
                Nothing {filterLabel}. Both the search and the name look at every row on the board, not just the ones
                on screen.
              </p>
            ) : null}
            {filtering && !boardEmpty ? (
              <p className="notes-truncated">
                {matchedTotal} {matchedTotal === 1 ? 'row' : 'rows'} {filterLabel}
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
                {group.items.map((item) =>
                  item.kind === 'task' ? renderTask(item.task, item.key) : renderNote(item.note, item.key),
                )}
              </section>
            ))}
          </div>
          <form
            className="notes-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (repeatWeekly) void submitTask();
              else void submit();
            }}
          >
            <label className="notes-author">
              <span>Posting as</span>
              {/* A fixed dropdown of the two people on the board. */}
              <select value={author} onChange={(event) => rememberAuthor(event.target.value)}>
                {author ? null : (
                  <option value="" disabled>
                    Pick your name
                  </option>
                )}
                {teamWith(author).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <div className="notes-composer-row">
              {/* One box for both. The list above no longer separates a note
                  from a scheduled job, and neither should the thing that adds
                  to it: what is typed is a to-do either way, and the only
                  question left is the tick box underneath. */}
              <textarea
                ref={inputRef}
                value={draft}
                rows={2}
                maxLength={repeatWeekly ? 140 : 2000}
                placeholder={repeatWeekly ? `New ${taskCategory.toLowerCase()} task for ${today}…` : 'Add a to-do…'}
                aria-label={repeatWeekly ? `New ${taskCategory.toLowerCase()} task for ${today}` : 'Add a to-do'}
                onChange={(event) => {
                  setDraft(event.target.value);
                  // The "added" line is about the last one, and it stops being
                  // about anything the moment the next is typed.
                  if (taskAdded) setTaskAdded('');
                }}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line — the chat
                  // convention, and the one muscle memory everyone already
                  // has. Left alone on a touch keyboard, where Enter is a
                  // newline and the button is what sends.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (repeatWeekly) void submitTask();
                    else void submit();
                  }
                }}
              />
              {voice.supported ? (
                <button
                  type="button"
                  className={`notes-mic${voice.listening ? ' is-listening' : ''}`}
                  aria-pressed={voice.listening}
                  aria-label={voice.listening ? 'Stop voice input' : 'Speak a to-do'}
                  title={voice.listening ? 'Stop voice input' : 'Speak a to-do'}
                  disabled={voice.transcribing}
                  onClick={() => voice.toggle()}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
                    />
                  </svg>
                </button>
              ) : null}
              <button
                type="submit"
                className="notes-send"
                disabled={!draft.trim() || posting || addingTask || voice.listening || voice.transcribing}
              >
                {posting || addingTask ? 'Saving…' : 'Add'}
              </button>
            </div>

            {/* The one real difference between the two things this box can
                write, asked as one question instead of a pair of mode tabs:
                does it come back next week. Off by default, because most of
                what gets typed here came up ten seconds ago. */}
            <label className="notes-repeat">
              <input
                type="checkbox"
                checked={repeatWeekly}
                onChange={(event) => {
                  setRepeatWeekly(event.target.checked);
                  if (!event.target.checked) setTaskAdded('');
                }}
              />
              <span>Repeats every {today}</span>
            </label>

            {repeatWeekly ? (
              <>
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
                  <select
                    value={taskWho || TEAM[0]}
                    aria-label="Assigned to"
                    onChange={(event) => setTaskWho(event.target.value)}
                  >
                    {TEAM.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Says out loud that this is the cadence and not a one-off.
                    The row it lands in sits under "Today" like everything
                    else, so nothing on screen would otherwise say that it is
                    also there next week. */}
                <p className={`notes-task-hint${taskAdded ? ' is-added' : ''}`} role="status">
                  {taskAdded
                    ? `Added “${taskAdded}” to every ${today}.`
                    : `Joins the weekly cadence — it comes back every ${today}. Change or remove it in Daily View.`}
                </p>
              </>
            ) : null}
          </form>
          <VoiceOverlay voice={voice} />
        </div>
      ) : null}
    </div>
  );
};

export default NotesBubble;
