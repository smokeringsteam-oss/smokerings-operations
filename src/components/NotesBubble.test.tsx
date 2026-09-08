// The note bubble's other half: today's cadence, pinned above the board, and
// the tab that adds to it.
//
// What is worth pinning here is not that the panel opens. It is the handful of
// things that would be wrong in a way nobody would notice by looking at the
// screen:
//
//   * the task tab writes to the weekly cadence for *today's* weekday, with
//     the category that is actually lit on the chip row. A task filed under
//     the wrong day or no category at all still looks like a task in the
//     strip and only goes missing next week;
//   * the strip lists the whole day, ticked jobs included. A list that drops a
//     row the moment it is ticked cannot show you that you ticked the wrong
//     one, and reads as an empty day by evening.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import NotesBubble from './NotesBubble';

const EMPTY_BOARD = {
  notes: [],
  total: 0,
  query: '',
  author: '',
  matched: 0,
  done: 0,
  open: 0,
  truncated: false,
  authors: [],
  fetchedAt: '2026-09-08T06:00:00.000Z',
};

type Task = { id: string; label: string; category: string; assignedTo: string; time: string; done: boolean };

const task = (id: string, label: string, extra: Partial<Task> = {}): Task => ({
  id,
  label,
  category: 'Marketing',
  assignedTo: 'Adarsh',
  time: '',
  done: false,
  ...extra,
});

// Tuesday, because that is the day the strip in the screenshot is read on and
// because the day has to travel from the /api/today-tasks answer into the
// create call — the browser's own clock is only the fallback.
const strip = (tasks: Task[]) => ({
  weekday: 'Tuesday',
  weekKey: '2026-W37',
  tasks,
  done: tasks.filter((t) => t.done).length,
  open: tasks.filter((t) => !t.done).length,
  fetchedAt: '2026-09-08T06:00:00.000Z',
});

const SCHEDULE = [
  { day: 'Tuesday', tasks: [{ id: 'WS-20', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh', category: 'Marketing' }] },
  { day: 'Friday', tasks: [{ id: 'WS-30', label: 'Make BBQ sauce', defaultTime: '', defaultAssignee: 'Sowmya', category: 'Prep' }] },
];

let calls: { url: string; method: string; body?: any }[] = [];
let tasks: Task[] = [];

beforeEach(() => {
  calls = [];
  tasks = [];
  window.localStorage.clear();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, method, body });

      if (url.startsWith('/api/notes')) return { ok: true, json: async () => EMPTY_BOARD };
      if (url === '/api/recurring-schedule') return { ok: true, json: async () => ({ schedule: SCHEDULE }) };
      if (url === '/api/recurring-schedule/tasks') {
        tasks = [...tasks, task(`WS-9${tasks.length}`, body.label, { category: body.category, time: body.time || '' })];
        return { ok: true, json: async () => ({ taskId: 'WS-90', schedule: SCHEDULE }) };
      }
      if (url === '/api/today-tasks') return { ok: true, json: async () => strip(tasks) };
      if (url.startsWith('/api/today-tasks/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        tasks = tasks.map((t) => (t.id === id ? { ...t, done: body.done } : t));
        return { ok: true, json: async () => strip(tasks) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});

const openPanel = async () => {
  render(<NotesBubble />);
  fireEvent.click(screen.getByRole('button', { name: /open shared notes/i }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/today-tasks')).toBe(true));
};

test('the task tab files a marketing job under today, and it lands in the strip', async () => {
  tasks = [task('WS-20', 'Reddit automation post', { time: '11:00 AM' })];
  await openPanel();

  fireEvent.click(screen.getByRole('button', { name: 'Task' }));
  // The categories come off the live schedule, not a hardcoded list.
  await waitFor(() => expect(screen.getByRole('option', { name: 'Prep' })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText(/new marketing task for tuesday/i), {
    target: { value: 'Diwali poster set' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(screen.getByText('Diwali poster set')).toBeInTheDocument());

  const created = calls.find((call) => call.url === '/api/recurring-schedule/tasks');
  expect(created?.body).toMatchObject({ day: 'Tuesday', label: 'Diwali poster set', category: 'Marketing' });
  // Said out loud, because the strip it lands in is headed "Today" and gives
  // no hint that this is the cadence rather than a one-off.
  expect(screen.getByText(/every Tuesday/i)).toBeInTheDocument();
});

test('the chosen category is the one that gets filed', async () => {
  await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Task' }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Prep' })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Prep' } });
  fireEvent.change(screen.getByLabelText(/new prep task for tuesday/i), { target: { value: 'Brine the wings' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(calls.some((call) => call.url === '/api/recurring-schedule/tasks')).toBe(true));
  expect(calls.find((call) => call.url === '/api/recurring-schedule/tasks')?.body.category).toBe('Prep');
});

test('the strip lists the whole day, however long it is', async () => {
  tasks = ['one', 'two', 'three', 'four', 'five', 'six'].map((label, i) => task(`WS-${i}`, label));
  await openPanel();

  await waitFor(() => expect(screen.getByText('one')).toBeInTheDocument());
  expect(screen.getByText('six')).toBeInTheDocument();
});

test('a ticked job stays in the list, so a mistick can be put back', async () => {
  tasks = [task('WS-20', 'Reddit automation post'), task('WS-21', 'Poster content post', { done: true })];
  await openPanel();

  await waitFor(() => expect(screen.getByText('Reddit automation post')).toBeInTheDocument());
  const ticked = screen.getByRole('checkbox', { name: /Poster content post" as not done/i });

  fireEvent.click(ticked);
  await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/today-tasks/WS-21'))).toBe(true));
  expect(calls.find((call) => call.url.startsWith('/api/today-tasks/WS-21'))?.body).toEqual({ done: false });
});
