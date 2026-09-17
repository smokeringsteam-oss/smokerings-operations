// Cost to Make, per order — what each weekend order cost to put in the box,
// and what the average one looks like.
//
// The same multiplication the per-dish lens does, grouped the other way:
// every line of an order is its dish's cost per plate (server/finance/
// unitCost.js) times the plates on it, and the order is the sum. So an order's
// cost is understated exactly as far as its dishes' costs are, and carries the
// same coverage figure — weighted here by plates, because an order of four
// burgers and one side is mostly a burger's coverage.
//
// A line that is not a dish on the menu (a delivery charge, an extra dip, a
// product renamed in Odoo and not yet matched) still counts toward the order's
// revenue — it was money the customer paid — but has no cost behind it. Those
// are counted per order so the screen can say so, rather than quietly letting
// them flatter the "left over" column.
//
// Pure: no Odoo, no database. The lines come in already fetched, the dish
// costs come in already computed, which is what lets the grouping be tested.
import { weekStartOf } from './weeklyLedger.js';

const round2 = (value) => Math.round(value * 100) / 100;
const round0 = (value) => Math.round(value);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// lines          B2C lines as fetchSoldItems returns them
// dishes         Map of menu item id -> the cost book's row for it
// groups         the cost groups, in order (unitCost GROUPS)
// periods        the weekly buckets the rest of the report is drawn in
// sessionsByOrder Map of order id -> session ids fed from (sessionEconomics)
function costOrders({ lines, dishes, groups, periods, sessionsByOrder = new Map() }) {
  const byOrder = new Map();
  for (const line of lines || []) {
    if (!byOrder.has(line.orderId)) {
      byOrder.set(line.orderId, {
        orderId: line.orderId,
        orderName: line.orderName,
        customer: line.customer || 'Unknown customer',
        day: line.day,
        promisedDay: line.promisedDay || line.day,
        lines: [],
      });
    }
    byOrder.get(line.orderId).lines.push(line);
  }

  const orders = [...byOrder.values()].map((order) => {
    const byGroup = Object.fromEntries(groups.map((group) => [group, 0]));
    let plates = 0;
    let revenue = 0;
    let knownCost = 0;
    let leavesPriced = 0;
    let leavesTotal = 0;
    let unmatchedLines = 0;
    let unmatchedRevenue = 0;
    let discount = 0;

    const lineRows = order.lines.map((line) => {
      revenue += line.revenue;
      // A coupon or Discount line (fetchSoldItems flags it): money off the
      // order, not a plate and not an unknown dish. It stays in the order's
      // value — that is what was paid — and is shown for what it is.
      if (line.isDiscountLine) {
        discount += -line.revenue;
        return {
          name: line.productName,
          itemId: null,
          kind: 'discount',
          quantity: round2(line.quantity),
          revenue: round0(line.revenue),
          costEach: null,
          cost: null,
          coveragePct: null,
        };
      }
      // A percentage typed on a dish line is money off too; the line's
      // revenue is already net of it.
      discount += line.discount || 0;
      const dish = line.itemId ? dishes.get(line.itemId) : null;
      plates += line.quantity;
      if (!dish) {
        unmatchedLines += 1;
        unmatchedRevenue += line.revenue;
        return {
          name: line.productName,
          itemId: line.itemId || null,
          kind: 'unmatched',
          quantity: round2(line.quantity),
          revenue: round0(line.revenue),
          costEach: null,
          cost: null,
          coveragePct: null,
        };
      }
      const cost = line.quantity * dish.costInr;
      knownCost += cost;
      leavesPriced += line.quantity * dish.leavesPriced;
      leavesTotal += line.quantity * dish.leavesTotal;
      for (const group of dish.groups) byGroup[group.group] = (byGroup[group.group] || 0) + line.quantity * group.cost;
      return {
        name: dish.name,
        itemId: dish.itemId,
        kind: 'dish',
        quantity: round2(line.quantity),
        revenue: round0(line.revenue),
        costEach: dish.costInr,
        cost: round2(cost),
        coveragePct: dish.coveragePct,
      };
    });

    for (const group of Object.keys(byGroup)) byGroup[group] = round2(byGroup[group]);

    return {
      orderId: order.orderId,
      orderName: order.orderName,
      customer: order.customer,
      day: order.day,
      promisedDay: order.promisedDay,
      plates: round2(plates),
      revenue: round0(revenue),
      knownCost: round2(knownCost),
      byGroup,
      // A floor under the real food-cost share, never a margin. Same caveat as
      // every other figure on the screen.
      knownCostPct: pct(knownCost, revenue),
      leftoverAtMost: round0(revenue - knownCost),
      coveragePct: leavesTotal > 0 ? Math.round((leavesPriced / leavesTotal) * 1000) / 10 : 0,
      unmatchedLines,
      unmatchedRevenue: round0(unmatchedRevenue),
      discount: round0(discount),
      sessions: sessionsByOrder.get(order.orderId) || [],
      lines: lineRows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    };
  });

  orders.sort((a, b) => b.day.localeCompare(a.day) || String(b.orderName).localeCompare(String(a.orderName)));

  // ---- The consolidated view -----------------------------------------------
  const count = orders.length;
  const sum = (field) => orders.reduce((total, order) => total + order[field], 0);
  const revenue = sum('revenue');
  const knownCost = sum('knownCost');
  const plates = sum('plates');

  // The average order, split the four ways a plate is. What the screen draws
  // as one bar: a typical order's rupees, from meat up to what is left.
  const averageByGroup = Object.fromEntries(
    groups.map((group) => [
      group,
      count ? round2(orders.reduce((total, order) => total + order.byGroup[group], 0) / count) : 0,
    ]),
  );

  // Bucketed by the day the order was placed — the same dating Sales by Item
  // and the per-dish lens use, so a week's order count here matches theirs.
  const index = new Map((periods || []).map((period, position) => [period.key, position]));
  const perWeek = (periods || []).map((period) => ({
    key: period.key,
    label: period.label,
    start: period.start,
    end: period.end,
    orders: 0,
    revenue: 0,
    knownCost: 0,
    plates: 0,
    byGroup: Object.fromEntries(groups.map((group) => [group, 0])),
  }));
  for (const order of orders) {
    const position = index.get(weekStartOf(order.day));
    if (position === undefined) continue;
    const row = perWeek[position];
    row.orders += 1;
    row.revenue += order.revenue;
    row.knownCost += order.knownCost;
    row.plates += order.plates;
    for (const group of groups) row.byGroup[group] += order.byGroup[group] || 0;
  }

  return {
    summary: {
      orders: count,
      revenue: round0(revenue),
      knownCost: round2(knownCost),
      plates: round2(plates),
      avgOrderValue: count ? round0(revenue / count) : 0,
      medianOrderValue: round0(median(orders.map((order) => order.revenue))),
      avgKnownCost: count ? round2(knownCost / count) : 0,
      avgPlates: count ? round2(plates / count) : 0,
      avgLeftoverAtMost: count ? round0((revenue - knownCost) / count) : 0,
      knownCostPct: pct(knownCost, revenue),
      averageByGroup,
      ordersWithUnmatched: orders.filter((order) => order.unmatchedLines > 0).length,
      discount: round0(sum('discount')),
      ordersDiscounted: orders.filter((order) => order.discount > 0).length,
    },
    perWeek: perWeek.map(({ byGroup, ...row }) => ({
      ...row,
      revenue: round0(row.revenue),
      knownCost: round2(row.knownCost),
      plates: round2(row.plates),
      avgOrderValue: row.orders ? round0(row.revenue / row.orders) : 0,
      avgKnownCost: row.orders ? round2(row.knownCost / row.orders) : 0,
      // The week's average order split the same four ways, so the chart can
      // stack it — cost groups from the baseline, what is left on top.
      avgByGroup: Object.fromEntries(
        groups.map((group) => [group, row.orders ? round2(byGroup[group] / row.orders) : 0]),
      ),
    })),
    orders,
  };
}

export { costOrders, median };
