// Per-unit economics — what a dish costs to make, and what the week's worth
// of them cost.
//
// Two numbers multiplied, and the whole screen is about being honest about
// both of them:
//
//   cost per unit   from server/finance/unitCost.js, which explodes each
//                   dish's bill of materials down to raw materials and prices
//                   what it can. Understated wherever an ingredient has no
//                   price on file — most of the sauces, all of the packaging
//                   — and it says by how much.
//   units per week  from server/finance/itemSales.js, the same Odoo feed the
//                   Sales by Item screen counts. Not re-derived here: one
//                   query, so a burger's count can never differ between the
//                   two screens.
//
// B2C only, and that is a decision rather than an omission. The wholesale
// book bills whatever the invoice says — three kilos of pulled pork, forty
// buns — and there is no dish, no bill of materials and no per-plate cost
// behind a line like that. Multiplying a kilo by a burger's cost per plate
// would produce a number, and the number would mean nothing. Wholesale cost
// of goods is a real question and it is a different one; it belongs on its
// own screen, built off b2b_sale_line and the material costs directly.
//
// Why weeks
// ---------
// The kitchen runs on weekends and buys against a weekend, so a week is the
// smallest period in which a dish's cost is a whole number of anything. The
// range picker can still be set to anything; the buckets underneath are
// always Monday-to-Sunday, courtesy of itemSales' own period walk.
//
// Three lenses, one payload
// -------------------------
// The same costs, grouped three ways, each with a consolidated view and the
// rows underneath it:
//
//   per dish      below — cost per plate × plates per week.
//   per order     orderEconomics.js — the plates on one order, summed.
//   per session   sessionEconomics.js — one cook's meat bill against its yield
//                 and the order lines it fed.
//
// One request builds all three off one Odoo read, so switching lens on the
// screen never re-fetches, and a burger counted on one lens is the same
// burger on the other two.
import { costMenuItems, priceMaterials, GROUPS } from './unitCost.js';
import { buildItemSalesReport } from './itemSales.js';
import { costOrders } from './orderEconomics.js';
import { costSessions } from './sessionEconomics.js';
import { readMaterials, readMenu, readRecipes, readRecipeLines, readPurchases, readSessions } from '../core/kbViews.js';

const round2 = (value) => Math.round(value * 100) / 100;
const round0 = (value) => Math.round(value);

// The dish a sold line is. itemSales has already done the matching — Odoo
// product id first, then name — and hands back the menu item id it landed on,
// or null for a line nothing in the menu table recognises.
function soldByItem(report) {
  const byItem = new Map();
  const unmatched = [];
  for (const item of report.items) {
    if (item.channel !== 'B2C') continue;
    if (!item.itemId) {
      unmatched.push({ name: item.name, units: item.units, revenue: item.revenue });
      continue;
    }
    // Two Odoo products can match the same dish (a renamed product, a
    // duplicate in the catalogue). Their series are added rather than one
    // winning, or half the sales of a renamed dish would vanish.
    const existing = byItem.get(item.itemId);
    if (!existing) {
      byItem.set(item.itemId, { units: item.units, revenue: item.revenue, series: [...item.series], orders: item.orders });
    } else {
      existing.units += item.units;
      existing.revenue += item.revenue;
      existing.orders += item.orders;
      existing.series = existing.series.map((value, index) => value + (item.series[index] || 0));
    }
  }
  return { byItem, unmatched };
}

// Finished grams of each smoked product on one plate of each dish, off the
// dish's own BoM lines. The session lens needs it twice: to know which order
// lines a pork cook fed, and how many burgers its finished weight is.
function productGramsByDish(recipeLines) {
  const byDish = new Map();
  for (const line of recipeLines) {
    if (!/^IP-/.test(line.child_id || '')) continue;
    const grams = Number(line.base_quantity === '' ? line.quantity : line.base_quantity);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    if (!byDish.has(line.parent_id)) byDish.set(line.parent_id, new Map());
    const products = byDish.get(line.parent_id);
    products.set(line.child_id, (products.get(line.child_id) || 0) + grams);
  }
  return byDish;
}

