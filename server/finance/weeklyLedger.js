// Money out against money in, one row per trading week.
//
// The question this answers is the one that gets asked on a Monday morning:
// did last week pay for itself. Not per channel (that is Marketing ROI's
// job), not per client (that is the B2B sales book) — per week, everything
// in, everything out.
//
// WHY THE WEEK RUNS MONDAY TO SUNDAY
//
// This kitchen buys on Friday, smokes on Friday night and Saturday, and
// serves Saturday and Sunday. Those four days are one commercial event, and
// the only week boundary that keeps them in the same bucket is Monday-start.
// A Sunday-start week splits Saturday from Sunday; a Saturday-start week
// splits Friday's meat from the weekend it was bought for. Either one
// produces a row where the spend landed in week A and the sales it generated
// landed in week B, which is not a rounding error — it is the entire figure
// this screen exists to show, inverted. So: Monday to Sunday, everywhere,
// and the same rule applies to the pro-rating of marketing spend below.
//
// WHAT COUNTS AS SPEND
//
//   purchase          the raw-material and ad-hoc buying, out of SQLite. The
//                     bulk of it, and always available.
//   marketing_budget  ad spend and the rest of the marketing ledger, pro-rated
//                     into each week by day-share (see marketingBudget.js).
//
// Not counted, and deliberately: rent, salaries, gas, electricity, equipment.
// None of them is recorded anywhere in this app, and inventing a fixed weekly
// figure for them would turn a measured number into a guess wearing a
// measured number's clothes. The screen says outright that it is a
// cash-purchases view, not a P&L, so nobody reads "net" as profit.
//
// WHAT COUNTS AS SALES
//
//   b2b_sale          wholesale invoices, out of SQLite, by delivery date.
//                     Always available.
//   Odoo sale.order   the B2C side, by order date, confirmed orders only.
//                     Optional — if Odoo is not configured or is down, the
//                     week rows still report the B2B half and the screen says
//                     which half is missing.
//
// THE DOUBLE-COUNT THIS FILE IS MOST CAREFUL ABOUT
//
// A B2B delivery can exist in both places at once: logged in b2b_sale here,
// and also present in Odoo as a sale.order tagged with the "B2B" order
// source. Adding both would inflate a week's revenue by the whole of its
// wholesale side. So Odoo orders carrying that channel are pulled out of the
// B2C figure, totalled on their own, and reported as `b2bTaggedOdoo` — shown
// on screen as a note rather than silently dropped, because if that number is
// large it means the two books are being kept in parallel and somebody should
// know.
//
// THE TWO SIDES OF THE BUSINESS
//
// Every figure that can be is split B2C against B2B, on both halves of the
// ledger, because "did the week pay" and "does wholesale pay" are different
// questions and the second one is the one a new account gets judged on.
//
//   sales   already separate at source: b2b_sale is wholesale by definition,
//           and Odoo orders are the B2C side.
//   spend   from purchase.channel, which the buyer picks on Weekly Purchasing
//           and the schema constrains to B2C or B2B. So a Friday meat run for
//           a cafe order is B2B cost and never lands against weekend revenue.
//
// Marketing spend is the one thing that will not split. Its `channel` column
// is a MARKETING channel — Instagram, Reddit, Swiggy — not a side of the
// business, and most of it genuinely works both sides at once. It is reported
// as `shared` rather than apportioned: splitting it 50/50, or by revenue
// share, would invent the exact figure somebody is about to make a decision
// on. The one exception is a spend row whose channel was typed as literally
// "B2B" or "B2C", which is somebody saying which side it was for, and is
// taken at their word.
//
// The consequence, stated on screen rather than buried: a side's net excludes
// shared marketing, so the two sides' nets do not add up to the whole
// business's net. The difference is exactly the shared figure.
//
// Every figure here is rounded to the rupee on the way out. Paise on a weekly
// total is noise, and it is what makes a column of numbers fail to add up to
// the total printed under it.
import { all } from '../core/db.js';
import { listBudgets } from '../marketing/marketingBudget.js';
import { listSales } from '../ops/b2b/b2bSales.js';
import { fetchAttributedOrders, channelFromGaSource, UNATTRIBUTED } from '../marketing/orderAttribution.js';
import { getConfig as getOdooConfig } from '../integrations/odoo.js';

