import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultWeekendRange } from '../ops/shared/packing';
import { REPORT_START } from '../reportRange';

// Spending vs Sales — money out against money in, one row per trading week.
//
// The Monday-morning screen. Marketing ROI answers "which channel paid";
// this one answers the blunter question underneath it: did last week pay at
// all, and is the trend going the right way.
//
// Two things this screen is careful to say out loud, because both would
// otherwise be read as something they are not:
//
//   * Net is not profit. Rent, electricity and anything else nobody has typed
//     in are not in the spend figure. What is here is purchases, marketing, and
//     the labour and miscellaneous expenses entered per week on Weekly
//     Purchasing — real cash out, but not all of the cost.
//
//   * Booked is not banked. A wholesale invoice is revenue the day the food
//     is delivered and cash whenever the client pays, which on 15-day terms
//     is the week after next. A week can be the best on the chart and be the
//     reason the account is empty, so outstanding is shown beside sales
//     rather than left to the receivables screen.
//
//   * The two sides do not add up. B2C and B2B each get their own cost and
//     their own revenue, but the marketing that works both at once is not
//     apportioned between them — it sits in `shared`. So B2C net plus B2B net
//     is short of the whole-business net by exactly that figure, and the
//     summary panel prints it as its own card rather than leaving the reader
//     to discover the arithmetic does not close.
//
// Backend: server/finance/weeklyLedger.js. It is the file that decides the
// week runs Monday to Sunday, and the comment at the top of it says why —
// Friday's buying and the weekend it feeds have to land in one row.
//
// Styling: the `.mkt-*` classes are the shared report-screen language of this
// app (toolbar, tiles, panels, tables, alerts), reused deliberately rather
// than copied under a new prefix. The `.fin-*` block in App.css is only the
// weekly column chart, which is the one thing here no other screen has.

// The two series colours. The same pairing Marketing ROI uses, and the same
// direction: blue is money out, ember is money in. Consistency across the two
// money screens matters more than a fresh palette — a reader who learns the
// mapping once should not have to relearn it one sidebar entry away.
//
// Re-validated for this screen against its surface (#ffffff) with the dataviz
// palette validator: both inside the lightness band, both above the chroma
// floor, adjacent CVD separation 21.2 (protan) against a floor of 8, normal
// vision 32.0, and both over 3:1 against the surface. Do not swap these for
// eyeballed values — re-run the validator.
const COLOR_SPEND = '#1668a8';
const COLOR_SALES = '#d9480f';

// One side of the business as its own profit line. `shared` has no revenue
// of its own by definition, so it is the one bucket with a spend and nothing
// else.
type SideFigures = { spend: number; sales: number; net: number; spendRatio: number | null; margin: number | null };
type Sides = { b2c: SideFigures; b2b: SideFigures; shared: { spend: number } };

// Which side of the business the chart is showing. 'all' is the whole thing,
// spend and sales including the shared marketing that belongs to neither.
type Side = 'all' | 'b2c' | 'b2b';

// One channel the weekend revenue arrived through.
//
// The crediting rule is the server's, and it is the same one Marketing ROI
// uses: the utm_source on the order beats the Order Source it was filed
// under. `fromLink` is how many of the row's orders got here that way, so a
// row that looks surprising can be checked against whether a link put it
// there or a person did.
type B2cSourceRow = {
  channel: string;
  sales: number;
  orders: number;
  fromLink: number;
  linkRevenue: number;
  share: number | null;
  aov: number | null;
  unattributed: boolean;
};

type Discounts = { total: number; onItems: number; coupons: number; orders: number };

type WeekRow = {
  weekStart: string;
  weekEnd: string;
  label: string;
  spend: {
    materials: number;
    services: number;
    uncategorised: number;
    purchases: number;
    marketing: number;
    // Optional: server/ is not hot-reloaded, so an older API build won't send them.
    labour?: number;
    misc?: number;
    total: number;
    // Practice buying — outside `total`; see the Total investment tile.
    practice?: number;
    b2c: number;
    b2b: number;
    shared: number;
  };
  sales: { b2c: number; b2b: number; total: number };
  sides: Sides;
  net: number;
  spendRatio: number | null;
  margin: number | null;
  counts: {
    purchaseLines: number;
    uncostedLines: number;
    b2cOrders: number;
    b2bInvoices: number;
    marketingRows: number;
  };
  b2bOutstanding: number;
  b2bTaggedOdoo: number;
  // Money taken off this week's counted B2C orders — already out of
  // sales.b2c, so shown beside it and never subtracted again. Optional: an
  // older API build won't send it.
  discounts?: Discounts;
  partialMarketing: boolean;
  quiet: boolean;
};

type WeeklyReport = {
  range: { requested: { from: string; to: string }; from: string; to: string; weeks: number };
  sources: { odoo: { configured: boolean; url: string; error: string; reachable: boolean; discountsError?: string } };
  totals: {
    spend: number;
    sales: number;
    net: number;
    spendRatio: number | null;
    margin: number | null;
    materials: number;
    services: number;
    uncategorised: number;
    marketing: number;
    b2c: number;
    b2b: number;
    b2cSpend: number;
    b2bSpend: number;
    sharedSpend: number;
    b2cOrders: number;
    b2bInvoices: number;
    purchaseLines: number;
    uncostedLines: number;
    tradingWeeks: number;
    avgSpend: number;
    avgSales: number;
    b2bOutstanding: number;
    b2bTaggedOdoo: number;
    b2bTaggedOrders: number;
    pendingRevenue: number;
    pendingOrders: number;
    discounts?: number;
    discountOnItems?: number;
    discountCoupons?: number;
    discountedOrders?: number;
    // Practice buying, left out of `spend`, and spend with it put back.
    practice?: number;
    practiceB2c?: number;
    practiceB2b?: number;
    practiceLines?: number;
    investmentBuys?: number;
    investmentB2c?: number;
    investmentB2b?: number;
    investmentLines?: number;
    investment?: number;
  };
  sides: Sides;
  weeks: WeekRow[];
  best: WeekRow | null;
  worst: WeekRow | null;
  vendors: { vendor: string; spend: number; b2c: number; b2b: number; lines: number }[];
  categories: { category: string; spend: number; b2c: number; b2b: number }[];
  clients: {
    id: string;
    client: string;
    sales: number;
    spend: number;
    invoices: number;
    purchaseLines: number;
    outstanding: number;
    net: number;
    margin: number | null;
  }[];
  // B2B buying that carries no client tag — general wholesale overhead. Real
  // cost on the B2B side, belonging to no one account, so it is in the side
  // total and in none of the client rows.
  untaggedB2bSpend: number;
  // Optional for the same reason the rest of this app treats new server
  // fields as optional: server/ is not hot-reloaded, so a tab left open
  // against an older API build has to render without it rather than crash.
  b2cSources?: B2cSourceRow[];
};