async function buildUnitEconomicsReport({ fromDate, toDate } = {}) {
  // Weekly, always — see the note at the top. The range itself is the
  // caller's, and itemSales widens it to whole weeks the same way it does for
  // the Sales by Item screen, so the two agree bar for bar.
  const sales = await buildItemSalesReport({ fromDate, toDate, granularity: 'week', keepLines: true });

  // Read once, costed once: the per-dish cost book and the per-session meat
  // rates are priced off the same purchase log in the same request.
  const tables = {
    materials: readMaterials(),
    menu: readMenu(),
    recipes: readRecipes(),
    recipeLines: readRecipeLines(),
    purchases: readPurchases(),
  };
  const costs = costMenuItems(tables);
  const dishes = new Map(costs.items.map((dish) => [dish.itemId, dish]));

  const { byItem, unmatched } = soldByItem(sales);
  const weeks = sales.periods.length;

  const items = costs.items
    // The B2B sample dish has no price, no recipe and never goes out of the
    // kitchen door. It is on the menu table for the wholesale catalogue's
    // benefit and would only ever be a row of zeroes here.
    .filter((dish) => dish.leavesTotal > 0)
    .map((dish) => {
      const sold = byItem.get(dish.itemId);
      const unitsSeries = sold ? sold.series : sales.periods.map(() => 0);
      // The one multiplication the screen exists for. Understated exactly as
      // far as the dish's cost is, which is why coveragePct travels with it
      // everywhere.
      const costSeries = unitsSeries.map((units) => round2(units * dish.costInr));
      const units = sold ? sold.units : 0;
      const knownCost = round2(units * dish.costInr);
      const revenue = sold ? sold.revenue : 0;
      const weeksSold = unitsSeries.filter((value) => value > 0).length;

      return {
        itemId: dish.itemId,
        name: dish.name,
        category: dish.category,
        isActive: dish.isActive,
        price: dish.price,
        costInr: dish.costInr,
        coveragePct: dish.coveragePct,
        leavesPriced: dish.leavesPriced,
        leavesTotal: dish.leavesTotal,
        knownCostPct: dish.knownCostPct,
        groups: dish.groups,
        missing: dish.missing,
        units: round2(units),
        orders: sold ? sold.orders : 0,
        revenue: round0(revenue),
        unitsSeries,
        costSeries,
        knownCost,
        // What the dish costs in an average week of the range. Averaged over
        // every week in it, not over the weeks it sold in — a dish that sells
        // on alternate weekends costs half as much per week as one that sells
        // every weekend, and that is the figure a budget is built on.
        costPerWeek: weeks > 0 ? round2(knownCost / weeks) : 0,
        unitsPerWeek: weeks > 0 ? round2(units / weeks) : 0,
        weeksSold,
        // Rupees left after the KNOWN cost. Named for what it is: an upper
        // bound, since every unpriced ingredient can only take it down.
        contributionAtMost: revenue > 0 ? round0(revenue - knownCost) : 0,
      };
    })
    .sort((a, b) => b.knownCost - a.knownCost || b.units - a.units || a.name.localeCompare(b.name));

  const sum = (field) => round2(items.reduce((total, item) => total + item[field], 0));
  const perWeek = sales.periods.map((period, index) => {
    // The week's cost split the same four ways a dish's is, so the chart and
    // the table are the same breakdown at two zoom levels. Per group rather
    // than per dish because eleven dishes is eleven stacked segments and no
    // chart survives that; the dish detail is the table's job.
    const byGroup = {};
    for (const group of GROUPS) byGroup[group] = 0;
    for (const item of items) {
      const units = item.unitsSeries[index] || 0;
      if (!units) continue;
      for (const group of item.groups) byGroup[group.group] = (byGroup[group.group] || 0) + units * group.cost;
    }
    for (const group of Object.keys(byGroup)) byGroup[group] = round2(byGroup[group]);

    return {
      key: period.key,
      label: period.label,
      start: period.start,
      end: period.end,
      units: round2(items.reduce((total, item) => total + (item.unitsSeries[index] || 0), 0)),
      knownCost: round2(items.reduce((total, item) => total + (item.costSeries[index] || 0), 0)),
      byGroup,
      revenue: period.b2cRevenue,
    };
  });

  // Sessions cooked inside the range read — the widened one, so a Friday cook
  // at the edge of a week is in or out with its whole week.
  const b2cLines = sales.b2cLines || [];
  const sessionLens = costSessions({
    sessions: readSessions().filter((row) => row.session_date >= sales.range.from && row.session_date <= sales.range.to),
    purchases: tables.purchases,
    materialCosts: priceMaterials({ materials: tables.materials, purchases: tables.purchases }),
    orderLines: b2cLines,
    dishes,
    productGrams: productGramsByDish(tables.recipeLines),
  });
  const orderLens = costOrders({
    lines: b2cLines,
    dishes,
    groups: GROUPS,
    periods: sales.periods,
    sessionsByOrder: sessionLens.sessionsByOrder,
  });

  return {
    range: sales.range,
    sources: {
      ...sales.sources,
      // The other half of every number here, and the half with the caveat on
      // it. Surfaced at the top of the payload so a screen cannot render the
      // costs without having been told how complete they are.
      costs: {
        materialsPriced: costs.totals.materialsPriced,
        materialsTotal: costs.totals.materialsTotal,
        dishes: costs.totals.dishes,
        dishesUncosted: costs.totals.dishesUncosted,
      },
    },
    weeks,
    totals: {
      units: sum('units'),
      revenue: round0(items.reduce((total, item) => total + item.revenue, 0)),
      knownCost: sum('knownCost'),
      knownCostPerWeek: weeks > 0 ? round2(items.reduce((total, item) => total + item.knownCost, 0) / weeks) : 0,
      unitsPerWeek: weeks > 0 ? round2(items.reduce((total, item) => total + item.units, 0) / weeks) : 0,
    },
    periods: perWeek,
    items,
    // What is standing between this report and a real cost, worst first. The
    // actionable half of the screen: price the top few and every number above
    // moves at once.
    groups: GROUPS,
    gaps: costs.gaps,
    // Sold under a name the menu table does not know. Not costed, and counted
    // nowhere above — reported so a dish missing from the report is a number
    // on screen rather than a silence.
    unmatched: unmatched.sort((a, b) => b.units - a.units),
    orders: orderLens,
    sessions: { summary: sessionLens.summary, sessions: sessionLens.sessions },
  };
}

export { buildUnitEconomicsReport, soldByItem, productGramsByDish };
