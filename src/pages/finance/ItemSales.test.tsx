// Sales by Item, rendered.
//
// The counting is tested server-side in server/finance/itemSales.test.js.
// What is left to get wrong is here, and it is all about a reader drawing a
// conclusion the numbers do not support: portions and wholesale kilos added
// into one tile with nothing saying so, a side filter that changes the table
// but not the totals above it, and a "new" dish printed with a percentage it
// cannot have.
//
// The separation of the two sides is what most of these are about: each side
// has to be countable on its own, and nothing on one side's half of the screen
// may be drawn from the other's numbers.
//
// So this file feeds the component one fixed report and asserts what a person
// reads off the page.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ItemSales from './ItemSales';

const period = (key: string, label: string, start: string, end: string, b2c: number, b2b: number) => ({
  key,
  label,
  start,
  end,
  units: b2c + b2b,
  revenue: b2c * 300 + b2b * 800,
  b2cUnits: b2c,
  b2bUnits: b2b,
  b2cRevenue: b2c * 300,
  b2bRevenue: b2b * 800,
  orders: (b2c ? 2 : 0) + (b2b ? 1 : 0),
  b2cOrders: b2c ? 2 : 0,
  b2bOrders: b2b ? 1 : 0,
});

const PERIODS = [
  period('2026-08-03', '3–9 Aug', '2026-08-03', '2026-08-09', 10, 4),
  period('2026-08-10', '10–16 Aug', '2026-08-10', '2026-08-16', 12, 4),
  period('2026-08-17', '17–23 Aug', '2026-08-17', '2026-08-23', 18, 2),
  period('2026-08-24', '24–30 Aug', '2026-08-24', '2026-08-30', 20, 2),
];

const item = (overrides: Record<string, unknown>) => ({
  key: 'B2C::x',
  itemId: 'x',
  name: 'Pork Ribs',
  category: 'Mains',
  channel: 'B2C',
  matched: true,
  unitLabel: '',
  units: 40,
  revenue: 12000,
  orders: 22,
  avgPrice: 300,
  sharePct: 66.7,
  periodsSold: 4,
  series: [8, 10, 10, 12],
  revenueSeries: [2400, 3000, 3000, 3600],
  first: '2026-08-03',
  last: '2026-08-24',
  recent: 22,
  previous: 18,
  deltaUnits: 4,
  deltaPct: 22.2,
  trend: 'steady',
  ...overrides,
});

const RIBS = item({});
const BURNT_ENDS = item({
  key: 'B2C::burnt',
  itemId: 'burnt',
  name: 'Burnt Ends',
  units: 20,
  revenue: 8000,
  orders: 12,
  sharePct: 33.3,
  series: [0, 0, 8, 12],
  recent: 20,
  previous: 0,
  deltaUnits: 20,
  deltaPct: null,
  trend: 'new',
});
const PULLED_PORK = item({
  key: 'B2B::pulled',
  itemId: 'pulled',
  name: 'Pulled Pork',
  channel: 'B2B',
  category: 'Wholesale',
  unitLabel: 'kg',
  units: 12,
  revenue: 9600,
  orders: 4,
  sharePct: 100,
  series: [4, 4, 2, 2],
  recent: 4,
  previous: 8,
  deltaUnits: -4,
  deltaPct: -50,
  trend: 'falling',
});

const report = (overrides: Record<string, unknown> = {}) => ({
  range: {
    requested: { from: '2026-08-03', to: '2026-08-30' },
    from: '2026-08-03',
    to: '2026-08-30',
    granularity: 'week',
    periods: 4,
  },
  sources: {
    odoo: {
      configured: true,
      url: 'https://example.odoo.com',
      error: '',
      reachable: true,
      ordersRead: 34,
      companyOrdersSkipped: 0,
    },
  },
  totals: {
    units: 72,
    revenue: 29600,
    b2cUnits: 60,
    b2bUnits: 12,
    b2cRevenue: 20000,
    b2bRevenue: 9600,
    orders: 38,
    b2cOrders: 34,
    b2bOrders: 4,
    items: 3,
    b2cItems: 2,
    b2bItems: 1,
    lines: 60,
    unmatchedLines: 0,
    outOfRange: 0,
  },
  periods: PERIODS,
  items: [RIBS, BURNT_ENDS, PULLED_PORK],
  movers: {
    B2C: { rising: [BURNT_ENDS], falling: [], risingCount: 1, fallingCount: 0 },
    B2B: { rising: [], falling: [PULLED_PORK], risingCount: 0, fallingCount: 1 },
  },
  comparison: {
    window: 2,
    recent: { from: '2026-08-17', to: '2026-08-30', periods: 2, units: { B2C: 38, B2B: 4 } },
    previous: { from: '2026-08-03', to: '2026-08-16', periods: 2, units: { B2C: 22, B2B: 8 } },
    ignoredPeriod: null,
  },
  ...overrides,
});