// The four keys the server invents, as against the expense_category values it
// passes straight through (the twelve in server/core/expenseCategories.js,
// written by Finance → Purchase Logger). Three of them are what a purchase
// line falls back to when nobody set a category on it, so they are labelled as
// the fallback they are — sitting in the same list as a real category like
// "Practice / R&D" under a tidy name, they would read as one, and a row that
// says "no category set" is a prompt to go and file it.
const CATEGORY_LABELS: Record<string, string> = {
  materials: 'Catalogue materials — no category set',
  services: 'Services — no category set',
  uncategorised: 'Off-catalogue buying — no category set',
  marketing: 'Marketing',
};

// Indian digit grouping, no paise — every figure arrives rounded to the rupee
// from the server, and paise on a weekly total is noise.
const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (value: number) => `₹${grouped.format(Math.round(value))}`;

// Compact rupees for the axis, where four full figures stacked up would be
// wider than the plot they label.
const shortMoney = (value: number) => {
  if (value === 0) return '₹0';
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(value) >= 1000) return `₹${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `₹${Math.round(value)}`;
};

// Null means the ratio has no denominator — a week that spent and sold
// nothing to divide by — which is a different fact from 0% and has to read
// differently, or the two sort together.
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(value < 10 && value > -10 ? 1 : 0)}%`);

const signed = (value: number) => `${value >= 0 ? '' : '−'}${money(Math.abs(value))}`;

const SIDE_LABELS: Record<Side, string> = { all: 'Whole business', b2c: 'B2C weekend', b2b: 'B2B wholesale' };

// The pair of figures the chart draws for one week, under the selected side.
// One place, so the bars, the tooltip and the best/worst line cannot end up
// reading a different side from each other.
const seriesOf = (week: WeekRow, side: Side) =>
  side === 'all'
    ? { spend: week.spend.total, sales: week.sales.total, net: week.net, margin: week.margin }
    : { spend: week.sides[side].spend, sales: week.sides[side].sales, net: week.sides[side].net, margin: week.sides[side].margin };

// The whole range under the selected side, in the same shape as one week, so
// the tiles read from the filter exactly like the chart and the table do.
const totalsOf = (report: WeeklyReport, side: Side) =>
  side === 'all'
    ? { spend: report.totals.spend, sales: report.totals.sales, net: report.totals.net, margin: report.totals.margin, spendRatio: report.totals.spendRatio }
    : report.sides[side];

// A rollup row's figure under the selected side. Vendors and categories both
// carry their own b2c/b2b split, so one helper covers both — and a row whose
// figure is zero on the selected side is dropped by the callers rather than
// shown as an empty line, because "this vendor did nothing on this side" is
// better said by absence than by a row of dashes.
const sideAmount = (row: { spend: number; b2c: number; b2b: number }, side: Side) =>
  side === 'all' ? row.spend : row[side];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const weeksAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n * 7);
  return iso(date);
};

// Moves a yyyy-mm-dd string by whole days, in local time, for the week stepper.
const shiftDays = (value: string, n: number) => {
  const [y, m, d] = value.split('-').map(Number);
  return iso(new Date(y, m - 1, d + n));
};

