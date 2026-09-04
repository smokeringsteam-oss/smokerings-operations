// The weekly spending-vs-sales rollup.
//
// Three things here are worth a test, and they are the three that would be
// wrong in a way nobody would notice:
//
//   * The week boundary. This kitchen buys on Friday and sells on Saturday
//     and Sunday, so a week that starts on any day but Monday files the cost
//     and the revenue it produced into different rows. That is not an
//     off-by-one, it is the whole figure inverted, and it would look
//     completely plausible on screen.
//
//   * The uncosted line. A purchase entered with no unit price stores NULL
//     for total_cost, and a rollup that coerced it to zero would report a
//     week as cheap when what actually happened is that nobody typed the
//     price in. It has to be counted as a line and excluded from the money.
//
//   * The B2B overlap. A wholesale delivery can exist both in b2b_sale and as
//     an Odoo order tagged "B2B". Counting both inflates a week's revenue by
//     the whole of its wholesale side.
//
// Odoo is never reached: createTestDb leaves ODOO_URL unset, so the report
// takes its no-Odoo path and every figure below comes from the local tables.
// That is also the real degraded state this screen is designed to work in.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb({
  vendors: [{ vendor_id: 'VEN-001', vendor_name: 'Ranga Meats' }],
});

const { buildWeeklyReport, weekStartOf, weeksBetween, weekLabel, derive, sides, purchaseBucket } = await import('./weeklyLedger.js');
const { addBudget } = await import('../marketing/marketingBudget.js');
const { run } = await import('../core/db.js');

beforeEach(() => {
  run('DELETE FROM purchase');
  run('DELETE FROM marketing_budget');
  run('DELETE FROM b2b_sale');
  run('DELETE FROM b2b_client');
});

afterAll(() => removeTestDb(dir));

let seq = 0;

// A purchase line. `totalCost` of null is the case the third describe block
// is about — a line entered without a unit price; `channel` is the side of
// the business it was bought for, and `clientId` the account it was bought
// for, which only a B2B line can carry.
const buy = ({
  date,
  totalCost = 1000,
  itemType = 'material',
  name = 'Pork shoulder',
  channel = 'B2C',
  clientId = null,
  clientName = null,
}) => {
  seq += 1;
  run(
    `INSERT INTO purchase (purchase_id, purchase_date, channel, vendor_id, item_type, item_name,
                           quantity_purchased, total_cost, client_id, client_name)
     VALUES (?, ?, ?, 'VEN-001', ?, ?, 1, ?, ?, ?)`,
    `PUR-${String(seq).padStart(4, '0')}`,
    date,
    channel,
    itemType,
    name,
    totalCost,
    clientId,
    clientName,
  );
};

const sell = ({ deliveredOn, amount = 5000, clientId = 'CLI-001', paid = 0 }) => {
  seq += 1;
  run(
    `INSERT OR IGNORE INTO b2b_client (client_id, name, stage, payment_terms_days) VALUES (?, ?, 'active', 15)`,
    clientId,
    `Client ${clientId}`,
  );
  run(
    `INSERT INTO b2b_sale (sale_id, client_id, delivered_on, amount_inr, payment_due_on, amount_paid_inr)
     VALUES (?, ?, ?, ?, date(?, '+15 days'), ?)`,
    `SAL-${String(seq).padStart(4, '0')}`,
    clientId,
    deliveredOn,
    amount,
    deliveredOn,
    paid,
  );
};

// 2026-09-04 is a Friday; its week is Mon 2026-08-31 to Sun 2026-09-06.
const FRIDAY = '2026-09-04';
const WEEK_START = '2026-08-31';
const WEEK_END = '2026-09-06';

const weekIn = (report, start) => report.weeks.find((week) => week.weekStart === start);

describe('weekStartOf', () => {
  it('puts Friday, Saturday and Sunday of one weekend in the same week', () => {
    // The reason the whole file uses Monday-start weeks: Friday is when the
    // meat is bought, Saturday and Sunday are when it is sold, and they have
    // to land in one row or the row is meaningless.
    expect(weekStartOf('2026-09-04')).toBe(WEEK_START); // Fri
    expect(weekStartOf('2026-09-05')).toBe(WEEK_START); // Sat
    expect(weekStartOf('2026-09-06')).toBe(WEEK_START); // Sun
  });

  it('starts a new week on Monday, not on Sunday', () => {
    // getDay() is 0 for Sunday, so the naive `day - 1` shift sends Sunday
    // forward into the following week instead of back into the current one.
    expect(weekStartOf('2026-09-07')).toBe('2026-09-07'); // Mon — its own start
    expect(weekStartOf('2026-09-06')).not.toBe('2026-09-07');
  });

  it('is idempotent — the Monday of a Monday is itself', () => {
    expect(weekStartOf(weekStartOf(FRIDAY))).toBe(WEEK_START);
  });
});

