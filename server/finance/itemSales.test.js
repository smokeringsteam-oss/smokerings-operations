// aggregate() and its bucket maths — the counting rules behind Sales by Item.
//
// buildItemSalesReport needs a live Odoo and is not something a test can
// stand up honestly. Everything that can go quietly wrong is below it: a
// wholesale kilo added to a B2C portion, a riser that is really just a longer
// window, a dish that vanishes from the table because nobody in the menu
// table has heard of it.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// itemSales.js pulls in weeklyLedger and the Odoo client, both of which reach
// the database at import time.
const { dir } = createTestDb();

const { aggregate, normalise, periodsBetween, periodKeyOf, compare } = await import('./itemSales.js');

afterAll(() => removeTestDb(dir));

// Four Monday-to-Sunday weeks, so the comparison splits two against two.
const WEEKS = periodsBetween('2026-08-03', '2026-08-30', 'week');

// No menu table behind these — matched naming is menuLookup's job, not
// aggregate's, and an empty lookup is the honest fixture for "this line was
// sold under whatever Odoo called it".
const menu = new Map();

const b2c = (name, date, units, revenue, orderRef) =>
  normalise({ channel: 'B2C', itemId: null, name, unitLabel: '', quantity: units, revenue, date, orderRef, menu });

const b2b = (name, date, units, revenue, saleRef, unitLabel = 'kg') =>
  normalise({ channel: 'B2B', itemId: null, name, unitLabel, quantity: units, revenue, date, orderRef: saleRef, menu });