const stubFetch = (payload: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch);

beforeEach(() => stubFetch(report()));
afterEach(() => vi.unstubAllGlobals());

// Two tables on the page in the default "both sides" view, one per side.
const tableFor = async (side: 'B2C' | 'B2B') => {
  const tables = await screen.findAllByRole('table');
  return side === 'B2C' ? tables[0] : tables[tables.length - 1];
};

const rowFor = async (side: 'B2C' | 'B2B', name: RegExp) =>
  within(await tableFor(side)).getByRole('row', { name });

test('counts how many of each item sold, with its share and its revenue', async () => {
  render(<ItemSales />);

  const ribs = await rowFor('B2C', /pork ribs/i);
  expect(within(ribs).getByText('40')).toBeInTheDocument();
  expect(within(ribs).getByText('66.7%')).toBeInTheDocument();
  expect(within(ribs).getByText('₹12k')).toBeInTheDocument();

  // A wholesale line is counted in the unit it was billed in, not as a dish.
  const pork = await rowFor('B2B', /pulled pork/i);
  expect(within(pork).getByText('12 kg')).toBeInTheDocument();
});

test('gives each side its own section, and never puts one side in the other', async () => {
  render(<ItemSales />);

  const b2c = await tableFor('B2C');
  const b2b = await tableFor('B2B');
  expect(b2c).not.toBe(b2b);

  // The weekend dishes are in the weekend table and nowhere else...
  expect(within(b2c).getByRole('row', { name: /pork ribs/i })).toBeInTheDocument();
  expect(within(b2c).queryByRole('row', { name: /pulled pork/i })).toBeNull();
  // ...and the wholesale line is in the wholesale table and nowhere else.
  expect(within(b2b).getByRole('row', { name: /pulled pork/i })).toBeInTheDocument();
  expect(within(b2b).queryByRole('row', { name: /pork ribs/i })).toBeNull();

  // Each side counts in its own words: portions against invoiced units, and
  // orders against invoices, down to the column heading.
  expect(screen.getByText('Portions sold')).toBeInTheDocument();
  expect(screen.getByText('Wholesale units sold')).toBeInTheDocument();
  expect(within(b2c).getByRole('columnheader', { name: 'Orders' })).toBeInTheDocument();
  expect(within(b2b).getByRole('columnheader', { name: 'Invoices' })).toBeInTheDocument();
});

test('adds up revenue across both sides but never the quantities', async () => {
  render(<ItemSales />);

  // Rupees are rupees on both sides, so the whole-business figure is real.
  expect(await screen.findByText('Revenue, both sides')).toBeInTheDocument();
  expect(screen.getByText('₹29,600')).toBeInTheDocument();

  // The quantities are named separately and never summed into one figure.
  expect(screen.getByText(/60 portions and 12 wholesale units are different things/i)).toBeInTheDocument();
  expect(screen.queryByText('72')).toBeNull();
});

test('shows one side alone when a side is picked', async () => {
  render(<ItemSales />);
  await screen.findAllByRole('table');

  fireEvent.click(screen.getByRole('button', { name: 'B2B wholesale' }));

  expect(screen.getAllByRole('table')).toHaveLength(1);
  expect(screen.getByText('Wholesale units sold')).toBeInTheDocument();
  expect(screen.queryByText('Portions sold')).toBeNull();
  // And the whole-business revenue strip goes with it, because there is no
  // longer a "both" for it to be about.
  expect(screen.queryByText('Revenue, both sides')).toBeNull();
});