describe('weeksBetween', () => {
  it('widens both ends out to whole weeks', () => {
    // Asked for Wednesday to Wednesday; answers with two full Mon-Sun weeks,
    // because a short bar beside full ones reads as a bad week rather than a
    // partial one.
    const weeks = weeksBetween('2026-09-02', '2026-09-09');
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({ weekStart: WEEK_START, weekEnd: WEEK_END });
    expect(weeks[1]).toMatchObject({ weekStart: '2026-09-07', weekEnd: '2026-09-13' });
  });

  it('returns a single week when both ends fall inside one', () => {
    expect(weeksBetween(FRIDAY, '2026-09-05')).toHaveLength(1);
  });

  it('returns weeks oldest first', () => {
    const weeks = weeksBetween('2026-08-01', '2026-09-30');
    const starts = weeks.map((week) => week.weekStart);
    expect([...starts].sort()).toEqual(starts);
  });
});

describe('weekLabel', () => {
  it('names a month once for a week inside it', () => {
    expect(weekLabel('2026-09-07', '2026-09-13')).toBe('7–13 Sep');
  });

  it('names both months for a week that straddles two', () => {
    expect(weekLabel(WEEK_START, WEEK_END)).toBe('31 Aug – 6 Sep');
  });
});

describe('derive', () => {
  it('reports no ratio at all when there were no sales', () => {
    // Not 0%. A week that spent Rs 9,000 and sold nothing has an undefined
    // ratio, and a 0 would sort it beside the best week on the screen.
    expect(derive({ spend: 9000, sales: 0 })).toMatchObject({ net: -9000, spendRatio: null, margin: null });
  });

  it('computes the spend ratio and margin off sales', () => {
    expect(derive({ spend: 6000, sales: 10000 })).toMatchObject({ net: 4000, spendRatio: 60, margin: 40 });
  });
});

describe('purchaseBucket', () => {
  it('keeps off-catalogue lines out of materials', () => {
    // recordPurchases writes item_type NULL for an ad-hoc line — packaging,
    // ice, a gas refill. Folding those into materials would hide how much of
    // a week's spend was off-catalogue, which is the point of the split.
    expect(purchaseBucket('material')).toBe('materials');
    expect(purchaseBucket('service')).toBe('services');
    expect(purchaseBucket(null)).toBe('uncategorised');
  });
});

