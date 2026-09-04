// Sales by Item — what actually sold, and what is catching on.
//
// Spending vs Sales answers "did the week pay". This answers the two
// questions underneath it that a total in rupees cannot: how many of each
// thing went out of the door, and which of them people are asking for more of
// than they were a month ago. One is a count, the other is a direction, and
// the screen is built so the second is never read off the first — a dish can
// be the best seller and the fastest faller in the same range.
//
// Where the numbers come from
// ---------------------------
//   Odoo sale.order.line   the B2C half. Confirmed orders only (sale/done),
//                          dated by date_order, individuals only. See
//                          fetchSoldItems in server/integrations/odoo.js.
//   b2b_sale_line          the wholesale half, this app's own invoice book,
//                          dated by the sale's delivered_on.
//
// The two are never added together, and that is the most important rule in
// this file. A B2C line is a portion of a dish; a B2B line is whatever the
// invoice billed — three kilos of pulled pork, forty buns. They are both
// "quantity" and they are not the same unit, so every count comes back split:
// an item that sells on both sides gets one row per side, the period rows
// carry each side's units, revenue and order count separately, and the movers
// lists are drawn per side (a single top five across both would be a race
// between portions and kilos, and the bigger numbers would win it every
// time). The screen renders the two as separate sections off the back of
// that. Revenue, being rupees on both sides, is the one figure that does add
// up, and the whole-business total of it is still reported.
//
// The overlap guard is the same one weeklyLedger.js applies, drawn in a
// different place: there, an Odoo order tagged B2B is held aside; here, an
// Odoo order for a *company* is dropped, because the wholesale side of this
// screen is the local invoice book and counting both would double every
// wholesale kilo. The count of what was dropped is reported, so a wholesale
// account whose orders only exist in Odoo shows up as a number rather than as
// silence.
//
// Trend
// -----
// "Rising" and "falling" are measured by comparing the most recent half of
// the range with the half before it — see compare() below for why the two
// windows are always the same length, and why an item needs a floor of volume
// before a percentage is allowed to describe it.
import { all } from '../core/db.js';
import { readMenu } from '../core/kbViews.js';
import { fetchSoldItems, matchProduct, getConfig as getOdooConfig } from '../integrations/odoo.js';
import { weekStartOf, weeksBetween } from './weeklyLedger.js';

// How much of the past the screen opens on. Twelve weeks is the same quarter
// Spending vs Sales opens on, for the same reason: long enough that a trend
// is a trend, short enough that every column is still readable.
const DEFAULT_WEEKS = 12;
// One row per period on the chart, so this is a limit on how many bars can be
// drawn before they stop being bars. Two years of weeks, or eight years of
// months.
const MAX_PERIODS = 104;

// How far a dish has to move between the two halves of the range before it is
// called rising or falling rather than steady. Ten per cent of a weekend's
// orders is one order; a quarter is a change in what people want.
const MOVE_THRESHOLD = 0.25;
// And how much of it there has to be for a percentage to mean anything. Two
// portions becoming four is not a 100% riser, it is two portions.
const MOVE_FLOOR_UNITS = 4;

const GRANULARITIES = ['week', 'month'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

// Local-calendar dates, never toISOString() — the same rule the rest of the
// server follows, because UTC hands back yesterday for the first five and a
// half hours of every IST day.
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const today = () => isoOf(new Date());

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function cleanDate(value, what) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) badRequest(`${what} must be a date (YYYY-MM-DD).`);
  return text;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(new Date(y, m - 1, d + days));
}

const monthStartOf = (iso) => `${iso.slice(0, 7)}-01`;

function monthEndOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return isoOf(new Date(y, m, 0)); // day 0 of the next month is the last of this one
}

// The buckets the chart is drawn in, oldest first, widened to whole weeks or
// whole months rather than clipped to the dates asked for. Same reasoning as
// weeksBetween in weeklyLedger.js: a half bucket at the end is a short bar
// beside full ones, and the eye reads a short bar as a bad week rather than
// as an unfinished one. The widened bounds come back on the report so the
// screen can say which days it actually covered.
function periodsBetween(fromDate, toDate, granularity) {
  if (granularity === 'month') {
    const periods = [];
    for (let start = monthStartOf(fromDate); start <= monthStartOf(toDate); start = monthStartOf(addDays(monthEndOf(start), 1))) {
      const [y, m] = start.split('-').map(Number);
      periods.push({ key: start, start, end: monthEndOf(start), label: `${MONTHS[m - 1]} ${String(y).slice(2)}` });
    }
    return periods;
  }
  return weeksBetween(fromDate, toDate).map((week) => ({
    key: week.weekStart,
    start: week.weekStart,
    end: week.weekEnd,
    label: week.label,
  }));
}

