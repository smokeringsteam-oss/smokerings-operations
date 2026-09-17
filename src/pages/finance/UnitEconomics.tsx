import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { REPORT_START } from '../reportRange';
import PriceSheet from './PriceSheet';

// Cost to Make — what a plate costs in ingredients, and what a week of them
// costs.
//
// The third money question, after "did the week pay" (Spending vs Sales) and
// "what sold" (Sales by Item): what did the things that sold cost to put in
// the box. Multiplying the cost of a dish by the number of them that went out
// is the whole screen, and both halves come from somewhere already trusted —
// the bill of materials and the purchase log for the cost, the same Odoo feed
// Sales by Item counts for the volume.
//
// The screen is built around one uncomfortable fact
// -------------------------------------------------
// Most ingredients have no price on file. Meat and bread do; the sauces, the
// salad, the spices and every piece of packaging do not, either because
// nobody has logged buying them or because nothing records what one purchased
// unit of them IS (a 250 ml pot of cream and a litre carton are both "1").
// So every cost here is a FLOOR, not an estimate, and the screen says so in
// four places rather than one: a banner at the top, a coverage column on every
// row, "at most" in the name of every margin figure, and a panel at the bottom
// naming exactly what is missing.
//
// That is a deliberate choice over the alternative — filling the gaps with
// market estimates, which would make every number complete and none of them
// checkable. A floor that names its own gaps is something you can act on: the
// price sheet at the bottom (PriceSheet.tsx) is ordered by how many dishes
// each missing price blocks, pre-filled from the purchase log, and takes the
// price and pack size right there — pricing the top three moves eleven dishes
// at once.
//
// Three lenses on the same costs
// ------------------------------
//   Per dish      cost per plate × plates per week (where this screen began).
//   Per order     the plates on one order, summed — and the average order.
//   Per session   one cook's meat bill, its yield, and the order lines it fed.
// Each lens opens on its consolidated view — tiles and a chart across the
// whole range — with the individual rows underneath, each opening to show
// what is inside it. All three come off one request, so switching lens never
// re-fetches and a burger counted on one is the same burger on the others.
//
// Backend: server/finance/unitEconomics.js, over server/finance/unitCost.js,
// orderEconomics.js and sessionEconomics.js.
// The reasoning behind the costing itself — the smoker yield gross-up, the
// batch division, what counts as a gap — is at the top of those files.
//
// Styling: `.mkt-*` is the shared report-screen language (toolbar, tiles,
// panels, tables, alerts) and `.sal-*` is the column-chart block Sales by Item
// introduced, both reused as-is. `.ue-*` is only what is new here — the
// composition bars and the coverage meter.

// The four cost groups, as chart colours.
//
// Slots 2, 3, 4 and 1 of the house categorical theme, in the order the stack
// draws them. The order is the colourblind-safety mechanism, not a
// preference: validated with the dataviz palette validator against this
// screen's white surface, worst adjacent pair CVD ΔE 9.1 (protan) against a
// floor of 8 and 22.9 for normal vision against a floor of 15. Aqua and
// yellow sit under 3:1 against white, which obliges the relief rule — hence
// the always-visible legend, the direct labels on the tooltip and the table
// underneath carrying every number the chart draws. Do not swap these for
// eyeballed values or reorder them; re-run the validator.
const GROUP_COLOURS: Record<string, string> = {
  Meat: '#eb6834',
  'Sauces, sides & produce': '#1baf7a',
  Bread: '#eda100',
  Packaging: '#2a78d6',
};

// Draw order, bottom of the stack first. Meat first because it is most of
// every plate and a stack reads from the baseline up.
const STACK_ORDER = ['Meat', 'Sauces, sides & produce', 'Bread', 'Packaging'];

// What is left of an order after its counted cost. Neutral rather than a fifth
// hue: it is the remainder, not a thing that was bought, and it should recede
// behind the four that were.
const LEFTOVER = 'Left over, at most';
const LEFTOVER_COLOUR = '#cfccc4';

// Where a cook's raw weight went. Sold and not-sold are the two identities
// that matter and take slots 1 and 2 of the house theme (validated as a pair:
// CVD ΔE 24.7, normal 33.6); the weight lost in the smoker is the expected
// remainder and gets the same neutral as the order lens's.
const MEAT_FATE = ['Went into orders', 'Cooked, not sold', 'Lost in the smoker'] as const;
const MEAT_FATE_COLOURS: Record<string, string> = {
  'Went into orders': '#eb6834',
  'Cooked, not sold': '#2a78d6',
  'Lost in the smoker': LEFTOVER_COLOUR,
};

type Lens = 'dish' | 'order' | 'session';
const LENSES: { id: Lens; label: string }[] = [
  { id: 'dish', label: 'Per dish' },
  { id: 'order', label: 'Per order' },
  { id: 'session', label: 'Per smoking session' },
];

type Group = {
  group: string;
  cost: number;
  priced: number;
  total: number;
  missing: string[];
};

type Item = {
  itemId: string;
  name: string;
  category: string;
  isActive: boolean;
  price: number | null;
  costInr: number;
  coveragePct: number;
  leavesPriced: number;
  leavesTotal: number;
  knownCostPct: number | null;
  groups: Group[];
  missing: { materialId: string; name: string; via: string; gap: string }[];
  units: number;
  orders: number;
  revenue: number;
  unitsSeries: number[];
  costSeries: number[];
  knownCost: number;
  costPerWeek: number;
  unitsPerWeek: number;
  weeksSold: number;
  contributionAtMost: number;
};

type Period = {
  key: string;
  label: string;
  start: string;
  end: string;
  units: number;
  knownCost: number;
  byGroup: Record<string, number>;
  revenue: number;
};

type Gap = {
  id: string;
  name: string;
  group: string;
  reason: string;
  dishes: string[];
  dishCount: number;
};

type Report = {
  range: {
    requested: { from: string; to: string };
    from: string;
    to: string;
    periods: number;
  };
  sources: {
    odoo: {
      configured: boolean;
      url: string;
      error: string;
      reachable: boolean;
      ordersRead: number;
    };
    costs: {
      materialsPriced: number;
      materialsTotal: number;
      dishes: number;
      dishesUncosted: number;
    };
  };
  weeks: number;
  totals: {
    units: number;
    revenue: number;
    knownCost: number;
    knownCostPerWeek: number;
    unitsPerWeek: number;
  };
  periods: Period[];
  items: Item[];
  groups: string[];
  gaps: Gap[];
  unmatched: { name: string; units: number; revenue: number }[];
  orders: OrderLensData;
  sessions: SessionLensData;
};

type OrderLine = {
  name: string;
  itemId: string | null;
  kind: 'dish' | 'unmatched' | 'discount';
  quantity: number;
  revenue: number;
  costEach: number | null;
  cost: number | null;
  coveragePct: number | null;
};

