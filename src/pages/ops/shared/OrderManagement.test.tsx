// The service board: what it opens on, what it remembers, and what it shows
// about where an order is going.
//
// Three behaviours worth pinning, all of them things a packer would otherwise
// have to work around every single service:
//
//   * The board opens on the service that is actually happening. It used to
//     open on the first slot with orders in it, so a Sunday evening started
//     on Saturday Lunch.
//   * A slot picked by hand sticks — but only for as long as that service is
//     the one on. Otherwise "remember my pick" and "open on now" contradict
//     each other and one of them has to be silently wrong.
//   * The delivery phone and address are on the card, from the order's own
//     shipping partner, because that is what a website customer typed and it
//     is not the account's.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import OrderManagement from './OrderManagement';
import type { PackOrder } from './packing';

const order = (id: number, over: Partial<PackOrder> = {}): PackOrder => ({
  orderId: id,
  orderName: `S0000${id}`,
  customer: 'Asha R',
  packBy: null,
  odooFulfilment: null,
  note: null,
  phone: '',
  address: '',
  addressName: '',
  itemCount: 1,
  items: [{ itemId: 'pork-tacos', name: 'Smoked Pork Tacos', qty: 1 }],
  ...over,
});

const group = (id: string, label: string, orders: PackOrder[]) => ({
  id,
  label,
  sublabel: '',
  emoji: '🍖',
  orders,
});

// A weekend where every slot has something, so nothing the board picks can be
// explained away by "it was the only one with orders".
let GROUPS = [
  group('satLunch', 'Saturday Lunch', [order(1)]),
  group('satEvening', 'Saturday Dinner', [order(2)]),
  group('sunLunch', 'Sunday Lunch', [order(3)]),
  group('sunEvening', 'Sunday Dinner', [order(4)]),
];

