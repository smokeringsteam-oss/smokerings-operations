// The note bubble's board: today's cadence and the notes typed since, in one
// list, and the one composer that writes to either.
//
// What is worth pinning here is not that the panel opens. It is the handful of
// things that would be wrong in a way nobody would notice by looking at the
// screen:
//
//   * a scheduled job and a note sit in the same day, in one column. That is
//     the whole point of the panel, and it is one lookup in buildGroups away
//     from silently going back to two lists;
//   * the repeat box files the job under *today's* weekday, with the category
//     actually chosen. A task filed under the wrong day or no category still
//     looks like a task in the list and only goes missing next week;
//   * the list shows the whole day, ticked jobs included. A list that drops a
//     row the moment it is ticked cannot show you that you ticked the wrong
//     one, and reads as an empty day by evening;
//   * a search narrows both halves. Tasks are filtered in the browser and
//     notes on the server, so this is the one place the two can disagree.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import NotesBubble from './NotesBubble';

type Task = { id: string; label: string; category: string; assignedTo: string; time: string; done: boolean };
type Note = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  done: boolean;
  doneAt: string | null;
  doneBy: string;
};

const task = (id: string, label: string, extra: Partial<Task> = {}): Task => ({
  id,
  label,
  category: 'Marketing',
  assignedTo: 'Adarsh',
  time: '',
  done: false,
  ...extra,
});

// Stamped now rather than at a fixed date, because the note has to land in the
// group headed "Today" — which is where the tasks go, and the merge of the two
// is what these tests are about.
const note = (id: number, body: string, extra: Partial<Note> = {}): Note => ({
  id,
  author: 'Sowmya',
  body,
  createdAt: new Date().toISOString(),
  done: false,
  doneAt: null,
  doneBy: '',
  ...extra,
});

// Tuesday, because the day has to travel from the /api/today-tasks answer into
// the create call — the browser's own clock is only the fallback.
const strip = (rows: Task[]) => ({
  weekday: 'Tuesday',
  weekKey: '2026-W37',
  tasks: rows,
  done: rows.filter((row) => row.done).length,
  open: rows.filter((row) => !row.done).length,
  fetchedAt: '2026-09-08T06:00:00.000Z',
});

// The server narrows the board itself and echoes back the filter it answered,
// which is what the panel keys its own task filtering off. Mirrored here, or
// the two halves of the list would be tested against different searches.
const board = (rows: Note[], q: string, who: string) => {
  const matches = rows.filter(
    (row) =>
      (!q || `${row.body} ${row.author}`.toLowerCase().includes(q.toLowerCase())) &&
      (!who || row.author.toLowerCase() === who.toLowerCase()),
  );
  return {
    notes: matches,
    total: rows.length,
    query: q,
    author: who,
    matched: matches.length,
    done: matches.filter((row) => row.done).length,
    open: matches.filter((row) => !row.done).length,
    truncated: false,
    authors: Array.from(new Set(rows.map((row) => row.author))),
    fetchedAt: '2026-09-08T06:00:00.000Z',
  };
};

const SCHEDULE = [
  {
    day: 'Tuesday',
    tasks: [
      { id: 'WS-20', label: 'Reddit automation post', defaultTime: '11:00 AM', defaultAssignee: 'Adarsh', category: 'Marketing' },
    ],
  },
  {
    day: 'Friday',
    tasks: [{ id: 'WS-30', label: 'Make BBQ sauce', defaultTime: '', defaultAssignee: 'Sowmya', category: 'Prep' }],
  },
];

let calls: { url: string; method: string; body?: any }[] = [];
let tasks: Task[] = [];
let notes: Note[] = [];