// Which bucket a date falls in. Returns the bucket key, which is always the
// bucket's first day, so a lookup can never disagree with periodsBetween.
const periodKeyOf = (date, granularity) => (granularity === 'month' ? monthStartOf(date) : weekStartOf(date));

const round2 = (value) => Math.round(value * 100) / 100;
const round0 = (value) => Math.round(value);

// The menu table as a lookup, for the name and category a matched line is
// shown under. The dish's own name wins over whatever the Odoo product or the
// invoice line happened to be called, so a product renamed in Odoo does not
// fork one dish into two rows halfway through the range.
function menuLookup() {
  const byId = new Map();
  try {
    readMenu().forEach((row) => {
      if (!row.menu_id) return;
      byId.set(row.menu_id, {
        name: String(row.item_name || row.menu_id).trim(),
        category: String(row.category || '').trim() || 'Uncategorised',
      });
    });
  } catch {
    // No database on this checkout. Lines then keep the names they were sold
    // under, which is a worse label and not a wrong number.
    return new Map();
  }
  return byId;
}

// Every wholesale line delivered in the range. Joined to its sale for the
// date, because a line has no date of its own — the invoice it sits on does,
// and `delivered_on` is the day the food moved, which is what this screen
// counts by. Cancelled sales do not exist in this book (a sale that did not
// happen is deleted, see b2bSales.js), so there is no state to filter on.
const B2B_LINE_SQL = `
  SELECT s.sale_id,
         s.delivered_on,
         l.description,
         l.unit_label,
         l.quantity,
         l.line_total,
         l.odoo_product_id
    FROM b2b_sale_line l
    JOIN b2b_sale s USING (sale_id)
   WHERE s.delivered_on >= ? AND s.delivered_on <= ?`;

// One sold line, in the shape aggregate() counts. Both halves of the business
// are normalised into this before anything is added up, so the counting rules
// live in one function instead of being written twice with a subtle
// difference between them.
//
//   channel    'B2C' | 'B2B' — never merged, see the note at the top
//   itemId     the menu item this line matched, or null
//   key        what the line is grouped by: the matched item, or failing that
//              its own name folded to lower case, so "Pulled Pork 1kg" and
//              "pulled pork 1kg" are one row and not two
//   orderRef   the order or invoice this line was on, for the distinct count
function normalise({ channel, itemId, name, unitLabel, quantity, revenue, date, orderRef, menu }) {
  const matched = itemId ? menu.get(itemId) : null;
  const shownName = matched ? matched.name : name;
  return {
    channel,
    itemId: itemId || null,
    key: `${channel}::${itemId || `name:${String(name).trim().toLowerCase()}`}`,
    name: shownName,
    category: matched ? matched.category : 'Unmatched',
    matched: Boolean(matched),
    unitLabel: unitLabel || '',
    units: quantity,
    revenue,
    date,
    orderRef: `${channel}:${orderRef}`,
  };
}

// The two halves of the range, and what moved between them.
//
// Both windows are the same length, always. When the range has an odd number
// of periods the oldest one falls out of the comparison rather than being
// added to the earlier window: a recent window one period shorter than the
// one it is measured against would show every dish falling, and one period
// longer would show every dish taking off. The dropped period is still in the
// totals and still on the chart — it is only out of this arithmetic, and it
// comes back named so the screen can say which one it was.
//
// A percentage needs a floor under it (MOVE_FLOOR_UNITS) or the risers list
// fills up with dishes that went from one portion to three. Below the floor
// an item is 'quiet' — a real answer, and a different one from 'steady'.
function compare(periods) {
  const window = Math.floor(periods.length / 2);
  if (window < 1) return null;

  const recentPeriods = periods.slice(periods.length - window);
  const previousPeriods = periods.slice(periods.length - 2 * window, periods.length - window);

  const sum = (series, from, count) => series.slice(from, from + count).reduce((total, value) => total + value, 0);

  return {
    window,
    recentFrom: periods.length - window,
    previousFrom: periods.length - 2 * window,
    recent: { from: recentPeriods[0].start, to: recentPeriods[window - 1].end, periods: window },
    previous: { from: previousPeriods[0].start, to: previousPeriods[window - 1].end, periods: window },
    // The oldest period, when there is an odd number of them and it therefore
    // fits in neither window. Named so the screen can say which bar is not in
    // the rising/falling arithmetic rather than leaving it to be discovered.
    ignoredPeriod: periods.length % 2 === 1 ? periods[periods.length - 2 * window - 1].label : null,
    of(series) {
      const recent = sum(series, periods.length - window, window);
      const previous = sum(series, periods.length - 2 * window, window);
      const delta = recent - previous;
      const deltaPct = previous > 0 ? delta / previous : null;
      // 'unrated' is added by the caller, which is the only place that knows
      // whether the earlier window has anything in it to be new against.
      let trend;
      if (recent > 0 && previous === 0) trend = 'new';
      else if (recent === 0 && previous > 0) trend = 'gone';
      else if (recent + previous < MOVE_FLOOR_UNITS) trend = 'quiet';
      else if (deltaPct !== null && deltaPct >= MOVE_THRESHOLD) trend = 'rising';
      else if (deltaPct !== null && deltaPct <= -MOVE_THRESHOLD) trend = 'falling';
      else trend = 'steady';
      return {
        recent: round2(recent),
        previous: round2(previous),
        deltaUnits: round2(delta),
        deltaPct: deltaPct === null ? null : Math.round(deltaPct * 1000) / 10,
        trend,
      };
    },
  };
}

