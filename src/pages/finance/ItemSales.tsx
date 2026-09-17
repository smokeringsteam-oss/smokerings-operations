import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REPORT_START } from '../reportRange';
import { defaultWeekendRange } from '../ops/shared/packing';

// Sales by Item — how much of each thing went out of the door, and which of
// them people are asking for more of than they were a month ago.
//
// Spending vs Sales is the money screen; this is the menu screen. It answers
// the two questions a rupee total cannot: what sold, and what is moving. The
// second is the reason the screen exists — a best-seller list is a photograph,
// and the useful thing is the direction of travel. So every item carries a
// small chart of its own weeks beside its total, the risers and fallers get a
// panel of their own above the table, and the range is split into two equal
// windows whose dates are printed rather than left implied.
//
// The two sides of the business are separate sections, not one list with a
// column saying which is which. A B2C line is a portion of a dish and a B2B
// line is whatever the invoice billed — three kilos, forty buns — so a shared
// table would sort kilos against plates, a shared chart would stack them, and
// a shared "top five risers" would be a race the bigger numbers always win.
// Each side therefore gets its own figures, its own chart on its own axis, its
// own movers and its own table. Revenue is the one thing that adds up across
// them, and the one figure reported for the business as a whole.
//
// Backend: server/finance/itemSales.js — the file that decides all of this,
// with the reasoning at the top of it.
//
// Styling: the `.mkt-*` classes are this app's shared report-screen language
// (toolbar, tiles, panels, tables, alerts), reused rather than re-prefixed.
// The `.sal-*` block in App.css is only what is new here — the column chart,
// the sparklines, the side headers and the trend badges.

// The two sides of the business, as chart colours.
//
// Ember for B2C carries over from the other two money screens, where ember is
// money in; the weekend kitchen is where nearly all of it comes from. Purple
// is the second hue, distinct from the blue those screens use for money out so
// nothing on this screen can be read as spending.
//
// Validated against this screen's surface with the dataviz palette validator:
// both inside the lightness band, both above the chroma floor, adjacent CVD
// separation 24.8 (protan) against a floor of 8, normal vision 28.8, and both
// over 3:1 against the surface. Do not swap these for eyeballed values —
// re-run the validator.
const COLOR_B2C = '#d9480f';
const COLOR_B2B = '#6b3fa0';

type Side = 'B2C' | 'B2B';
// What the toolbar can be set to: one side, or both shown one after the other.
type Shown = 'both' | Side;
type Granularity = 'week' | 'month';
type View = 'week' | 'simple' | 'full';
type Trend = 'rising' | 'falling' | 'new' | 'gone' | 'steady' | 'quiet' | 'unrated';

type Period = {
  key: string;
  label: string;
  start: string;
  end: string;
  units: number;
  revenue: number;
  b2cUnits: number;
  b2bUnits: number;
  b2cRevenue: number;
  b2bRevenue: number;
  orders: number;
  b2cOrders: number;
  b2bOrders: number;
};

type Item = {
  key: string;
  itemId: string | null;
  name: string;
  category: string;
  channel: Side;
  matched: boolean;
  unitLabel: string;
  units: number;
  revenue: number;
  orders: number;
  avgPrice: number;
  sharePct: number;
  periodsSold: number;
  series: number[];
  revenueSeries: number[];
  first: string | null;
  last: string | null;
  recent: number;
  previous: number;
  deltaUnits: number;
  deltaPct: number | null;
  trend: Trend;
};

type Movers = {
  rising: Item[];
  falling: Item[];
  risingCount: number;
  fallingCount: number;
};

type Report = {
  range: {
    requested: { from: string; to: string };
    from: string;
    to: string;
    granularity: Granularity;
    periods: number;
  };
  sources: {
    odoo: {
      configured: boolean;
      url: string;
      error: string;
      reachable: boolean;
      ordersRead: number;
      companyOrdersSkipped: number;
    };
  };
  totals: {
    units: number;
    revenue: number;
    b2cUnits: number;
    b2bUnits: number;
    b2cRevenue: number;
    b2bRevenue: number;
    orders: number;
    b2cOrders: number;
    b2bOrders: number;
    items: number;
    b2cItems: number;
    b2bItems: number;
    lines: number;
    unmatchedLines: number;
    outOfRange: number;
  };
  // B2C only — the wholesale book cannot price a line below zero. `gross` is
  // weekend revenue before any of it came off. Optional so a server that
  // predates it still renders.
  discounts?: {
    total: number;
    coupons: number;
    couponLines: number;
    onItems: number;
    itemLines: number;
    orders: number;
    gross: number;
    pct: number;
  };
  periods: Period[];
  items: Item[];
  // Per side, never pooled — see the note at the top of this file.
  movers: Record<Side, Movers>;
  comparison: {
    window: number;
    // `units` is what each side sold in that window. An earlier window of zero
    // is why a dish can come back 'unrated': there is nothing for it to be new
    // against, and badging the whole menu "new" would be noise.
    recent: {
      from: string;
      to: string;
      periods: number;
      units?: Record<Side, number>;
    };
    previous: {
      from: string;
      to: string;
      periods: number;
      units?: Record<Side, number>;
    };
    ignoredPeriod: string | null;
  } | null;
};

