import { useCallback, useEffect, useState } from 'react';

// The shared note board, fetched once for the whole app.
//
// Same shape and same reasoning as useWhatsappAttention.ts next door: two
// things want this data at once and must never disagree — the bubble in the
// top bar, which is mounted for the entire session, and the panel it opens.
// A plain useEffect fetch in each would mean two timers drifting apart and
// twice the polling, forever, on a tab that is often left open all weekend on
// the kitchen tablet. So the fetch lives here, module-scoped: one request,
// one timer, one copy of the answer.
//
// The bubble's count is what makes this feel like a chat rather than a page
// you have to remember to visit. It is "notes newer than the newest one this
// device has seen", kept as a note id in localStorage — per device on purpose,
// because two people should each get told once, not race to clear a flag for
// both of them. Ids, not timestamps: the server hands out note_id in
// insertion order, so two notes posted in the same second still count as two.

export type SharedNote = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  done: boolean;
  doneAt: string | null;
  doneBy: string;
  // Whose job it is, or '' when it is nobody's in particular.
  assignedTo: string;
};

export type SharedNotes = {
  notes: SharedNote[];
  total: number;
  done: number;
  open: number;
  // The search this payload answers, echoed back by the server, and how many
  // notes it found across the whole table rather than just this page.
  query: string;
  // The name the rows are narrowed to, or '' for the whole board.
  author: string;
  matched: number;
  truncated: boolean;
  authors: string[];
  fetchedAt: string | null;
};

type Store = {
  data: SharedNotes | null;
  error: string | null;
  loading: boolean;
};

const EMPTY: SharedNotes = {
  notes: [],
  total: 0,
  done: 0,
  open: 0,
  query: '',
  author: '',
  matched: 0,
  truncated: false,
  authors: [],
  fetchedAt: null,
};

// Thirty seconds. Half the WhatsApp inbox's minute, because this is the one
// place where two people are expected to be typing at each other — a note left
// on the tablet should reach the phone in the time it takes to walk over — and
// the cost is one indexed read of a table with a few hundred rows.
const POLL_MS = 30_000;

// The newest note id this browser has actually looked at. Per device, and
// deliberately not on the server: "seen" is a property of a person in front of
// a screen, and there is no login here to attach it to.
const SEEN_KEY = 'smokerings.notesSeenId';
// The name this browser posts under, remembered so it is chosen once.
const AUTHOR_KEY = 'smokerings.notesAuthor';

function readNumber(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // Unreadable storage is the same as never having seen anything, which
    // errs towards showing a bubble rather than hiding a note.
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // A browser that cannot remember still shows every note; it just keeps
    // offering to tell you about them.
  }
}

export function readNotesAuthor(): string {
  try {
    return window.localStorage.getItem(AUTHOR_KEY) || '';
  } catch {
    return '';
  }
}

export function writeNotesAuthor(name: string): void {
  try {
    window.localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    // Then it gets asked again next time, which is a small price.
  }
}

let store: Store = { data: null, error: null, loading: false };
// Held outside the store so marking notes read re-renders subscribers without
// touching the fetched data, and so a reload starts from what is on disk.
let seenId = 0;
// The search and the name filter every fetch from here carries, including the
// background poll — otherwise the poll would land thirty seconds into a search
// and replace the results with the unfiltered board.
let query = '';
let author = '';
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
// Guards against a focus refresh landing on top of an in-flight poll and the
// slower of the two winning. Keyed by the filters it was issued for, so
// changing either one always starts a fresh request rather than being handed
// the one already running for the previous set.
let inFlight: Promise<void> | null = null;
let inFlightKey = '';
// Every request in issue order. A response is only allowed to reach the store
// if nothing newer has been sent since — without this, typing quickly means
// the answer for "ga" can arrive after the answer for "gas" and win.
let issued = 0;

function publish(next: Store) {
  store = next;
  for (const notify of subscribers) notify();
}

function filterKey(): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (author) params.set('author', author);
  return params.toString();
}

async function load(): Promise<void> {
  const key = filterKey();
  if (inFlight && inFlightKey === key) return inFlight;
  const mine = ++issued;
  inFlightKey = key;
  publish({ ...store, loading: true });
  inFlight = (async () => {
    try {
      const resp = await fetch(key ? `/api/notes?${key}` : '/api/notes');
      const body = await resp.json();
      if (mine !== issued) return;
      if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
      publish({ data: body as SharedNotes, error: null, loading: false });
    } catch (err) {
      if (mine !== issued) return;
      // The last good answer is deliberately kept on screen. A dropped Wi-Fi
      // poll should not blank the panel into looking like nobody wrote
      // anything.
      publish({ ...store, error: err instanceof Error ? err.message : String(err), loading: false });
    } finally {
      if (mine === issued) inFlight = null;
    }
  })();
  return inFlight;
}

// Runs a new search. Called from the panel behind a short debounce, so this is
// one request per pause in typing rather than one per keystroke.
function search(next: string): Promise<void> {
  const trimmed = next.trim();
  if (trimmed === query) return Promise.resolve();
  query = trimmed;
  return load();
}

// Narrows the board to one person, or back to everyone with ''. Not debounced:
// this is a tap on a name, not typing, so there is one request per tap and no
// pause to wait for.
function filterByAuthor(next: string): Promise<void> {
  const trimmed = next.trim();
  if (trimmed === author) return Promise.resolve();
  author = trimmed;
  return load();
}