// The whole report, from normalised lines. Pure — no database, no Odoo — so
// the counting rules can be tested for what they are.
function aggregate({ periods, lines, granularity = 'week' }) {
  const index = new Map(periods.map((period, position) => [period.key, position]));
  const blank = () => periods.map(() => 0);

  const periodRows = periods.map((period) => ({
    ...period,
    units: 0,
    revenue: 0,
    b2cUnits: 0,
    b2bUnits: 0,
    b2cRevenue: 0,
    b2bRevenue: 0,
    // Kept as two sets rather than one, so each side's chart can say how many
    // orders (or invoices) are behind its own column. The refs are prefixed
    // with the side, so the two can never overlap and the whole-period count
    // is their sum.
    b2cOrders: new Set(),
    b2bOrders: new Set(),
  }));

  const items = new Map();
  const totals = {
    units: 0,
    revenue: 0,
    b2cUnits: 0,
    b2bUnits: 0,
    b2cRevenue: 0,
    b2bRevenue: 0,
    unmatchedLines: 0,
  };
  const orderRefs = new Set();
  const b2cOrderRefs = new Set();
  const b2bOrderRefs = new Set();
  // Lines dated outside every bucket cannot happen — the buckets are built
  // from the range the lines were read over — so one here is a bug in the
  // date arithmetic and not a data condition. Counted rather than silently
  // dropped, so it would be visible if it ever did.
  let outOfRange = 0;

  for (const line of lines) {
    const position = index.get(periodKeyOf(line.date, granularity));
    if (position === undefined) {
      outOfRange += 1;
      continue;
    }

    const side = line.channel === 'B2B' ? 'b2b' : 'b2c';
    const row = periodRows[position];
    row.units += line.units;
    row.revenue += line.revenue;
    row[`${side}Units`] += line.units;
    row[`${side}Revenue`] += line.revenue;
    row[`${side}Orders`].add(line.orderRef);

    totals.units += line.units;
    totals.revenue += line.revenue;
    totals[`${side}Units`] += line.units;
    totals[`${side}Revenue`] += line.revenue;
    if (!line.matched) totals.unmatchedLines += 1;
    orderRefs.add(line.orderRef);
    (side === 'b2b' ? b2bOrderRefs : b2cOrderRefs).add(line.orderRef);

    if (!items.has(line.key)) {
      items.set(line.key, {
        key: line.key,
        itemId: line.itemId,
        name: line.name,
        category: line.category,
        channel: line.channel,
        matched: line.matched,
        unitLabels: new Set(),
        units: 0,
        revenue: 0,
        orders: new Set(),
        series: blank(),
        revenueSeries: blank(),
      });
    }
    const item = items.get(line.key);
    item.units += line.units;
    item.revenue += line.revenue;
    item.series[position] += line.units;
    item.revenueSeries[position] += line.revenue;
    item.orders.add(line.orderRef);
    if (line.unitLabel) item.unitLabels.add(line.unitLabel);
  }

  const comparison = compare(periods);

  // What each side of the business sold in each window. A dish cannot be
  // "new" in a window its whole side of the business did not trade in — the
  // kitchen was shut, or Odoo only goes back so far — and calling every dish
  // on the menu a riser because of that is worse than saying nothing. Where
  // the earlier window is empty the verdict is 'unrated' and the screen says
  // why.
  const windowUnits = (from, field) =>
    comparison ? periodRows.slice(from, from + comparison.window).reduce((total, row) => total + row[field], 0) : 0;
  const windowSides = comparison
    ? {
        recent: { B2C: windowUnits(comparison.recentFrom, 'b2cUnits'), B2B: windowUnits(comparison.recentFrom, 'b2bUnits') },
        previous: {
          B2C: windowUnits(comparison.previousFrom, 'b2cUnits'),
          B2B: windowUnits(comparison.previousFrom, 'b2bUnits'),
        },
      }
    : null;

  // Share is per side of the business, never across it: "12% of the portions
  // that went out of the B2C kitchen" is a fact, and "12% of portions and
  // kilos added together" is not.
  const sideUnits = { B2C: totals.b2cUnits, B2B: totals.b2bUnits };

  const itemRows = [...items.values()]
    .map((item) => {
      const moved = comparison ? comparison.of(item.series) : null;
      if (moved && windowSides.previous[item.channel] === 0) moved.trend = 'unrated';
      const sold = item.series.reduce((count, units) => count + (units > 0 ? 1 : 0), 0);
      const denominator = sideUnits[item.channel] || 0;
      return {
        key: item.key,
        itemId: item.itemId,
        name: item.name,
        category: item.category,
        channel: item.channel,
        matched: item.matched,
        // '' for a B2C portion (a dish is a dish), the invoice's own unit for
        // wholesale, and 'mixed' when one item was billed in more than one —
        // a total that silently adds kilos to packs has to say that it did.
        unitLabel: item.unitLabels.size === 0 ? '' : item.unitLabels.size === 1 ? [...item.unitLabels][0] : 'mixed',
        units: round2(item.units),
        revenue: round0(item.revenue),
        orders: item.orders.size,
        // Rupees per unit, as sold. Not a price list — a dish discounted for
        // half the range averages to something nobody was ever charged — but
        // it is what the mix is actually earning.
        avgPrice: item.units > 0 ? round0(item.revenue / item.units) : 0,
        sharePct: denominator > 0 ? Math.round((item.units / denominator) * 1000) / 10 : 0,
        periodsSold: sold,
        series: item.series.map(round2),
        revenueSeries: item.revenueSeries.map(round0),
        first: periods[item.series.findIndex((units) => units > 0)]?.start || null,
        last: periods[item.series.length - 1 - [...item.series].reverse().findIndex((units) => units > 0)]?.start || null,
        ...(moved || { recent: 0, previous: 0, deltaUnits: 0, deltaPct: null, trend: 'steady' }),
      };
    })
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name));

  // The movers lists, PER SIDE of the business. Two lists rather than one,
  // for the same reason the item rows are never merged: a top five drawn
  // across both sides is a race between portions and kilos, and the side with
  // the bigger numbers wins it every time — which would leave the weekend
  // menu's own risers off its own list.
  //
  // Sorted by how many units moved and not by percentage: the dish that gained
  // thirty portions is the news, not the one that went from four to nine. The
  // percentage is shown beside it, which is the right way round.
  const moversFor = (channel) => {
    const side = itemRows.filter((item) => item.channel === channel);
    const risers = side
      .filter((item) => (item.trend === 'rising' || item.trend === 'new') && item.deltaUnits > 0)
      .sort((a, b) => b.deltaUnits - a.deltaUnits);
    const fallers = side
      .filter((item) => (item.trend === 'falling' || item.trend === 'gone') && item.deltaUnits < 0)
      .sort((a, b) => a.deltaUnits - b.deltaUnits);
    return {
      // Five each. A list long enough to be a list and short enough that the
      // eye takes it in without scrolling; the side's full table underneath
      // carries everything else, sortable by the same column.
      rising: risers.slice(0, 5),
      falling: fallers.slice(0, 5),
      risingCount: risers.length,
      fallingCount: fallers.length,
    };
  };

  return {
    totals: {
      units: round2(totals.units),
      revenue: round0(totals.revenue),
      b2cUnits: round2(totals.b2cUnits),
      b2bUnits: round2(totals.b2bUnits),
      b2cRevenue: round0(totals.b2cRevenue),
      b2bRevenue: round0(totals.b2bRevenue),
      orders: orderRefs.size,
      b2cOrders: b2cOrderRefs.size,
      b2bOrders: b2bOrderRefs.size,
      items: itemRows.length,
      b2cItems: itemRows.filter((item) => item.channel === 'B2C').length,
      b2bItems: itemRows.filter((item) => item.channel === 'B2B').length,
      lines: lines.length,
      unmatchedLines: totals.unmatchedLines,
      outOfRange,
    },
    periods: periodRows.map((row) => ({
      key: row.key,
      label: row.label,
      start: row.start,
      end: row.end,
      units: round2(row.units),
      revenue: round0(row.revenue),
      b2cUnits: round2(row.b2cUnits),
      b2bUnits: round2(row.b2bUnits),
      b2cRevenue: round0(row.b2cRevenue),
      b2bRevenue: round0(row.b2bRevenue),
      orders: row.b2cOrders.size + row.b2bOrders.size,
      b2cOrders: row.b2cOrders.size,
      b2bOrders: row.b2bOrders.size,
    })),
    items: itemRows,
    movers: { B2C: moversFor('B2C'), B2B: moversFor('B2B') },
    comparison: comparison
      ? {
          window: comparison.window,
          recent: { ...comparison.recent, units: windowSides.recent },
          previous: { ...comparison.previous, units: windowSides.previous },
          ignoredPeriod: comparison.ignoredPeriod,
        }
      : null,
  };
}