type Order = {
  orderId: number;
  orderName: string;
  customer: string;
  day: string;
  promisedDay: string;
  plates: number;
  revenue: number;
  knownCost: number;
  byGroup: Record<string, number>;
  knownCostPct: number | null;
  leftoverAtMost: number;
  coveragePct: number;
  unmatchedLines: number;
  unmatchedRevenue: number;
  discount: number;
  sessions: string[];
  lines: OrderLine[];
};

type OrderWeek = {
  key: string;
  label: string;
  orders: number;
  revenue: number;
  knownCost: number;
  plates: number;
  avgOrderValue: number;
  avgKnownCost: number;
  avgByGroup: Record<string, number>;
};

type OrderLensData = {
  summary: {
    orders: number;
    revenue: number;
    knownCost: number;
    plates: number;
    avgOrderValue: number;
    medianOrderValue: number;
    avgKnownCost: number;
    avgPlates: number;
    avgLeftoverAtMost: number;
    knownCostPct: number | null;
    averageByGroup: Record<string, number>;
    ordersWithUnmatched: number;
    discount: number;
    ordersDiscounted: number;
  };
  perWeek: OrderWeek[];
  orders: Order[];
};

type Session = {
  sessionId: string;
  date: string;
  channel: string;
  purpose: string;
  clientName: string;
  stage: string;
  pitmaster: string;
  materialName: string;
  productName: string;
  categoryLabel: string;
  outputType: string;
  rawKg: number | null;
  rate: { perKg: number; source: string; ref: string; asOf: string } | null;
  rateGap: string | null;
  meatCost: number | null;
  otherSpend: { purchaseId: string; name: string; cost: number }[];
  otherSpendTotal: number;
  knownCost: number | null;
  plannedYieldPct: number | null;
  actualYieldPct: number | null;
  finishedKg: number | null;
  finishedSource: 'recorded' | 'planned' | null;
  costPerFinishedKg: number | null;
  plannedCostPerFinishedKg: number | null;
  portions: {
    itemId: string;
    name: string;
    price: number | null;
    grams: number;
    portionsPossible: number | null;
    meatCostEach: number | null;
    plannedMeatCostEach: number | null;
  }[];
  rubRecipe: string;
  brineRecipe: string;
  attribution: 'linked' | 'week' | 'none';
  attributionNote: string;
  orders: number;
  plates: number;
  gramsSold: number;
  sellThroughPct: number | null;
  revenue: number;
  knownCostPct: number | null;
  meatCostPerPlate: number | null;
  dishes: { itemId: string; name: string; plates: number; revenue: number }[];
};

type MeatRow = {
  key: string;
  label: string;
  material: string;
  sessions: number;
  rawKg: number;
  meatCost: number;
  avgRatePerKg: number | null;
  plannedYieldPct: number | null;
  realisedYieldPct: number | null;
  sessionsWeighed: number;
  costPerFinishedKg: number | null;
  plates: number;
  revenue: number;
  meatCostPerPlate: number | null;
  unpriced: number;
};

type SessionLensData = {
  summary: {
    sessions: number;
    sessionsPriced: number;
    sessionsWeighed: number;
    sessionsEarning: number;
    rawKg: number;
    meatCost: number;
    otherSpend: number;
    knownCost: number;
    finishedKg: number;
    plates: number;
    revenue: number;
    knownCostPct: number | null;
    byMeat: MeatRow[];
  };
  sessions: Session[];
};

const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (value: number) => `₹${grouped.format(Math.round(value))}`;
const money1 = (value: number) => `₹${value.toFixed(value < 10 && value % 1 !== 0 ? 2 : 0)}`;
const qty = (value: number) => (Number.isInteger(value) ? grouped.format(value) : value.toFixed(1));
const pctText = (value: number | null) => (value == null ? '—' : `${value}%`);
const kg = (value: number | null) => (value == null ? '—' : `${value.toFixed(value < 10 ? 2 : 1)} kg`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const weeksAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n * 7);
  return iso(date);
};