beforeEach(() => {
  window.localStorage.clear();
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [order(1)]),
    group('satEvening', 'Saturday Dinner', [order(2)]),
    group('sunLunch', 'Sunday Lunch', [order(3)]),
    group('sunEvening', 'Sunday Dinner', [order(4)]),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/order-packing')) {
        return {
          ok: true,
          json: async () => ({ groups: GROUPS, slots: {}, unmatched: [], ordersFound: 4 }),
        } as unknown as Response;
      }
      if (url.includes('/time-preferences')) {
        return { ok: true, json: async () => ({ preferences: {} }) } as unknown as Response;
      }
      // The fulfilment pipeline's own state load.
      return { ok: true, json: async () => ({ statuses: {} }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The board reads the local clock, so the clock is what the tests set.
const atClock = (iso: string) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
};

const activeSlotName = () =>
  document.querySelector('.slot-picker-btn.active .slot-picker-name')?.textContent?.trim() ?? '';

const waitForBoard = async () => {
  await waitFor(() => expect(document.querySelector('.slot-picker-btn.active')).toBeTruthy());
};

// Scoped to the picker strip, so a slot name used anywhere else on the page
// can't match instead of the button.
const clickSlot = (label: string) => {
  const button = Array.from(document.querySelectorAll('.slot-picker-btn')).find((el) =>
    el.textContent?.includes(label),
  );
  if (!button) throw new Error(`No slot button for ${label}`);
  fireEvent.click(button);
};

test('opens on the service the clock is in, not the first one with orders', async () => {
  // 2026-09-06 is a Sunday; 18:00 is past the 4pm line, so Sunday Dinner.
  // Before this the board opened on Saturday Lunch — two days finished.
  atClock('2026-09-06T18:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  expect(activeSlotName()).toContain('Sunday Dinner');
});

test('opens on the coming Saturday lunch on a prep-day weekday', async () => {
  atClock('2026-09-02T14:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  expect(activeSlotName()).toContain('Saturday Lunch');
});

test('a slot picked by hand survives the tab being thrown away', async () => {
  atClock('2026-09-05T10:00:00'); // Saturday, lunch service
  const first = render(<OrderManagement />);
  await waitForBoard();
  expect(activeSlotName()).toContain('Saturday Lunch');

  clickSlot('Sunday Dinner');
  await waitFor(() => expect(activeSlotName()).toContain('Sunday Dinner'));

  first.unmount();
  render(<OrderManagement />);
  await waitForBoard();

  // Same service still on, so the packer's own choice is still the answer.
  expect(activeSlotName()).toContain('Sunday Dinner');
});

test('a pick made in an earlier service does not hold the board there', async () => {
  // The whole reason a pick is stored with the suggestion it was made
  // against. Picked during Saturday lunch; reopened on Sunday evening, when
  // that choice is about a service two days gone.
  atClock('2026-09-05T10:00:00');
  const first = render(<OrderManagement />);
  await waitForBoard();
  clickSlot('Sunday Lunch');
  await waitFor(() => expect(activeSlotName()).toContain('Sunday Lunch'));
  first.unmount();

  atClock('2026-09-06T18:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  expect(activeSlotName()).toContain('Sunday Dinner');
});

test('the date range comes back, and a spent one does not', async () => {
  atClock('2026-09-02T10:00:00');
  const first = render(<OrderManagement />);
  await waitForBoard();

  const dates = () => Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  fireEvent.change(dates()[1], { target: { value: '2026-09-30' } });
  await waitFor(() => expect(dates()[1].value).toBe('2026-09-30'));
  first.unmount();

  const second = render(<OrderManagement />);
  await waitForBoard();
  expect((Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[])[1].value).toBe(
    '2026-09-30',
  );
  second.unmount();

  // Now walk the clock past the end of that window. A range that has finished
  // is not the one to reopen on — it looks exactly like a live one sitting in
  // the date boxes.
  atClock('2026-10-15T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();
  expect((Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[])[1].value).not.toBe(
    '2026-09-30',
  );
});

test('shows the delivery phone and address off the order', async () => {
  await renderWithContact();

  expect(screen.getByText(/221B Mariyannapalya/)).toBeInTheDocument();
  // Dialable, because this is read on a phone — and stripped of the spaces
  // Odoo stores the number with.
  const link = screen.getByRole('link', { name: /98450/ });
  expect(link).toHaveAttribute('href', 'tel:+919845012345');
  // Flagged as a drop to somewhere other than the account itself.
  expect(screen.getByText(/Asha \(home\)/)).toBeInTheDocument();
});

// The board with one fully-addressed order on it, which every copy test wants.
const renderWithContact = async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [
      order(1, {
        phone: '+91 98450 12345',
        address: '221B Mariyannapalya, Bengaluru 560024',
        addressName: 'Asha (home)',
      }),
    ]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();
};

test('copies the phone number as printed, not as dialled', async () => {
  // The tel: link strips the number down to digits so a phone can dial it;
  // what gets pasted into a delivery app is read by a person, so it is the
  // printed form that goes on the clipboard.
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  await renderWithContact();

  fireEvent.click(screen.getByRole('button', { name: /Copy phone number/ }));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith('+91 98450 12345'));
  expect(screen.getByRole('button', { name: /Copy phone number/ })).toHaveTextContent('Copied');
});

test('copies the address without the packer-facing name beside it', async () => {
  // "Asha (home)" is a flag telling the packer this drop is not the account's
  // own address. It is not part of the address, and pasting it into a
  // delivery app would be pasting a note.
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  await renderWithContact();

  fireEvent.click(screen.getByRole('button', { name: /Copy address/ }));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith('221B Mariyannapalya, Bengaluru 560024'));
});

test('falls back to execCommand where there is no clipboard API', async () => {
  // The branch that actually runs on the kitchen tablet: the app is opened on
  // the LAN over plain http, where navigator.clipboard is undefined.
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
  const execCommand = vi.fn().mockReturnValue(true);
  document.execCommand = execCommand as unknown as typeof document.execCommand;
  await renderWithContact();

  fireEvent.click(screen.getByRole('button', { name: /Copy address/ }));

  await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  expect(screen.getByRole('button', { name: /Copy address/ })).toHaveTextContent('Copied');
});

test('admits it when the copy did not happen', async () => {
  // A button that says "Copied" over an empty clipboard is worse than one
  // that admits it — the address then gets typed from memory.
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
  document.execCommand = vi.fn().mockReturnValue(false) as unknown as typeof document.execCommand;
  await renderWithContact();

  fireEvent.click(screen.getByRole('button', { name: /Copy address/ }));

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Copy address/ })).toHaveTextContent("Couldn't copy"),
  );
});

test('says nothing at all when Odoo has no contact on file', async () => {
  // An empty "Phone: —" on every card is noise, and noise is what makes
  // people stop reading the block that matters.
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  expect(document.querySelector('.pack-order-contact')).toBeNull();
});