describe('buildWeeklyReport — bucketing', () => {
  it('files a Friday purchase and the weekend sales it paid for into one week', async () => {
    buy({ date: FRIDAY, totalCost: 4000 });
    sell({ deliveredOn: '2026-09-05', amount: 9000 });
    sell({ deliveredOn: '2026-09-06', amount: 3000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    const week = weekIn(report, WEEK_START);

    expect(report.weeks).toHaveLength(1);
    expect(week.spend.total).toBe(4000);
    expect(week.sales.total).toBe(12000);
    expect(week.net).toBe(8000);
  });

  it('does not let the Sunday sales fall into the following week', async () => {
    sell({ deliveredOn: WEEK_END, amount: 7000 });
    sell({ deliveredOn: '2026-09-07', amount: 500 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: '2026-09-13' });
    expect(weekIn(report, WEEK_START).sales.b2b).toBe(7000);
    expect(weekIn(report, '2026-09-07').sales.b2b).toBe(500);
  });

  it('keeps a week with no trading as a row of measured zeroes, flagged quiet', async () => {
    buy({ date: FRIDAY, totalCost: 4000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: '2026-09-13' });
    const quiet = weekIn(report, '2026-09-07');

    expect(quiet.quiet).toBe(true);
    expect(quiet.spend.total).toBe(0);
    expect(quiet.sales.total).toBe(0);
    // And it is excluded from the per-week averages, or two closed weeks in a
    // quarter would drag a good quarter down by a sixth.
    expect(report.totals.tradingWeeks).toBe(1);
    expect(report.totals.avgSpend).toBe(4000);
  });
});

describe('buildWeeklyReport — uncosted purchases', () => {
  it('counts a line with no total cost without adding zero to the spend', async () => {
    buy({ date: FRIDAY, totalCost: 2500 });
    buy({ date: FRIDAY, totalCost: null, name: 'Charcoal' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    const week = weekIn(report, WEEK_START);

    expect(week.spend.total).toBe(2500);
    expect(week.counts.purchaseLines).toBe(2);
    expect(week.counts.uncostedLines).toBe(1);
    expect(report.totals.uncostedLines).toBe(1);
  });

  it('splits catalogue materials from off-catalogue lines', async () => {
    buy({ date: FRIDAY, totalCost: 3000, itemType: 'material' });
    buy({ date: FRIDAY, totalCost: 700, itemType: null, name: 'Foil trays' });

    const week = weekIn(await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END }), WEEK_START);
    expect(week.spend.materials).toBe(3000);
    expect(week.spend.uncategorised).toBe(700);
    expect(week.spend.purchases).toBe(3700);
  });
});

describe('buildWeeklyReport — marketing spend', () => {
  it('pro-rates a month-long budget into each week it overlaps', async () => {
    // Rs 3,000 across the 30 days of September is Rs 100 a day. The week of
    // 31 Aug to 6 Sep has six of those days in September, so Rs 600 — the
    // whole Rs 3,000 against one weekend would make a good week look ruinous.
    addBudget({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      channel: 'Instagram',
      category: 'ads',
      amount: 3000,
    });

    const week = weekIn(await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END }), WEEK_START);
    expect(week.spend.marketing).toBe(600);
    expect(week.spend.total).toBe(600);
    expect(week.partialMarketing).toBe(true);
  });

  it('does not flag a budget entered for exactly one week as pro-rated', async () => {
    addBudget({
      periodStart: WEEK_START,
      periodEnd: WEEK_END,
      channel: 'Instagram',
      category: 'ads',
      amount: 1400,
    });

    const week = weekIn(await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END }), WEEK_START);
    expect(week.spend.marketing).toBe(1400);
    expect(week.partialMarketing).toBe(false);
  });
});

