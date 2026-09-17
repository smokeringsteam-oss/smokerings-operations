import { useCallback, useEffect, useMemo, useState } from 'react';
import { REPORT_START } from '../reportRange';
import { defaultWeekendRange, formatDateInput } from '../ops/shared/packing';

// Marketing ROI — what marketing cost, next to what it brought in.
//
// Two tabs, in the order the questions get asked. Overview answers "did this
// pay"; Traffic sources answers the one before it, "did anybody even arrive",
// per utm_source rather than per channel.
//
// Overview credits an order to the channel its utm_source names, in
// preference to the Order Source somebody filed it under — see the second
// rule at the top of server/marketing/marketingRoi.js. Every row says how
// many of its orders arrived that way.
//
// The number this screen is most careful about is the one it does NOT show.
// Revenue whose channel is unknown is never spread across the channels that
// are known, and never dropped: it sits in its own row, it is excluded from
// every channel's return, and the tiles print how much of the total is
// actually attributed. On the database this was built against that was a bit
// over half — so a return computed as though it were all of it would have
// been wrong by nearly a factor of two, and would have looked completely
// plausible.
//
// Backend: server/marketing/marketingRoi.js (the join).

// The two series colours, used for the invested-vs-generated bars and their
// legend. Checked with the dataviz palette validator against this app's
// chart surface (#fff8ef): both inside the lightness band, both above the
// chroma floor, adjacent CVD separation 21.2 (protan) against a floor of 8,
// and both over 3:1 against the surface. Ember is the brand accent and
// carries revenue; the blue is the cost. Do not swap these for eyeballed
// values — re-run the validator instead.
const COLOR_INVESTED = '#1668a8';
const COLOR_GENERATED = '#d9480f';

// The sessions bars on the Traffic sources tab. A third hue rather than a
// reuse of either above, because on this screen those two already mean
// "money out" and "money in", and sessions are neither -- a bar in the ember
// of revenue that counts visits would be read as revenue at a glance.
//
// Validated against the same #fff8ef surface as a three-slot palette with
// the pair above: inside the lightness band, over the chroma floor, worst
// adjacent CVD separation 21.2 (protan) against a floor of 8, and over 3:1
// on the surface. One series, so the chart carries no legend -- the panel
// title names the measure and every bar is direct-labelled with its count.
const COLOR_SESSIONS = '#6b3fa0';

type ChannelRow = {
  channel: string;
  invested: number;
  generated: number;
  net: number;
  roi: number | null;
  orders: number;
  aov: number | null;
  cac: number | null;
  sessions: number;
  users: number;
  keyEvents: number;
  conversionRate: number | null;
  spendRows: number;
  partialSpend: boolean;
  // Of this channel's orders, how many were credited to it by the utm_source
  // on the order rather than by the Order Source field, and what they were
  // worth.
  fromLink: number;
  linkRevenue: number;
  campaigns: string[];
  mapped: boolean;
  unattributed: boolean;
};

type CampaignRow = {
  campaign: string;
  channels: string[];
  invested: number;
  generated: number;
  net: number;
  roi: number | null;
  orders: number;
  aov: number | null;
  cac: number | null;
  sessions: number;
  conversionRate: number | null;
};

type SpendRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  channel: string;
  campaign: string;
  category: string;
  amount: number;
  vendor: string;
  notes: string;
  source: string;
  days: number;
  share: number;
  amountInRange: number;
  partial: boolean;
};

// One utm_source, as buildTrafficSources in server/marketing/marketingRoi.js
// assembles it. `sessions` is the count of visits; `users` is people, which
// is smaller and cannot be added across rows -- see fetchTrafficBySource.
type TrafficSourceRow = {
  source: string;
  sessions: number;
  users: number;
  newUsers: number;
  keyEvents: number;
  share: number | null;
  channel: string;
  mediums: { medium: string; sessions: number }[];
  campaigns: { campaign: string; sessions: number }[];
  links: number;
  orders: number;
  revenue: number;
  revenuePerSession: number | null;
  seenOnOrders: boolean;
  seenByGa: boolean;
};