const SpendVsSales = () => {
  // Opens on the current Mon→Sun service week, same as Marketing ROI, so the
  // two money screens show the same week side by side. The multi-week presets
  // are still there for the trend.
  const [from, setFrom] = useState(() => defaultWeekendRange().from);
  const [to, setTo] = useState(() => defaultWeekendRange().to);
  // The side filter lives up here with the date range rather than inside the
  // chart, because it is a filter on the whole screen and not a chart option:
  // the tiles, the week table and both breakdowns all read from it. A control
  // that changes half a dashboard has to sit where the other filters are, or
  // the half it did not change looks like it disagrees with the half it did.
  const [side, setSide] = useState<Side>('all');

  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Only the date range is a server round trip. The report already carries
  // every figure split by side, so switching sides is instant and cannot
  // disagree with itself halfway through a refetch.
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/finance/weekly?from=${from}&to=${to}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the weekly report.');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const preset = (weeks: number) => {
    setFrom(weeksAgo(weeks - 1));
    setTo(iso(new Date()));
  };

  const setRange = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
  };

  return (
    <div className="mkt-roi">
      {/* A div, not a <header> — `.marketing-dashboard header` in App.css is
          the dark hero the parent dashboard already renders, and a second one
          here would read as a duplicate page title. */}
      <div className="mkt-head">
        <h3>Spending vs Sales</h3>
        <p>
          What went out against what came in, week by week. Weeks run Monday to Sunday so Friday&apos;s buying and the
          weekend it feeds sit in the same row. Weekend orders count in the week of the slot they were booked for, not
          the day they were placed.
        </p>
      </div>

      <div className="mkt-toolbar">
        <div className="mkt-range">
          <label className="mkt-range-field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="mkt-range-field">
            <span>To</span>
            <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
          </label>
          <div className="mkt-presets">
            <button
              type="button"
              className="mkt-chip"
              aria-label="Previous week"
              onClick={() => setRange(shiftDays(from, -7), shiftDays(to, -7))}
            >
              ‹ Week
            </button>
            <button
              type="button"
              className="mkt-chip"
              onClick={() => {
                const week = defaultWeekendRange();
                setRange(week.from, week.to);
              }}
            >
              This week
            </button>
            <button
              type="button"
              className="mkt-chip"
              aria-label="Next week"
              onClick={() => setRange(shiftDays(from, 7), shiftDays(to, 7))}
            >
              Week ›
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(4)}>
              Last 4 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(8)}>
              Last 8 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(12)}>
              Last 12 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(26)}>
              Last 26 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => setRange(REPORT_START, iso(new Date()))}>
              All time
            </button>
          </div>
        </div>

        {/* The second filter, beside the first. Reuses `.mkt-tab` so it reads
            as the same kind of control as the tabs on Marketing ROI. */}
        <div className="mkt-tabs fin-side-tabs" role="group" aria-label="Side of the business">
          {(['all', 'b2c', 'b2b'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`mkt-tab${side === option ? ' is-active' : ''}`}
              onClick={() => setSide(option)}
              aria-pressed={side === option}
            >
              {SIDE_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {loading && !report ? <div className="mkt-alert">Adding up the weeks…</div> : null}

      {report ? <Report report={report} side={side} /> : null}
    </div>
  );
};

// ---- The report ------------------------------------------------------------

const Report = ({ report, side }: { report: WeeklyReport; side: Side }) => {
  const { totals, weeks, range, sources } = report;
  // Every headline figure on the screen, under the filter. Read once here and
  // passed down, so no panel can end up computing the filtered total its own
  // slightly different way.
  const shown = totalsOf(report, side);
  // Practice cooks fed no sale, so the server leaves them out of every spend,
  // net and margin figure on this screen. They are still money out, and this
  // is where they come back: spending on the side shown, plus its practice.
  const practice =
    side === 'b2c' ? totals.practiceB2c ?? 0 : side === 'b2b' ? totals.practiceB2b ?? 0 : totals.practice ?? 0;
  // Investment-tab buys (a smoker, a freezer) are left out the same way.
  const investmentBuys =
    side === 'b2c'
      ? totals.investmentB2c ?? 0
      : side === 'b2b'
        ? totals.investmentB2b ?? 0
        : totals.investmentBuys ?? 0;
  const investment = shown.spend + practice + investmentBuys;

  return (
    <div className="mkt-body">
      {/* Only surfaces when something is wrong: Odoo supplies the B2C half, so
          a wholesale-only view has nothing to warn about. */}
      {side !== 'b2b' && !sources.odoo.reachable ? (
        <div className="mkt-sources">
          <span className="mkt-source is-off" title={sources.odoo.error}>
            Odoo {sources.odoo.configured ? 'unavailable' : 'not connected'} — the B2C half of sales is missing.{' '}
            {sources.odoo.error}
          </span>
        </div>
      ) : null}

      {side !== 'all' && report.sides.shared.spend > 0 ? (
        <div className="mkt-alert">
          Showing <strong>{SIDE_LABELS[side]}</strong> only, which excludes the{' '}
          {money(report.sides.shared.spend)} of marketing that worked both sides — that spend is in neither side&apos;s
          net.
        </div>
      ) : null}

      <div className="mkt-tiles">
        <Tile
          label={side === 'all' ? 'Sales' : `${SIDE_LABELS[side]} sales`}
          value={money(shown.sales)}
          sub={
            side === 'b2c'
              ? `${totals.b2cOrders} order${totals.b2cOrders === 1 ? '' : 's'}`
              : side === 'b2b'
                ? `${totals.b2bInvoices} invoice${totals.b2bInvoices === 1 ? '' : 's'}`
                : `${totals.b2cOrders} B2C order${totals.b2cOrders === 1 ? '' : 's'} · ${totals.b2bInvoices} wholesale invoice${
                    totals.b2bInvoices === 1 ? '' : 's'
                  }`
          }
        />
        <Tile
          label={side === 'all' ? 'Spending' : `${SIDE_LABELS[side]} spending`}
          value={money(shown.spend)}
          sub={
            side === 'all'
              ? `${money(totals.marketing)} of it marketing · ${totals.purchaseLines} purchase line${
                  totals.purchaseLines === 1 ? '' : 's'
                }`
              : `Bought for this side only · ${money(totals.sharedSpend)} of shared marketing sits outside it`
          }
        />
        <Tile
          label={side === 'all' ? 'Total investment' : `${SIDE_LABELS[side]} investment`}
          value={money(investment)}
          sub={
            practice > 0 || investmentBuys > 0
              ? `Spending plus ${[
                  practice > 0 ? `${money(practice)} on practice cooks` : '',
                  investmentBuys > 0 ? `${money(investmentBuys)} of investment` : '',
                ]
                  .filter(Boolean)
                  .join(' and ')} — left out of spending, net and margin`
              : 'Same as spending — no practice or investment buying in this range'
          }
        />
        <Tile
          label="Net"
          value={signed(shown.net)}
          sub={
            // Per-week averages are only defined for the whole business —
            // `tradingWeeks` counts weeks that traded at all, not weeks that
            // traded on this side, and dividing by it under a filter would
            // quietly answer a different question.
            side !== 'all'
              ? `${money(shown.sales)} in, ${money(shown.spend)} out`
              : totals.tradingWeeks
                ? `${signed(Math.round(totals.net / totals.tradingWeeks))} a week across ${totals.tradingWeeks} trading week${
                    totals.tradingWeeks === 1 ? '' : 's'
                  }`
                : 'Nothing traded in this range'
          }
          tone={shown.net >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Spend as % of sales"
          value={percent(shown.spendRatio)}
          sub={
            shown.spendRatio === null
              ? 'No sales in this range to measure against'
              : side !== 'all'
                ? `${percent(shown.margin)} margin on this side`
                : `${money(totals.avgSpend)} out, ${money(totals.avgSales)} in, per trading week`
          }
        />
      </div>

      {/* Kept under every filter: an unpriced line sits on one side or the
          other, so whichever side is on screen may be the one being
          flattered. Counted across both, and it says so rather than looking
          like a count for the filtered view. */}
      {totals.uncostedLines > 0 ? (
        <div className="mkt-alert mkt-alert-warn">
          <strong>
            {totals.uncostedLines} purchase line{totals.uncostedLines === 1 ? '' : 's'} in this range{' '}
            {totals.uncostedLines === 1 ? 'has' : 'have'} no price on{' '}
            {totals.uncostedLines === 1 ? 'it' : 'them'}
            {side === 'all' ? '' : ', counting both sides'}.
          </strong>{' '}
          {totals.uncostedLines === 1 ? 'It is' : 'They are'} counted as {totals.uncostedLines === 1 ? 'a line' : 'lines'}{' '}
          but contribute nothing to the spending figure, so every net and margin below is flattering by however much{' '}
          {totals.uncostedLines === 1 ? 'it' : 'they'} cost. Add the unit price on Weekly Purchasing to close the gap.
        </div>
      ) : null}

      {/* Wholesale double-count guard — nothing to say on a B2C-only view. */}
      {side !== 'b2c' && totals.b2bTaggedOrders > 0 ? (
        <div className="mkt-alert mkt-alert-warn">
          <strong>
            {totals.b2bTaggedOrders} Odoo order{totals.b2bTaggedOrders === 1 ? '' : 's'} worth {money(totals.b2bTaggedOdoo)}{' '}
            {totals.b2bTaggedOrders === 1 ? 'is' : 'are'} tagged B2B and {totals.b2bTaggedOrders === 1 ? 'is' : 'are'} not
            counted here.
          </strong>{' '}
          Wholesale is counted from the B2B sales book, and adding these too would count the same deliveries twice. If
          they are genuinely separate sales, log them in B2B Sales instead.
        </div>
      ) : null}

      {/* Discounts only exist on the Odoo (B2C) side. The sales figures are
          already net of them, so this is what was given away, not a cost. */}
      {side !== 'b2b' && (totals.discounts ?? 0) > 0 ? (
        <div className="mkt-alert">
          <strong>{money(totals.discounts ?? 0)} given away in discounts</strong> across {totals.discountedOrders}{' '}
          order{totals.discountedOrders === 1 ? '' : 's'} —{' '}
          {[
            (totals.discountOnItems ?? 0) > 0 ? `${money(totals.discountOnItems ?? 0)} as a percentage on dishes` : '',
            (totals.discountCoupons ?? 0) > 0 ? `${money(totals.discountCoupons ?? 0)} as discount or coupon lines` : '',
          ]
            .filter(Boolean)
            .join(', ')}
          . Sales above are already after these, so they are not taken off again.
        </div>
      ) : null}
      {side !== 'b2b' && sources.odoo.reachable && sources.odoo.discountsError ? (
        <div className="mkt-alert mkt-alert-warn">
          Could not read order lines from Odoo, so discounts are not shown: {sources.odoo.discountsError}
        </div>
      ) : null}

      {/* Unconfirmed quotations are Odoo sale.orders, which are the B2C side
          — under the wholesale filter they are a figure about a different
          part of the business and would read as wholesale pipeline. */}
      {side !== 'b2b' && totals.pendingOrders > 0 ? (
        <div className="mkt-alert">
          {totals.pendingOrders} unconfirmed quotation{totals.pendingOrders === 1 ? '' : 's'} worth{' '}
          {money(totals.pendingRevenue)} are in this range and are not counted as sales yet.
        </div>
      ) : null}

      {/* The comparison panel is the one thing a side filter makes pointless:
          under "B2B only" it would be showing the side that was just filtered
          out. It is the whole-business view's job. */}
      {side === 'all' ? <SidesPanel report={report} /> : null}

      <WeeklyChart weeks={weeks} side={side} />

      <WeekTable weeks={weeks} totals={totals} side={side} />

      <div className="fin-split">
        <WhereItWent report={report} side={side} />
        <WhereItCameFrom report={report} side={side} />
      </div>

      <p className="mkt-panel-hint">
        Covering {range.from} to {range.to} — {range.weeks} whole week{range.weeks === 1 ? '' : 's'}. Both ends were
        rounded out to Monday and Sunday from the {range.requested.from} to {range.requested.to} you asked for, so no row
        on the chart is a part week pretending to be a whole one.
      </p>
    </div>
  );
};

const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) => (
  <div className="mkt-tile">
    <span className="mkt-tile-label">{label}</span>
    <span className={`mkt-tile-value${tone ? ` is-${tone}` : ''}`}>{value}</span>
    {sub ? <span className="mkt-tile-sub">{sub}</span> : null}
  </div>
);

// ---- The two sides ---------------------------------------------------------

// B2C and B2B as two separate little businesses, which is how they behave:
// different buying, different customers, different payment timing. The whole
// point of the panel is that a side can be carrying the other one and the
// blended figure at the top of the screen would never show it.
const SidesPanel = ({ report }: { report: WeeklyReport }) => {
  const { sides, totals, untaggedB2bSpend } = report;

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>The two sides of the business</h4>
        <span className="mkt-panel-hint">Each side against its own cost</span>
      </div>

      <div className="fin-sides">
        <SideCard
          title="B2C weekend"
          hint={`${totals.b2cOrders} order${totals.b2cOrders === 1 ? '' : 's'}`}
          figures={sides.b2c}
        />
        <SideCard
          title="B2B wholesale"
          hint={`${totals.b2bInvoices} invoice${totals.b2bInvoices === 1 ? '' : 's'}`}
          figures={sides.b2b}
          footer={
            totals.b2bOutstanding > 0
              ? `${money(totals.b2bOutstanding)} of this revenue is still owed`
              : undefined
          }
        />

        {/* Not a third side. A card so it cannot be missed, worded so it
            cannot be read as one. */}
        <div className="fin-side-card is-shared">
          <span className="mkt-tile-label">Shared</span>
          <span className="mkt-tile-value">{money(sides.shared.spend)}</span>
          <span className="mkt-tile-sub">
            Marketing that worked both sides at once. It is in the whole-business spend above and in neither side here —
            splitting it would invent the number you are about to decide on.
          </span>
        </div>
      </div>

      <p className="mkt-panel-hint">
        {/* Only worth saying when there IS shared spend — with none, the two
            sides add up and the sentence would be explaining nothing. The gap
            is printed as computed rather than asserted to equal the shared
            figure: each side rounds to the rupee on its own, so the two can
            differ by a rupee, and a sentence claiming an equality the numbers
            beside it visibly miss by 1 destroys trust in the whole screen. */}
        {sides.shared.spend > 0 ? (
          <>
            B2C net {signed(sides.b2c.net)} and B2B net {signed(sides.b2b.net)} come to{' '}
            {signed(sides.b2c.net + sides.b2b.net)}, which is {money(sides.b2c.net + sides.b2b.net - totals.net)} above
            the whole-business net of {signed(totals.net)} — that gap is the shared marketing, which is in neither
            side.{' '}
          </>
        ) : null}
        {untaggedB2bSpend > 0 ? (
          <>
            <strong>{money(untaggedB2bSpend)}</strong> of the B2B cost was bought without naming an account, so it counts
            against wholesale as a whole but appears in none of the per-client rows below.
          </>
        ) : null}
      </p>
    </section>
  );
};