beforeEach(() => {
  calls = [];
  tasks = [];
  notes = [];
  window.localStorage.clear();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, method, body });

      if (url.startsWith('/api/notes')) {
        const params = new URLSearchParams(url.split('?')[1] || '');
        return { ok: true, json: async () => board(notes, params.get('q') || '', params.get('author') || '') };
      }
      if (url === '/api/recurring-schedule') return { ok: true, json: async () => ({ schedule: SCHEDULE }) };
      if (url === '/api/recurring-schedule/tasks') {
        tasks = [...tasks, task(`WS-9${tasks.length}`, body.label, { category: body.category, time: body.time || '' })];
        return { ok: true, json: async () => ({ taskId: 'WS-90', schedule: SCHEDULE }) };
      }
      if (url === '/api/today-tasks') return { ok: true, json: async () => strip(tasks) };
      if (url.startsWith('/api/today-tasks/')) {
        const id = decodeURIComponent(url.split('/').pop()!);
        tasks = tasks.map((row) => (row.id === id ? { ...row, done: body.done } : row));
        return { ok: true, json: async () => strip(tasks) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});

const openPanel = async () => {
  const view = render(<NotesBubble />);
  fireEvent.click(screen.getByRole('button', { name: /open shared notes/i }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/today-tasks')).toBe(true));
  return view;
};

test("today's jobs and the notes are one list, under one Today", async () => {
  tasks = [task('WS-20', 'Reddit automation post', { time: '11:00 AM' })];
  notes = [note(1, 'Gas cylinder is nearly out')];
  const { container } = await openPanel();

  await waitFor(() => expect(screen.getByText('Reddit automation post')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('Gas cylinder is nearly out')).toBeInTheDocument());

  // One day heading, not one per kind of row. Two sections headed Today would
  // be the old split with the tint taken off it.
  const days = Array.from(container.querySelectorAll('.notes-day'));
  const today = days.filter((day) => day.querySelector('.notes-day-label')?.textContent === 'Today');
  expect(today).toHaveLength(1);

  // Both rows in it, cadence first, and both as the same kind of card.
  const rows = Array.from(today[0].querySelectorAll('.notes-item')).map((row) => row.textContent);
  expect(rows[0]).toContain('Reddit automation post');
  expect(rows[1]).toContain('Gas cylinder is nearly out');

  // The header counts the whole board, not just the notes half.
  expect(screen.getByText('2 to do')).toBeInTheDocument();
});

test('the repeat box files a marketing job under today, and it lands in the list', async () => {
  tasks = [task('WS-20', 'Reddit automation post', { time: '11:00 AM' })];
  await openPanel();

  fireEvent.click(screen.getByRole('checkbox', { name: /repeats every tuesday/i }));
  // The categories come off the live schedule, not a hardcoded list.
  await waitFor(() => expect(screen.getByRole('option', { name: 'Prep' })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText(/new marketing task for tuesday/i), {
    target: { value: 'Diwali poster set' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(screen.getByText('Diwali poster set')).toBeInTheDocument());

  const created = calls.find((call) => call.url === '/api/recurring-schedule/tasks');
  expect(created?.body).toMatchObject({ day: 'Tuesday', label: 'Diwali poster set', category: 'Marketing' });
  // Said out loud, because the row it lands in sits under "Today" like every
  // other row and gives no hint that it is also there next week.
  expect(screen.getByText(/Added .*Diwali poster set.* to every Tuesday/i)).toBeInTheDocument();
});

test('with the repeat box clear, the same composer writes a note', async () => {
  await openPanel();

  fireEvent.change(screen.getByLabelText('Add a to-do'), { target: { value: 'Hose is broken' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(calls.some((call) => call.url === '/api/notes' && call.method === 'POST')).toBe(true));
  expect(calls.some((call) => call.url === '/api/recurring-schedule/tasks')).toBe(false);
});

test('the chosen category is the one that gets filed', async () => {
  await openPanel();
  fireEvent.click(screen.getByRole('checkbox', { name: /repeats every tuesday/i }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Prep' })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Prep' } });
  fireEvent.change(screen.getByLabelText(/new prep task for tuesday/i), { target: { value: 'Brine the wings' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => expect(calls.some((call) => call.url === '/api/recurring-schedule/tasks')).toBe(true));
  expect(calls.find((call) => call.url === '/api/recurring-schedule/tasks')?.body.category).toBe('Prep');
});

test('the list shows the whole day, however long it is', async () => {
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

test('a search narrows the jobs as well as the notes', async () => {
  tasks = [task('WS-20', 'Reddit automation post'), task('WS-21', 'Hose down the smoker')];
  notes = [note(1, 'Reddit login is not working'), note(2, 'Order more charcoal')];
  const { container } = await openPanel();

  await waitFor(() => expect(screen.getByText('Hose down the smoker')).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText(/search notes, tasks and names/i), { target: { value: 'reddit' } });

  // The note half is the server's answer; the task half is filtered in the
  // browser. Both have to have moved before this passes.
  await waitFor(() => expect(screen.queryByText('Order more charcoal')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText('Hose down the smoker')).not.toBeInTheDocument());
  // Read off the rows rather than by text, because the matched run is wrapped
  // in a <mark> and getByText would be looking for a string the highlighter
  // has already broken into three.
  const bodies = Array.from(container.querySelectorAll('.notes-item-body')).map((row) => row.textContent);
  expect(bodies).toEqual(['Reddit automation post', 'Reddit login is not working']);
  expect(within(container.querySelector('.notes-scroll')!).getByText(/2 rows matching/)).toBeInTheDocument();

  // Left set, this leaks into the next test through the shared store in
  // useSharedNotes.ts.
  fireEvent.change(screen.getByLabelText(/search notes, tasks and names/i), { target: { value: '' } });
  await waitFor(() => expect(screen.getByText('Order more charcoal')).toBeInTheDocument());
});

// Voice input. The microphone and the recorder are faked, and the transcribe
// endpoint answers from the fetch stub: what matters here is that the words
// join whatever was already typed rather than replacing it, that the mic is
// released, and that nothing is posted until someone presses Add.
class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (type: string) => type.startsWith('audio/webm');
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType || '';
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['sound'], { type: 'audio/webm' }) });
    void this.onstop?.();
  }
}

const withMic = () => {
  const track = { stop: vi.fn() };
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  const realFetch = globalThis.fetch as any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/notes/transcribe') {
        calls.push({ url, method: 'POST' });
        return { ok: true, json: async () => ({ text: 'more gas' }) };
      }
      return realFetch(url, options);
    }),
  );
  return track;
};

test('the mic records, and the words join what is typed and wait for Add', async () => {
  const track = withMic();
  try {
    await openPanel();
    const box = screen.getByLabelText('Add a to-do') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Order' } });

    fireEvent.click(screen.getByRole('button', { name: 'Speak a to-do' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop voice input' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(FakeRecorder.last?.state).toBe('recording');
    // The big mic in the middle of the panel, Google-style, is what ends it.
    expect(screen.getByRole('dialog', { name: 'Voice input' })).toBeInTheDocument();
    expect(screen.getByText('Listening…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done speaking' }));
    await waitFor(() => expect(box.value).toBe('Order more gas'));
    expect(screen.queryByRole('dialog', { name: 'Voice input' })).not.toBeInTheDocument();
    // The phone's mic light goes off with the recording, not with the panel.
    expect(track.stop).toHaveBeenCalled();
    expect(calls.some((call) => call.url === '/api/notes' && call.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/notes' && call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.url === '/api/notes' && call.method === 'POST')?.body).toMatchObject({
      body: 'Order more gas',
    });
  } finally {
    delete (navigator as any).mediaDevices;
  }
});

test('the cross throws the recording away', async () => {
  withMic();
  try {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Speak a to-do' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Voice input' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice input' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Voice input' })).not.toBeInTheDocument());
    expect(calls.some((call) => call.url === '/api/notes/transcribe')).toBe(false);
    expect((screen.getByLabelText('Add a to-do') as HTMLTextAreaElement).value).toBe('');
  } finally {
    delete (navigator as any).mediaDevices;
  }
});

test('a blocked microphone says so instead of looking live', async () => {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    },
  });
  try {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Speak a to-do' }));
    await waitFor(() => expect(screen.getByText(/Microphone access is blocked/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Speak a to-do' })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    delete (navigator as any).mediaDevices;
  }
});

test('a browser that cannot record shows no mic', async () => {
  vi.stubGlobal('MediaRecorder', undefined);
  await openPanel();
  expect(screen.queryByRole('button', { name: 'Speak a to-do' })).not.toBeInTheDocument();
});