// The Odoo order-source value that means "this is wholesale". Matches the
// entry in CHANNELS in orderAttribution.js — the two are the same selection
// value, spelled once there for UTM mapping and once here for the overlap
// guard.
const B2B_CHANNEL = 'B2B';

// How many weeks back the screen opens on. Twelve is a quarter: long enough
// for a bad week to be visibly a bad week rather than the trend, short enough
// that every bar is still readable.
const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 104;

const round = (value) => Math.round(value);
const ratio = (value) => Math.round(value * 100) / 100;

const pad = (n) => String(n).padStart(2, '0');

// Local-calendar dates throughout, never UTC — the same rule b2bSales.js and
// serviceWeeks.js follow. toISOString() hands back yesterday for the first
// five and a half hours of every IST day, which here would file a Monday
// purchase into the previous week.
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(new Date(y, m - 1, d + days));
}

function today() {
  return isoOf(new Date());
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function cleanDate(value, what) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) badRequest(`${what} must be a date (YYYY-MM-DD).`);
  return text;
}

// The Monday on or before a date. getDay() is 0 for Sunday, so the shift back
// is (day + 6) % 7 — Monday 0, Sunday 6 — rather than day - 1, which would
// send Sunday forward six days into the following week.
function weekStartOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return isoOf(new Date(y, m - 1, d - ((date.getDay() + 6) % 7)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "1–7 Sep" for a week inside one month, "29 Sep – 5 Oct" for one that
// straddles two. The year is left off: every row on the screen is in the
// range the reader chose, and repeating it twelve times crowds out the
// figures.
function weekLabel(start, end) {
  const [, sm, sd] = start.split('-').map(Number);
  const [, em, ed] = end.split('-').map(Number);
  if (sm === em) return `${sd}–${ed} ${MONTHS[sm - 1]}`;
  return `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]}`;
}

// Every Monday-to-Sunday week touching the range, oldest first.
//
// The range is widened to whole weeks rather than clipped to the dates asked
// for. A half week at either end would be a short row shown beside full ones,
// and the eye reads a short bar as a bad week rather than as a partial one.
// The widened bounds come back on the report so the screen can say which days
// it actually covered.
function weeksBetween(fromDate, toDate) {
  const first = weekStartOf(fromDate);
  const last = weekStartOf(toDate);
  const weeks = [];
  for (let start = first; start <= last; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    weeks.push({ weekStart: start, weekEnd: end, label: weekLabel(start, end) });
  }
  return weeks;
}

// An empty week, with every bucket present from the start.
//
// Seeded rather than built up as figures arrive, because a week with no
// trading has to render as a row of measured zeroes. A missing key that reads
// as blank is indistinguishable from a week nobody entered anything for, and
// the two mean opposite things: one is a closed kitchen, the other is a data
// gap.
function emptyWeek(week) {
  return {
    ...week,
    spend: {
      materials: 0,
      services: 0,
      uncategorised: 0,
      purchases: 0,
      marketing: 0,
      total: 0,
      // The same money again, cut the other way: which side of the business
      // it was spent on. `shared` is the marketing that belongs to neither —
      // see the note at the top of this file on why it is not apportioned.
      b2c: 0,
      b2b: 0,
      shared: 0,
    },
    sales: { b2c: 0, b2b: 0, total: 0 },
    counts: { purchaseLines: 0, uncostedLines: 0, b2cOrders: 0, b2bInvoices: 0, marketingRows: 0 },
    // Booked is not banked. A wholesale invoice is revenue on the day it is
    // delivered and cash whenever the client pays, which on 15-day terms is
    // the week after next — so a week can look profitable and still be the
    // reason the account is empty. Carried per week so that gap is visible
    // rather than inferred.
    b2bOutstanding: 0,
    // Odoo orders tagged B2B: excluded from `sales.b2c` above, kept here so
    // the overlap can be reported instead of silently disappearing.
    b2bTaggedOdoo: 0,
    partialMarketing: false,
  };
}

// The derived figures for a week or for the whole range, in one place so the
// week rows and the totals tile cannot compute "margin" two different ways.
//
// `net` is sales minus the spend this app can see. It is NOT profit, and the
// screen says so — see the header note on what is excluded.
//
// `spendRatio` is null rather than 0 when there were no sales. A week that
// spent Rs 9,000 and sold nothing has an undefined ratio, not a 0% one, and a
// 0 would sort it beside the best week on the screen.
function derive({ spend, sales }) {
  return {
    net: round(sales - spend),
    spendRatio: sales > 0 ? ratio((spend / sales) * 100) : null,
    margin: sales > 0 ? ratio(((sales - spend) / sales) * 100) : null,
  };
}

// One side of the business, as its own little profit line.
//
// Built from the same derive() as everything else so a side's margin and the
// whole business's margin cannot be computed two different ways. `shared` is
// carried alongside rather than folded in, so a reader can see immediately
// why B2C net plus B2B net is not the total net.
function sides({ spend, sales }) {
  return {
    b2c: { spend: round(spend.b2c), sales: round(sales.b2c), ...derive({ spend: spend.b2c, sales: sales.b2c }) },
    b2b: { spend: round(spend.b2b), sales: round(sales.b2b), ...derive({ spend: spend.b2b, sales: sales.b2b }) },
    shared: { spend: round(spend.shared) },
  };
}

// ---- Spend -----------------------------------------------------------------

// Read straight out of the purchase table rather than through kbViews'
// projection: that one exists to hand the screens CSV-shaped strings with
// blanks for nulls, and this file needs to tell a zero-cost line from an
// uncosted one, which a blank cannot.
const PURCHASE_SQL = `
  SELECT p.purchase_date,
         p.channel,
         p.item_type,
         p.expense_category,
         p.total_cost,
         p.item_name,
         p.client_id,
         p.client_name,
         v.vendor_name,
         p.vendor_id
    FROM purchase p
    LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
   WHERE p.purchase_date >= ? AND p.purchase_date <= ?`;

// Which spend bucket a purchase line belongs in.
//
// item_type is 'material' for anything bought out of the catalogue and NULL
// for an ad-hoc line somebody typed a name into — recordPurchases only ever
// writes those two, though the schema allows 'service' as well. The NULL case
// is a third bucket rather than being folded into materials: it is the
// packaging, the ice, the gas refill, and knowing how much of a week's spend
// was off-catalogue is the point of separating it.
function purchaseBucket(itemType) {
  if (itemType === 'material') return 'materials';
  if (itemType === 'service') return 'services';
  return 'uncategorised';
}

// ---- The report ------------------------------------------------------------

async function buildWeeklyReport({ fromDate, toDate, weeks } = {}) {
  const to = toDate ? cleanDate(toDate, 'The end of the range') : today();
  const wanted = weeks === undefined || weeks === '' ? DEFAULT_WEEKS : Number(weeks);
  if (!Number.isFinite(wanted) || wanted < 1 || wanted > MAX_WEEKS) {
    badRequest(`The number of weeks must be between 1 and ${MAX_WEEKS}.`);
  }
  const from = fromDate
    ? cleanDate(fromDate, 'The start of the range')
    : addDays(weekStartOf(to), -7 * (Math.floor(wanted) - 1));
  if (from > to) badRequest('The start of the range is after its end.');

  const buckets = weeksBetween(from, to);
  if (buckets.length > MAX_WEEKS) badRequest(`That range is more than ${MAX_WEEKS} weeks.`);

  // The whole-week bounds everything below is read over. Wider than what was
  // asked for, by up to six days at each end — see weeksBetween.
  const rangeFrom = buckets[0].weekStart;
  const rangeTo = buckets[buckets.length - 1].weekEnd;

  const odoo = getOdooConfig();

  // Odoo is fetched alongside nothing else it can take down with it. Unlike
  // the ROI screen, revenue here is not all Odoo's — the wholesale half lives
  // locally — so a failed read degrades the screen rather than emptying it.
  const b2c = odoo.configured
    ? await fetchAttributedOrders({ fromDate: rangeFrom, toDate: rangeTo })
        .then((result) => ({ orders: result.orders, error: '' }))
        .catch((err) => ({ orders: [], error: err.message || String(err) }))
    : { orders: [], error: '' };

  const rows = new Map(buckets.map((week) => [week.weekStart, emptyWeek(week)]));
  // Anything dated inside the range but outside every bucket cannot happen —
  // the buckets are built from the range — so a miss here is a bug in the
  // date arithmetic, not a data condition, and it is dropped rather than
  // given a row of its own that would not add up.
  const weekOf = (date) => rows.get(weekStartOf(date));

  // ---- Purchases ---------------------------------------------------------
  const vendors = new Map();
  const categories = new Map();
  let uncostedLines = 0;

  // Every rollup on this screen is filterable by side, so the category list
  // carries its own split rather than being the one table that silently stays
  // whole-business when a side is picked.
  const addCategory = (name, side, amount) => {
    const row = categories.get(name) || { category: name, spend: 0, b2c: 0, b2b: 0 };
    row.spend += amount;
    if (side) row[side] += amount;
    categories.set(name, row);
  };

  // The wholesale account book, keyed by client id rather than by name: the
  // name on a purchase row is whatever it was called the day it was bought,
  // and the name on a sale is read live through b2bClients, so joining on the
  // two strings would split an account in half the first time somebody fixes
  // a spelling. Seeded from both sides, so an account that was bought for but
  // not yet invoiced gets a row — that is money out with nothing against it,
  // which is exactly the row worth seeing.
  const clients = new Map();
  // B2B cost that came from the purchase book, as against B2B cost that came
  // from a marketing row somebody typed "B2B" into. Only the first kind can
  // be tagged to an account, so only the first kind is what the per-client
  // table's coverage is measured against.
  let b2bPurchaseSpend = 0;
  const clientOf = (id, fallbackName) => {
    if (!clients.has(id)) {
      clients.set(id, {
        id,
        client: fallbackName || id,
        sales: 0,
        spend: 0,
        invoices: 0,
        purchaseLines: 0,
        outstanding: 0,
      });
    }
    const row = clients.get(id);
    // The sales side wins the name when it has one, because it comes from the
    // live client book; a purchase row's copy is only used if nothing else
    // ever names the account.
    if (fallbackName && row.client === id) row.client = fallbackName;
    return row;
  };

  all(PURCHASE_SQL, rangeFrom, rangeTo).forEach((line) => {
    const week = weekOf(line.purchase_date);
    if (!week) return;

    week.counts.purchaseLines += 1;

    // A line with no unit price has no total cost — see recordPurchases,
    // which writes NULL for both rather than a zero. It is counted as a line
    // and contributes nothing to the money, and the count is reported so a
    // week whose spend looks impossibly low says why.
    if (line.total_cost === null || line.total_cost === undefined) {
      week.counts.uncostedLines += 1;
      uncostedLines += 1;
      return;
    }

    const cost = Number(line.total_cost) || 0;
    const bucket = purchaseBucket(line.item_type);
    week.spend[bucket] += cost;
    week.spend.purchases += cost;
    week.spend.total += cost;

    // The side of the business this cost belongs to. The column is NOT NULL
    // with a CHECK of ('B2C','B2B'), so there is no third case to handle —
    // anything that is not B2B is B2C by the schema's own definition.
    const side = line.channel === 'B2B' ? 'b2b' : 'b2c';
    week.spend[side] += cost;
    if (side === 'b2b') b2bPurchaseSpend += cost;

    const vendor = line.vendor_name || line.vendor_id || 'Unknown vendor';
    const vendorRow = vendors.get(vendor) || { vendor, spend: 0, b2c: 0, b2b: 0, lines: 0 };
    vendorRow.spend += cost;
    vendorRow[side] += cost;
    vendorRow.lines += 1;
    vendors.set(vendor, vendorRow);

    // Cost bought for one named account. Only B2B lines carry a client — see
    // recordPurchases, which drops the tag on the B2C side because there is no
    // account book to attribute it to. An untagged B2B line is general
    // wholesale overhead, which is a real answer and not a gap, so it stays in
    // the B2B total above without joining any client's row.
    if (side === 'b2b' && line.client_id) {
      const account = clientOf(line.client_id, line.client_name);
      account.spend += cost;
      account.purchaseLines += 1;
    }

    // expense_category is what the Purchase Logger writes (Finance →
    // Purchase Logger, server/finance/purchaseLog.js) and what Weekly
    // Purchasing stamps 'Raw materials' on. It is still nullable: an
    // off-catalogue line is left blank on purpose rather than guessed at, and
    // everything bought before the column had a writer is blank too. So the
    // fallback stays the bucket rather than a blank label — a "where did it
    // go" list of empty strings answers nothing.
    addCategory(line.expense_category || bucket, side, cost);
  });

  // ---- Marketing spend ---------------------------------------------------
  // Asked week by week rather than once for the range, because that is what
  // makes the pro-rating land in the right rows: a month-long Instagram
  // budget is seven-thirtieths of itself in each week it overlaps, and
  // listBudgets computes exactly that share for whatever window it is given.
  buckets.forEach((week) => {
    const row = rows.get(week.weekStart);
    listBudgets({ fromDate: week.weekStart, toDate: week.weekEnd }).forEach((spend) => {
      row.spend.marketing += spend.amountInRange;
      row.spend.total += spend.amountInRange;
      row.counts.marketingRows += 1;

      // A marketing channel is Instagram or Reddit, not a side of the
      // business, so this spend is shared by default. The exception is a row
      // whose channel was typed as literally "B2B" or "B2C" — that is
      // somebody stating which side it was for, and it is taken at their
      // word rather than thrown into the shared pot with the rest.
      // Null side, not a default of B2C: shared marketing belongs to neither,
      // and addCategory leaves it out of both columns while still counting it
      // in the row's total.
      const marketingSide = spend.channel === 'B2B' ? 'b2b' : spend.channel === 'B2C' ? 'b2c' : null;
      if (marketingSide) row.spend[marketingSide] += spend.amountInRange;
      else row.spend.shared += spend.amountInRange;
      // Marked when any of the week's marketing spend is a slice of a longer
      // period rather than a figure somebody entered for these days. The
      // screen shows the flag so a pro-rated number is never taken as an
      // invoice.
      if (spend.partial) row.partialMarketing = true;
      addCategory('marketing', marketingSide, spend.amountInRange);
    });
  });

  // ---- B2B sales ---------------------------------------------------------
  // By delivery date, which is what listSales ranges on and what b2bSales.js
  // treats as the revenue date — the invoice may be raised days later and
  // paid weeks later, and neither is when the food left the kitchen.
  const b2b = listSales({ from: rangeFrom, to: rangeTo });

  b2b.sales.forEach((sale) => {
    const week = weekOf(sale.deliveredOn);
    if (!week) return;
    week.sales.b2b += sale.amount;
    week.sales.total += sale.amount;
    week.counts.b2bInvoices += 1;
    week.b2bOutstanding += sale.outstanding;

    const row = clientOf(sale.clientId, sale.clientName);
    // Unconditionally, not only as a fallback: this name came from the live
    // client book and is the current one.
    row.client = sale.clientName;
    row.sales += sale.amount;
    row.invoices += 1;
    row.outstanding += sale.outstanding;
  });

  // ---- B2C sales ---------------------------------------------------------
  let pendingRevenue = 0;
  let pendingOrders = 0;
  let b2bTaggedOdoo = 0;
  let b2bTaggedOrders = 0;

  // Where the weekend revenue came from, per channel.
  //
  // This screen has always been able to say how much the B2C side made and
  // never which channel made it, which sent the reader to Marketing ROI to
  // answer half of one question. The rollup is here so both halves are on
  // one screen -- but the CREDITING RULE IS NOT REINVENTED HERE. It is
  // exactly the rule marketingRoi.js applies, imported rather than copied:
  // the utm_source on the order wins over the Order Source somebody filed it
  // under, because the tag is a fact about the link that was clicked and the
  // filing is a judgement made afterwards. If these two files ever resolved a
  // channel differently, the same order would show under Reddit on one screen
  // and Website on the other, and there would be no way to tell which screen
  // was lying.
  const b2cSources = new Map();
  const sourceOf = (channel) => {
    let row = b2cSources.get(channel);
    if (!row) {
      row = { channel, sales: 0, orders: 0, fromLink: 0, linkRevenue: 0 };
      b2cSources.set(channel, row);
    }
    return row;
  };

  b2c.orders.forEach((order) => {
    const week = weekOf(String(order.orderedOn).slice(0, 10));
    if (!week) return;

    // Draft quotations. Real money soon, not revenue now — the same rule the
    // ROI screen applies. Totalled separately so a week with a lot of them
    // does not look quiet when it is actually about to be busy.
    if (!order.countsAsRevenue) {
      pendingRevenue += order.amount;
      pendingOrders += 1;
      return;
    }

    // The overlap guard. See the note at the top of this file: this money is
    // very likely already counted in b2b_sale, so it is held aside rather
    // than added to either total.
    if (order.channel === B2B_CHANNEL) {
      week.b2bTaggedOdoo += order.amount;
      b2bTaggedOdoo += order.amount;
      b2bTaggedOrders += 1;
      return;
    }

    week.sales.b2c += order.amount;
    week.sales.total += order.amount;
    week.counts.b2cOrders += 1;

    // An order with neither a link nor a filed source is not spread across
    // the channels that do have one -- it gets the Unattributed row, exactly
    // as on the ROI screen, so the reader can see how much of the split is
    // actually measured.
    const linkChannel = channelFromGaSource(order.utm?.source || '');
    const row = sourceOf(linkChannel || order.channel || UNATTRIBUTED);
    row.sales += order.amount;
    row.orders += 1;
    if (linkChannel) {
      row.fromLink += 1;
      row.linkRevenue += order.amount;
    }
  });

  // The denominator for the per-source shares. Summed from the rollup itself
  // rather than from the week totals: both are the same figure, but only this
  // one is guaranteed to stay the same figure if the loop above ever changes
  // what it counts.
  const b2cSalesTotal = [...b2cSources.values()].reduce((sum, row) => sum + row.sales, 0);

  // ---- Shape -------------------------------------------------------------
  const weekRows = buckets.map((week) => {
    const row = rows.get(week.weekStart);
    const spend = {
      materials: round(row.spend.materials),
      services: round(row.spend.services),
      uncategorised: round(row.spend.uncategorised),
      purchases: round(row.spend.purchases),
      marketing: round(row.spend.marketing),
      total: round(row.spend.total),
      b2c: round(row.spend.b2c),
      b2b: round(row.spend.b2b),
      shared: round(row.spend.shared),
    };
    const sales = { b2c: round(row.sales.b2c), b2b: round(row.sales.b2b), total: round(row.sales.total) };
    return {
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      label: row.label,
      spend,
      sales,
      ...derive({ spend: row.spend.total, sales: row.sales.total }),
      // The same week again, per side of the business. Carried on every row
      // rather than only in the totals, so the chart can be switched to one
      // side and still have a figure for every week.
      sides: sides({ spend: row.spend, sales: row.sales }),
      counts: row.counts,
      b2bOutstanding: round(row.b2bOutstanding),
      b2bTaggedOdoo: round(row.b2bTaggedOdoo),
      partialMarketing: row.partialMarketing,
      // Whether anything at all happened in this week. A closed weekend is a
      // real answer and the row stays, but the screen greys it rather than
      // showing four zeroes that read like a broken query.
      quiet: row.spend.total === 0 && row.sales.total === 0,
    };
  });

  const totalSpend = weekRows.reduce((sum, week) => sum + week.spend.total, 0);
  const totalSales = weekRows.reduce((sum, week) => sum + week.sales.total, 0);
  const trading = weekRows.filter((week) => !week.quiet);

  // Best and worst are picked over trading weeks only. A quiet week is a net
  // of zero, which would otherwise beat every week that lost money and be
  // reported as the best one.
  const ranked = [...trading].sort((a, b) => b.net - a.net);

  return {
    range: {
      // What was asked for, and what was actually covered once the ends were
      // rounded out to whole weeks. Both, because they differ by up to six
      // days and the figures belong to the second one.
      requested: { from, to },
      from: rangeFrom,
      to: rangeTo,
      weeks: weekRows.length,
    },
    sources: {
      odoo: {
        configured: odoo.configured,
        url: odoo.url,
        error: b2c.error,
        // Configured and failing is its own state, distinct from not set up:
        // the first means the B2C column is missing and should come back, the
        // second means it was never there.
        reachable: odoo.configured && !b2c.error,
      },
    },
    totals: {
      spend: round(totalSpend),
      sales: round(totalSales),
      ...derive({ spend: totalSpend, sales: totalSales }),
      materials: round(weekRows.reduce((sum, week) => sum + week.spend.materials, 0)),
      services: round(weekRows.reduce((sum, week) => sum + week.spend.services, 0)),
      uncategorised: round(weekRows.reduce((sum, week) => sum + week.spend.uncategorised, 0)),
      marketing: round(weekRows.reduce((sum, week) => sum + week.spend.marketing, 0)),
      b2c: round(weekRows.reduce((sum, week) => sum + week.sales.b2c, 0)),
      b2b: round(weekRows.reduce((sum, week) => sum + week.sales.b2b, 0)),
      b2cSpend: round(weekRows.reduce((sum, week) => sum + week.spend.b2c, 0)),
      b2bSpend: round(weekRows.reduce((sum, week) => sum + week.spend.b2b, 0)),
      sharedSpend: round(weekRows.reduce((sum, week) => sum + week.spend.shared, 0)),
      b2cOrders: weekRows.reduce((sum, week) => sum + week.counts.b2cOrders, 0),
      b2bInvoices: weekRows.reduce((sum, week) => sum + week.counts.b2bInvoices, 0),
      purchaseLines: weekRows.reduce((sum, week) => sum + week.counts.purchaseLines, 0),
      uncostedLines,
      // Averages over trading weeks, not over the calendar. Two closed weeks
      // in a twelve-week range would drag a per-week average down by a sixth
      // and make a good quarter read as a mediocre one.
      tradingWeeks: trading.length,
      avgSpend: trading.length ? round(totalSpend / trading.length) : 0,
      avgSales: trading.length ? round(totalSales / trading.length) : 0,
      b2bOutstanding: round(weekRows.reduce((sum, week) => sum + week.b2bOutstanding, 0)),
      b2bTaggedOdoo: round(b2bTaggedOdoo),
      b2bTaggedOrders,
      pendingRevenue: round(pendingRevenue),
      pendingOrders,
    },
    // The whole range, per side. The headline answer to "does wholesale pay":
    // its own cost against its own revenue, with the marketing that could not
    // be attributed to either side kept visibly outside both.
    sides: sides({
      spend: {
        b2c: weekRows.reduce((sum, week) => sum + week.spend.b2c, 0),
        b2b: weekRows.reduce((sum, week) => sum + week.spend.b2b, 0),
        shared: weekRows.reduce((sum, week) => sum + week.spend.shared, 0),
      },
      sales: {
        b2c: weekRows.reduce((sum, week) => sum + week.sales.b2c, 0),
        b2b: weekRows.reduce((sum, week) => sum + week.sales.b2b, 0),
      },
    }),
    weeks: weekRows,
    best: ranked[0] || null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    vendors: [...vendors.values()]
      .map((row) => ({ ...row, spend: round(row.spend), b2c: round(row.b2c), b2b: round(row.b2b) }))
      .sort((a, b) => b.spend - a.spend),
    categories: [...categories.values()]
      .map((row) => ({ category: row.category, spend: round(row.spend), b2c: round(row.b2c), b2b: round(row.b2b) }))
      .sort((a, b) => b.spend - a.spend),
    // Per account: what it bought from us against what we bought for it.
    // Only the directly-tagged cost — a wholesale line nobody tagged is real
    // B2B cost but belongs to no one account, so it is in the B2B total and
    // in no row here. `untaggedB2bSpend` is exactly that difference, printed
    // so the column is never mistaken for the whole of the B2B cost.
    clients: [...clients.values()]
      .map((row) => ({
        ...row,
        sales: round(row.sales),
        spend: round(row.spend),
        outstanding: round(row.outstanding),
        ...derive({ spend: row.spend, sales: row.sales }),
      }))
      .sort((a, b) => b.sales - a.sales || b.spend - a.spend),
    untaggedB2bSpend: round(b2bPurchaseSpend - [...clients.values()].reduce((sum, row) => sum + row.spend, 0)),
    // Per channel: which source the weekend revenue came in through. Shares
    // are of the B2C total only -- of the money this rollup actually covers,
    // not of all sales, or the wholesale half would silently shrink every
    // percentage on the B2C tab.
    b2cSources: [...b2cSources.values()]
      .map((row) => ({
        channel: row.channel,
        sales: round(row.sales),
        orders: row.orders,
        fromLink: row.fromLink,
        linkRevenue: round(row.linkRevenue),
        share: b2cSalesTotal > 0 ? ratio((row.sales / b2cSalesTotal) * 100) : null,
        aov: row.orders > 0 ? round(row.sales / row.orders) : null,
        unattributed: row.channel === UNATTRIBUTED,
      }))
      // Unattributed is always last however big it is: it is a measurement
      // gap, not a channel, and ranking it against real ones invites reading
      // it as the best-performing source we have.
      .sort((a, b) => {
        if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
        return b.sales - a.sales;
      }),
  };
}

export { buildWeeklyReport, weekStartOf, weeksBetween, weekLabel, derive, sides, purchaseBucket, DEFAULT_WEEKS, MAX_WEEKS };