describe('periodsBetween', () => {
  it('widens a range to whole weeks, oldest first', () => {
    // Asked for a Wednesday to a Wednesday; gets the Mondays either side.
    const weeks = periodsBetween('2026-08-05', '2026-08-19', 'week');
    expect(weeks.map((w) => w.start)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
    expect(weeks[0].end).toBe('2026-08-09');
  });

  it('walks whole months, including the short and long ones', () => {
    const months = periodsBetween('2026-01-15', '2026-03-02', 'month');
    expect(months.map((m) => m.key)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(months.map((m) => m.end)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(months.map((m) => m.label)).toEqual(['Jan 26', 'Feb 26', 'Mar 26']);
  });

  it('files a date into the bucket that contains it', () => {
    expect(periodKeyOf('2026-08-09', 'week')).toBe('2026-08-03'); // Sunday belongs to its Monday
    expect(periodKeyOf('2026-08-10', 'week')).toBe('2026-08-10');
    expect(periodKeyOf('2026-08-31', 'month')).toBe('2026-08-01');
  });
});

describe('aggregate', () => {
  it('counts units, revenue and distinct orders per item and per period', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        b2c('Pork Ribs', '2026-08-05', 2, 900, 101),
        b2c('Pork Ribs', '2026-08-06', 1, 450, 102),
        b2c('Pulled Pork Burger', '2026-08-06', 3, 900, 102), // same order as the line above
        b2c('Pork Ribs', '2026-08-12', 4, 1800, 103),
      ],
      granularity: 'week',
    });

    const ribs = report.items.find((item) => item.name === 'Pork Ribs');
    expect(ribs.units).toBe(7);
    expect(ribs.revenue).toBe(3150);
    expect(ribs.orders).toBe(3);
    expect(ribs.series).toEqual([3, 4, 0, 0]);
    expect(ribs.first).toBe('2026-08-03');
    expect(ribs.last).toBe('2026-08-10');
    expect(ribs.periodsSold).toBe(2);
    expect(ribs.avgPrice).toBe(450);

    // Two lines on order 102 are one order, not two.
    expect(report.totals.orders).toBe(3);
    expect(report.totals.units).toBe(10);
    expect(report.periods.map((p) => p.units)).toEqual([6, 4, 0, 0]);
    // The best seller sorts first.
    expect(report.items[0].name).toBe('Pork Ribs');
  });

  it('keeps B2C portions and B2B kilos in separate rows and separate shares', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        b2c('Pulled Pork', '2026-08-05', 6, 1800, 201),
        b2b('Pulled Pork', '2026-08-05', 4, 3200, 'S-1'),
        b2b('Buns', '2026-08-05', 40, 800, 'S-1', 'pack'),
      ],
      granularity: 'week',
    });

    const rows = report.items.filter((item) => item.name === 'Pulled Pork');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['B2B', 'B2C']);

    // Share is of the item's own side of the business: the six B2C portions
    // are all of the B2C units, and the four wholesale kilos are 4 of 44.
    const retail = rows.find((r) => r.channel === 'B2C');
    const wholesale = rows.find((r) => r.channel === 'B2B');
    expect(retail.sharePct).toBe(100);
    expect(wholesale.sharePct).toBe(9.1);
    expect(wholesale.unitLabel).toBe('kg');

    expect(report.totals.b2cUnits).toBe(6);
    expect(report.totals.b2bUnits).toBe(44);
    expect(report.totals.revenue).toBe(5800);
    // One Odoo order and one wholesale invoice — the two orders counts are
    // kept apart as well, because an invoice is not an order.
    expect(report.totals.b2cOrders).toBe(1);
    expect(report.totals.b2bOrders).toBe(1);
  });

  it('says mixed when one item was billed in more than one unit', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [b2b('Brisket', '2026-08-05', 2, 4000, 'S-1', 'kg'), b2b('Brisket', '2026-08-12', 1, 2000, 'S-2', 'each')],
      granularity: 'week',
    });
    expect(report.items[0].unitLabel).toBe('mixed');
  });

  it('folds one product sold under two spellings into one row', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [b2c('Pork Ribs', '2026-08-05', 2, 900, 301), b2c('pork ribs ', '2026-08-12', 3, 1350, 302)],
      granularity: 'week',
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0].units).toBe(5);
  });

  it('compares two windows of the same length, dropping the oldest period when there is an odd number', () => {
    const threeWeeks = periodsBetween('2026-08-03', '2026-08-23', 'week');
    const report = aggregate({
      periods: threeWeeks,
      lines: [
        b2c('Tacos', '2026-08-05', 99, 29700, 401), // week 1 — too old to fit either window
        b2c('Tacos', '2026-08-12', 10, 3000, 402), // week 2 — the compared past
        b2c('Tacos', '2026-08-19', 20, 6000, 403), // week 3 — the compared present
      ],
      granularity: 'week',
    });

    const tacos = report.items[0];
    expect(report.comparison.window).toBe(1);
    expect(report.comparison.ignoredPeriod).toBe(threeWeeks[0].label);
    // The 99 in the oldest week is in the totals and on the chart, and out of
    // the comparison — otherwise one week would be measured against two and
    // every dish on the menu would read as collapsing.
    expect(tacos.units).toBe(129);
    expect(tacos.previous).toBe(10);
    expect(tacos.recent).toBe(20);
    expect(tacos.deltaPct).toBe(100);
    expect(tacos.trend).toBe('rising');
  });

  it('calls a dish new, gone, quiet or steady rather than guessing a percentage', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        // Nothing in the first half, plenty in the second.
        b2c('Burnt Ends', '2026-08-19', 8, 3200, 501),
        // The other way round.
        b2c('Quesadilla', '2026-08-05', 9, 2700, 502),
        // Real movement, but only three portions of it — below the floor.
        b2c('Wings', '2026-08-05', 1, 300, 503),
        b2c('Wings', '2026-08-19', 2, 600, 504),
        // Flat.
        b2c('Brisket Plate', '2026-08-05', 10, 5000, 505),
        b2c('Brisket Plate', '2026-08-19', 10, 5000, 506),
      ],
      granularity: 'week',
    });

    const trendOf = (name) => report.items.find((item) => item.name === name).trend;
    expect(trendOf('Burnt Ends')).toBe('new');
    expect(trendOf('Quesadilla')).toBe('gone');
    expect(trendOf('Wings')).toBe('quiet');
    expect(trendOf('Brisket Plate')).toBe('steady');

    // Percentages have no denominator for a brand new dish, and null is not
    // the same fact as 0.
    expect(report.items.find((item) => item.name === 'Burnt Ends').deltaPct).toBeNull();

    // Movers are ranked by units moved, not by percentage, so the biggest
    // real change leads — and they come back per side of the business, not as
    // one list the bigger numbers would win.
    expect(report.movers.B2C.rising.map((item) => item.name)).toEqual(['Burnt Ends']);
    expect(report.movers.B2C.falling.map((item) => item.name)).toEqual(['Quesadilla']);
    expect(report.movers.B2B.rising).toEqual([]);
  });

  it('will not call a dish new against a window its whole side of the business did not trade in', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        // Nothing at all in the first two weeks — a shut kitchen, or a range
        // that reaches back further than the orders do.
        b2c('Ribs', '2026-08-19', 12, 5400, 801),
        b2c('Tacos', '2026-08-26', 9, 2700, 802),
      ],
      granularity: 'week',
    });

    // Every dish would otherwise be badged "new", which is a screenful of
    // noise dressed up as a trend.
    expect(report.items.map((item) => item.trend)).toEqual(['unrated', 'unrated']);
    expect(report.movers.B2C.rising).toEqual([]);
    // The counts are still true, and the screen reads the empty window off
    // them to say why nothing is rated.
    expect(report.comparison.previous.units).toEqual({ B2C: 0, B2B: 0 });
    expect(report.comparison.recent.units).toEqual({ B2C: 21, B2B: 0 });

    // The other side of the business is judged on its own history, not on
    // this one's: a wholesale book that did trade earlier still gets verdicts.
    const mixed = aggregate({
      periods: WEEKS,
      lines: [
        b2b('Pulled Pork', '2026-08-05', 8, 6400, 'S-1'),
        b2b('Pulled Pork', '2026-08-19', 16, 12800, 'S-2'),
        b2c('Ribs', '2026-08-19', 12, 5400, 803),
      ],
      granularity: 'week',
    });
    expect(mixed.items.find((item) => item.channel === 'B2B').trend).toBe('rising');
    expect(mixed.items.find((item) => item.channel === 'B2C').trend).toBe('unrated');
  });

  it('draws the movers per side, so the weekend menu cannot crowd wholesale off its own list', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        // Six B2C dishes, each gaining more portions than the wholesale line
        // gains kilos. One combined top five would be all of them.
        ...['Ribs', 'Tacos', 'Burger', 'Quesadilla', 'Wings', 'Burnt Ends'].flatMap((name, index) => [
          b2c(name, '2026-08-05', 10, 3000, 900 + index),
          b2c(name, '2026-08-19', 30, 9000, 950 + index),
        ]),
        b2b('Pulled Pork', '2026-08-05', 4, 3200, 'S-1'),
        b2b('Pulled Pork', '2026-08-19', 9, 7200, 'S-2'),
      ],
      granularity: 'week',
    });

    expect(report.movers.B2C.rising).toHaveLength(5);
    expect(report.movers.B2C.risingCount).toBe(6);
    // The wholesale riser keeps its own list, five portions-movers or not.
    expect(report.movers.B2B.rising.map((item) => item.name)).toEqual(['Pulled Pork']);
  });

  it('counts the orders behind each period per side, not just its units', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        b2c('Ribs', '2026-08-05', 2, 900, 1001),
        b2c('Tacos', '2026-08-05', 3, 900, 1002),
        b2b('Pulled Pork', '2026-08-05', 4, 3200, 'S-1'),
      ],
      granularity: 'week',
    });
    expect(report.periods[0]).toMatchObject({ b2cOrders: 2, b2bOrders: 1, orders: 3 });
  });

  it('has no comparison to make in a single period', () => {
    const oneWeek = periodsBetween('2026-08-03', '2026-08-09', 'week');
    const report = aggregate({ periods: oneWeek, lines: [b2c('Ribs', '2026-08-05', 3, 1350, 601)], granularity: 'week' });
    expect(report.comparison).toBeNull();
    expect(report.items[0].trend).toBe('steady');
    expect(report.movers.B2C.rising).toEqual([]);
  });

  it('counts lines it could not match to the menu rather than dropping them', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [b2c('Mystery Special', '2026-08-05', 2, 700, 701)],
      granularity: 'week',
    });
    expect(report.totals.unmatchedLines).toBe(1);
    expect(report.items[0].name).toBe('Mystery Special');
    expect(report.items[0].category).toBe('Unmatched');
    expect(report.items[0].units).toBe(2);
  });

  it('totals both kinds of discount, and never counts a coupon line as a dish', () => {
    const report = aggregate({
      periods: WEEKS,
      lines: [
        // 10% off a ₹479 dish — ₹431.10 charged, ₹47.90 off.
        normalise({ channel: 'B2C', itemId: null, name: 'Pork Tacos', unitLabel: '', quantity: 1, revenue: 431.1, date: '2026-08-05', orderRef: 801, menu, discount: 47.9 }),
        b2c('Ribs', '2026-08-06', 2, 900, 802),
        normalise({ channel: 'B2C', itemId: null, name: 'Discount', unitLabel: '', quantity: 1, revenue: -150, date: '2026-08-06', orderRef: 802, menu, kind: 'discount' }),
      ],
      granularity: 'week',
    });

    expect(report.discounts).toEqual({
      total: 198,
      coupons: 150,
      couponLines: 1,
      onItems: 48,
      itemLines: 1,
      orders: 2,
      gross: 1379,
      pct: 14.4,
    });
    // The coupon comes off revenue — that is what the orders took — but adds
    // no portion and no row to the table.
    expect(report.totals.b2cRevenue).toBe(1181);
    expect(report.totals.b2cUnits).toBe(3);
    expect(report.items.map((item) => item.name).sort()).toEqual(['Pork Tacos', 'Ribs']);
  });

  it('reports a zero period as a measured zero, not a gap', () => {
    const report = aggregate({ periods: WEEKS, lines: [], granularity: 'week' });
    expect(report.periods).toHaveLength(4);
    expect(report.periods.every((p) => p.units === 0 && p.orders === 0)).toBe(true);
    expect(report.totals.units).toBe(0);
    expect(report.items).toEqual([]);
  });
});

describe('compare', () => {
  it('has nothing to say about a single period', () => {
    expect(compare(periodsBetween('2026-08-03', '2026-08-09', 'week'))).toBeNull();
  });

  it('names both windows by the days they cover', () => {
    const comparison = compare(WEEKS);
    expect(comparison.previous).toMatchObject({ from: '2026-08-03', to: '2026-08-16', periods: 2 });
    expect(comparison.recent).toMatchObject({ from: '2026-08-17', to: '2026-08-30', periods: 2 });
    expect(comparison.ignoredPeriod).toBeNull();
  });
});