// The timer and the focus listener only exist while something is watching, so
// a session that never mounts the bubble costs nothing.
function startPolling() {
  if (timer) return;
  timer = setInterval(load, POLL_MS);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onVisibility);
}

function onFocus() {
  void load();
}

function onVisibility() {
  if (!document.hidden) void load();
}

async function post(body: string, author: string): Promise<SharedNote> {
  const resp = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author }),
  });
  const created = await resp.json();
  if (!resp.ok) throw new Error(created?.error || `Request failed (${resp.status})`);
  // Refetch rather than splice the new note in: the poll may be a full thirty
  // seconds away, and anything another device wrote in the meantime should
  // arrive alongside your own note rather than after it.
  await load();
  return created as SharedNote;
}

// The same board with one note's tick flipped, counts included. Used to move
// the box before the server has answered.
function withDone(data: SharedNotes, id: number, done: boolean, by: string): SharedNotes {
  let changed = false;
  const notes = data.notes.map((note) => {
    if (note.id !== id || note.done === done) return note;
    changed = true;
    return { ...note, done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? by : '' };
  });
  if (!changed) return data;
  const delta = done ? 1 : -1;
  return { ...data, notes, done: data.done + delta, open: data.open - delta };
}

// Ticking is a write to the server, not a flag in this browser: one person
// marking the gas ordered has to reach the other phone before someone orders
// it twice.
//
// The box moves before the request goes out, though. A checkbox is the one
// control where any delay reads as "it didn't register" — the reflex is to tap
// it again — and on a phone on kitchen wifi the round trip is long enough to
// provoke exactly that. So the tick is applied locally first and the server is
// told after; a failure reloads the board, which puts the box back where the
// server says it belongs and lets the caller show why.
async function setDone(id: number, done: boolean, by: string): Promise<void> {
  if (store.data) publish({ ...store, data: withDone(store.data, id, done, by) });
  let resp: Response;
  let updated: unknown;
  try {
    resp = await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done, by }),
    });
    updated = await resp.json();
  } catch (err) {
    await load();
    throw err;
  }
  if (!resp.ok) {
    await load();
    throw new Error((updated as { error?: string })?.error || `Request failed (${resp.status})`);
  }
  // Still a full reload on success: the server owns doneAt, and another
  // device's changes should arrive with your own rather than after it.
  await load();
}

// Hands a note to someone (or to nobody with ''). Optimistic like the tick, so
// the new name is on the row the moment Save is tapped.
async function assign(id: number, assignedTo: string): Promise<void> {
  const name = assignedTo.trim();
  if (store.data) {
    const notes = store.data.notes.map((note) => (note.id === id ? { ...note, assignedTo: name } : note));
    publish({ ...store, data: { ...store.data, notes } });
  }
  let resp: Response;
  let updated: unknown;
  try {
    resp = await fetch(`/api/notes/${id}/assignee`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: name }),
    });
    updated = await resp.json();
  } catch (err) {
    await load();
    throw err;
  }
  if (!resp.ok) {
    await load();
    throw new Error((updated as { error?: string })?.error || `Request failed (${resp.status})`);
  }
  await load();
}

async function destroy(id: number): Promise<void> {
  const resp = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
  await load();
}

export function useSharedNotes() {
  // A counter rather than the store itself: subscribers re-render on both a
  // new fetch and a change to seenId, and only one of those lives in `store`.
  const [, bump] = useState(0);

  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    subscribers.add(notify);
    if (!seenId) seenId = readNumber(SEEN_KEY);
    startPolling();
    // First subscriber pays for the initial fetch; the second arrives to an
    // answer already in the store.
    if (!store.data && !inFlight) void load();
    return () => {
      subscribers.delete(notify);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  const data = store.data ?? EMPTY;

  // Everything above the watermark, whoever wrote it — including this device.
  // Marking read happens while the panel is open, and a note you just posted
  // is a note you are looking at, so it clears itself.
  const unread = data.notes.reduce((count, note) => (note.id > seenId ? count + 1 : count), 0);

  const markRead = useCallback(() => {
    const newest = store.data?.notes.reduce((max, note) => (note.id > max ? note.id : max), 0) ?? 0;
    if (newest <= seenId) return;
    seenId = newest;
    writeNumber(SEEN_KEY, newest);
    for (const notify of subscribers) notify();
  }, []);

  return {
    notes: data.notes,
    total: data.total,
    doneCount: data.done,
    openCount: data.open,
    // The search these results answer — the server's echo, not what is in the
    // box, so highlighting never marks up a term the rows were not filtered by
    // while a request is still in the air.
    query: data.query,
    // Likewise the name the rows are narrowed to — the server's echo, so a
    // chip never lights up for a filter the rows have not answered yet.
    author: data.author,
    matched: data.matched,
    search: useCallback((next: string) => search(next), []),
    filterByAuthor: useCallback((next: string) => filterByAuthor(next), []),
    truncated: data.truncated,
    authors: data.authors,
    unread,
    markRead,
    error: store.error,
    // Only "loading" before there is anything to show — a background poll must
    // not put a spinner over notes you are reading.
    loading: store.loading && !store.data,
    refresh: useCallback(() => load(), []),
    addNote: useCallback((body: string, author: string) => post(body, author), []),
    setDone: useCallback((id: number, done: boolean, by: string) => setDone(id, done, by), []),
    assignNote: useCallback((id: number, assignedTo: string) => assign(id, assignedTo), []),
    deleteNote: useCallback((id: number) => destroy(id), []),
  };
}