const SideCard = ({
  title,
  hint,
  figures,
  footer,
}: {
  title: string;
  hint: string;
  figures: SideFigures;
  footer?: string;
}) => (
  <div className="fin-side-card">
    <span className="mkt-tile-label">
      {title} <span className="mkt-muted">· {hint}</span>
    </span>
    <span className={`mkt-tile-value${figures.sales > 0 || figures.spend > 0 ? (figures.net >= 0 ? ' is-good' : ' is-bad') : ''}`}>
      {signed(figures.net)}
    </span>
    <span className="mkt-tile-sub">
      {money(figures.sales)} in, {money(figures.spend)} out
      {figures.margin !== null ? ` · ${percent(figures.margin)} margin` : ''}
    </span>
    {footer ? <span className="mkt-tile-sub mkt-muted">{footer}</span> : null}
  </div>
);

// ---- The chart -------------------------------------------------------------

// A round number at or above `value`, for the top gridline. An axis topped by
// the largest bar exactly gives the best week a full-height bar and no
// headroom, and every tick label under it is then an unreadable figure like
// ₹18,437.
//
// The step list is deliberately fine-grained. A coarse one (1, 2, 5, 10) sends
// a ₹26,000 best week to a ₹50,000 ceiling, which halves every bar on the
// chart and wastes the top half of the panel; these steps put it on ₹30,000
// and the tallest bar reaches most of the way up, which is what makes the
// smaller weeks beside it readable.
const CEILING_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceCeiling(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = CEILING_STEPS.find((candidate) => normalised <= candidate) ?? 10;
  return step * magnitude;
}