test('pasting a Porter link saves it and moves a packed order out for delivery', async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [order(1, { odooFulfilment: 'packed' })]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  const input = screen.getByLabelText(/Porter tracking link/);
  // Porter's share text wraps the link in a sentence; only the link is sent.
  fireEvent.paste(input, {
    clipboardData: { getData: () => 'Track your order here: https://porter.in/track_live_order?booking_id=CRN123' },
  });

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/order-packing/tracking'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toMatchObject({
      orderId: 1,
      trackingUrl: 'https://porter.in/track_live_order?booking_id=CRN123',
      advance: true,
    });
  });
});

test('a Porter link pasted without https:// is still taken', async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [order(1, { odooFulfilment: 'packed' })]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  fireEvent.paste(screen.getByLabelText(/Porter tracking link/), {
    clipboardData: { getData: () => 'porter.in/rd/b98a3b5ba4' },
  });

  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/order-packing/tracking'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toMatchObject({ trackingUrl: 'https://porter.in/rd/b98a3b5ba4' });
  });
});

test('puts the farthest drop first, and unmeasured ones after', async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [
      order(1, { distanceKm: 9.4, distanceStatus: 'ok' }),
      order(2, { distanceKm: null, distanceStatus: 'no_address' }),
      order(3, { distanceKm: 2.1, distanceStatus: 'ok', locality: 'Koramangala' }),
    ]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  const names = () => Array.from(document.querySelectorAll('.pack-order-name')).map((el) => el.textContent);
  expect(names()).toEqual(['S00001', 'S00003', 'S00002']);
  expect(screen.getByText(/~2\.1 km · Koramangala/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Earliest time/ }));
  expect(names()).toEqual(['S00001', 'S00002', 'S00003']);
});

test('reopening the board draws from the browser instead of fetching again', async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [order(1, { note: 'please deliver by 1pm' })]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  atClock('2026-09-05T10:00:00');
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part)).length;

  const first = render(<OrderManagement />);
  await waitForBoard();
  await waitFor(() => expect(calls('/time-preferences')).toBe(1));
  expect(calls('/api/odoo/order-packing?')).toBe(1);
  first.unmount();

  render(<OrderManagement />);
  await waitForBoard();
  expect(calls('/api/odoo/order-packing?')).toBe(1);
  expect(calls('/time-preferences')).toBe(1);

  // Refresh is still the way to pull new orders in.
  fireEvent.click(screen.getByRole('button', { name: /Refresh orders/ }));
  await waitFor(() => expect(calls('/api/odoo/order-packing?')).toBe(2));
});

test('Priority puts the customer who asked for a time ahead of a farther drop', async () => {
  GROUPS = [
    group('satLunch', 'Saturday Lunch', [
      order(1, { distanceKm: 12, distanceStatus: 'ok' }),
      order(2, { distanceKm: 3, distanceStatus: 'ok', note: 'need it by 1pm, party. no onions' }),
    ]),
    group('satEvening', 'Saturday Dinner', []),
    group('sunLunch', 'Sunday Lunch', []),
    group('sunEvening', 'Sunday Dinner', []),
  ];
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/time-preferences')) {
      return {
        ok: true,
        json: async () => ({
          preferences: {
            2: {
              hasPreference: true,
              label: 'Deliver by 1:00 PM',
              preferredTime: '13:00',
              quote: 'need it by 1pm',
              confidence: 'high',
              kind: 'by',
              urgencyFlags: ['Party'],
              kitchenInstructions: 'No onions',
            },
          },
        }),
      } as unknown as Response;
    }
    return base(url, init);
  });
  atClock('2026-09-05T10:00:00');
  render(<OrderManagement />);
  await waitForBoard();

  const names = () => Array.from(document.querySelectorAll('.pack-order-name')).map((el) => el.textContent);
  await waitFor(() => expect(names()).toEqual(['S00002', 'S00001']));
  expect(screen.getByText(/Leave by ~12:48 PM/)).toBeInTheDocument();
  expect(screen.getByText(/Party/, { selector: '.pack-urgency-flag' })).toBeInTheDocument();
  expect(screen.getByText(/No onions/, { selector: '.pack-kitchen-line' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Farthest first/ }));
  expect(names()).toEqual(['S00001', 'S00002']);
});