test('names the two windows it compared rather than leaving the reader to guess', async () => {
  render(<ItemSales />);
  // Once per side: the windows are the same dates, but the verdicts under
  // them are each side's own.
  expect(await screen.findAllByText(/17 Aug 26 – 30 Aug 26/)).toHaveLength(2);
  expect(screen.getAllByText(/3 Aug 26 – 16 Aug 26/)).toHaveLength(2);
});

test('shows a new dish as new rather than as a percentage it cannot have', async () => {
  render(<ItemSales />);

  const burnt = await rowFor('B2C', /burnt ends/i);
  expect(within(burnt).getByText('★ New')).toBeInTheDocument();
  expect(within(burnt).getByText('+20')).toBeInTheDocument();
  // No percentage exists for a dish with nothing behind it, and a dash
  // hanging off the +20 would read as a figure that failed to load.
  expect(within(burnt).queryByText('—')).toBeNull();

  // And it leads its own side's risers panel, which is what the screen is
  // for. Both sides have a Gaining column, so there are two of them.
  expect(screen.getAllByText('Gaining')).toHaveLength(2);
  expect(screen.getAllByText('Burnt Ends').length).toBeGreaterThan(1);
});

test('sorts the table by the column asked for', async () => {
  render(<ItemSales />);
  await screen.findAllByRole('table');

  // Sorting by revenue puts the 12k dish above the 8k one, within its own side.
  fireEvent.click(screen.getAllByRole('button', { name: 'Revenue' })[0]);
  const rows = within(await tableFor('B2C')).getAllByRole('row').slice(1); // past the header
  expect(within(rows[0]).getByText('Pork Ribs')).toBeInTheDocument();
  expect(within(rows[1]).getByText('Burnt Ends')).toBeInTheDocument();
});

test('says the weekend half is missing rather than printing it as zero', async () => {
  stubFetch(
    report({
      sources: {
        odoo: {
          configured: true,
          url: 'https://example.odoo.com',
          error: 'connect ECONNREFUSED',
          reachable: false,
          ordersRead: 0,
          companyOrdersSkipped: 0,
        },
      },
    }),
  );
  render(<ItemSales />);
  expect(await screen.findByText(/odoo unreachable/i)).toBeInTheDocument();
});

test('says the earlier window is empty rather than badging the whole menu new', async () => {
  stubFetch(
    report({
      movers: {
        B2C: { rising: [], falling: [], risingCount: 0, fallingCount: 0 },
        B2B: { rising: [], falling: [], risingCount: 0, fallingCount: 0 },
      },
      comparison: {
        window: 2,
        recent: { from: '2026-08-17', to: '2026-08-30', periods: 2, units: { B2C: 60, B2B: 12 } },
        previous: { from: '2026-08-03', to: '2026-08-16', periods: 2, units: { B2C: 0, B2B: 0 } },
        ignoredPeriod: null,
      },
    }),
  );
  render(<ItemSales />);
  // Said once per side, because it is a fact about that side's own history.
  expect(await screen.findAllByText(/nothing sold on this side between 3 Aug 26 and 16 Aug 26/i)).toHaveLength(2);
  // And not an empty Gaining/Slipping pair, which would read as "nothing is
  // moving" when the truth is "there is nothing to move against".
  expect(screen.queryByText('Gaining')).toBeNull();
});

test('has nothing to compare in a single period, and says so instead of drawing empty panels', async () => {
  stubFetch(
    report({
      range: { requested: { from: '2026-08-03', to: '2026-08-09' }, from: '2026-08-03', to: '2026-08-09', granularity: 'week', periods: 1 },
      periods: [PERIODS[0]],
      comparison: null,
      movers: {
        B2C: { rising: [], falling: [], risingCount: 0, fallingCount: 0 },
        B2B: { rising: [], falling: [], risingCount: 0, fallingCount: 0 },
      },
    }),
  );
  render(<ItemSales />);
  expect(await screen.findAllByText(/one week is a photograph, not a trend/i)).toHaveLength(2);
});