// A round number above the tallest column, so the axis reads in steps a person
// would choose rather than in the peak divided by four.
function niceStep(rough: number) {
  if (rough <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const snapped = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return snapped * magnitude;
}

type SortKey = 'cost' | 'costEach' | 'units' | 'coverage' | 'name';

const UnitEconomics = () => {
  const [from, setFrom] = useState(REPORT_START);
  const [to, setTo] = useState(iso(new Date()));
  const [sort, setSort] = useState<SortKey>('cost');
  const [open, setOpen] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('dish');

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/finance/unit-economics?from=${from}&to=${to}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the cost report.');
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

  return (
    <div className="mkt-roi">
      <div className="mkt-head">
        <h3>Cost to Make</h3>
        <p>
          What a plate, an order and a cook cost to make, and what each one earned. Ingredient figures are floors — they
          count only what has a price on file, and say how much that is.
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
            <button type="button" className="mkt-chip" onClick={() => preset(4)}>
              Last 4 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(12)}>
              Last 12 weeks
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(26)}>
              Last 26 weeks
            </button>
          </div>
        </div>
        <div className="mkt-tabs" role="tablist" aria-label="Cost lens">
          {LENSES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={lens === entry.id}
              className={`mkt-tab${lens === entry.id ? ' is-active' : ''}`}
              onClick={() => setLens(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {loading && !report ? <div className="mkt-alert">Costing the menu…</div> : null}

      {report ? (
        <ReportView
          report={report}
          lens={lens}
          sort={sort}
          onSort={setSort}
          open={open}
          onOpen={setOpen}
          onRecalculate={load}
        />
      ) : null}
    </div>
  );
};

// ---- The report ------------------------------------------------------------

// What every lens shares: where the numbers came from, the warning that they
// are floors, and — at the bottom — what is missing. The lens in between is
// the only part that changes.
const ReportView = ({
  report,
  lens,
  sort,
  onSort,
  open,
  onOpen,
  onRecalculate,
}: {
  report: Report;
  lens: Lens;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
  onRecalculate: () => void;
}) => {
  const { range, sources } = report;

  return (
    <div className="mkt-body">
      <div className="mkt-sources">
        {sources.odoo.reachable ? (
          <span className="mkt-source is-on">Odoo connected — {sources.odoo.ordersRead} weekend orders read</span>
        ) : sources.odoo.configured ? (
          <span className="mkt-source is-off" title={sources.odoo.error}>
            Odoo unreachable — there are no volumes behind these costs
          </span>
        ) : (
          <span className="mkt-source is-off">Odoo not configured — costs per plate only, no weekly figures</span>
        )}
        <span className={sources.costs.materialsPriced > 0 ? 'mkt-source is-on' : 'mkt-source is-off'}>
          {sources.costs.materialsPriced} of {sources.costs.materialsTotal} materials priced from the purchase log
        </span>
      </div>

      {/* The banner is not decoration. Every number below it is a floor, and a
          reader who misses that will read the contribution column as a margin
          and price a dish off it. The session lens swaps it for its own note:
          a cook's meat is priced off what was actually paid for it, so its
          caveat is a different one. */}
      {lens === 'session' ? (
        <div className="mkt-alert">
          <strong>A cook&apos;s meat is priced from what was paid for it</strong> — the purchase the session names, else
          the latest purchase of that cut. Rub, brine, wood and charcoal are not counted unless they are logged against
          the session. Cooks that nobody has weighed after the smoker use the planned yield, and say so.
        </div>
      ) : (
        <div className="mkt-alert mkt-alert-warn">
          <strong>These costs are floors, not full costs.</strong> Only {sources.costs.materialsPriced} of{' '}
          {sources.costs.materialsTotal} materials have both a price and a stated pack size, so meat and bread are
          counted and most sauces, salad and packaging are not. Every row says what share of its ingredients is counted;
          the <a href="#price-sheet">price sheet at the bottom</a> lists what is missing, worst first, and takes the
          prices.
        </div>
      )}

      {lens === 'dish' ? (
        <DishLens report={report} sort={sort} onSort={onSort} open={open} onOpen={onOpen} />
      ) : lens === 'order' ? (
        <OrderLens data={report.orders} odooReachable={sources.odoo.reachable} />
      ) : (
        <SessionLens data={report.sessions} />
      )}

      <PriceSheet onCostsChanged={onRecalculate} />

      {lens !== 'session' && report.unmatched.length > 0 ? (
        <div className="mkt-alert">
          {report.unmatched.length} sold {report.unmatched.length === 1 ? 'line is' : 'lines are'} not a dish on the
          menu and {report.unmatched.length === 1 ? 'has' : 'have'} no recipe to cost —{' '}
          {report.unmatched.map((row) => row.name).join(', ')}. They count toward an order&apos;s value but carry no
          cost.
        </div>
      ) : null}

      <p className="mkt-panel-hint">
        Covering {dayLabel(range.from)} – {dayLabel(range.to)}, widened to whole weeks from the dates asked for.{' '}
        {lens === 'session'
          ? 'Cooks are dated by the session day; the orders they fed are the ones promised in the same week unless the session lists its own.'
          : 'Volumes are the weekend menu only: a wholesale invoice bills kilos rather than plates, and there is no per-plate cost behind a line like that.'}
      </p>
    </div>
  );
};

// ---- Per dish --------------------------------------------------------------

const DishLens = ({
  report,
  sort,
  onSort,
  open,
  onOpen,
}: {
  report: Report;
  sort: SortKey;
  onSort: (key: SortKey) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
}) => {
  const { totals, weeks } = report;

  const sold = useMemo(() => report.items.filter((item) => item.units > 0), [report.items]);
  const unsold = useMemo(() => report.items.filter((item) => item.units === 0), [report.items]);

  const sorted = useMemo(() => {
    const rows = [...sold];
    switch (sort) {
      case 'costEach':
        return rows.sort((a, b) => b.costInr - a.costInr);
      case 'units':
        return rows.sort((a, b) => b.units - a.units);
      case 'coverage':
        return rows.sort((a, b) => b.coveragePct - a.coveragePct);
      case 'name':
        return rows.sort((a, b) => a.name.localeCompare(b.name));
      case 'cost':
      default:
        return rows.sort((a, b) => b.knownCost - a.knownCost);
    }
  }, [sold, sort]);

  const revenuePerWeek = weeks > 0 ? totals.revenue / weeks : 0;
  // The dish whose cost is most in the dark, among the ones actually selling.
  // The single most useful pointer on the screen after the gap panel.
  const thinnest = sold.length ? [...sold].sort((a, b) => a.coveragePct - b.coveragePct)[0] : null;

  return (
    <>
      <div className="mkt-tiles">
        <Tile
          label="Ingredient cost per week"
          value={money(totals.knownCostPerWeek)}
          sub={`at least — ${money(totals.knownCost)} over ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`}
        />
        <Tile
          label="Revenue per week"
          value={money(revenuePerWeek)}
          sub={`${money(totals.revenue)} from ${qty(totals.units)} plates`}
        />
        <Tile
          label="Known cost of revenue"
          value={revenuePerWeek > 0 ? `${Math.round((totals.knownCost / totals.revenue) * 1000) / 10}%` : '—'}
          sub="a floor — the unpriced ingredients can only push it up"
        />
        <Tile label="Plates per week" value={qty(totals.unitsPerWeek)} sub={`${qty(totals.units)} in the range`} />
        <Tile
          name
          label="Thinnest coverage"
          value={thinnest ? thinnest.name : '—'}
          sub={thinnest ? `${thinnest.coveragePct}% of its ingredients priced` : 'nothing sold'}
        />
      </div>

      <WeeklyChart periods={report.periods} groups={report.groups} />

      <ItemTable items={sorted} sort={sort} onSort={onSort} open={open} onOpen={onOpen} />

      {unsold.length > 0 ? (
        <section className="mkt-panel">
          <div className="mkt-panel-head">
            <h4>On the menu, nothing sold in this range</h4>
            <span className="mkt-panel-hint">costed anyway, so the number is ready when one does</span>
          </div>
          <div className="mkt-table-wrap">
            <table className="mkt-table">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="mkt-num">Menu price</th>
                  <th className="mkt-num">Cost each, at least</th>
                  <th className="mkt-num">Ingredients priced</th>
                </tr>
              </thead>
              <tbody>
                {unsold.map((item) => (
                  <tr key={item.itemId}>
                    <td>{item.name}</td>
                    <td className="mkt-num">{item.price == null ? '—' : money(item.price)}</td>
                    <td className="mkt-num">{money1(item.costInr)}</td>
                    <td className="mkt-num">
                      {item.leavesPriced}/{item.leavesTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
};

const Tile = ({ label, value, sub, name = false }: { label: string; value: string; sub?: string; name?: boolean }) => (
  <div className="mkt-tile">
    <span className="mkt-tile-label">{label}</span>
    <span className={`mkt-tile-value${name ? ' sal-tile-name' : ''}`}>{value}</span>
    {sub ? <span className="mkt-tile-sub">{sub}</span> : null}
  </div>
);

// ---- Cost over time --------------------------------------------------------

// One column per week, stacked by cost group. Stacked rather than four lines
// because the question is "what did the week cost and what was it", which is a
// total with a composition — and the total is the thing the eye should get
// first.
//
// Not drawn against revenue. Two measures on one axis is the mistake that
// makes a chart lie, and Spending vs Sales already draws that comparison
// properly on a screen built for it.
const WeeklyChart = ({ periods, groups }: { periods: Period[]; groups: string[] }) => (
  <StackedColumns
    title="Ingredient cost per week"
    hint="counted ingredients only — the real bar is taller"
    order={STACK_ORDER.filter((group) => groups.includes(group))}
    colours={GROUP_COLOURS}
    columns={periods.map((period) => ({
      key: period.key,
      label: period.label,
      total: period.knownCost,
      values: period.byGroup,
      ariaLabel: `${period.label}: ${money(period.knownCost)} of counted ingredients across ${qty(period.units)} plates`,
      tip: (
        <>
          <span className="sal-tip-row">Counted cost {money(period.knownCost)}</span>
          <span className="sal-tip-row">{qty(period.units)} plates</span>
          <span className="sal-tip-note">Sauces and packaging are mostly unpriced — the bar is a floor.</span>
        </>
      ),
    }))}
  />
);

// One column per week, stacked. Shared by the per-dish and per-order lenses:
// both are a rupee total with a composition, drawn on one axis.
type StackColumn = {
  key: string;
  label: string;
  total: number;
  values: Record<string, number>;
  ariaLabel: string;
  tip: ReactNode;
};

const StackedColumns = ({
  title,
  hint,
  order,
  colours,
  columns,
}: {
  title: string;
  hint: string;
  order: string[];
  colours: Record<string, string>;
  columns: StackColumn[];
}) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const peak = Math.max(1, ...columns.map((column) => column.total));
  const step = niceStep(peak / 4);
  const ceiling = Math.max(step * 4, step);
  const ticks = [4, 3, 2, 1, 0].map((n) => n * step);
  // Only the series with rupees in them get a segment or a legend entry — an
  // empty legend swatch invites the reader to look for a colour that is not
  // on the chart.
  const drawn = order.filter((name) => columns.some((column) => (column.values[name] || 0) > 0));

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>{title}</h4>
        <span className="mkt-panel-hint">{hint}</span>
      </div>

      <div className="mkt-legend">
        {drawn.map((name) => (
          <span key={name}>
            <i className="mkt-swatch" style={{ background: colours[name] }} aria-hidden="true" />
            {name}
          </span>
        ))}
      </div>

      <div className="sal-plot ue-plot">
        <div className="sal-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick}>{money(tick)}</span>
          ))}
        </div>
        <div className="sal-plot-area">
          <div className="sal-gridlines" aria-hidden="true">
            {ticks.map((tick) => (
              <div className="sal-gridline" key={tick} />
            ))}
          </div>
          <div className="sal-cols">
            {columns.map((column, index) => {
              const isHot = hovered === column.key;
              const flip = index >= columns.length - 2 && columns.length > 2;
              const segments = drawn.filter((name) => (column.values[name] || 0) > 0);
              return (
                <div
                  key={column.key}
                  className={`sal-col${isHot ? ' is-hot' : ''}${column.total === 0 ? ' is-quiet' : ''}`}
                  onMouseEnter={() => setHovered(column.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(column.key)}
                  onBlur={() => setHovered(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={column.ariaLabel}
                >
                  <div className="sal-stack">
                    {segments.map((name, position) => (
                      <div
                        key={name}
                        className={`sal-bar${position === segments.length - 1 ? ' ue-bar-top' : ''}`}
                        style={{
                          height: `${(column.values[name] / ceiling) * 100}%`,
                          background: colours[name],
                        }}
                      />
                    ))}
                  </div>
                  {isHot ? (
                    <div className={`sal-tip${flip ? ' is-flipped' : ''}`}>
                      <strong>{column.label}</strong>
                      {segments
                        .slice()
                        .reverse()
                        .map((name) => (
                          <span className="sal-tip-row" key={name}>
                            <i style={{ background: colours[name] }} />
                            {name} {money(column.values[name])}
                          </span>
                        ))}
                      <div className="sal-tip-sep" />
                      {column.tip}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="sal-xaxis">
        {columns.map((column) => (
          <span key={column.key} className={`sal-xtick${hovered === column.key ? ' is-hot' : ''}`}>
            {column.label}
          </span>
        ))}
      </div>
    </section>
  );
};

// ---- Per dish --------------------------------------------------------------

const ItemTable = ({
  items,
  sort,
  onSort,
  open,
  onOpen,
}: {
  items: Item[];
  sort: SortKey;
  onSort: (key: SortKey) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
}) => {
  // Every composition bar is drawn against the same rupee scale, so a burger's
  // bar next to a half-rack's is a comparison rather than two bars each filling
  // their own row.
  const widest = Math.max(1, ...items.map((item) => item.costInr));

  const Header = ({ label, sortKey, numeric = true }: { label: string; sortKey?: SortKey; numeric?: boolean }) => (
    <th className={numeric ? 'mkt-num' : undefined}>
      {sortKey ? (
        <button
          type="button"
          className={`sal-sort${sort === sortKey ? ' is-on' : ''}`}
          onClick={() => onSort(sortKey)}
          aria-pressed={sort === sortKey}
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>What each dish costs</h4>
        <span className="mkt-panel-hint">a row opens to show what is not counted in it</span>
      </div>

      <div className="mkt-table-wrap">
        <table className="mkt-table ue-table">
          <thead>
            <tr>
              <Header label="Dish" sortKey="name" numeric={false} />
              <th>What is counted</th>
              <Header label="Cost each" sortKey="costEach" />
              <Header label="Ingredients priced" sortKey="coverage" />
              <th className="mkt-num">Menu price</th>
              <Header label="Sold" sortKey="units" />
              <th className="mkt-num">Per week</th>
              <Header label="Cost per week" sortKey="cost" />
              <th className="mkt-num">Left over, at most</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isOpen = open === item.itemId;
              return (
                // Fragment carries the key: a row and its detail row are one
                // entry in the list, and keying the <tr>s instead leaves React
                // reconciling an unkeyed fragment.
                <Fragment key={item.itemId}>
                  <tr
                    onClick={() => onOpen(isOpen ? null : item.itemId)}
                    className={isOpen ? 'ue-row-open' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <button type="button" className="ue-disclose" aria-expanded={isOpen}>
                        <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {item.name}
                      </button>
                    </td>
                    <td>
                      <CompositionBar groups={item.groups} widest={widest} />
                    </td>
                    <td className="mkt-num">{money1(item.costInr)}</td>
                    <td className="mkt-num">
                      <Coverage item={item} />
                    </td>
                    <td className="mkt-num">{item.price == null ? '—' : money(item.price)}</td>
                    <td className="mkt-num">{qty(item.units)}</td>
                    <td className="mkt-num">{qty(item.unitsPerWeek)}</td>
                    <td className="mkt-num">
                      <strong>{money(item.costPerWeek)}</strong>
                    </td>
                    <td className="mkt-num mkt-muted">{money(item.contributionAtMost)}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="ue-detail">
                      <td colSpan={9}>
                        <ItemDetail item={item} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mkt-panel-hint">
        &ldquo;Left over, at most&rdquo; is revenue minus the counted cost. It is an upper bound and never a margin —
        every ingredient in the right-hand column of an open row can only take it down.
      </p>
    </section>
  );
};

// The dish's counted cost, split the four ways the chart is. Only the priced
// part has a width: the unpriced ingredients have no known rupees, and drawing
// a guess at them is exactly what this screen refuses to do. The bar therefore
// stops short, which is the honest picture — how far the bar falls short is
// what the coverage column beside it says.
const CompositionBar = ({ groups, widest }: { groups: Group[]; widest: number }) => (
  <div className="ue-comp" role="img" aria-label={groups.map((g) => `${g.group} ${money(g.cost)}`).join(', ')}>
    {STACK_ORDER.filter((name) => groups.some((group) => group.group === name && group.cost > 0)).map((name) => {
      const group = groups.find((entry) => entry.group === name)!;
      return (
        <span
          key={name}
          className="ue-comp-seg"
          style={{
            width: `${(group.cost / widest) * 100}%`,
            background: GROUP_COLOURS[name],
          }}
          title={`${name}: ${money(group.cost)}`}
        />
      );
    })}
  </div>
);

// Coverage as a figure and a meter. The meter is not decoration — at 5% a
// number alone reads as a rounding error, and the empty bar is what makes it
// land as "almost nothing in this dish is priced".
const Coverage = ({ item }: { item: Item }) => (
  <span className="ue-cov" title={`${item.leavesPriced} of ${item.leavesTotal} ingredients have a price`}>
    <span className="ue-cov-track">
      <span className="ue-cov-fill" style={{ width: `${Math.max(item.coveragePct, 1.5)}%` }} />
    </span>
    <span className="ue-cov-text">
      {item.leavesPriced}/{item.leavesTotal}
    </span>
  </span>
);

// What is in the dish, and what is not. Two columns rather than one list: the
// priced side is the number above, and the unpriced side is the reason it is
// not the whole number — reading them side by side is the point.
const ItemDetail = ({ item }: { item: Item }) => {
  const byVia = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of item.missing) {
      const key = entry.via || 'In the dish itself';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry.name);
    }
    return [...map.entries()];
  }, [item.missing]);

  return (
    <div className="ue-detail-grid">
      <div>
        <h5 className="ue-detail-title">Counted — {money1(item.costInr)}</h5>
        {/* Its own list rather than .mkt-category-list: that block paints each
            row in the alt surface, which is the colour this open row already
            sits on, so every pill would vanish into its own background. */}
        <ul className="ue-counted">
          {item.groups
            .filter((group) => group.priced > 0)
            .map((group) => (
              <li key={group.group}>
                <span>
                  <i style={{ background: GROUP_COLOURS[group.group] }} aria-hidden="true" />
                  {group.group}
                </span>
                <strong>{money1(group.cost)}</strong>
              </li>
            ))}
        </ul>
        {item.knownCostPct != null ? (
          <p className="mkt-panel-hint">
            {item.knownCostPct}% of the {money(item.price || 0)} menu price, before everything on the right.
          </p>
        ) : null}
      </div>
      <div>
        <h5 className="ue-detail-title">Not counted — {item.missing.length} ingredients</h5>
        <ul className="ue-missing">
          {byVia.map(([via, names]) => (
            <li key={via}>
              <span className="mkt-muted">{via}</span>
              <span>{names.join(', ')}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

// ---- Per order -------------------------------------------------------------

type OrderSort = 'date' | 'value' | 'cost' | 'costPct' | 'plates';

// The first screenful. Weekend orders run to dozens a week; the table is the
// detail, not the overview, and the rest is one click away.
const ORDER_PAGE = 25;

const OrderLens = ({ data, odooReachable }: { data: OrderLensData; odooReachable: boolean }) => {
  const [sort, setSort] = useState<OrderSort>('date');
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const { summary } = data;

  const sorted = useMemo(() => {
    const rows = [...data.orders];
    switch (sort) {
      case 'value':
        return rows.sort((a, b) => b.revenue - a.revenue);
      case 'cost':
        return rows.sort((a, b) => b.knownCost - a.knownCost);
      case 'costPct':
        return rows.sort((a, b) => (b.knownCostPct ?? -1) - (a.knownCostPct ?? -1));
      case 'plates':
        return rows.sort((a, b) => b.plates - a.plates);
      case 'date':
      default:
        return rows.sort((a, b) => b.day.localeCompare(a.day) || b.orderName.localeCompare(a.orderName));
    }
  }, [data.orders, sort]);

  if (summary.orders === 0) {
    return (
      <div className="mkt-alert">
        {odooReachable
          ? 'No weekend orders were placed in this range.'
          : 'Orders come from Odoo, and Odoo could not be read — there are no orders to cost.'}
      </div>
    );
  }

  const shown = all ? sorted : sorted.slice(0, ORDER_PAGE);
  // Every order's bar is drawn against the biggest order, so a ₹400 order is a
  // short bar next to a ₹2,000 one rather than two bars filling their rows.
  const widest = Math.max(1, ...data.orders.map((order) => order.revenue));

  const Header = ({ label, sortKey, numeric = true }: { label: string; sortKey?: OrderSort; numeric?: boolean }) => (
    <th className={numeric ? 'mkt-num' : undefined}>
      {sortKey ? (
        <button
          type="button"
          className={`sal-sort${sort === sortKey ? ' is-on' : ''}`}
          onClick={() => setSort(sortKey)}
          aria-pressed={sort === sortKey}
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <>
      <div className="mkt-tiles">
        <Tile label="Orders" value={qty(summary.orders)} sub={`${qty(summary.avgPlates)} plates each, on average`} />
        <Tile
          label="Average order"
          value={money(summary.avgOrderValue)}
          sub={`median ${money(summary.medianOrderValue)} — ${money(summary.revenue)} in all`}
        />
        <Tile
          label="Ingredient cost per order"
          value={money(summary.avgKnownCost)}
          sub="at least — counted ingredients only"
        />
        <Tile
          label="Known cost of an order"
          value={pctText(summary.knownCostPct)}
          sub="a floor — the unpriced ingredients can only push it up"
        />
        <Tile
          label="Left over per order"
          value={money(summary.avgLeftoverAtMost)}
          sub="at most — before sauces, packaging and delivery"
        />
      </div>

      <AverageOrder summary={summary} />

      <StackedColumns
        title="The average order, week by week"
        hint="bar height is the average order; what is under the grey is counted cost"
        order={[...STACK_ORDER, LEFTOVER]}
        colours={{ ...GROUP_COLOURS, [LEFTOVER]: LEFTOVER_COLOUR }}
        columns={data.perWeek.map((week) => ({
          key: week.key,
          label: week.label,
          total: week.avgOrderValue,
          values: {
            ...week.avgByGroup,
            [LEFTOVER]: Math.max(0, week.avgOrderValue - week.avgKnownCost),
          },
          ariaLabel: week.orders
            ? `${week.label}: ${week.orders} orders averaging ${money(week.avgOrderValue)}, of which ${money(week.avgKnownCost)} counted cost`
            : `${week.label}: no orders`,
          tip: (
            <>
              <span className="sal-tip-row">
                {week.orders} {week.orders === 1 ? 'order' : 'orders'}, {qty(week.plates)} plates
              </span>
              <span className="sal-tip-row">Average order {money(week.avgOrderValue)}</span>
              <span className="sal-tip-row">Counted cost {money(week.avgKnownCost)}</span>
            </>
          ),
        }))}
      />

      <section className="mkt-panel">
        <div className="mkt-panel-head">
          <h4>Every order</h4>
          <span className="mkt-panel-hint">a row opens to show its dishes and the cooks that fed it</span>
        </div>

        <div className="mkt-legend">
          {STACK_ORDER.filter((group) => (summary.averageByGroup[group] || 0) > 0).map((group) => (
            <span key={group}>
              <i className="mkt-swatch" style={{ background: GROUP_COLOURS[group] }} aria-hidden="true" />
              {group}
            </span>
          ))}
          <span>
            <i className="mkt-swatch" style={{ background: LEFTOVER_COLOUR }} aria-hidden="true" />
            {LEFTOVER}
          </span>
        </div>

        <div className="mkt-table-wrap">
          <table className="mkt-table ue-table">
            <thead>
              <tr>
                <Header label="Order" sortKey="date" numeric={false} />
                <th>Customer</th>
                <th>Where the money went</th>
                <Header label="Plates" sortKey="plates" />
                <Header label="Order value" sortKey="value" />
                <Header label="Counted cost" sortKey="cost" />
                <Header label="Cost share" sortKey="costPct" />
                <th className="mkt-num">Left over, at most</th>
                <th>Cooks</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((order) => {
                const isOpen = open === order.orderId;
                return (
                  <Fragment key={order.orderId}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : order.orderId)}
                      className={isOpen ? 'ue-row-open' : undefined}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <button type="button" className="ue-disclose" aria-expanded={isOpen}>
                          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {order.orderName}
                        </button>
                        <div className="ue-sub">for {dayLabel(order.promisedDay)}</div>
                      </td>
                      <td>{order.customer}</td>
                      <td>
                        <OrderBar order={order} widest={widest} />
                      </td>
                      <td className="mkt-num">{qty(order.plates)}</td>
                      <td className="mkt-num">
                        <strong>{money(order.revenue)}</strong>
                      </td>
                      <td className="mkt-num">{money(order.knownCost)}</td>
                      <td className="mkt-num">{pctText(order.knownCostPct)}</td>
                      <td className="mkt-num mkt-muted">{money(order.leftoverAtMost)}</td>
                      <td className="mkt-muted">{order.sessions.length ? order.sessions.join(', ') : '—'}</td>
                    </tr>
                    {isOpen ? (
                      <tr className="ue-detail">
                        <td colSpan={9}>
                          <OrderDetail order={order} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {sorted.length > ORDER_PAGE ? (
          <button type="button" className="mkt-chip" onClick={() => setAll(!all)}>
            {all ? `Show the first ${ORDER_PAGE}` : `Show all ${sorted.length} orders`}
          </button>
        ) : null}

        <p className="mkt-panel-hint">
          Cost share is the counted cost over the order value — a floor, never a margin. Order value is what was paid,
          after discounts
          {summary.discount > 0
            ? ` (${money(summary.discount)} off across ${summary.ordersDiscounted} ${summary.ordersDiscounted === 1 ? 'order' : 'orders'})`
            : ''}
          .
          {summary.ordersWithUnmatched
            ? ` ${summary.ordersWithUnmatched} ${summary.ordersWithUnmatched === 1 ? 'order has a line' : 'orders have lines'} that are not a dish on the menu and carry no cost.`
            : ''}
        </p>
      </section>
    </>
  );
};

// The average order as one bar: its rupees from meat up to what is left. The
// headline picture of the lens — "of a ₹975 order, this much is meat" — so it
// carries its numbers on the labels rather than in a tooltip.
const AverageOrder = ({ summary }: { summary: OrderLensData['summary'] }) => {
  const total = Math.max(1, summary.avgOrderValue);
  const parts = [
    ...STACK_ORDER.filter((group) => (summary.averageByGroup[group] || 0) > 0).map((group) => ({
      name: group,
      value: summary.averageByGroup[group],
      colour: GROUP_COLOURS[group],
    })),
    {
      name: LEFTOVER,
      value: Math.max(0, summary.avgOrderValue - summary.avgKnownCost),
      colour: LEFTOVER_COLOUR,
    },
  ];

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>The average order — {money(summary.avgOrderValue)}</h4>
        <span className="mkt-panel-hint">
          {qty(summary.avgPlates)} plates; the grey is everything the counted ingredients do not account for
        </span>
      </div>
      <div
        className="ue-avg-bar"
        role="img"
        aria-label={parts.map((part) => `${part.name} ${money(part.value)}`).join(', ')}
      >
        {parts.map((part) => (
          <span
            key={part.name}
            className="ue-avg-seg"
            style={{
              width: `${(part.value / total) * 100}%`,
              background: part.colour,
            }}
            title={`${part.name}: ${money(part.value)}`}
          />
        ))}
      </div>
      <ul className="ue-avg-labels">
        {parts.map((part) => (
          <li key={part.name}>
            <i style={{ background: part.colour }} aria-hidden="true" />
            <span>{part.name}</span>
            <strong>{money(part.value)}</strong>
            <span className="mkt-muted">{Math.round((part.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

// One order's value as a bar: counted cost by group, then what is left, the
// whole length scaled to the biggest order in the range.
const OrderBar = ({ order, widest }: { order: Order; widest: number }) => {
  const parts = [
    ...STACK_ORDER.filter((group) => (order.byGroup[group] || 0) > 0).map((group) => ({
      name: group,
      value: order.byGroup[group],
      colour: GROUP_COLOURS[group],
    })),
    {
      name: LEFTOVER,
      value: Math.max(0, order.revenue - order.knownCost),
      colour: LEFTOVER_COLOUR,
    },
  ];
  return (
    <div
      className="ue-comp"
      role="img"
      aria-label={parts.map((part) => `${part.name} ${money(part.value)}`).join(', ')}
    >
      {parts
        .filter((part) => part.value > 0)
        .map((part) => (
          <span
            key={part.name}
            className="ue-comp-seg"
            style={{
              width: `${(part.value / widest) * 100}%`,
              background: part.colour,
            }}
            title={`${part.name}: ${money(part.value)}`}
          />
        ))}
    </div>
  );
};

const OrderDetail = ({ order }: { order: Order }) => (
  <div className="ue-detail-grid">
    <div>
      <h5 className="ue-detail-title">
        {order.orderName} — {order.customer}
      </h5>
      <table className="mkt-table ue-lines">
        <thead>
          <tr>
            <th>Dish</th>
            <th className="mkt-num">Qty</th>
            <th className="mkt-num">Cost each</th>
            <th className="mkt-num">Counted cost</th>
            <th className="mkt-num">Paid</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line, index) => (
            <tr key={`${line.itemId || line.name}-${index}`}>
              <td>
                {line.name}
                {line.kind === 'discount' ? (
                  <span className="ue-sub"> money off the order</span>
                ) : line.cost == null ? (
                  <span className="ue-sub"> not a costed dish</span>
                ) : null}
              </td>
              <td className="mkt-num">{qty(line.quantity)}</td>
              <td className="mkt-num">{line.costEach == null ? '—' : money1(line.costEach)}</td>
              <td className="mkt-num">{line.cost == null ? '—' : money(line.cost)}</td>
              <td className="mkt-num">{money(line.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mkt-panel-hint">
        Placed {dayLabel(order.day)}, for {dayLabel(order.promisedDay)}.
        {order.discount > 0 ? ` ${money(order.discount)} was taken off it.` : ''} {order.coveragePct}% of the
        ingredients on these plates carry a price.
      </p>
    </div>
    <div>
      <h5 className="ue-detail-title">Fed from</h5>
      {order.sessions.length ? (
        <ul className="ue-counted">
          {order.sessions.map((id) => (
            <li key={id}>
              <span>{id}</span>
              <span className="mkt-muted">see Per smoking session</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mkt-panel-hint">
          No cook on file for this order&apos;s week and meat — either it had no smoked meat on it, or the session was
          not logged.
        </p>
      )}
    </div>
  </div>
);

// ---- Per smoking session ---------------------------------------------------

const STAGE_LABELS: Record<string, string> = {
  planned: 'Planned',
  brining: 'Brining',
  rub: 'Rubbed',
  ready_to_smoke: 'Ready to smoke',
  smoking: 'In the smoker',
  resting: 'Resting',
  shredding: 'Shredding',
  completed: 'Done',
};

const SessionLens = ({ data }: { data: SessionLensData }) => {
  const [open, setOpen] = useState<string | null>(null);
  const { summary, sessions } = data;

  if (summary.sessions === 0) {
    return <div className="mkt-alert">No smoking sessions were logged in this range.</div>;
  }

  // Every cook's bar is drawn against the heaviest one, in kilos of raw meat,
  // so a 1.4 kg belly next to a 5 kg rack of ribs looks like one.
  const heaviest = Math.max(0.001, ...sessions.map((session) => session.rawKg || 0));
  const unweighed = summary.sessions - summary.sessionsWeighed;

  return (
    <>
      <div className="mkt-tiles">
        <Tile
          label="Cooks"
          value={qty(summary.sessions)}
          sub={
            summary.sessionsWeighed
              ? `${summary.sessionsWeighed} weighed after the smoker`
              : 'none weighed after the smoker yet'
          }
        />
        <Tile label="Raw meat" value={kg(summary.rawKg)} sub={`${money(summary.meatCost)} paid for it`} />
        <Tile
          label="Revenue it fed"
          value={money(summary.revenue)}
          sub={`${qty(summary.plates)} plates across ${summary.sessionsEarning} cooks`}
        />
        <Tile
          label="Meat cost of that revenue"
          value={pctText(summary.knownCostPct)}
          sub="the whole cook's meat, leftovers included"
        />
        {summary.sessionsPriced < summary.sessions ? (
          <Tile
            label="Cooks not priced"
            value={qty(summary.sessions - summary.sessionsPriced)}
            sub="no rate per kilo on file for the cut"
          />
        ) : null}
      </div>

      <section className="mkt-panel">
        <div className="mkt-panel-head">
          <h4>By meat</h4>
          <span className="mkt-panel-hint">every cook in the range, added up per cut</span>
        </div>
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Meat</th>
                <th className="mkt-num">Cooks</th>
                <th className="mkt-num">Raw</th>
                <th className="mkt-num">Paid per kg</th>
                <th className="mkt-num">Yield, planned</th>
                <th className="mkt-num">Yield, weighed</th>
                <th className="mkt-num">Per finished kg</th>
                <th className="mkt-num">Plates fed</th>
                <th className="mkt-num">Meat per plate</th>
                <th className="mkt-num">Revenue fed</th>
              </tr>
            </thead>
            <tbody>
              {summary.byMeat.map((meat) => (
                <tr key={meat.key}>
                  <td>
                    {meat.label}
                    <div className="ue-sub">{meat.material}</div>
                  </td>
                  <td className="mkt-num">{meat.sessions}</td>
                  <td className="mkt-num">{kg(meat.rawKg)}</td>
                  <td className="mkt-num">{meat.avgRatePerKg == null ? 'not priced' : money(meat.avgRatePerKg)}</td>
                  <td className="mkt-num">{pctText(meat.plannedYieldPct)}</td>
                  <td className="mkt-num">
                    {meat.realisedYieldPct == null ? (
                      <span className="mkt-muted">not weighed</span>
                    ) : (
                      `${meat.realisedYieldPct}%`
                    )}
                  </td>
                  <td className="mkt-num">{meat.costPerFinishedKg == null ? '—' : money(meat.costPerFinishedKg)}</td>
                  <td className="mkt-num">{qty(meat.plates)}</td>
                  <td className="mkt-num">
                    <strong>{meat.meatCostPerPlate == null ? '—' : money(meat.meatCostPerPlate)}</strong>
                  </td>
                  <td className="mkt-num">{money(meat.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mkt-panel-hint">
          &ldquo;Meat per plate&rdquo; is what the cooks paid for their meat over the plates they actually fed —
          leftovers and smoker loss included. Open a cook below to set it against what the plan says one plate&apos;s
          meat should cost.
          {unweighed
            ? ` ${unweighed} of ${summary.sessions} cooks have no finished weight yet, so their per-kilo figures use the planned yield.`
            : ''}
        </p>
      </section>

      <section className="mkt-panel">
        <div className="mkt-panel-head">
          <h4>Every cook</h4>
          <span className="mkt-panel-hint">a row opens to show its cost, its yield and what it fed</span>
        </div>

        <div className="mkt-legend">
          {MEAT_FATE.map((name) => (
            <span key={name}>
              <i className="mkt-swatch" style={{ background: MEAT_FATE_COLOURS[name] }} aria-hidden="true" />
              {name}
            </span>
          ))}
        </div>

        <div className="mkt-table-wrap">
          <table className="mkt-table ue-table">
            <thead>
              <tr>
                <th>Cook</th>
                <th>Stage</th>
                <th>Where the meat went</th>
                <th className="mkt-num">Raw</th>
                <th className="mkt-num">Meat cost</th>
                <th className="mkt-num">Yield</th>
                <th className="mkt-num">Sold through</th>
                <th className="mkt-num">Plates fed</th>
                <th className="mkt-num">Revenue fed</th>
                <th className="mkt-num">Meat per plate</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const isOpen = open === session.sessionId;
                return (
                  <Fragment key={session.sessionId}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : session.sessionId)}
                      className={isOpen ? 'ue-row-open' : undefined}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <button type="button" className="ue-disclose" aria-expanded={isOpen}>
                          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {session.categoryLabel}
                        </button>
                        <div className="ue-sub">
                          {session.sessionId} · {dayLabel(session.date)}
                          {session.purpose !== 'Order' ? ` · ${session.purpose}` : ''}
                        </div>
                      </td>
                      <td className="mkt-muted">{STAGE_LABELS[session.stage] || session.stage}</td>
                      <td>
                        <MeatFateBar session={session} heaviest={heaviest} />
                      </td>
                      <td className="mkt-num">{kg(session.rawKg)}</td>
                      <td className="mkt-num">
                        {session.meatCost == null ? (
                          <span className="mkt-muted">not priced</span>
                        ) : (
                          money(session.meatCost)
                        )}
                      </td>
                      <td className="mkt-num">
                        {session.finishedSource === 'recorded' ? (
                          `${session.actualYieldPct}%`
                        ) : (
                          <span className="mkt-muted">{pctText(session.plannedYieldPct)} plan</span>
                        )}
                      </td>
                      <td className="mkt-num">{pctText(session.sellThroughPct)}</td>
                      <td className="mkt-num">{session.attribution === 'none' ? '—' : qty(session.plates)}</td>
                      <td className="mkt-num">{session.attribution === 'none' ? '—' : money(session.revenue)}</td>
                      <td className="mkt-num">
                        <strong>{session.meatCostPerPlate == null ? '—' : money(session.meatCostPerPlate)}</strong>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="ue-detail">
                        <td colSpan={10}>
                          <SessionDetail session={session} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mkt-panel-hint">
          Sold through is the finished meat that went into orders, over the finished meat the cook produced. Well under
          100% is leftover, staff food or waste; over 100% means the week&apos;s orders were fed from more than the
          cooks on file.
        </p>
      </section>
    </>
  );
};

// A cook's raw weight, split three ways: what went onto plates, what came out
// of the smoker and did not, and what the smoker took. One measure — grams of
// the same meat — so it stacks honestly. Scaled to the heaviest cook.
const MeatFateBar = ({ session, heaviest }: { session: Session; heaviest: number }) => {
  const raw = (session.rawKg || 0) * 1000;
  const finished = session.finishedKg == null ? raw : Math.min(raw, session.finishedKg * 1000);
  const sold = Math.min(finished, session.gramsSold);
  const values: Record<string, number> = {
    'Went into orders': sold,
    'Cooked, not sold': Math.max(0, finished - sold),
    'Lost in the smoker': Math.max(0, raw - finished),
  };
  const grams = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} kg` : `${Math.round(value)} g`);
  return (
    <div
      className="ue-comp"
      role="img"
      aria-label={MEAT_FATE.map((name) => `${name} ${grams(values[name])}`).join(', ')}
    >
      {MEAT_FATE.filter((name) => values[name] > 0).map((name) => (
        <span
          key={name}
          className="ue-comp-seg"
          style={{
            width: `${(values[name] / (heaviest * 1000)) * 100}%`,
            background: MEAT_FATE_COLOURS[name],
          }}
          title={`${name}: ${grams(values[name])}${
            name !== 'Went into orders' && session.finishedSource === 'planned' ? ' (at the planned yield)' : ''
          }`}
        />
      ))}
    </div>
  );
};

// "(PUR-0004, 10 Aug 26)", or as much of it as is known.
const rateRef = (rate: NonNullable<Session['rate']>) => {
  const parts = [rate.ref, rate.asOf ? dayLabel(rate.asOf) : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

const SessionDetail = ({ session }: { session: Session }) => {
  const planned = session.finishedSource !== 'recorded';
  return (
    <div className="ue-detail-grid ue-detail-grid-3">
      <div>
        <h5 className="ue-detail-title">What it cost</h5>
        <ul className="ue-counted">
          <li>
            <span>
              {session.materialName}, {kg(session.rawKg)}
            </span>
            <strong>{session.meatCost == null ? '—' : money(session.meatCost)}</strong>
          </li>
          {session.otherSpend.map((entry) => (
            <li key={entry.purchaseId}>
              <span>{entry.name}</span>
              <strong>{money(entry.cost)}</strong>
            </li>
          ))}
        </ul>
        <p className="mkt-panel-hint">
          {session.rate
            ? `${money(session.rate.perKg)}/kg from ${session.rate.source}${rateRef(session.rate)}.`
            : `The meat is not priced — ${session.rateGap}.`}{' '}
          Not counted: {[session.rubRecipe, session.brineRecipe].filter(Boolean).join(' and ') || 'rub and brine'}
          {session.otherSpend.length ? '' : ', wood and charcoal (log them against the session to count them)'}.
        </p>
      </div>

      <div>
        <h5 className="ue-detail-title">What it yielded</h5>
        <ul className="ue-counted">
          <li>
            <span>Finished weight</span>
            <strong>
              {kg(session.finishedKg)}
              {planned ? ' (plan)' : ''}
            </strong>
          </li>
          <li>
            <span>Yield</span>
            <strong>
              {planned
                ? `${pctText(session.plannedYieldPct)} planned`
                : `${session.actualYieldPct}% vs ${pctText(session.plannedYieldPct)} planned`}
            </strong>
          </li>
          <li>
            <span>Meat per finished kg</span>
            <strong>{session.costPerFinishedKg == null ? '—' : money(session.costPerFinishedKg)}</strong>
          </li>
        </ul>
        {session.portions.length ? (
          <div className="ue-lines-wrap">
            <table className="mkt-table ue-lines">
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="mkt-num">Meat</th>
                  <th className="mkt-num">Could make</th>
                  <th className="mkt-num">Meat each</th>
                  <th className="mkt-num">Plan</th>
                </tr>
              </thead>
              <tbody>
                {session.portions.map((portion) => (
                  <tr key={portion.itemId}>
                    <td>{portion.name}</td>
                    <td className="mkt-num">{portion.grams} g</td>
                    <td className="mkt-num">
                      {portion.portionsPossible == null ? '—' : qty(portion.portionsPossible)}
                    </td>
                    <td className="mkt-num">{portion.meatCostEach == null ? '—' : money1(portion.meatCostEach)}</td>
                    <td className="mkt-num mkt-muted">
                      {portion.plannedMeatCostEach == null ? '—' : money1(portion.plannedMeatCostEach)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mkt-panel-hint">
          {planned
            ? 'Not weighed after the smoker yet, so "meat each" is the plan. Record the finished weight on the Smoking Session screen and this becomes the real figure.'
            : '"Meat each" is at this cook\'s weighed yield; "plan" is at the yield the buying is planned on.'}
        </p>
      </div>

      <div>
        <h5 className="ue-detail-title">What it fed</h5>
        {session.attribution === 'none' ? (
          <p className="mkt-panel-hint">{session.attributionNote}.</p>
        ) : session.dishes.length ? (
          <>
            <ul className="ue-counted">
              {session.dishes.map((dish) => (
                <li key={dish.itemId}>
                  <span>
                    {qty(dish.plates)} × {dish.name}
                  </span>
                  <strong>{money(dish.revenue)}</strong>
                </li>
              ))}
            </ul>
            <p className="mkt-panel-hint">
              {session.orders} {session.orders === 1 ? 'order' : 'orders'},{' '}
              {session.attribution === 'linked'
                ? 'as listed on the session.'
                : 'taken from the orders promised that week — the session lists none of its own.'}{' '}
              Meat is {pctText(session.knownCostPct)} of this revenue; {session.gramsSold} g of{' '}
              {session.finishedKg == null ? '—' : `${Math.round(session.finishedKg * 1000)} g`} finished went onto
              plates.
            </p>
          </>
        ) : (
          <p className="mkt-panel-hint">
            No orders that week had {session.productName.toLowerCase() || 'this meat'} on them.
          </p>
        )}
      </div>
    </div>
  );
};

export default UnitEconomics;
