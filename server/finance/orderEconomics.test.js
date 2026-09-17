// Cost to Make's per-order lens. Pure — the lines and the dish costs are
// handed in — so these pin the grouping rules rather than the catalogue.
import { describe, it, expect } from 'vitest';
import { costOrders, median } from './orderEconomics.js';

const GROUPS = ['Meat', 'Bread', 'Sauces, sides & produce', 'Packaging'];

const dish = (itemId, costInr, groups, over = {}) => ({
  itemId,
  name: itemId,
  costInr,
  leavesPriced: 2,
  leavesTotal: 4,
  coveragePct: 50,
  groups: Object.entries(groups).map(([group, cost]) => ({ group, cost })),
  ...over,
});

const DISHES = new Map([
  ['burger', dish('burger', 80, { Meat: 60, Bread: 20 })],
  ['ribs', dish('ribs', 300, { Meat: 300 }, { leavesPriced: 1, leavesTotal: 1, coveragePct: 100 })],
]);

const PERIODS = [
  {
    key: '2026-08-31',
    label: '31 Aug',
    start: '2026-08-31',
    end: '2026-09-06',
  },
  { key: '2026-09-07', label: '7 Sep', start: '2026-09-07', end: '2026-09-13' },
];

const line = (over = {}) => ({
  orderId: 1,
  orderName: 'S001',
  customer: 'Asha',
  day: '2026-09-02',
  promisedDay: '2026-09-05',
  itemId: 'burger',
  productName: 'Burger',
  quantity: 2,
  revenue: 600,
  ...over,
});

const run = (lines, extra = {}) =>
  costOrders({
    lines,
    dishes: DISHES,
    groups: GROUPS,
    periods: PERIODS,
    ...extra,
  });

describe('costOrders', () => {
  it('sums each line as plates × cost per plate, split by group', () => {
    const { orders } = run([line(), line({ itemId: 'ribs', productName: 'Ribs', quantity: 1, revenue: 850 })]);
    expect(orders).toHaveLength(1);
    const [order] = orders;
    expect(order.knownCost).toBe(460);
    expect(order.byGroup).toMatchObject({ Meat: 420, Bread: 40 });
    expect(order.revenue).toBe(1450);
    expect(order.leftoverAtMost).toBe(990);
    expect(order.plates).toBe(3);
    // Weighted by plates: 2 burgers at 2/4 and one ribs at 1/1 is 5 of 9.
    expect(order.coveragePct).toBe(55.6);
  });

  it('keeps a discount line in the order value but not as a plate or an unknown dish', () => {
    const { orders, summary } = run([
      line(),
      line({
        itemId: null,
        productName: 'Discount',
        quantity: 1,
        revenue: -100,
        isDiscountLine: true,
      }),
    ]);
    const [order] = orders;
    expect(order.revenue).toBe(500);
    expect(order.plates).toBe(2);
    expect(order.unmatchedLines).toBe(0);
    expect(order.discount).toBe(100);
    expect(order.lines.find((entry) => entry.kind === 'discount')).toBeTruthy();
    expect(summary.ordersDiscounted).toBe(1);
  });

  it('counts a line the menu does not know toward value, with no cost', () => {
    const { orders } = run([
      line(),
      line({
        itemId: null,
        productName: 'Extra dip',
        quantity: 1,
        revenue: 40,
      }),
    ]);
    expect(orders[0].unmatchedLines).toBe(1);
    expect(orders[0].unmatchedRevenue).toBe(40);
    expect(orders[0].knownCost).toBe(160);
    expect(orders[0].plates).toBe(3);
  });

  it('averages across orders and buckets them by the day they were placed', () => {
    const { summary, perWeek } = run([
      line(),
      line({
        orderId: 2,
        orderName: 'S002',
        day: '2026-09-08',
        quantity: 1,
        revenue: 300,
      }),
    ]);
    expect(summary.orders).toBe(2);
    expect(summary.avgOrderValue).toBe(450);
    expect(summary.avgKnownCost).toBe(120);
    expect(summary.averageByGroup.Meat).toBe(90);
    expect(perWeek.map((week) => week.orders)).toEqual([1, 1]);
    expect(perWeek[1].avgByGroup).toMatchObject({ Meat: 60, Bread: 20 });
  });

  it('carries the sessions that fed an order', () => {
    const { orders } = run([line()], {
      sessionsByOrder: new Map([[1, ['SMK-0001']]]),
    });
    expect(orders[0].sessions).toEqual(['SMK-0001']);
  });
});

describe('median', () => {
  it('takes the middle, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
