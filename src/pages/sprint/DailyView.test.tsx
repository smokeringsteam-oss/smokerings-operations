// Daily View's edit mode, rendered.
//
// Two different things get written from this one list and they must not blur
// together: a tick is this week only (task_completion), while an edit changes
// the cadence itself (scheduled_task) and so every week after this one. So
// these tests assert on which endpoint each gesture hits and with what — plus
// the two things the field-per-row layout makes easy to get wrong: tabbing
// across a row firing writes for fields nobody touched, and the person filter
// hiding rows while someone is reordering them.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import DailyView from './DailyView';

const monday = () => ({
  day: 'Monday',
  tasks: [
    { id: 'WS-01', label: 'Review weekend sales', defaultTime: '9:00 AM', defaultAssignee: 'Adarsh', category: 'Review' },
    { id: 'WS-02', label: 'Order pork', defaultTime: '11:00 AM', defaultAssignee: 'Sowmya', category: 'Procurement' },
    { id: 'WS-09', label: 'Post reel', defaultTime: '6:00 PM', defaultAssignee: 'Sowmya', category: 'Marketing' },
  ],
});

const schedule = () => [monday(), { day: 'Tuesday', tasks: [] }];

// Every call the page makes, keyed by what it asks for. Schedule writes answer
// with the whole schedule the way the server does; the fixture is regenerated
// per call so a test that mutates one response can't leak into the next.
let calls: { url: string; method: string; body: unknown }[] = [];

const respond = (url: string) => {
  if (url.startsWith('/api/recurring-schedule/status')) return { weekState: {} };
  if (url.startsWith('/api/recurring-schedule')) return { schedule: schedule() };
  if (url === '/api/github/status') return { configured: false };
  return {};
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({
        url,
        method: options?.method || 'GET',
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      });
      return { ok: true, json: async () => respond(url) };
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const writes = () => calls.filter((call) => call.method !== 'GET');

// The page opens on today, whatever day the suite happens to run on, so every
// test steps to the day the fixture describes and waits for its rows — which
// also confirms the live schedule replaced the built-in fallback.
const openMonday = async () => {
  render(<DailyView />);
  fireEvent.click(await screen.findByRole('button', { name: /^Monday/ }));
  await screen.findByText('Review weekend sales');
};

const startEditing = async () => {
  await openMonday();
  fireEvent.click(screen.getByRole('button', { name: /edit schedule/i }));
};

test('edit mode turns the rows into fields holding what the schedule says', async () => {
  await startEditing();

  expect(screen.getByLabelText('Task name for Review weekend sales')).toHaveValue('Review weekend sales');
  expect(screen.getByLabelText('Time for Review weekend sales')).toHaveValue('9:00 AM');
  expect(screen.getByLabelText('Assignee for Order pork')).toHaveValue('Sowmya');
  expect(screen.getByLabelText('Category for Order pork')).toHaveValue('Procurement');
});

test('changing an assignee patches only that field, and only on blur', async () => {
  await startEditing();

  const field = screen.getByLabelText('Assignee for Order pork');
  fireEvent.change(field, { target: { value: 'Adarsh' } });
  expect(writes()).toHaveLength(0);

  fireEvent.blur(field);

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    url: '/api/recurring-schedule/tasks/WS-02',
    method: 'PATCH',
    body: { assignedTo: 'Adarsh' },
  });
});

test('blurring a field nobody changed writes nothing', async () => {
  await startEditing();

  fireEvent.blur(screen.getByLabelText('Task name for Order pork'));
  fireEvent.blur(screen.getByLabelText('Time for Order pork'));
  fireEvent.blur(screen.getByLabelText('Assignee for Order pork'));

  expect(writes()).toHaveLength(0);
});

test('a task cannot be renamed to nothing', async () => {
  await startEditing();

  const field = screen.getByLabelText('Task name for Order pork');
  fireEvent.change(field, { target: { value: '   ' } });
  fireEvent.blur(field);

  expect(writes()).toHaveLength(0);
  expect(screen.getByText(/a task needs a name/i)).toBeInTheDocument();
});

test('the person filter narrows the list, but never while editing', async () => {
  await openMonday();

  fireEvent.change(screen.getByLabelText(/filter by assignee/i), { target: { value: 'Sowmya' } });
  expect(screen.queryByText('Review weekend sales')).not.toBeInTheDocument();

  // Reordering against a half-hidden list would be unreadable, and a task is
  // often moved precisely because it belongs to someone else now.
  fireEvent.click(screen.getByRole('button', { name: /edit schedule/i }));
  expect(screen.getByLabelText('Task name for Review weekend sales')).toBeInTheDocument();
});

test('a new task lands on the day on screen, assigned to whoever is filtered in', async () => {
  await openMonday();
  fireEvent.change(screen.getByLabelText(/filter by assignee/i), { target: { value: 'Sowmya' } });
  fireEvent.click(screen.getByRole('button', { name: /edit schedule/i }));

  fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Count the wood' } });
  fireEvent.click(screen.getAllByRole('button', { name: /^Add$/ })[0]);

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    url: '/api/recurring-schedule/tasks',
    method: 'POST',
    body: { day: 'Monday', label: 'Count the wood', assignedTo: 'Sowmya', category: '' },
  });
});

test('a task added under Marketing gets that category', async () => {
  await startEditing();

  const field = screen.getByLabelText('New marketing task');
  fireEvent.change(field, { target: { value: 'Story teaser' } });
  // The marketing card's own Add, not the ops card's — the category comes from
  // which card the row sits in, so pressing the wrong one proves nothing.
  fireEvent.click(within(field.closest('.daily-view-add-row') as HTMLElement).getByRole('button', { name: /^Add$/ }));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    url: '/api/recurring-schedule/tasks',
    method: 'POST',
    body: { day: 'Monday', label: 'Story teaser', category: 'Marketing' },
  });
});

test('nudging a row down moves it among the day’s other tasks', async () => {
  await startEditing();

  fireEvent.click(screen.getByLabelText('Move Review weekend sales down'));

  await waitFor(() => expect(writes()).toHaveLength(1));
  // WS-01 lifted out leaves [WS-02]; landing after it is index 1.
  expect(writes()[0]).toMatchObject({
    url: '/api/recurring-schedule/tasks/WS-01/move',
    method: 'POST',
    body: { index: 1 },
  });
});

test('the first row cannot be nudged up and the last cannot be nudged down', async () => {
  await startEditing();

  expect(screen.getByLabelText('Move Review weekend sales up')).toBeDisabled();
  expect(screen.getByLabelText('Move Post reel down')).toBeDisabled();
});

test('removing a task asks first, and a cancelled prompt writes nothing', async () => {
  await startEditing();
  vi.stubGlobal('confirm', vi.fn(() => false));

  fireEvent.click(screen.getByLabelText('Remove Order pork'));
  expect(writes()).toHaveLength(0);

  vi.stubGlobal('confirm', vi.fn(() => true));
  fireEvent.click(screen.getByLabelText('Remove Order pork'));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({ url: '/api/recurring-schedule/tasks/WS-02', method: 'DELETE' });
});

test('ticking a task off is a week-only write, not a schedule change', async () => {
  await openMonday();

  const row = screen.getByText('Order pork').closest('.group-item-row')!;
  fireEvent.click(within(row as HTMLElement).getByRole('checkbox'));

  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    url: '/api/recurring-schedule/status',
    method: 'POST',
    body: { taskId: 'WS-02', done: true },
  });
});
