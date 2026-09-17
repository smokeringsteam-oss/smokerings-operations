import { useCallback, useEffect, useState } from 'react';

// Today's row of the weekly cadence, for the strip pinned above the shared
// note board. See server/sprint/todayTasks.js for why the two sit in one
// panel; this is only how the panel gets at it.
//
// Same module-scoped store as useSharedNotes.ts next door, and for the same
// reason — one timer, one request, one copy of the answer however many things
// mount it. The difference is that this one only runs while something asks it
// to: the notes poll has to run all session to keep the bubble's unread count
// honest, but nobody needs today's tasks refreshed behind a closed panel.

export type TodayTask = {
  id: string;
  label: string;
  category: string;
  assignedTo: string;
  time: string;
  done: boolean;
};

export type TodayTasks = {
  weekday: string;
  weekKey: string;
  tasks: TodayTask[];
  done: number;
  open: number;
  fetchedAt: string | null;
};

const EMPTY: TodayTasks = {
  weekday: '',
  weekKey: '',
  tasks: [],
  done: 0,
  open: 0,
  fetchedAt: null,
};

// A minute. Slower than the notes' thirty seconds on purpose: a note is
// somebody typing at you and wants to arrive while they are still standing
// there, whereas the cadence changes when someone finishes a job — and the
// tick that says so already refreshes this on the spot.
const POLL_MS = 60_000;

type Store = { data: TodayTasks | null; error: string | null; loading: boolean };

let store: Store = { data: null, error: null, loading: false };
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
// How many mounted panels currently want this. The timer starts on the first
// and stops on the last, so a session that never opens the panel never asks
// for any of it.
let watchers = 0;

function publish(next: Store) {
  store = next;
  for (const notify of subscribers) notify();
}

async function load(): Promise<void> {
  if (inFlight) return inFlight;
  publish({ ...store, loading: true });
  inFlight = (async () => {
    try {
      const resp = await fetch('/api/today-tasks');
      const body = await resp.json();
      if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
      publish({ data: body as TodayTasks, error: null, loading: false });
    } catch (err) {
      // Last good answer stays on screen, same as the board — a dropped poll
      // must not make a day with five jobs in it look like a day off.
      publish({ ...store, error: err instanceof Error ? err.message : String(err), loading: false });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function onFocus() {
  void load();
}

// The same optimistic tick the note board uses, and for the same reason: a
// checkbox that waits on a round trip reads as one that did not register, and
// the reflex is to tap it again. The server's answer replaces this wholesale a
// moment later.
function withDone(data: TodayTasks, id: string, done: boolean): TodayTasks {
  let changed = false;
  const tasks = data.tasks.map((task) => {
    if (task.id !== id || task.done === done) return task;
    changed = true;
    return { ...task, done };
  });
  if (!changed) return data;
  const delta = done ? 1 : -1;
  return { ...data, tasks, done: data.done + delta, open: data.open - delta };
}

async function setTaskDone(id: string, done: boolean): Promise<void> {
  if (store.data) publish({ ...store, data: withDone(store.data, id, done) });
  let resp: Response;
  let body: unknown;
  try {
    resp = await fetch(`/api/today-tasks/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    body = await resp.json();
  } catch (err) {
    await load();
    throw err;
  }
  if (!resp.ok) {
    await load();
    throw new Error((body as { error?: string })?.error || `Request failed (${resp.status})`);
  }
  // The endpoint answers with the whole strip, so this is the refresh — no
  // second request, and anything ticked on another device arrives with it.
  publish({ data: body as TodayTasks, error: null, loading: false });
}

// Hands a task to someone else for this week. Optimistic like the tick, so the
// new name is on the row the moment Save is tapped.
async function reassignTask(id: string, assignedTo: string): Promise<void> {
  const name = assignedTo.trim();
  if (store.data) {
    const tasks = store.data.tasks.map((task) => (task.id === id ? { ...task, assignedTo: name } : task));
    publish({ ...store, data: { ...store.data, tasks } });
  }
  let resp: Response;
  let body: unknown;
  try {
    resp = await fetch(`/api/today-tasks/${encodeURIComponent(id)}/assignee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: name }),
    });
    body = await resp.json();
  } catch (err) {
    await load();
    throw err;
  }
  if (!resp.ok) {
    await load();
    throw new Error((body as { error?: string })?.error || `Request failed (${resp.status})`);
  }
  publish({ data: body as TodayTasks, error: null, loading: false });
}

// `active` is the panel being open. Passing false keeps the hook mounted and
// the data addressable while costing nothing, which is what lets the bubble
// call it unconditionally.
export function useTodayTasks(active: boolean) {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const notify = () => bump((n) => n + 1);
    subscribers.add(notify);
    watchers += 1;
    if (watchers === 1) {
      timer = setInterval(load, POLL_MS);
      window.addEventListener('focus', onFocus);
    }
    // Always on open, even with an answer already in the store: the panel is
    // usually opened minutes or hours after it was last shut, and the first
    // thing it says should not be this morning's list.
    void load();
    return () => {
      subscribers.delete(notify);
      watchers -= 1;
      if (watchers === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [active]);

  const data = store.data ?? EMPTY;

  return {
    weekday: data.weekday,
    tasks: data.tasks,
    openCount: data.open,
    doneCount: data.done,
    error: store.error,
    // Only before there is anything to show, so a poll never puts a spinner
    // over a list someone is reading.
    loading: store.loading && !store.data,
    setTaskDone: useCallback((id: string, done: boolean) => setTaskDone(id, done), []),
    reassignTask: useCallback((id: string, assignedTo: string) => reassignTask(id, assignedTo), []),
    refresh: useCallback(() => load(), []),
  };
}