// One order the link rule moved. `filedAs` and `creditedTo` are both real
// channels and always differ -- an order with no channel filed at all is not
// a move, it is the link supplying the only channel there was, and the server
// keeps it out of this list.
type RecreditedRow = {
  order: string;
  orderedOn: string;
  amount: number;
  filedAs: string;
  utmSource: string;
  creditedTo: string;
};

type ChannelOption = { value: string; label: string; mapped: boolean; medium: string; source: string };

// One utm_source / utm_campaign / utm_content value, and what arrived under it.
type UtmValueRow = { value: string; orders: number; revenue: number; channels: string[] };

type UtmReport = {
  fields: string[];
  orders: number;
  revenue: number;
  tagged: number;
  taggedRevenue: number;
  taggedShare: number | null;
  sources: UtmValueRow[];
  campaigns: UtmValueRow[];
  contents: UtmValueRow[];
  combos: {
    source: string;
    campaign: string;
    content: string;
    orders: number;
    revenue: number;
    channels: string[];
    lastOrderedOn: string;
    orderNames: string[];
  }[];
  mismatched: { order: string; channel: string; utmSource: string; implied: string }[];
};

type RoiReport = {
  range: { from: string; to: string };
  sources: {
    odoo: { configured: boolean; url: string; channelField: string };
    ga: { configured: boolean; propertyId: string; serviceAccount: string; error: string; reachable: boolean };
  };
  totals: {
    invested: number;
    generated: number;
    net: number;
    roi: number | null;
    orders: number;
    attributedRevenue: number;
    unattributedRevenue: number;
    unattributedOrders: number;
    attributedShare: number | null;
    attributedRoi: number | null;
    pendingRevenue: number;
    pendingOrders: number;
    recreditedOrders: number;
    recreditedRevenue: number;
    linkOnlyOrders: number;
    linkOnlyRevenue: number;
    sessions: number | null;
    users: number | null;
    newUsers: number | null;
  };
  channels: ChannelRow[];
  campaigns: CampaignRow[];
  categories: { category: string; invested: number }[];
  gaOnly: { source: string; medium: string; sessions: number; users: number; keyEvents: number }[];
  trafficSources: TrafficSourceRow[];
  utm: UtmReport;
  // The orders whose utm_source moved them off the channel they were filed
  // under. Optional: server/ is not hot-reloaded, so a tab open against an
  // older API build must render without it rather than crash.
  recredited?: RecreditedRow[];
  spend: SpendRow[];
  untagged: number;
  unfiled?: number;
  channelOptions: ChannelOption[];
};

const CATEGORY_LABELS: Record<string, string> = {
  ads: 'Paid ads',
  commission: 'Aggregator commission',
  influencer: 'Influencer / blogger',
  print: 'Print & signage',
  event: 'Events & pop-ups',
  tooling: 'Tools & subscriptions',
  other: 'Other',
};

const iso = (date: Date) => date.toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return iso(date);
};

const monthStart = () => {
  const date = new Date();
  date.setDate(1);
  return iso(date);
};

// Indian digit grouping, no paise. Every figure on this screen is a rupee
// total or a pro-rated share of one, and both were rounded server-side.
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (value: number) => `₹${rupees.format(Math.round(value))}`;

// A return of null means there was no spend to divide by, which is a
// different fact from a return of zero — see the note on derive() in
// marketingRoi.js. It has to read differently too, or the two sort together
// and the free channel looks like the failing one.
const multiple = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}×`);

const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`);

// Sessions and people are counts, not money. Same grouping, no rupee sign --
// the digits are grouped the Indian way everywhere on this screen so a
// four-figure session count and a four-figure rupee total line up.
const count = (value: number) => rupees.format(Math.round(value));