const TICKS = 4;

const WeeklyChart = ({ weeks, side }: { weeks: WeekRow[]; side: Side }) => {
  const [hot, setHot] = useState<string | null>(null);

  // Every week reduced to the selected side's pair, once, so the bars, the
  // scale, the tooltip and the best/worst line all read the same numbers.
  const series = useMemo(() => weeks.map((week) => ({ week, ...seriesOf(week, side) })), [weeks, side]);

  // One scale across both series and every week, so a bar's height means the
  // same thing wherever it appears. Never two axes — spend and sales are the
  // same unit and the whole point is comparing them directly.
  //
  // Rescaled per side rather than pinned to the whole business: on a side that
  // is a fifth of the total, a fixed scale would flatten every bar into the
  // baseline and the switch would show nothing.
  const max = useMemo(
    () => niceCeiling(Math.max(1, ...series.flatMap((row) => [row.spend, row.sales]))),
    [series],
  );

  // Best and worst under the selected side. Computed here rather than taken
  // from the report, which only ranks the whole business — a wholesale week
  // that carried a bad consumer weekend has to be able to show as the best
  // one when the wholesale side is selected.
  const [best, worst] = useMemo(() => {
    const traded = series.filter((row) => row.spend > 0 || row.sales > 0);
    if (!traded.length) return [null, null] as const;
    const ranked = [...traded].sort((a, b) => b.net - a.net);
    return [ranked[0], ranked.length > 1 ? ranked[ranked.length - 1] : null] as const;
  }, [series]);

  if (!weeks.length) return null;

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>Week by week{side === 'all' ? '' : ` — ${SIDE_LABELS[side]}`}</h4>
        {/* Two series, so a legend is always present — identity never rests
            on colour alone. */}
        <div className="mkt-legend">
          <span>
            <i className="mkt-swatch" style={{ background: COLOR_SPEND }} aria-hidden="true" /> Spending
          </span>
          <span>
            <i className="mkt-swatch" style={{ background: COLOR_SALES }} aria-hidden="true" /> Sales
          </span>
        </div>
      </div>

      <div className="fin-plot">
        <div className="fin-axis" aria-hidden="true">
          {Array.from({ length: TICKS + 1 }, (_, index) => (
            <span key={index}>{shortMoney((max * (TICKS - index)) / TICKS)}</span>
          ))}
        </div>

        <div className="fin-plot-area">
          <div className="fin-gridlines" aria-hidden="true">
            {Array.from({ length: TICKS + 1 }, (_, index) => (
              <div className="fin-gridline" key={index} />
            ))}
          </div>

          <div className="fin-cols">
            {series.map((row, index) => (
              <div
                key={row.week.weekStart}
                // Quiet under the SELECTED side: a week that traded on the
                // consumer side and not the wholesale one is genuinely a
                // quiet wholesale week, and hatching it says so.
                className={`fin-col${row.spend === 0 && row.sales === 0 ? ' is-quiet' : ''}${
                  hot === row.week.weekStart ? ' is-hot' : ''
                }`}
                onMouseEnter={() => setHot(row.week.weekStart)}
                onMouseLeave={() => setHot(null)}
              >
                {(
                  [
                    ['Spending', row.spend, COLOR_SPEND],
                    ['Sales', row.sales, COLOR_SALES],
                  ] as const
                ).map(([name, value, color]) => (
                  <div
                    key={name}
                    className="fin-bar"
                    style={{
                      // A measured zero gets a hairline rather than nothing,
                      // so "spent nothing this week" reads as a fact and not
                      // as a bar that failed to render.
                      height: `${Math.max(value > 0 ? 1 : 0.5, (value / max) * 100)}%`,
                      background: color,
                    }}
                    title={`${row.week.label} — ${name.toLowerCase()} ${money(value)}`}
                  />
                ))}

                {hot === row.week.weekStart ? (
                  // Flipped to the left for the last two columns, where a
                  // tooltip centred on the bar would run off the panel; and
                  // lifted to sit just above the taller of the two bars
                  // rather than above the full-height column, which would
                  // float it up over the tiles.
                  <WeekTooltip
                    week={row.week}
                    side={side}
                    flip={index >= series.length - 2}
                    above={(Math.max(row.spend, row.sales) / max) * 100}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="fin-xaxis">
          {weeks.map((week) => (
            <span key={week.weekStart} className={`fin-xtick${hot === week.weekStart ? ' is-hot' : ''}`}>
              {week.label}
            </span>
          ))}
        </div>
      </div>

      <div className="fin-headline">
        {best ? (
          <span>
            Best week <strong>{best.week.label}</strong> at {signed(best.net)}
          </span>
        ) : null}
        {worst ? (
          <span>
            Worst week <strong>{worst.week.label}</strong> at {signed(worst.net)}
          </span>
        ) : null}
        {series.some((row) => row.spend === 0 && row.sales === 0) ? (
          <span className="mkt-muted">
            {side === 'all'
              ? 'Hatched columns are weeks with nothing bought and nothing sold — a closed kitchen, not missing data.'
              : `Hatched columns are weeks with no ${SIDE_LABELS[side]} activity either way.`}
          </span>
        ) : null}
      </div>
    </section>
  );
};

const WeekTooltip = ({
  week,
  side,
  flip,
  above,
}: {
  week: WeekRow;
  side: Side;
  flip: boolean;
  above: number;
}) => {
  const shown = seriesOf(week, side);
  return (
  <div
    className={`fin-tip${flip ? ' is-flipped' : ''}`}
    role="status"
    // Clamped rather than simply offset from the bar top: a week whose bar
    // nearly fills the plot would otherwise push the tooltip out through the
    // top of the panel and over the tiles. The upper bound keeps its whole
    // height inside the plot area whatever the bar does.
    style={{ bottom: `clamp(4px, calc(${above.toFixed(1)}% + 8px), calc(100% - 132px))` }}
  >
    <strong>
      {week.weekStart} → {week.weekEnd}
    </strong>
    {side !== 'all' ? <span className="fin-tip-note">{SIDE_LABELS[side]} only</span> : null}
    <span className="fin-tip-row">
      <span>
        <i style={{ background: COLOR_SALES }} aria-hidden="true" />
        Sales
      </span>
      <span>{money(shown.sales)}</span>
    </span>
    {side === 'all' ? (
      <span className="fin-tip-row fin-tip-note">
        <span>B2C / wholesale</span>
        <span>
          {money(week.sales.b2c)} / {money(week.sales.b2b)}
        </span>
      </span>
    ) : null}
    <span className="fin-tip-row">
      <span>
        <i style={{ background: COLOR_SPEND }} aria-hidden="true" />
        Spending
      </span>
      <span>{money(shown.spend)}</span>
    </span>
    {/* The composition line only makes sense for the whole business. Under a
        side, the only breakdown available would be the other sides' figures,
        and printing those beneath a heading that says "B2C only" contradicts
        it — better to show nothing than the wrong scope. */}
    {side === 'all' ? (
      <span className="fin-tip-row fin-tip-note">
        <span>B2C / wholesale / shared</span>
        <span>
          {money(week.spend.b2c)} / {money(week.spend.b2b)} / {money(week.spend.shared)}
        </span>
      </span>
    ) : null}
    {side !== 'b2b' && (week.discounts?.total ?? 0) > 0 ? (
      <span className="fin-tip-row fin-tip-note">
        <span>Discounts given</span>
        <span>
          {money(week.discounts?.total ?? 0)} · {week.discounts?.orders} order{week.discounts?.orders === 1 ? '' : 's'}
        </span>
      </span>
    ) : null}
    <div className="fin-tip-sep" />
    <span className="fin-tip-row">
      <span>Net</span>
      <span>
        {signed(shown.net)}
        {shown.margin !== null ? ` · ${percent(shown.margin)}` : ''}
      </span>
    </span>
    {side !== 'b2c' && week.b2bOutstanding > 0 ? (
      <span className="fin-tip-note">{money(week.b2bOutstanding)} of the wholesale revenue is still owed</span>
    ) : null}
    {week.counts.uncostedLines > 0 ? (
      <span className="fin-tip-note">
        {week.counts.uncostedLines} purchase line{week.counts.uncostedLines === 1 ? '' : 's'} with no price
      </span>
    ) : null}
    {week.partialMarketing ? <span className="fin-tip-note">Marketing is a pro-rated share of a longer period</span> : null}
  </div>
  );
};

// ---- The table -------------------------------------------------------------

// The chart's numbers in full, which is also the accessible route to them —
// every figure the bars encode is readable here without hovering anything.
//
// Grouped by side rather than following the chart's selector: the selector
// exists because two series is all a column chart can carry legibly, and a
// table has no such limit. Both sides at once, side by side, is the whole
// point — a row where B2C net is up and B2B net is down is invisible on any
// single-side view and obvious here.
const WeekTable = ({
  weeks,
  totals,
  side,
}: {
  weeks: WeekRow[];
  totals: WeeklyReport['totals'];
  side: Side;
}) => {
  // Under a filter the eleven-column grouped table is mostly columns the
  // reader just asked not to see, so a side gets its own narrow table: out,
  // in, net, margin, and — for wholesale — what is still owed. Two shapes
  // rather than one that greys nine cells out.
  if (side !== 'all') return <SideWeekTable weeks={weeks} totals={totals} side={side} />;

  return (
  <section className="mkt-panel">
    <h4>Every week in full</h4>
    <div className="mkt-table-wrap">
      <table className="mkt-table fin-week-table">
        <thead>
          <tr>
            <th rowSpan={2}>Week</th>
            <th className="fin-group" colSpan={4}>
              B2C weekend
            </th>
            <th className="fin-group" colSpan={3}>
              B2B wholesale
            </th>
            <th className="fin-group" rowSpan={2} title="Marketing that worked both sides — in neither side's net">
              Shared
            </th>
            <th className="fin-group" colSpan={3}>
              Whole business
            </th>
          </tr>
          <tr>
            <th className="mkt-num fin-group-start">Out</th>
            <th className="mkt-num">In</th>
            <th className="mkt-num" title="Discounts on these orders — already taken out of In">
              Discounts
            </th>
            <th className="mkt-num">Net</th>
            <th className="mkt-num fin-group-start">Out</th>
            <th className="mkt-num">In</th>
            <th className="mkt-num">Net</th>
            <th className="mkt-num fin-group-start">Out</th>
            <th className="mkt-num">In</th>
            <th className="mkt-num">Net</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart} className={week.quiet ? 'fin-week-quiet' : ''}>
              <td>
                {week.label}
                {week.quiet ? <span className="mkt-tag">Quiet</span> : null}
                {week.counts.uncostedLines > 0 ? (
                  <span className="mkt-tag" title="Purchase lines with no price on them">
                    {week.counts.uncostedLines} unpriced
                  </span>
                ) : null}
                <span className="mkt-block mkt-muted fin-week-dates">
                  {week.weekStart} → {week.weekEnd}
                </span>
              </td>
              <td className="mkt-num fin-group-start">{money(week.spend.b2c)}</td>
              <td className="mkt-num">{money(week.sales.b2c)}</td>
              <DiscountCell discounts={week.discounts} />
              <td className={`mkt-num fin-net ${week.sides.b2c.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
                {signed(week.sides.b2c.net)}
              </td>

              <td className="mkt-num fin-group-start">{money(week.spend.b2b)}</td>
              <td className="mkt-num">
                {money(week.sales.b2b)}
                {week.b2bOutstanding > 0 ? (
                  <span className="mkt-block mkt-muted" title="Not paid yet">
                    {money(week.b2bOutstanding)} owed
                  </span>
                ) : null}
              </td>
              <td className={`mkt-num fin-net ${week.sides.b2b.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
                {signed(week.sides.b2b.net)}
              </td>

              <td className="mkt-num fin-group-start">
                {money(week.spend.shared)}
                {week.partialMarketing ? (
                  <span className="mkt-tag" title="A pro-rated share of a longer spend period">
                    Share
                  </span>
                ) : null}
              </td>

              <td className="mkt-num fin-group-start">{money(week.spend.total)}</td>
              <td className="mkt-num">{money(week.sales.total)}</td>
              <td className={`mkt-num fin-net ${week.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
                {signed(week.net)}
                {week.margin !== null ? <span className="mkt-block mkt-muted">{percent(week.margin)}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th className="mkt-num fin-group-start">{money(totals.b2cSpend)}</th>
            <th className="mkt-num">{money(totals.b2c)}</th>
            <th className="mkt-num">{(totals.discounts ?? 0) > 0 ? money(totals.discounts ?? 0) : '—'}</th>
            <th className={`mkt-num fin-net ${totals.b2c - totals.b2cSpend >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
              {signed(totals.b2c - totals.b2cSpend)}
            </th>

            <th className="mkt-num fin-group-start">{money(totals.b2bSpend)}</th>
            <th className="mkt-num">{money(totals.b2b)}</th>
            <th className={`mkt-num fin-net ${totals.b2b - totals.b2bSpend >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
              {signed(totals.b2b - totals.b2bSpend)}
            </th>

            <th className="mkt-num fin-group-start">{money(totals.sharedSpend)}</th>

            <th className="mkt-num fin-group-start">{money(totals.spend)}</th>
            <th className="mkt-num">{money(totals.sales)}</th>
            <th className={`mkt-num fin-net ${totals.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
              {signed(totals.net)}
              <span className="mkt-block mkt-muted">{percent(totals.margin)}</span>
            </th>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
  );
};

// A week's discounts: the rupees, how many orders got one, and the split
// between the two ways Odoo books money off in the hover title.
const DiscountCell = ({ discounts }: { discounts?: Discounts }) =>
  discounts && discounts.total > 0 ? (
    <td
      className="mkt-num"
      title={`${money(discounts.onItems)} as % off dishes · ${money(discounts.coupons)} as discount/coupon lines`}
    >
      {money(discounts.total)}
      <span className="mkt-block mkt-muted">
        {discounts.orders} order{discounts.orders === 1 ? '' : 's'}
      </span>
    </td>
  ) : (
    <td className="mkt-num mkt-muted">—</td>
  );

// One side, week by week. The same figures the grouped table shows for it,
// with room for the margin and the receivable that the wide layout has to
// tuck under another cell.
const SideWeekTable = ({
  weeks,
  totals,
  side,
}: {
  weeks: WeekRow[];
  totals: WeeklyReport['totals'];
  side: Exclude<Side, 'all'>;
}) => {
  const totalSpend = side === 'b2c' ? totals.b2cSpend : totals.b2bSpend;
  const totalSales = side === 'b2c' ? totals.b2c : totals.b2b;
  const totalNet = totalSales - totalSpend;

  return (
    <section className="mkt-panel">
      <h4>Every week in full — {SIDE_LABELS[side]}</h4>
      <div className="mkt-table-wrap">
        <table className="mkt-table fin-week-table">
          <thead>
            <tr>
              <th>Week</th>
              <th className="mkt-num">Spending</th>
              <th className="mkt-num">Sales</th>
              {side === 'b2c' ? (
                <th className="mkt-num" title="Discounts on these orders — already taken out of Sales">
                  Discounts
                </th>
              ) : null}
              <th className="mkt-num">Net</th>
              <th className="mkt-num">Margin</th>
              {side === 'b2b' ? <th className="mkt-num">Still owed</th> : null}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => {
              const row = week.sides[side];
              // Quiet on THIS side, which is not the same as the quiet flag
              // the server sets for the whole business — a week can trade
              // hard on the consumer side and not at all on wholesale.
              const quiet = row.spend === 0 && row.sales === 0;
              return (
                <tr key={week.weekStart} className={quiet ? 'fin-week-quiet' : ''}>
                  <td>
                    {week.label}
                    {quiet ? <span className="mkt-tag">Quiet</span> : null}
                    <span className="mkt-block mkt-muted fin-week-dates">
                      {week.weekStart} → {week.weekEnd}
                    </span>
                  </td>
                  <td className="mkt-num">{money(row.spend)}</td>
                  <td className="mkt-num">{money(row.sales)}</td>
                  {side === 'b2c' ? <DiscountCell discounts={week.discounts} /> : null}
                  <td className={`mkt-num fin-net ${row.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>{signed(row.net)}</td>
                  <td className="mkt-num">{percent(row.margin)}</td>
                  {side === 'b2b' ? (
                    <td className="mkt-num">{week.b2bOutstanding > 0 ? money(week.b2bOutstanding) : '—'}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th className="mkt-num">{money(totalSpend)}</th>
              <th className="mkt-num">{money(totalSales)}</th>
              {side === 'b2c' ? (
                <th className="mkt-num">{(totals.discounts ?? 0) > 0 ? money(totals.discounts ?? 0) : '—'}</th>
              ) : null}
              <th className={`mkt-num fin-net ${totalNet >= 0 ? 'mkt-good' : 'mkt-bad'}`}>{signed(totalNet)}</th>
              <th className="mkt-num">{percent(totalSales > 0 ? Math.round((totalNet / totalSales) * 10000) / 100 : null)}</th>
              {side === 'b2b' ? (
                <th className="mkt-num">{totals.b2bOutstanding > 0 ? money(totals.b2bOutstanding) : '—'}</th>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
};

// ---- The two breakdowns ----------------------------------------------------

const WhereItWent = ({ report, side }: { report: WeeklyReport; side: Side }) => {
  // A category or vendor with nothing on the selected side is dropped rather
  // than shown as a row of dashes: under a filter, "did not appear on this
  // side" is said better by absence than by an empty line the eye still has
  // to read past.
  const categories = report.categories
    .map((row) => ({ ...row, shown: sideAmount(row, side) }))
    .filter((row) => row.shown > 0)
    .sort((a, b) => b.shown - a.shown);
  const vendors = report.vendors
    .map((row) => ({ ...row, shown: sideAmount(row, side) }))
    .filter((row) => row.shown > 0)
    .sort((a, b) => b.shown - a.shown);
  const total = side === 'all' ? report.totals.spend : report.sides[side].spend;

  return (
  <section className="mkt-panel">
    <h4>Where the money went{side === 'all' ? '' : ` — ${SIDE_LABELS[side]}`}</h4>

    {categories.length ? (
      <ul className="mkt-category-list">
        {categories.map((row) => (
          <li key={row.category}>
            <span>{CATEGORY_LABELS[row.category] || row.category}</span>
            <strong>{money(row.shown)}</strong>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mkt-panel-hint">Nothing was bought for this side in this range.</p>
    )}

    {vendors.length ? (
      <>
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th className="mkt-num">Lines</th>
                {side === 'all' ? (
                  <>
                    <th className="mkt-num">B2C</th>
                    <th className="mkt-num">B2B</th>
                  </>
                ) : null}
                <th className="mkt-num">Spend</th>
                <th className="mkt-num">Share</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((row) => (
                <tr key={row.vendor}>
                  <td>{row.vendor}</td>
                  {/* The line count is for the vendor as a whole. Under a
                      filter it is not the count for the shown figure, so it
                      says so rather than looking like one. */}
                  <td className="mkt-num" title={side === 'all' ? undefined : 'Lines across both sides'}>
                    {row.lines}
                  </td>
                  {side === 'all' ? (
                    <>
                      <td className="mkt-num">{row.b2c > 0 ? money(row.b2c) : '—'}</td>
                      <td className="mkt-num">{row.b2b > 0 ? money(row.b2b) : '—'}</td>
                    </>
                  ) : null}
                  <td className="mkt-num fin-net">{money(row.shown)}</td>
                  <td className="mkt-num">{total > 0 ? percent((row.shown / total) * 100) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    ) : (
      <p className="mkt-panel-hint">
        {side === 'all' ? 'No priced purchases in this range.' : `No priced purchases for ${SIDE_LABELS[side]} in this range.`}
      </p>
    )}
  </section>
  );
};

const WhereItCameFrom = ({ report, side }: { report: WeeklyReport; side: Side }) => {
  const { totals, clients } = report;

  return (
    <section className="mkt-panel">
      <h4>Where the money came from{side === 'all' ? '' : ` — ${SIDE_LABELS[side]}`}</h4>

      {/* The two-way split is the answer to a whole-business question. Under
          a filter it would be restating the filter back at the reader, so the
          panel leads with that side's own figure instead. */}
      {side === 'all' ? (
        <>
          <ul className="mkt-category-list">
            <li>
              <span>B2C weekend orders</span>
              <strong>{money(totals.b2c)}</strong>
            </li>
            <li>
              <span>Wholesale deliveries</span>
              <strong>{money(totals.b2b)}</strong>
            </li>
          </ul>
        </>
      ) : (
        <ul className="mkt-category-list">
          <li>
            <span>{side === 'b2c' ? 'B2C weekend orders' : 'Wholesale deliveries'}</span>
            <strong>{money(side === 'b2c' ? totals.b2c : totals.b2b)}</strong>
          </li>
          <li>
            <span>{side === 'b2c' ? 'Orders' : 'Still owed'}</span>
            <strong>{side === 'b2c' ? totals.b2cOrders : money(totals.b2bOutstanding)}</strong>
          </li>
        </ul>
      )}

      {/* Wholesale is answered per account; the weekend is answered per
          channel. Both are "who did this money come from", asked of a side of
          the business that keeps a different kind of record: B2C orders come
          out of Odoo as orders and never as accounts, so a customer table
          cannot exist for them, and the channel is the closest true answer.
          Neither table is ever shown under the other side's heading. */}
      {side === 'b2c' ? (
        <B2cSources rows={report.b2cSources} total={totals.b2c} orders={totals.b2cOrders} />
      ) : clients.length ? (
        <>
          <div className="mkt-table-wrap">
            <table className="mkt-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="mkt-num">Invoices</th>
                  <th className="mkt-num">Sales</th>
                  <th className="mkt-num">Bought for</th>
                  <th className="mkt-num">Net</th>
                  <th className="mkt-num">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.client}
                      {row.sales === 0 ? (
                        <span className="mkt-tag" title="Bought for, but nothing invoiced in this range">
                          No sales
                        </span>
                      ) : null}
                    </td>
                    <td className="mkt-num">{row.invoices}</td>
                    <td className="mkt-num">{money(row.sales)}</td>
                    <td className="mkt-num">{row.spend > 0 ? money(row.spend) : '—'}</td>
                    <td className={`mkt-num fin-net ${row.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>
                      {signed(row.net)}
                      {row.margin !== null ? <span className="mkt-block mkt-muted">{percent(row.margin)}</span> : null}
                    </td>
                    <td className={`mkt-num${row.outstanding > 0 ? ' mkt-bad' : ''}`}>
                      {row.outstanding > 0 ? money(row.outstanding) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mkt-panel-hint">No wholesale deliveries in this range.</p>
      )}
    </section>
  );
};

// Which channel the weekend money came in through.
//
// Laid out as the vendor table opposite it, deliberately: on this screen the
// left-hand panel says who we paid and the right-hand one says who paid us,
// and reading one should not require learning a second layout.
//
// The unattributed row is never folded into the channels around it and never
// dropped. It is the honesty line for everything above it -- a 4x-looking
// channel split means very little if half the revenue never said where it
// came from -- so it stays in the table, set apart, and the hint under the
// table prints how much of the total is actually measured.
const B2cSources = ({ rows, total, orders }: { rows?: B2cSourceRow[]; total: number; orders: number }) => {
  const list = rows ?? [];

  // Attributed share, computed here rather than taken from the rows: it is
  // the one figure that has to be right for the table above it to mean
  // anything, and deriving it from the same array the table renders is what
  // guarantees the two agree.
  const known = list.filter((row) => !row.unattributed).reduce((sum, row) => sum + row.sales, 0);
  const attributedShare = total > 0 ? (known / total) * 100 : null;

  if (!list.length) {
    return (
      <p className="mkt-panel-hint">
        {orders > 0
          ? 'No channel breakdown available — the Odoo read for this range came back without order sources.'
          : 'No weekend orders in this range.'}
      </p>
    );
  }

  return (
    <>
      <div className="mkt-table-wrap">
        <table className="mkt-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th className="mkt-num">Orders</th>
              <th className="mkt-num">Sales</th>
              <th className="mkt-num">Avg order</th>
              <th className="mkt-num">Share</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={row.channel} className={row.unattributed ? 'mkt-row-unattributed' : ''}>
                <td>
                  {row.unattributed ? 'No source on the order' : row.channel}
                  {row.fromLink ? (
                    <span
                      className="mkt-tag"
                      title={`${money(row.linkRevenue)} of this row came from orders whose utm_source named this channel`}
                    >
                      {row.fromLink} from a link
                    </span>
                  ) : null}
                </td>
                <td className="mkt-num">{row.orders}</td>
                <td className="mkt-num fin-net">{money(row.sales)}</td>
                <td className="mkt-num">{row.aov === null ? '—' : money(row.aov)}</td>
                <td className="mkt-num">{percent(row.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mkt-panel-hint">
        {attributedShare === null
          ? 'No weekend revenue in this range.'
          : attributedShare >= 100
            ? 'Every weekend order in this range names a source.'
            : `${percent(attributedShare)} of weekend revenue names a source. The rest is real money with no channel on it — tag those orders on Marketing ROI's Attribution tab to make this split whole.`}{' '}
        Spend does not appear here: marketing is bought per channel but the food is not, so there is no per-channel
        cost to set against these rows. Marketing ROI is the screen that puts the two together.
      </p>
    </>
  );
};

export default SpendVsSales;