describe('buildWeeklyReport — receivables and totals', () => {
  it('separates revenue booked from money still owed', async () => {
    // A week can look profitable and still be the reason the account is
    // empty: on 15-day terms the cash arrives the week after next.
    sell({ deliveredOn: '2026-09-05', amount: 9000, paid: 2000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    const week = weekIn(report, WEEK_START);

    expect(week.sales.b2b).toBe(9000);
    expect(week.b2bOutstanding).toBe(7000);
    expect(report.totals.b2bOutstanding).toBe(7000);
  });

  it('ranks the best and worst trading weeks, ignoring quiet ones', async () => {
    buy({ date: FRIDAY, totalCost: 1000 });
    sell({ deliveredOn: '2026-09-05', amount: 9000 });
    buy({ date: '2026-09-11', totalCost: 8000 });
    sell({ deliveredOn: '2026-09-12', amount: 2000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: '2026-09-20' });

    expect(report.best.weekStart).toBe(WEEK_START);
    expect(report.best.net).toBe(8000);
    expect(report.worst.weekStart).toBe('2026-09-07');
    expect(report.worst.net).toBe(-6000);
    // The third week traded nothing and is neither.
    expect(weekIn(report, '2026-09-14').quiet).toBe(true);
  });

  it('lists vendors and clients by size', async () => {
    buy({ date: FRIDAY, totalCost: 1000 });
    buy({ date: FRIDAY, totalCost: 500 });
    sell({ deliveredOn: '2026-09-05', amount: 4000, clientId: 'CLI-001' });
    sell({ deliveredOn: '2026-09-05', amount: 6000, clientId: 'CLI-002' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });

    expect(report.vendors[0]).toMatchObject({ vendor: 'Ranga Meats', spend: 1500, lines: 2 });
    expect(report.clients.map((row) => row.sales)).toEqual([6000, 4000]);
  });

  it('reports the range it actually covered, not only the one asked for', async () => {
    const report = await buildWeeklyReport({ fromDate: '2026-09-02', toDate: '2026-09-09' });
    expect(report.range.requested).toEqual({ from: '2026-09-02', to: '2026-09-09' });
    expect(report.range.from).toBe(WEEK_START);
    expect(report.range.to).toBe('2026-09-13');
    expect(report.range.weeks).toBe(2);
  });

  it('says the B2C half is missing rather than failing when Odoo is not set up', async () => {
    sell({ deliveredOn: '2026-09-05', amount: 9000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });

    expect(report.sources.odoo.configured).toBe(false);
    expect(report.sources.odoo.reachable).toBe(false);
    // The wholesale half still answers in full — which is the point.
    expect(report.totals.b2b).toBe(9000);
    expect(report.totals.b2c).toBe(0);
  });
});

describe('sides', () => {
  it('gives each side its own margin off its own cost and revenue', () => {
    const split = sides({ spend: { b2c: 2000, b2b: 6000, shared: 500 }, sales: { b2c: 10000, b2b: 8000 } });
    expect(split.b2c).toMatchObject({ spend: 2000, sales: 10000, net: 8000, margin: 80 });
    expect(split.b2b).toMatchObject({ spend: 6000, sales: 8000, net: 2000, margin: 25 });
  });

  it('keeps shared marketing outside both sides', () => {
    // The consequence the screen has to state: the two nets do not add up to
    // the whole business's net, and the difference is exactly the shared
    // figure. Apportioning it would invent the number being decided on.
    const split = sides({ spend: { b2c: 1000, b2b: 1000, shared: 900 }, sales: { b2c: 5000, b2b: 5000 } });
    expect(split.shared.spend).toBe(900);
    expect(split.b2c.net + split.b2b.net).toBe(8000);
    // Whole-business net over the same figures is 900 lower.
    expect(derive({ spend: 2900, sales: 10000 }).net).toBe(7100);
  });
});

describe('buildWeeklyReport — the two sides of the business', () => {
  it('files a purchase against the side it was bought for', async () => {
    // The point of the split: meat bought for a cafe order is wholesale cost
    // and must never land against the weekend's consumer revenue.
    buy({ date: FRIDAY, totalCost: 4000, channel: 'B2B' });
    buy({ date: FRIDAY, totalCost: 1500, channel: 'B2C' });

    const week = weekIn(await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END }), WEEK_START);
    expect(week.spend.b2b).toBe(4000);
    expect(week.spend.b2c).toBe(1500);
    expect(week.spend.total).toBe(5500);
  });

  it('reports each side as its own profit line', async () => {
    buy({ date: FRIDAY, totalCost: 4000, channel: 'B2B' });
    buy({ date: FRIDAY, totalCost: 1000, channel: 'B2C' });
    sell({ deliveredOn: '2026-09-05', amount: 9000 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });

    // Wholesale: Rs 9,000 in against Rs 4,000 of its own cost.
    expect(report.sides.b2b).toMatchObject({ spend: 4000, sales: 9000, net: 5000 });
    // B2C: Odoo is not configured in tests, so cost with no revenue against
    // it — which is exactly what the screen should say rather than hiding it.
    expect(report.sides.b2c).toMatchObject({ spend: 1000, sales: 0, net: -1000, margin: null });
    expect(report.totals.b2bSpend).toBe(4000);
    expect(report.totals.b2cSpend).toBe(1000);
  });

  it('holds marketing outside both sides unless a row names one', async () => {
    addBudget({
      periodStart: WEEK_START,
      periodEnd: WEEK_END,
      channel: 'Instagram',
      category: 'ads',
      amount: 1400,
    });
    addBudget({
      periodStart: WEEK_START,
      periodEnd: WEEK_END,
      channel: 'B2B',
      category: 'event',
      amount: 600,
    });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });

    // Instagram works both sides at once and is not apportioned; the row
    // somebody typed "B2B" into is taken at their word.
    expect(report.sides.shared.spend).toBe(1400);
    expect(report.sides.b2b.spend).toBe(600);
    expect(report.sides.b2c.spend).toBe(0);
    // And the whole-business spend is still all of it.
    expect(report.totals.spend).toBe(2000);
  });

  it('tags wholesale cost to the account it was bought for', async () => {
    sell({ deliveredOn: '2026-09-05', amount: 9000, clientId: 'CLI-001' });
    buy({ date: FRIDAY, totalCost: 3000, channel: 'B2B', clientId: 'CLI-001', clientName: 'Client CLI-001' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    const account = report.clients.find((row) => row.id === 'CLI-001');

    expect(account).toMatchObject({ sales: 9000, spend: 3000, net: 6000, invoices: 1, purchaseLines: 1 });
    expect(report.untaggedB2bSpend).toBe(0);
  });

  it('keeps untagged wholesale cost in the B2B total and out of every account', async () => {
    // An untagged B2B line is general wholesale overhead — a real answer, not
    // a gap — so it must count against the side without being charged to
    // somebody's account.
    sell({ deliveredOn: '2026-09-05', amount: 9000, clientId: 'CLI-001' });
    buy({ date: FRIDAY, totalCost: 3000, channel: 'B2B', clientId: 'CLI-001', clientName: 'Client CLI-001' });
    buy({ date: FRIDAY, totalCost: 800, channel: 'B2B' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });

    expect(report.sides.b2b.spend).toBe(3800);
    expect(report.clients.find((row) => row.id === 'CLI-001').spend).toBe(3000);
    expect(report.untaggedB2bSpend).toBe(800);
  });

  it('does not let marketing typed B2B inflate the untagged-cost figure', async () => {
    // untaggedB2bSpend is measured against the purchase book alone: only a
    // purchase can carry a client tag, so a marketing row counted on the B2B
    // side must not read as wholesale cost nobody attributed.
    addBudget({ periodStart: WEEK_START, periodEnd: WEEK_END, channel: 'B2B', category: 'event', amount: 600 });
    buy({ date: FRIDAY, totalCost: 3000, channel: 'B2B', clientId: 'CLI-001', clientName: 'Acme' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    expect(report.sides.b2b.spend).toBe(3600);
    expect(report.untaggedB2bSpend).toBe(0);
  });

  it('gives an account bought for but never invoiced a row of its own', async () => {
    // Money out with nothing against it — the row most worth seeing.
    buy({ date: FRIDAY, totalCost: 2200, channel: 'B2B', clientId: 'CLI-009', clientName: 'New Cafe' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    expect(report.clients).toHaveLength(1);
    expect(report.clients[0]).toMatchObject({ id: 'CLI-009', client: 'New Cafe', sales: 0, spend: 2200, net: -2200 });
  });

  it('joins an account on its id, not on the name spelled on the purchase', async () => {
    // A purchase carries whatever the account was called the day it was
    // bought for; the sale carries the live name. Joining the strings would
    // split one account into two rows the first time somebody fixes a typo.
    sell({ deliveredOn: '2026-09-05', amount: 5000, clientId: 'CLI-001' });
    buy({ date: FRIDAY, totalCost: 1200, channel: 'B2B', clientId: 'CLI-001', clientName: 'Old spelling' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    expect(report.clients).toHaveLength(1);
    expect(report.clients[0]).toMatchObject({ id: 'CLI-001', client: 'Client CLI-001', sales: 5000, spend: 1200 });
  });

  it('splits each spend category by side, leaving shared marketing in neither', async () => {
    // The category list is filterable like everything else on the screen, so
    // it carries its own split. Shared marketing still counts in the row's
    // total — it is real spend — but belongs to neither column.
    buy({ date: FRIDAY, totalCost: 4000, channel: 'B2B' });
    buy({ date: FRIDAY, totalCost: 1000, channel: 'B2C' });
    addBudget({ periodStart: WEEK_START, periodEnd: WEEK_END, channel: 'Instagram', category: 'ads', amount: 900 });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    const materials = report.categories.find((row) => row.category === 'materials');
    const marketing = report.categories.find((row) => row.category === 'marketing');

    expect(materials).toMatchObject({ spend: 5000, b2b: 4000, b2c: 1000 });
    expect(marketing).toMatchObject({ spend: 900, b2b: 0, b2c: 0 });
  });

  it('splits each vendor by the side its lines were bought for', async () => {
    buy({ date: FRIDAY, totalCost: 4000, channel: 'B2B' });
    buy({ date: FRIDAY, totalCost: 1000, channel: 'B2C' });

    const report = await buildWeeklyReport({ fromDate: WEEK_START, toDate: WEEK_END });
    expect(report.vendors[0]).toMatchObject({ vendor: 'Ranga Meats', spend: 5000, b2b: 4000, b2c: 1000 });
  });
});

describe('buildWeeklyReport — bad input', () => {
  it('rejects a range that ends before it starts', async () => {
    await expect(buildWeeklyReport({ fromDate: '2026-09-10', toDate: '2026-09-01' })).rejects.toThrow(
      /start of the range is after its end/i,
    );
  });

  it('rejects a week count outside the allowed span', async () => {
    await expect(buildWeeklyReport({ weeks: 0 })).rejects.toThrow(/between 1 and/i);
    await expect(buildWeeklyReport({ weeks: 500 })).rejects.toThrow(/between 1 and/i);
  });
});