const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (value: number) => `₹${grouped.format(Math.round(value))}`;

const shortMoney = (value: number) => {
  if (!value) return '₹0';
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(value) >= 1000) return `₹${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `₹${Math.round(value)}`;
};

// Wholesale quantities can be fractional (2.5 kg); dishes never are. One
// formatter for both, so a kilo and a half does not print as 2 and a plate
// does not print as 1.0.
const qty = (value: number) => (Number.isInteger(value) ? grouped.format(value) : value.toFixed(1));

const units = (value: number, label: string) => `${qty(value)}${label ? ` ${label}` : ''}`;

const signedQty = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${qty(Math.abs(value))}`;

// Null means there was nothing to divide by — a dish with no history has no
// percentage change, which is a different fact from 0% and has to read
// differently or the two sort together.
const percent = (value: number | null) =>
  value === null
    ? '—'
    : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%`;

const SHOWN_LABELS: Record<Shown, string> = {
  both: 'Both sides',
  B2C: 'B2C weekend',
  B2B: 'B2B wholesale',
};

// How each side of the business names its own figures. A wholesale invoice is
// not an order and a kilo is not a portion, and one vocabulary for both would
// be wrong on one of them.
const SIDE: Record<
  Side,
  {
    title: string;
    hint: string;
    colour: string;
    quantity: string;
    orders: string;
    order: string;
  }
> = {
  B2C: {
    title: 'B2C weekend',
    hint: 'Odoo order lines, counted in the week of the weekend slot they were ordered for',
    colour: COLOR_B2C,
    quantity: 'Portions sold',
    orders: 'Orders',
    order: 'order',
  },
  B2B: {
    title: 'B2B wholesale',
    hint: "This app's own invoice book, counted on the day of delivery",
    colour: COLOR_B2B,
    quantity: 'Wholesale units sold',
    orders: 'Invoices',
    order: 'invoice',
  },
};

const TREND_LABELS: Record<Trend, string> = {
  rising: '▲ Rising',
  falling: '▼ Falling',
  new: '★ New',
  gone: '○ Stopped',
  steady: '— Steady',
  quiet: '· Too few to call',
  unrated: '· No earlier trade',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// Local-date arithmetic on a YYYY-MM-DD string — never toISOString, which is
// UTC and hands back yesterday for the first hours of every IST day.
const shiftDays = (value: string, n: number) => {
  const [y, m, d] = value.split('-').map(Number);
  return iso(new Date(y, m - 1, d + n));
};

const VIEW_LABELS: Record<View, string> = {
  week: 'One week',
  simple: 'Week by week',
  full: 'Full report',
};

const weeksAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n * 7);
  return iso(date);
};

const monthsAgo = (n: number) => {
  const date = new Date();
  date.setMonth(date.getMonth() - n);
  return iso(date);
};

// One side's figures out of a period row or the totals. Written once so the
// tiles, the chart and the tooltip cannot end up reading different sides from
// each other.
const sideUnits = (row: { b2cUnits: number; b2bUnits: number }, side: Side) =>
  side === 'B2C' ? row.b2cUnits : row.b2bUnits;
const sideRevenue = (row: { b2cRevenue: number; b2bRevenue: number }, side: Side) =>
  side === 'B2C' ? row.b2cRevenue : row.b2bRevenue;
const sideOrders = (row: { b2cOrders: number; b2bOrders: number }, side: Side) =>
  side === 'B2C' ? row.b2cOrders : row.b2bOrders;

type SortKey = 'units' | 'revenue' | 'delta' | 'share' | 'name';

const ItemSales = () => {
  const [granularity, setGranularity] = useState<Granularity>('week');
  const [from, setFrom] = useState(REPORT_START);
  const [to, setTo] = useState(iso(new Date()));
  // Which side (or both) the screen is showing. Not a server round trip: the
  // report carries both sides in full, so switching is instant and no half of
  // the screen can be showing a side the other half is not.
  // Opens on the weekend menu: that is the side this screen is mostly read for.
  const [shown, setShown] = useState<Shown>('B2C');
  // 'week' is one Mon→Sun week against the week before, stepped with
  // ‹ Week / Week › the way Marketing ROI is.
  // 'simple' is the plain grid — how many of each item sold in each week.
  // 'full' is everything else: tiles, chart, movers, trend table.
  const [view, setView] = useState<View>('simple');
  // The Monday of the week the one-week view is on. Opens on the same service
  // week as Marketing ROI and B2C Order Management.
  const [weekFrom, setWeekFrom] = useState(() => defaultWeekendRange().from);
  // One sort for both tables. A per-table sort would let the two sides be
  // ordered differently while sitting one above the other, which reads as an
  // inconsistency rather than as a choice.
  const [sort, setSort] = useState<SortKey>('units');

  // The one-week view reads the week before as well, so every item can be
  // shown against it. The other two views read the chosen range.
  const query =
    view === 'week'
      ? `from=${shiftDays(weekFrom, -7)}&to=${shiftDays(weekFrom, 6)}&granularity=week`
      : `from=${from}&to=${to}&granularity=${granularity}`;

  const [report, setReport] = useState<Report | null>(null);
  // Which query the report on screen answers. Switching views changes the
  // query, and until the new report lands the old one must not be drawn — a
  // twelve-week report read as "this week and last" would be wrong numbers.
  const [reportQuery, setReportQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/finance/item-sales?${query}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the item sales report.');
      setReport(data);
      setReportQuery(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const preset = (weeks: number) => {
    setGranularity('week');
    setFrom(weeksAgo(weeks - 1));
    setTo(iso(new Date()));
  };

  const monthPreset = (months: number) => {
    setGranularity('month');
    setFrom(monthsAgo(months - 1));
    setTo(iso(new Date()));
  };

  return (
    <div className="mkt-roi">
      <div className="mkt-head">
        <h3>Sales by Item</h3>
        <p>
          How many of each thing sold, and what is moving. The weekend menu and the wholesale book are counted apart — a
          portion and a kilo are both &quot;one&quot; and they are not the same thing.
        </p>
      </div>

      <div className="mkt-toolbar">
        {view === 'week' ? (
          <div className="mkt-range">
            <div className="mkt-presets">
              <button
                type="button"
                className="mkt-chip"
                aria-label="Previous week"
                onClick={() => setWeekFrom(shiftDays(weekFrom, -7))}
              >
                ‹ Week
              </button>
              <button type="button" className="mkt-chip" onClick={() => setWeekFrom(defaultWeekendRange().from)}>
                This week
              </button>
              <button
                type="button"
                className="mkt-chip"
                aria-label="Next week"
                onClick={() => setWeekFrom(shiftDays(weekFrom, 7))}
              >
                Week ›
              </button>
            </div>
            <strong className="sal-week-label">
              {dayLabel(weekFrom)} – {dayLabel(shiftDays(weekFrom, 6))}
            </strong>
          </div>
        ) : (
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
              <button type="button" className="mkt-chip" onClick={() => preset(4)}>
                Last 4 weeks
              </button>
              <button type="button" className="mkt-chip" onClick={() => preset(12)}>
                Last 12 weeks
              </button>
              <button type="button" className="mkt-chip" onClick={() => preset(26)}>
                Last 26 weeks
              </button>
              <button type="button" className="mkt-chip" onClick={() => monthPreset(12)}>
                Last 12 months
              </button>
            </div>
          </div>
        )}

        <div className="mkt-tabs" role="group" aria-label="View">
          {(['week', 'simple', 'full'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`mkt-tab${view === option ? ' is-active' : ''}`}
              onClick={() => setView(option)}
              aria-pressed={view === option}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="mkt-tabs fin-side-tabs" role="group" aria-label="Side of the business">
          {(['both', 'B2C', 'B2B'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`mkt-tab${shown === option ? ' is-active' : ''}`}
              onClick={() => setShown(option)}
              aria-pressed={shown === option}
            >
              {SHOWN_LABELS[option]}
            </button>
          ))}
        </div>

        {view === 'week' ? null : (
          <div className="mkt-tabs" role="group" aria-label="Period">
            {(['week', 'month'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`mkt-tab${granularity === option ? ' is-active' : ''}`}
                onClick={() => setGranularity(option)}
                aria-pressed={granularity === option}
              >
                {option === 'week' ? 'By week' : 'By month'}
              </button>
            ))}
          </div>
        )}
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {loading && reportQuery !== query ? <div className="mkt-alert">Counting what sold…</div> : null}

      {report && reportQuery === query ? (
        <ReportView report={report} shown={shown} view={view} sort={sort} onSort={setSort} />
      ) : null}
    </div>
  );
};

// ---- The report ------------------------------------------------------------

const ReportView = ({
  report,
  shown,
  view,
  sort,
  onSort,
}: {
  report: Report;
  shown: Shown;
  view: View;
  sort: SortKey;
  onSort: (key: SortKey) => void;
}) => {
  const { totals, range, sources } = report;
  const sides: Side[] = shown === 'both' ? ['B2C', 'B2B'] : [shown];

  return (
    <div className="mkt-body">
      <div className="mkt-sources">
        <span className="mkt-source is-on">Wholesale invoice lines from this app&apos;s own database</span>
        {shown === 'B2B' ? null : sources.odoo.reachable ? (
          <span className="mkt-source is-on">Odoo connected — {sources.odoo.ordersRead} weekend orders read</span>
        ) : sources.odoo.configured ? (
          <span className="mkt-source is-off" title={sources.odoo.error}>
            Odoo unreachable — the weekend menu is missing from these figures
          </span>
        ) : (
          <span className="mkt-source is-off">Odoo not configured — wholesale only</span>
        )}
      </div>

      {sources.odoo.companyOrdersSkipped > 0 ? (
        <div className="mkt-alert">
          {sources.odoo.companyOrdersSkipped} Odoo {sources.odoo.companyOrdersSkipped === 1 ? 'order' : 'orders'} for
          company customers were left out — wholesale is counted from the invoice book here, and counting both would
          double it.
        </div>
      ) : null}

      {/* The one figure that spans both sides. Rupees add up where quantities
          do not, so revenue is reported for the business as a whole and every
          count below it belongs to one side only. */}
      {shown === 'both' && view === 'full' ? (
        <div className="sal-whole">
          <div className="sal-whole-figure">
            <span className="mkt-tile-label">Revenue, both sides</span>
            <strong>{money(totals.revenue)}</strong>
          </div>
          <p className="mkt-panel-hint">
            {money(totals.b2cRevenue)} from the weekend menu across {grouped.format(totals.b2cOrders)} orders,{' '}
            {money(totals.b2bRevenue)} from wholesale across {grouped.format(totals.b2bOrders)} invoices. Quantities are
            not added across the two — {qty(totals.b2cUnits)} portions and {qty(totals.b2bUnits)} wholesale units are
            different things — so each side is counted in its own section below.
          </p>
        </div>
      ) : null}

      {sides.map((side) =>
        view === 'week' ? (
          <OneWeek key={side} side={side} report={report} />
        ) : view === 'simple' ? (
          <WeekGrid key={side} side={side} report={report} />
        ) : (
          <SideReport key={side} side={side} report={report} sort={sort} onSort={onSort} labelled={shown === 'both'} />
        ),
      )}

      {view === 'week' ? null : (
        <p className="mkt-panel-hint">
          Covering {dayLabel(range.from)} – {dayLabel(range.to)}, widened to whole {range.granularity}s from the dates
          asked for.
          {totals.unmatchedLines > 0
            ? ` ${totals.unmatchedLines} ${totals.unmatchedLines === 1 ? 'line is' : 'lines are'} not matched to a menu item — those are listed under the name they were sold as.`
            : ''}
        </p>
      )}
    </div>
  );
};

// ---- One week --------------------------------------------------------------

// A single Mon→Sun week, the way Marketing ROI reads one: what each item sold
// that week, beside the week before so the number has something to be read
// against. The report is fetched two weeks wide for exactly this — the last
// period is the week on screen, the one before it is last week. An item that
// sold last week and nothing this week stays on the list at zero: a dish that
// stopped is as much news as one that sold.
const OneWeek = ({ side, report }: { side: Side; report: Report }) => {
  const words = SIDE[side];
  const { periods } = report;
  const now = periods.length - 1;
  const before = periods.length - 2;
  const thisWeek = periods[now];
  const lastWeek = before >= 0 ? periods[before] : null;

  const rows = useMemo(
    () =>
      report.items
        .filter((item) => item.channel === side)
        .map((item) => ({
          item,
          sold: item.series[now] || 0,
          earned: item.revenueSeries[now] || 0,
          previous: before >= 0 ? item.series[before] || 0 : 0,
        }))
        .filter((row) => row.sold > 0 || row.previous > 0)
        .sort((a, b) => b.sold - a.sold || b.previous - a.previous || a.item.name.localeCompare(b.item.name)),
    [report.items, side, now, before],
  );

  if (!thisWeek) return null;

  const sold = sideUnits(thisWeek, side);
  const orders = sideOrders(thisWeek, side);
  const revenue = sideRevenue(thisWeek, side);
  const vsLastWeek = (value: number, previous: number, show: (n: number) => string) =>
    lastWeek ? `${value - previous >= 0 ? '+' : '−'}${show(Math.abs(value - previous))} vs last week` : undefined;
  const tone = (delta: number) => (delta > 0 ? 'mkt-good' : delta < 0 ? 'mkt-bad' : 'mkt-muted');
  const soldCount = rows.filter((row) => row.sold > 0).length;

  return (
    <div className="sal-side">
      <div className="sal-side-head">
        <h4>
          <i style={{ background: words.colour }} aria-hidden="true" />
          {words.title}
        </h4>
        <span className="mkt-panel-hint">
          {dayLabel(thisWeek.start)} – {dayLabel(thisWeek.end)}
        </span>
      </div>

      <div className="mkt-tiles">
        <Tile
          label={words.quantity}
          value={qty(sold)}
          sub={vsLastWeek(sold, lastWeek ? sideUnits(lastWeek, side) : 0, qty)}
        />
        <Tile
          label={words.orders}
          value={grouped.format(orders)}
          sub={vsLastWeek(orders, lastWeek ? sideOrders(lastWeek, side) : 0, qty)}
        />
        <Tile
          label="Revenue"
          value={money(revenue)}
          sub={vsLastWeek(revenue, lastWeek ? sideRevenue(lastWeek, side) : 0, money)}
        />
      </div>

      <section className="mkt-panel">
        <div className="mkt-panel-head">
          <h4>What sold this week</h4>
          <span className="mkt-panel-hint">
            {soldCount} {soldCount === 1 ? 'item' : 'items'} sold
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="mkt-alert">Nothing sold on this side of the business this week or last.</div>
        ) : (
          <div className="mkt-table-wrap">
            <table className="mkt-table sal-table sal-week-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="mkt-num">This week</th>
                  <th className="mkt-num">Last week</th>
                  <th className="mkt-num">Change</th>
                  <th className="mkt-num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, sold: count, previous, earned }) => (
                  <tr key={item.key}>
                    <td>
                      {item.name}
                      {item.unitLabel ? <span className="mkt-muted"> ({item.unitLabel})</span> : null}
                    </td>
                    <td className={`mkt-num sal-grid-cell${count ? '' : ' is-zero'}`}>{count ? qty(count) : '–'}</td>
                    <td className="mkt-num mkt-muted">{previous ? qty(previous) : '–'}</td>
                    <td className={`mkt-num ${tone(count - previous)}`}>
                      {count === previous ? '–' : signedQty(count - previous)}
                    </td>
                    <td className="mkt-num">{earned ? money(earned) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

// ---- Week by week (the simple view) ----------------------------------------

// The plain answer: one row per item, one column per week, the count in each
// cell. Oldest week first, reading left to right like a calendar; on a range
// too wide for the screen the table opens scrolled to its right-hand end, so
// the latest weeks are in view. The item column is sticky for when the range
// is long. No trends, no revenue — the full report has those.
const WeekGrid = ({ side, report }: { side: Side; report: Report }) => {
  const { range } = report;
  const words = SIDE[side];
  const items = useMemo(
    () =>
      report.items
        .filter((item) => item.channel === side)
        .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)),
    [report.items, side],
  );
  // Oldest first, the same order as each item's series.
  const columns = report.periods.map((period, index) => ({ period, index }));
  const unitWord = side === 'B2C' ? 'portions' : 'units';

  // Start scrolled to the newest weeks whenever a new report is drawn.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap) wrap.scrollLeft = wrap.scrollWidth;
  }, [report]);

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>
          {words.title} — sold each {range.granularity}
        </h4>
        <span className="mkt-panel-hint">
          {items.length} {items.length === 1 ? 'item' : 'items'} · oldest {range.granularity} first
        </span>
      </div>

      {items.length === 0 ? (
        <div className="mkt-alert">Nothing sold on this side of the business in this range.</div>
      ) : (
        <div className="mkt-table-wrap" ref={wrapRef}>
          <table className="mkt-table sal-grid">
            <thead>
              <tr>
                <th className="sal-grid-item">Item</th>
                {columns.map(({ period }) => (
                  <th
                    key={period.key}
                    className="mkt-num"
                    title={`${dayLabel(period.start)} – ${dayLabel(period.end)}`}
                  >
                    {period.label}
                  </th>
                ))}
                <th className="mkt-num sal-grid-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <td className="sal-grid-item">
                    {item.name}
                    {item.unitLabel ? <span className="mkt-muted"> ({item.unitLabel})</span> : null}
                  </td>
                  {columns.map(({ period, index }) => {
                    const count = item.series[index] || 0;
                    return (
                      <td key={period.key} className={`mkt-num sal-grid-cell${count ? '' : ' is-zero'}`}>
                        {count ? qty(count) : '–'}
                      </td>
                    );
                  })}
                  <td className="mkt-num sal-grid-total">{qty(item.units)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="sal-grid-item">All {unitWord}</th>
                {columns.map(({ period }) => (
                  <td key={period.key} className="mkt-num">
                    {qty(sideUnits(period, side))}
                  </td>
                ))}
                <td className="mkt-num sal-grid-total">{qty(sideUnits(report.totals, side))}</td>
              </tr>
              <tr>
                <th className="sal-grid-item">{words.orders}</th>
                {columns.map(({ period }) => (
                  <td key={period.key} className="mkt-num">
                    {grouped.format(sideOrders(period, side))}
                  </td>
                ))}
                <td className="mkt-num sal-grid-total">{grouped.format(sideOrders(report.totals, side))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
};

// ---- One side of the business ----------------------------------------------

// Everything about B2C, or everything about B2B: its figures, its chart on its
// own axis, its movers, its table. Self-contained on purpose — two of these
// stacked is the whole "keep the sides apart" idea, and nothing in here reads
// a number belonging to the other one.
const SideReport = ({
  side,
  report,
  sort,
  onSort,
  labelled,
}: {
  side: Side;
  report: Report;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  labelled: boolean;
}) => {
  const { totals, periods, range, comparison } = report;
  const words = SIDE[side];

  const items = useMemo(() => report.items.filter((item) => item.channel === side), [report.items, side]);

  const sorted = useMemo(() => {
    const rows = [...items];
    switch (sort) {
      case 'revenue':
        return rows.sort((a, b) => b.revenue - a.revenue);
      case 'delta':
        return rows.sort((a, b) => b.deltaUnits - a.deltaUnits);
      case 'share':
        return rows.sort((a, b) => b.sharePct - a.sharePct);
      case 'name':
        return rows.sort((a, b) => a.name.localeCompare(b.name));
      case 'units':
      default:
        return rows.sort((a, b) => b.units - a.units);
    }
  }, [items, sort]);

  const figures = {
    units: sideUnits(totals, side),
    revenue: sideRevenue(totals, side),
    orders: sideOrders(totals, side),
  };
  const best = items.length ? [...items].sort((a, b) => b.units - a.units)[0] : null;
  const movers = report.movers[side];
  const discounts = side === 'B2C' ? report.discounts : undefined;

  return (
    <div className="sal-side">
      {labelled ? (
        <div className="sal-side-head">
          <h4>
            <i style={{ background: words.colour }} aria-hidden="true" />
            {words.title}
          </h4>
          <span className="mkt-panel-hint">{words.hint}</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="mkt-alert">Nothing sold on this side of the business in this range.</div>
      ) : (
        <>
          <div className="mkt-tiles">
            <Tile
              label={words.quantity}
              value={qty(figures.units)}
              sub={`across ${items.length} ${items.length === 1 ? 'item' : 'items'}`}
            />
            <Tile label="Revenue" value={money(figures.revenue)} sub={`${range.periods} ${range.granularity}s`} />
            <Tile
              label={words.orders}
              value={grouped.format(figures.orders)}
              sub={
                figures.orders
                  ? `${qty(Math.round((figures.units / figures.orders) * 10) / 10)} per ${words.order}`
                  : 'nothing sold'
              }
            />
            {discounts ? (
              <Tile
                label="Discounts given"
                value={money(discounts.total)}
                sub={
                  discounts.total
                    ? `${discounts.pct}% off ${money(discounts.gross)} · ${discounts.orders} ${discounts.orders === 1 ? 'order' : 'orders'}`
                    : 'no discounts in this range'
                }
              />
            ) : null}
            <Tile
              name
              label="Best seller"
              value={best ? best.name : '—'}
              sub={best ? `${units(best.units, best.unitLabel)} · ${best.sharePct}% of this side` : 'nothing sold'}
            />
            <Tile
              name
              label="Biggest riser"
              value={movers.rising[0] ? movers.rising[0].name : '—'}
              sub={movers.rising[0] ? `${signedQty(movers.rising[0].deltaUnits)} vs the half before` : 'nothing rising'}
            />
            <Tile
              name
              label="Biggest faller"
              value={movers.falling[0] ? movers.falling[0].name : '—'}
              sub={
                movers.falling[0] ? `${signedQty(movers.falling[0].deltaUnits)} vs the half before` : 'nothing falling'
              }
            />
          </div>

          {discounts && discounts.total > 0 ? (
            <p className="mkt-panel-hint">
              Discounts: {money(discounts.coupons)} from coupon codes and Discount lines ({discounts.couponLines}{' '}
              {discounts.couponLines === 1 ? 'line' : 'lines'}), {money(discounts.onItems)} as a percentage off dishes (
              {discounts.itemLines} {discounts.itemLines === 1 ? 'line' : 'lines'}). Revenue above is after them —
              before, it would have been {money(discounts.gross)}.
            </p>
          ) : null}

          <TimeChart periods={periods} side={side} granularity={range.granularity} />

          <MoversPanel
            movers={movers}
            periods={periods}
            comparison={comparison}
            granularity={range.granularity}
            side={side}
          />

          <ItemTable items={sorted} periods={periods} side={side} sort={sort} onSort={onSort} />
        </>
      )}
    </div>
  );
};

// `name` is for the three tiles whose value is a dish rather than a figure.
// At the figure size a name like "Signature Pulled Chicken BBQ Burger" is five
// lines tall and drags every tile beside it down with it, so the type steps
// down and the tile keeps the height of the row it is in.
const Tile = ({ label, value, sub, name = false }: { label: string; value: string; sub?: string; name?: boolean }) => (
  <div className="mkt-tile">
    <span className="mkt-tile-label">{label}</span>
    <span className={`mkt-tile-value${name ? ' sal-tile-name' : ''}`}>{value}</span>
    {sub ? <span className="mkt-tile-sub">{sub}</span> : null}
  </div>
);

// ---- Quantity over time ----------------------------------------------------

// One column per period, one side of the business, one axis. Deliberately not
// a stacked chart of the two: portions and wholesale units share no scale, so
// stacking them would draw a total that means nothing and squash whichever
// side happens to trade in smaller numbers. Two charts, each scaled to its own
// peak, is the honest version of the same comparison.
const TimeChart = ({ periods, side, granularity }: { periods: Period[]; side: Side; granularity: Granularity }) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const peak = Math.max(1, ...periods.map((period) => sideUnits(period, side)));
  // A round number above the tallest column, so the axis reads in steps a
  // person would choose rather than in the peak divided by four.
  const step = niceStep(peak / 4);
  const ceiling = Math.max(step * 4, step);
  const ticks = [4, 3, 2, 1, 0].map((n) => n * step);
  const words = SIDE[side];

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>Sold over time</h4>
        {/* One series needs no legend box — the panel title and the section it
            sits in already name it. */}
        <span className="mkt-panel-hint">
          {words.quantity.toLowerCase()} per {granularity}
        </span>
      </div>

      <div className="sal-plot">
        <div className="sal-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick}>{qty(tick)}</span>
          ))}
        </div>
        <div className="sal-plot-area">
          <div className="sal-gridlines" aria-hidden="true">
            {ticks.map((tick) => (
              <div className="sal-gridline" key={tick} />
            ))}
          </div>
          <div className="sal-cols">
            {periods.map((period, index) => {
              const total = sideUnits(period, side);
              const orders = sideOrders(period, side);
              const isHot = hovered === period.key;
              // The last two columns' tooltips open leftwards, or they push
              // the panel sideways on the way out.
              const flip = index >= periods.length - 2 && periods.length > 2;
              return (
                <div
                  key={period.key}
                  className={`sal-col${isHot ? ' is-hot' : ''}${total === 0 ? ' is-quiet' : ''}`}
                  onMouseEnter={() => setHovered(period.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(period.key)}
                  onBlur={() => setHovered(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={`${period.label}: ${qty(total)} sold, ${money(sideRevenue(period, side))}`}
                >
                  <div className="sal-stack">
                    {total > 0 ? (
                      <div
                        className="sal-bar"
                        style={{
                          height: `${(total / ceiling) * 100}%`,
                          background: words.colour,
                        }}
                      />
                    ) : null}
                  </div>
                  {isHot ? (
                    <div className={`sal-tip${flip ? ' is-flipped' : ''}`}>
                      <strong>{period.label}</strong>
                      <span className="sal-tip-row">
                        <i style={{ background: words.colour }} aria-hidden="true" /> {qty(total)} sold ·{' '}
                        {money(sideRevenue(period, side))}
                      </span>
                      <span className="sal-tip-sep" />
                      <span className="sal-tip-row sal-tip-note">
                        {orders} {orders === 1 ? words.order : `${words.order}s`} · {dayLabel(period.start)} –{' '}
                        {dayLabel(period.end)}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="sal-xaxis">
        {periods.map((period) => (
          <span key={period.key} className={`sal-xtick${hovered === period.key ? ' is-hot' : ''}`}>
            {period.label}
          </span>
        ))}
      </div>
    </section>
  );
};

// A step size a person would pick: 1, 2, 5, 10, 20, 50, 100…
function niceStep(rough: number) {
  if (rough <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const snapped = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return snapped * magnitude;
}

// ---- What is catching on ---------------------------------------------------

const MoversPanel = ({
  movers,
  periods,
  comparison,
  granularity,
  side,
}: {
  movers: Movers;
  periods: Period[];
  comparison: Report['comparison'];
  granularity: Granularity;
  side: Side;
}) => {
  // What this side sold in the earlier window. Zero means there is nothing to
  // be rising against: the kitchen was shut, or the range reaches back further
  // than the orders do. Saying that is the finding — badging every dish "new"
  // would be a screenful of noise dressed up as a trend.
  const earlier = comparison?.previous.units;
  const nothingToCompare = comparison !== null && earlier !== undefined && earlier[side] === 0;

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>What&apos;s catching on</h4>
        {comparison ? (
          <span className="mkt-panel-hint">
            Last {comparison.window} {granularity}
            {comparison.window === 1 ? '' : 's'} ({dayLabel(comparison.recent.from)} – {dayLabel(comparison.recent.to)})
            against the {comparison.window} before ({dayLabel(comparison.previous.from)} –{' '}
            {dayLabel(comparison.previous.to)})
          </span>
        ) : (
          <span className="mkt-panel-hint">Needs at least two {granularity}s to compare</span>
        )}
      </div>

      {!comparison ? (
        <div className="mkt-alert">
          One {granularity} is a photograph, not a trend. Widen the range and this panel fills in.
        </div>
      ) : nothingToCompare ? (
        <div className="mkt-alert mkt-alert-warn">
          Nothing sold on this side between {dayLabel(comparison.previous.from)} and {dayLabel(comparison.previous.to)},
          so there is nothing for the recent {granularity}s to be rising against. Every item is marked{' '}
          <em>no earlier trade</em> rather than <em>new</em>. Shorten the range to where the orders actually start, and
          this panel starts working.
        </div>
      ) : (
        <div className="sal-movers">
          <MoverList
            title="Gaining"
            items={movers.rising}
            total={movers.risingCount}
            periods={periods}
            side={side}
            tone="good"
            empty="Nothing is up by more than a quarter on the half before."
          />
          <MoverList
            title="Slipping"
            items={movers.falling}
            total={movers.fallingCount}
            periods={periods}
            side={side}
            tone="bad"
            empty="Nothing is down by more than a quarter on the half before."
          />
        </div>
      )}

      {comparison?.ignoredPeriod ? (
        <p className="mkt-panel-hint">
          {comparison.ignoredPeriod} is on the chart and in the totals but out of this comparison — the range has an odd
          number of {granularity}s, and the two windows are kept the same length so growth is growth and not extra time.
        </p>
      ) : null}
    </section>
  );
};

const MoverList = ({
  title,
  items,
  total,
  periods,
  side,
  tone,
  empty,
}: {
  title: string;
  items: Item[];
  total: number;
  periods: Period[];
  side: Side;
  tone: 'good' | 'bad';
  empty: string;
}) => (
  <div className="sal-mover-col">
    <h5 className="sal-mover-title">
      {title}
      {total > items.length ? (
        <span className="mkt-muted">
          {' '}
          · top {items.length} of {total}
        </span>
      ) : null}
    </h5>
    {items.length === 0 ? (
      <p className="mkt-panel-hint">{empty}</p>
    ) : (
      <ul className="sal-mover-list">
        {items.map((item) => (
          <li key={item.key}>
            <div className="sal-mover-name">
              <span>{item.name}</span>
            </div>
            <Sparkline series={item.series} side={side} labels={periods.map((period) => period.label)} />
            <div className="sal-mover-figures">
              <strong className={tone === 'good' ? 'mkt-good' : 'mkt-bad'}>
                {signedQty(item.deltaUnits)} {item.unitLabel || 'sold'}
              </strong>
              <span className="mkt-muted">
                {item.deltaPct === null ? '' : `${percent(item.deltaPct)} · `}
                {qty(item.previous)} → {qty(item.recent)}
              </span>
            </div>
            <TrendBadge trend={item.trend} />
          </li>
        ))}
      </ul>
    )}
  </div>
);

// ---- Every item ------------------------------------------------------------

const ItemTable = ({
  items,
  periods,
  side,
  sort,
  onSort,
}: {
  items: Item[];
  periods: Period[];
  side: Side;
  sort: SortKey;
  onSort: (key: SortKey) => void;
}) => {
  const labels = periods.map((period) => period.label);

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>Every item</h4>
        <span className="mkt-panel-hint">
          {items.length} {items.length === 1 ? 'item' : 'items'} sold · sorted by {sort === 'delta' ? 'change' : sort}
        </span>
      </div>

      <div className="mkt-table-wrap">
        <table className="mkt-table sal-table">
          <thead>
            <tr>
              <SortHeader label="Item" value="name" sort={sort} onSort={onSort} align="left" />
              <th>Category</th>
              <th>Over time</th>
              <SortHeader label="Sold" value="units" sort={sort} onSort={onSort} />
              <SortHeader label="Share" value="share" sort={sort} onSort={onSort} />
              <SortHeader label="Revenue" value="revenue" sort={sort} onSort={onSort} />
              <th className="mkt-num">Avg</th>
              <th className="mkt-num">{SIDE[side].orders}</th>
              <SortHeader label="Change" value="delta" sort={sort} onSort={onSort} />
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td>
                  {item.name}
                  {item.matched ? null : (
                    <span className="mkt-muted" title="No menu item matches this product name">
                      {' '}
                      · unmatched
                    </span>
                  )}
                </td>
                <td className="mkt-muted">{item.category}</td>
                <td>
                  <Sparkline series={item.series} side={side} labels={labels} />
                </td>
                <td className="mkt-num">{units(item.units, item.unitLabel)}</td>
                <td className="mkt-num">{item.sharePct}%</td>
                <td className="mkt-num">{shortMoney(item.revenue)}</td>
                <td className="mkt-num mkt-muted">{shortMoney(item.avgPrice)}</td>
                <td className="mkt-num mkt-muted">{item.orders}</td>
                <td
                  className={`mkt-num ${item.deltaUnits > 0 ? 'mkt-good' : item.deltaUnits < 0 ? 'mkt-bad' : 'mkt-muted'}`}
                >
                  {signedQty(item.deltaUnits)}
                  {item.deltaPct === null ? null : <span className="mkt-muted"> {percent(item.deltaPct)}</span>}
                </td>
                <td>
                  <TrendBadge trend={item.trend} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mkt-panel-hint">
        Share is of this side of the business only. Change compares the two windows named in the panel above.
      </p>
    </section>
  );
};

const SortHeader = ({
  label,
  value,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  value: SortKey;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) => (
  <th className={align === 'right' ? 'mkt-num' : undefined} aria-sort={sort === value ? 'descending' : 'none'}>
    <button type="button" className={`sal-sort${sort === value ? ' is-on' : ''}`} onClick={() => onSort(value)}>
      {label}
    </button>
  </th>
);

// The badge is a word first and a colour second — the trend has to survive
// being printed in grey, and 'steady' and 'too few to call' are different
// findings that no colour could tell apart.
const TrendBadge = ({ trend }: { trend: Trend }) => (
  <span className={`sal-badge is-${trend}`}>{TREND_LABELS[trend]}</span>
);

// ---- Sparkline -------------------------------------------------------------

// One item's quantity across the same periods the chart above draws, at table
// scale. Scaled to its own peak, not to the section's: this line answers "is
// this dish going up", and a ribs-sized y-axis would flatten every side dish
// on the menu into the same straight line. The last point is marked so the end
// of the line is unambiguous.
const Sparkline = ({ series, side, labels }: { series: number[]; side: Side; labels: string[] }) => {
  const width = 92;
  const height = 22;
  const peak = Math.max(...series, 1);
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const y = (value: number) => height - 2 - (value / peak) * (height - 4);
  const points = series.map((value, index) => `${(index * stepX).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const lastX = (series.length - 1) * stepX;
  const colour = SIDE[side].colour;

  const busiest = series.reduce((best, value, index) => (value > series[best] ? index : best), 0);

  return (
    <svg
      className="sal-spark"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${qty(series[series.length - 1])} in ${labels[labels.length - 1]}, peak ${qty(series[busiest])} in ${labels[busiest]}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={colour}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={y(series[series.length - 1])} r="2.5" fill={colour} />
    </svg>
  );
};

export default ItemSales;