// The report the screen reads. Everything above this line is arithmetic;
// this is the part that talks to Odoo and to the database.
async function buildItemSalesReport({ fromDate, toDate, granularity } = {}) {
  const grain = String(granularity || 'week').trim() || 'week';
  if (!GRANULARITIES.includes(grain)) badRequest(`"${grain}" is not a period — use week or month.`);

  const to = toDate ? cleanDate(toDate, 'The end of the range') : today();
  const from = fromDate
    ? cleanDate(fromDate, 'The start of the range')
    : grain === 'month'
      ? monthStartOf(addDays(to, -365))
      : addDays(weekStartOf(to), -7 * (DEFAULT_WEEKS - 1));
  if (from > to) badRequest('The start of the range is after its end.');

  const periods = periodsBetween(from, to, grain);
  if (periods.length > MAX_PERIODS) badRequest(`That range is more than ${MAX_PERIODS} ${grain}s.`);

  // The bounds actually read over — the widened ones, not the ones asked for,
  // or the first and last bars would be built from part of a week.
  const rangeFrom = periods[0].start;
  const rangeTo = periods[periods.length - 1].end;

  const odoo = getOdooConfig();
  // Odoo is allowed to fail without emptying the screen: the wholesale half
  // is local and still counts. Same degradation as Spending vs Sales, and for
  // the same reason — half a report that says which half is missing beats an
  // error page.
  const b2c = odoo.configured
    ? await fetchSoldItems({ fromDate: rangeFrom, toDate: rangeTo })
        .then((result) => ({ ...result, error: '' }))
        .catch((err) => ({ lines: [], ordersFound: 0, companyOrdersSkipped: 0, error: err.message || String(err) }))
    : { lines: [], ordersFound: 0, companyOrdersSkipped: 0, error: '' };

  const menu = menuLookup();

  const lines = [
    ...b2c.lines.map((line) =>
      normalise({
        channel: 'B2C',
        itemId: line.itemId,
        name: line.productName,
        unitLabel: '',
        quantity: line.quantity,
        revenue: line.revenue,
        date: line.day,
        orderRef: line.orderId,
        menu,
      }),
    ),
    ...all(B2B_LINE_SQL, rangeFrom, rangeTo).map((line) =>
      normalise({
        channel: 'B2B',
        // The invoice line names its own product; the Odoo product id it was
        // billed against, when it has one, is the stronger match — the same
        // order of evidence matchProduct applies everywhere else.
        itemId: matchProduct(line.description, line.odoo_product_id),
        name: line.description,
        unitLabel: line.unit_label,
        quantity: Number(line.quantity) || 0,
        revenue: Number(line.line_total) || 0,
        date: line.delivered_on,
        orderRef: line.sale_id,
        menu,
      }),
    ),
  ];

  const report = aggregate({ periods, lines, granularity: grain });

  return {
    range: {
      requested: { from: fromDate ? cleanDate(fromDate, 'The start of the range') : from, to },
      from: rangeFrom,
      to: rangeTo,
      granularity: grain,
      periods: periods.length,
    },
    sources: {
      odoo: {
        configured: odoo.configured,
        url: odoo.url,
        error: b2c.error || '',
        reachable: odoo.configured && !b2c.error,
        ordersRead: b2c.ordersFound,
        // Wholesale orders that live in Odoo as well as in this app's invoice
        // book. Held aside, not counted — see the overlap note at the top.
        companyOrdersSkipped: b2c.companyOrdersSkipped,
      },
    },
    ...report,
  };
}

export {
  buildItemSalesReport,
  aggregate,
  normalise,
  periodsBetween,
  periodKeyOf,
  compare,
  DEFAULT_WEEKS,
  MAX_PERIODS,
  MOVE_THRESHOLD,
  MOVE_FLOOR_UNITS,
};