// Local-date arithmetic on a YYYY-MM-DD string. Not iso(): toISOString is UTC,
// and in IST a local midnight is the previous day in UTC.
const shiftDays = (value: string, n: number) => {
  const [y, m, d] = value.split('-').map(Number);
  return formatDateInput(new Date(y, m - 1, d + n));
};

const MarketingROI = () => {
  // Opens on the same Mon→Sun service week as B2C Order Management, so the
  // money here lines up with the weekend the kitchen just cooked.
  const [from, setFrom] = useState(() => defaultWeekendRange().from);
  const [to, setTo] = useState(() => defaultWeekendRange().to);
  const [tab, setTab] = useState<'overview' | 'traffic'>('overview');

  const [report, setReport] = useState<RoiReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/marketing/roi?from=${from}&to=${to}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the report.');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const preset = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
  };

  return (
    <div className="mkt-roi">
      {/* A div, not a <header> — `.marketing-dashboard header` in App.css is
          the dark hero the parent dashboard already uses, and a second one
          here reads as a duplicate page title. */}
      <div className="mkt-head">
        <h3>Marketing ROI</h3>
        <p>
          What each channel and campaign cost, against the revenue it produced. Spend is entered here; revenue comes
          from Odoo orders; traffic comes from Google Analytics when it is connected.
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
              onClick={() => preset(shiftDays(from, -7), shiftDays(to, -7))}
            >
              ‹ Week
            </button>
            <button
              type="button"
              className="mkt-chip"
              onClick={() => {
                const week = defaultWeekendRange();
                preset(week.from, week.to);
              }}
            >
              This week
            </button>
            <button
              type="button"
              className="mkt-chip"
              aria-label="Next week"
              onClick={() => preset(shiftDays(from, 7), shiftDays(to, 7))}
            >
              Week ›
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(daysAgo(6), iso(new Date()))}>
              Last 7 days
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(daysAgo(30), iso(new Date()))}>
              Last 30 days
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(monthStart(), iso(new Date()))}>
              This month
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(daysAgo(90), iso(new Date()))}>
              Last 90 days
            </button>
            <button type="button" className="mkt-chip" onClick={() => preset(REPORT_START, iso(new Date()))}>
              All time
            </button>
          </div>
        </div>

        <div className="mkt-tabs">
          {(
            [
              ['overview', 'Overview'],
              ['traffic', 'Traffic sources'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`mkt-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {loading && !report ? <div className="mkt-alert">Reading orders from Odoo…</div> : null}

      {report ? (
        <>
          {tab === 'overview' ? <Overview report={report} /> : null}
          {tab === 'traffic' ? <TrafficSources report={report} /> : null}
        </>
      ) : null}
    </div>
  );
};

// ---- Overview --------------------------------------------------------------

const Overview = ({ report }: { report: RoiReport }) => {
  const { totals, channels, sources } = report;

  // Channels only — the unattributed row is revenue with no channel and
  // charting it beside real channels would invite reading it as one.
  const charted = useMemo(() => channels.filter((row) => !row.unattributed), [channels]);

  return (
    <div className="mkt-body">
      <SourceBanner report={report} />

      <div className="mkt-tiles">
        <Tile label="Invested" value={money(totals.invested)} sub={`${report.spend.length} spend row${report.spend.length === 1 ? '' : 's'} in range`} />
        <Tile
          label="Generated"
          value={money(totals.generated)}
          sub={`${totals.orders} confirmed order${totals.orders === 1 ? '' : 's'}`}
        />
        <Tile
          label="Net"
          value={money(totals.net)}
          sub={totals.net >= 0 ? 'Revenue above spend' : 'Spend above revenue'}
          tone={totals.net >= 0 ? 'good' : 'bad'}
        />
        <Tile
          label="Return on spend"
          value={multiple(totals.roi)}
          sub={
            totals.roi === null
              ? 'No spend recorded in this range'
              : `${multiple(totals.attributedRoi)} counting only attributed revenue`
          }
        />
      </div>

      {/* The honesty line. It sits above every chart on purpose: the figures
          below are only as good as this percentage, and a reader who does not
          know it will over-trust them. */}
      {totals.attributedShare !== null && totals.attributedShare < 100 ? (
        <div className="mkt-alert mkt-alert-warn">
          <strong>{percent(totals.attributedShare)} of revenue has a channel on it.</strong> The other{' '}
          {money(totals.unattributedRevenue)} across {totals.unattributedOrders} order
          {totals.unattributedOrders === 1 ? '' : 's'} is not counted towards any channel below — it is shown as its own
          row. Set the Order Source on those orders in Odoo to make these figures whole.
        </div>
      ) : null}

      {/* What the link rule moved, stated before the tables it moved things
          in. Only when it actually did something — on a range with no tagged
          orders this is silent rather than explaining a rule with no
          effect. */}
      {totals.recreditedOrders > 0 || totals.linkOnlyOrders > 0 ? (
        <div className="mkt-alert">
          <strong>
            {money(totals.recreditedRevenue + totals.linkOnlyRevenue)} was credited by the link on the order, not by
            the Order Source field.
          </strong>{' '}
          {totals.recreditedOrders > 0
            ? `${totals.recreditedOrders} order${totals.recreditedOrders === 1 ? '' : 's'} carried a utm_source pointing at a different channel from the one ${totals.recreditedOrders === 1 ? 'it was' : 'they were'} filed under, and ${totals.recreditedOrders === 1 ? 'is' : 'are'} counted where the link says. `
            : ''}
          {totals.linkOnlyOrders > 0
            ? `${totals.linkOnlyOrders} order${totals.linkOnlyOrders === 1 ? '' : 's'} had no channel filed at all and got one from the link. `
            : ''}
          The tag is a fact about the URL that was clicked; the Order Source is a judgement made afterwards.
        </div>
      ) : null}

      {totals.pendingOrders > 0 ? (
        <div className="mkt-alert">
          {totals.pendingOrders} unconfirmed quotation{totals.pendingOrders === 1 ? '' : 's'} worth{' '}
          {money(totals.pendingRevenue)} in this range are not counted as revenue yet.
        </div>
      ) : null}

      <InvestedVsGenerated rows={charted} />

      <ChannelTable rows={channels} gaOn={sources.ga.reachable} />

      {report.categories.length ? (
        <section className="mkt-panel">
          <h4>Where the spend went</h4>
          <ul className="mkt-category-list">
            {report.categories.map((row) => (
              <li key={row.category}>
                <span>{CATEGORY_LABELS[row.category] || row.category}</span>
                <strong>{money(row.invested)}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.gaOnly.length ? (
        <section className="mkt-panel">
          <h4>Traffic with no channel of ours</h4>
          <p className="mkt-panel-hint">
            Sources Google Analytics saw that do not map onto any order source. Real visits, but nothing here can say
            what they were worth — add the source to <code>CHANNELS</code> in server/marketing/orderAttribution.js to
            fold it into a channel.
          </p>
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Source / medium</th>
                <th className="mkt-num">Sessions</th>
                <th className="mkt-num">Users</th>
                <th className="mkt-num">Key events</th>
              </tr>
            </thead>
            <tbody>
              {report.gaOnly.map((row) => (
                <tr key={`${row.source}/${row.medium}`}>
                  <td>
                    {row.source} <span className="mkt-muted">/ {row.medium}</span>
                  </td>
                  <td className="mkt-num">{rupees.format(row.sessions)}</td>
                  <td className="mkt-num">{rupees.format(row.users)}</td>
                  <td className="mkt-num">{rupees.format(row.keyEvents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
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

const SourceBanner = ({ report }: { report: RoiReport }) => {
  const { ga } = report.sources;
  return (
    <div className="mkt-sources">
      <span className="mkt-source is-on">
        Odoo connected — revenue from <code>{report.sources.odoo.channelField || 'no order source field'}</code>
      </span>
      {ga.reachable ? (
        <span className="mkt-source is-on">Google Analytics connected — property {ga.propertyId}</span>
      ) : (
        <span className="mkt-source is-off" title={ga.error}>
          Google Analytics {ga.configured ? 'unavailable' : 'not connected'} — sessions and conversion rate are blank.{' '}
          {ga.error}
        </span>
      )}
    </div>
  );
};

// ---- Invested vs generated -------------------------------------------------

// Grouped horizontal bars: two rupee measures on one shared scale, one bar
// each, per channel.
//
// Horizontal because the category labels are words of very different lengths
// ("Friends & Family", "Pop-up Event") and vertical columns would either
// clip them or turn them on their side. One scale, never two — the whole
// point is that the two bars are directly comparable, and a second axis would
// make their relative lengths arbitrary.
//
// Values ride the bar tips rather than sitting under an axis, so there is no
// gridline chrome at all: the numbers ARE the scale here, and the bars carry
// the comparison.
const InvestedVsGenerated = ({ rows }: { rows: ChannelRow[] }) => {
  const [hover, setHover] = useState<{ channel: string; series: 'invested' | 'generated' } | null>(null);

  // One scale across both series and every channel, so a bar's length means
  // the same thing wherever it appears.
  const max = useMemo(() => Math.max(1, ...rows.flatMap((row) => [row.invested, row.generated])), [rows]);

  if (!rows.length) {
    return (
      <section className="mkt-panel">
        <h4>Invested vs generated</h4>
        <p className="mkt-panel-hint">
          Nothing to compare yet in this range — no spend rows, and no orders carrying a channel.
        </p>
      </section>
    );
  }

  return (
    <section className="mkt-panel">
      <div className="mkt-panel-head">
        <h4>Invested vs generated</h4>
        {/* A legend is present because there are two series; identity never
            rests on colour alone. */}
        <div className="mkt-legend">
          <span>
            <i className="mkt-swatch" style={{ background: COLOR_INVESTED }} aria-hidden="true" /> Invested
          </span>
          <span>
            <i className="mkt-swatch" style={{ background: COLOR_GENERATED }} aria-hidden="true" /> Generated
          </span>
        </div>
      </div>

      <div className="mkt-chart">
        {rows.map((row) => (
          <div className="mkt-chart-row" key={row.channel}>
            <div className="mkt-chart-label">
              {row.channel}
              {row.roi !== null ? <span className="mkt-chart-roi">{multiple(row.roi)}</span> : null}
            </div>

            <div className="mkt-chart-bars">
              {(
                [
                  ['invested', row.invested, COLOR_INVESTED],
                  ['generated', row.generated, COLOR_GENERATED],
                ] as const
              ).map(([series, value, color]) => (
                <div
                  className="mkt-bar-track"
                  key={series}
                  onMouseEnter={() => setHover({ channel: row.channel, series })}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className="mkt-bar"
                    style={{
                      // Zero gets a hairline rather than nothing, so "spent
                      // nothing here" reads as a measured zero and not as a
                      // row that failed to render.
                      width: `${Math.max(value > 0 ? 1 : 0.4, (value / max) * 100)}%`,
                      background: color,
                    }}
                  />
                  <span className="mkt-bar-value">{money(value)}</span>

                  {hover?.channel === row.channel && hover.series === series ? (
                    <div className="mkt-tooltip" role="status">
                      <strong>
                        {row.channel} — {series === 'invested' ? 'invested' : 'generated'}
                      </strong>
                      <span>{money(value)}</span>
                      <span>
                        {row.orders} order{row.orders === 1 ? '' : 's'}
                        {row.aov !== null ? ` · ${money(row.aov)} average` : ''}
                      </span>
                      <span>
                        Return {multiple(row.roi)}
                        {row.cac !== null ? ` · ${money(row.cac)} per order` : ''}
                      </span>
                      {row.partialSpend ? <span className="mkt-muted">Includes a pro-rated spend row</span> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

// ---- Traffic sources -------------------------------------------------------

// Who arrived, and from which utm_source.
//
// The Overview tab answers this per channel, which is the right grain for
// money and the wrong one for reach: three channels share the source
// 'Referral', a QR on a flyer has no channel at all, and both of those
// disappear into a single row or an "unmapped" footnote over there. Here
// every source stands on its own, whether or not any revenue ever found its
// way back to it.
//
// Two things are shown that GA alone cannot say, both coming from the link
// builder's table:
//
//   * how many links we have published carrying each source, so a number
//     that looks low can be checked against whether anything was ever
//     pointed at it; and
//   * sources we publish to that GA saw nothing from at all. Those are the
//     rows worth acting on -- a printed QR that nobody has scanned looks
//     exactly like a source that does not exist, unless the screen keeps the
//     row and prints the zero.
const TrafficSources = ({ report }: { report: RoiReport }) => {
  const { totals, sources, trafficSources } = report;
  const [hover, setHover] = useState<string | null>(null);

  // Rows with visits, and rows we published to that got none. Split rather
  // than sorted together: a run of zeroes at the bottom of a ranked chart is
  // noise, and the same zeroes under a heading that says what they mean are
  // the finding.
  const arrived = useMemo(() => trafficSources.filter((row) => row.sessions > 0), [trafficSources]);
  const silent = useMemo(
    () => trafficSources.filter((row) => row.sessions === 0 && row.links > 0),
    [trafficSources],
  );

  // One scale across every bar, taken from the largest. The top source is
  // usually direct or organic search by a wide margin, so the tail is short
  // bars -- which is the true shape and not something to rescale away.
  const max = useMemo(() => Math.max(1, ...arrived.map((row) => row.sessions)), [arrived]);

  return (
    <div className="mkt-body">
      <SourceBanner report={report} />

      {!sources.ga.reachable ? (
        <div className="mkt-alert mkt-alert-warn">
          <strong>Session counts come from Google Analytics, which is not answering.</strong> {sources.ga.error} The
          sources below are the ones we have published links to; every count reads zero until GA is connected.
        </div>
      ) : null}

      <div className="mkt-tiles">
        <Tile
          label="Sessions"
          value={totals.sessions === null ? '—' : count(totals.sessions)}
          sub="Visits in this range, all sources"
        />
        <Tile
          label="People"
          value={totals.users === null ? '—' : count(totals.users)}
          sub={
            totals.newUsers === null
              ? 'Distinct visitors'
              : `${count(totals.newUsers)} here for the first time`
          }
        />
        <Tile
          label="Sources seen"
          value={count(arrived.length)}
          sub={`${count(trafficSources.filter((row) => row.links > 0).length)} we publish links to`}
        />
        <Tile
          label="Never scanned"
          value={count(silent.length)}
          sub={silent.length ? 'Sources we published to with no visits' : 'Every published source got visits'}
          tone={silent.length ? 'bad' : 'good'}
        />
        <Tile
          label="Revenue from tagged sources"
          value={money(report.utm?.taggedRevenue ?? 0)}
          sub={`${count(report.utm?.tagged ?? 0)} of ${count(report.utm?.orders ?? 0)} orders arrived carrying a utm_source`}
        />
      </div>

      {/* People, not sessions, is the tile above, and the two differ by
          repeat visits. Said once, here, rather than as a footnote under
          every count: a reader who thinks 'sessions' means 'people' will
          over-read the whole tab. */}
      <p className="mkt-panel-hint">
        A <strong>session</strong> is one visit; a person who came back on Thursday is two sessions and one person.
        People cannot be added up across the rows below — somebody who arrived once from Instagram and once from a QR
        code is one person site-wide and appears in both rows — so the tile above is the site total and the column is
        per source.
      </p>

      {arrived.length ? (
        <section className="mkt-panel">
          <div className="mkt-panel-head">
            <h4>Sessions by utm_source</h4>
          </div>
          <div className="mkt-chart">
            {arrived.map((row) => (
              <div className="mkt-chart-row" key={row.source}>
                <div className="mkt-chart-label">
                  {row.source}
                  <span className="mkt-chart-roi">
                    {row.channel || 'no channel'}
                    {row.links ? ` · ${row.links} link${row.links === 1 ? '' : 's'}` : ''}
                  </span>
                </div>

                <div className="mkt-chart-bars">
                  <div
                    className="mkt-bar-track"
                    onMouseEnter={() => setHover(row.source)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div
                      className="mkt-bar"
                      style={{ width: `${Math.max(1, (row.sessions / max) * 100)}%`, background: COLOR_SESSIONS }}
                    />
                    <span className="mkt-bar-value">
                      {count(row.sessions)} · {percent(row.share)}
                    </span>

                    {hover === row.source ? (
                      <div className="mkt-tooltip" role="status">
                        <strong>{row.source}</strong>
                        <span>
                          {count(row.sessions)} session{row.sessions === 1 ? '' : 's'} · {count(row.users)} person
                          {row.users === 1 ? '' : 's'}
                        </span>
                        <span>
                          {count(row.newUsers)} first-time · {count(row.keyEvents)} key event
                          {row.keyEvents === 1 ? '' : 's'}
                        </span>
                        {row.mediums.length ? (
                          <span>{row.mediums.map((entry) => `${entry.medium} ${count(entry.sessions)}`).join(' · ')}</span>
                        ) : null}
                        {row.campaigns.length ? (
                          <span className="mkt-muted">
                            {row.campaigns
                              .slice(0, 3)
                              .map((entry) => `${entry.campaign} ${count(entry.sessions)}`)
                              .join(' · ')}
                          </span>
                        ) : null}
                        <span className="mkt-muted">
                          {row.channel ? `Counts towards ${row.channel}` : 'Maps to no channel — revenue reads unattributed'}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="mkt-alert">
          No sessions in this range.{' '}
          {sources.ga.reachable
            ? 'Google Analytics is connected and reported nothing for these dates.'
            : 'Connect Google Analytics to see where visits came from.'}
        </div>
      )}

      <section className="mkt-panel">
        <h4>Every source</h4>
        <p className="mkt-panel-hint">
          The same rows as a table, with the medium each source arrived on and the channel its revenue rolls into on
          the Overview tab. “—” under channel means the source maps to none, so anything bought after that visit shows
          up in the unattributed row until it is tagged.
        </p>
        {/* The two halves of the table come from different places and fail
            independently, which the reader has to know to read a blank cell
            correctly: sessions are GA's, revenue is the orders'. A source can
            have one without the other and usually does. */}
        <p className="mkt-panel-hint">
          Sessions and people come from Google Analytics; orders and revenue come from the <code>utm_source</code> on
          the Odoo orders themselves. A source with visits and no revenue got looked at and not bought from; a source
          with revenue and no visits sold through a link GA never saw a session for, which is normal for WhatsApp.
          First-time visitors and key events are in the tooltips on the chart above.
        </p>
        <table className="mkt-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Medium</th>
              <th>Rolls up to</th>
              <th className="mkt-num">Our links</th>
              <th className="mkt-num">Sessions</th>
              <th className="mkt-num">People</th>
              <th className="mkt-num">Orders</th>
              <th className="mkt-num">Revenue</th>
              <th className="mkt-num">Per session</th>
              <th className="mkt-num">Share</th>
            </tr>
          </thead>
          <tbody>
            {trafficSources.map((row) => (
              <tr key={row.source}>
                <td>{row.source}</td>
                <td className="mkt-muted">{row.mediums.map((entry) => entry.medium).join(', ') || '—'}</td>
                <td>{row.channel || <span className="mkt-muted">—</span>}</td>
                <td className="mkt-num">{row.links ? count(row.links) : <span className="mkt-muted">—</span>}</td>
                <td className="mkt-num">{count(row.sessions)}</td>
                <td className="mkt-num">{count(row.users)}</td>
                <td className="mkt-num">{row.orders ? count(row.orders) : <span className="mkt-muted">—</span>}</td>
                <td className="mkt-num">{row.revenue ? money(row.revenue) : <span className="mkt-muted">—</span>}</td>
                {/* Blank, not ₹0, wherever one of the two halves is missing.
                    A source GA cannot see has no revenue per session; a
                    source nobody ordered from has none either, and printing
                    ₹0 for both would say something false about the first. */}
                <td className="mkt-num">
                  {row.revenuePerSession === null ? (
                    <span className="mkt-muted">—</span>
                  ) : (
                    money(row.revenuePerSession)
                  )}
                </td>
                <td className="mkt-num">{percent(row.share)}</td>
              </tr>
            ))}
            {!trafficSources.length ? (
              <tr>
                <td colSpan={10} className="mkt-muted">
                  Nothing to show yet — no traffic in this range and no tracked links built.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {silent.length ? (
        <section className="mkt-panel">
          <h4>Published, but nobody came</h4>
          <p className="mkt-panel-hint">
            Sources we have built tracked links for that Google Analytics saw no visits from in this range. For a QR
            code that is the whole point of measuring it — the sticker is out in the world and nothing is coming back.
          </p>
          <ul className="mkt-category-list">
            {silent.map((row) => (
              <li key={row.source}>
                <span>
                  {row.source} <span className="mkt-muted">· {row.channel || 'no channel'}</span>
                </span>
                <strong>
                  {row.links} link{row.links === 1 ? '' : 's'}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};

// ---- Tables ----------------------------------------------------------------

const ChannelTable = ({ rows, gaOn }: { rows: ChannelRow[]; gaOn: boolean }) => (
  <section className="mkt-panel">
    <h4>By channel</h4>
    <div className="mkt-table-wrap">
      <table className="mkt-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th className="mkt-num">Invested</th>
            <th className="mkt-num">Generated</th>
            <th className="mkt-num">Net</th>
            <th className="mkt-num">Return</th>
            <th className="mkt-num">Orders</th>
            <th className="mkt-num">Avg order</th>
            <th className="mkt-num">Cost / order</th>
            {gaOn ? <th className="mkt-num">Sessions</th> : null}
            {gaOn ? <th className="mkt-num">Conv.</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.channel} className={row.unattributed ? 'mkt-row-unattributed' : ''}>
              <td>
                {row.channel}
                {row.unattributed ? <span className="mkt-tag">no channel on the order</span> : null}
                {row.partialSpend ? <span className="mkt-tag">pro-rated spend</span> : null}
                {row.fromLink ? (
                  <span className="mkt-tag" title={`${money(row.linkRevenue)} of this row's revenue came from orders whose utm_source named this channel`}>
                    {row.fromLink} from a link
                  </span>
                ) : null}
                {row.campaigns.length ? (
                  <span className="mkt-muted mkt-block">{row.campaigns.join(', ')}</span>
                ) : null}
              </td>
              <td className="mkt-num">{money(row.invested)}</td>
              <td className="mkt-num">{money(row.generated)}</td>
              <td className={`mkt-num ${row.net >= 0 ? 'mkt-good' : 'mkt-bad'}`}>{money(row.net)}</td>
              <td className="mkt-num">{multiple(row.roi)}</td>
              <td className="mkt-num">{row.orders}</td>
              <td className="mkt-num">{row.aov === null ? '—' : money(row.aov)}</td>
              <td className="mkt-num">{row.cac === null ? '—' : money(row.cac)}</td>
              {gaOn ? <td className="mkt-num">{row.sessions ? rupees.format(row.sessions) : '—'}</td> : null}
              {gaOn ? <td className="mkt-num">{percent(row.conversionRate)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

export default MarketingROI;
