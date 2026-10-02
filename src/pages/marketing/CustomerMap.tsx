import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { REPORT_START } from '../reportRange';
import CompetitorMap from './CompetitorMap';
import {
  CHANNEL_LABELS,
  COLOR_B2B,
  COLOR_B2C,
  DEFAULT_CENTRE,
  DEFAULT_ZOOM,
  PRECISION_NOTE,
  TILE_ATTRIBUTION,
  TILE_URL,
  dayLabel,
  escapeHtml,
  grouped,
  iso,
  money,
  ordersOn,
  radiusFor,
  revenueOn,
  shortMoney,
  weeksAgo,
  type Area,
  type Channel,
  type LocateResult,
  type OdooSource,
  type Point,
  type Tally,
  type Unlocated,
} from './mapShared';

// Customer Map — where the orders actually come from, and who else is there.
//
// Every other report on this dashboard is about time or about money. This one
// is about place, and it is the only screen that can answer the questions a
// delivery business runs on: which neighbourhoods are worth a flyer drop,
// where a pop-up would already have customers within walking distance, which
// direction the Saturday run should go, and whether the wholesale accounts
// sit anywhere near the weekend ones.
//
// TWO VIEWS, ONE RANGE. The mode switch at the top is the biggest control on
// the screen, because the two views answer two different questions and one
// map showing both at once would answer neither:
//   Our customers  this file. Where our orders come from.
//   Competitors    CompetitorMap.tsx. Who else is selling smoked meat, and
//                  how close they are to the neighbourhoods above.
// The date range is owned here and handed down, so switching view never
// quietly changes the window — a competitor “within 3 km of eleven orders”
// is within 3 km of the same eleven orders the other view was just showing.
//
// The map is a proportional-symbol map, not a heatmap. A heatmap of forty
// orders is a picture of a blur; a circle per address, sized by how many
// orders came from it, is a picture of the actual customers — and it can be
// clicked, which a blur cannot. Circles are sized by AREA (radius scales with
// the square root of the count), because a radius scaled linearly makes four
// orders look sixteen times as big as one.
//
// Two ways of grouping the same orders, and both are needed:
//   Addresses  one circle per address. This is the honest picture — it shows
//              the spread, the outliers, and the streets that come up twice.
//   Areas      one circle per neighbourhood. This is the picture you plan
//              from, because “eleven orders in HSR Layout” is an action and
//              eleven separate pins are not.
//
// PRECISION IS DRAWN, NOT HIDDEN. Bengaluru addresses are landmarks and
// apartment names as often as they are streets, so a good share of them
// cannot be found to the rooftop. Rather than quietly place those at the
// middle of a PIN code and let them read as exact, a circle whose position is
// only locality- or PIN-code-accurate is drawn hollow with a dashed edge and
// says so on its tooltip. What can be fixed by hand is offered as a pin drop.
//
// Backend: server/marketing/customerGeography.js for the counting rules,
// server/marketing/competitors.js for the roster behind the other view, and
// server/core/geocode.js for the one that matters most — an address is sent
// to a geocoder at most once, ever, and only when somebody presses the button
// on this screen.

type View = 'addresses' | 'areas';

// Which of the two views is on screen. Held here rather than in a parent
// because the range controls sit above the switch and belong to both.
type Mode = 'customers' | 'competitors';

type Report = {
  range: { from: string; to: string; days: number };
  sources: {
    odoo: OdooSource;
    geocoder: { provider: string; cached: number };
  };
  totals: Tally & {
    customers: number;
    areas: number;
    addresses: number;
    located: Tally & { customers: number; addresses: number };
    unlocated: { addresses: number; orders: number; pending: number; notFound: number };
    noAddress: { customers: number; orders: number };
  };
  points: Point[];
  areas: Area[];
  unlocated: Unlocated[];
  noAddress: (Tally & { customer: string })[];
};

const MODE_LABELS: Record<Mode, string> = {
  customers: 'Our customers',
  competitors: 'Competitors',
};

const CustomerMap = () => {
  const [from, setFrom] = useState(REPORT_START);
  const [to, setTo] = useState(iso(new Date()));
  const [mode, setMode] = useState<Mode>('customers');
  const [channel, setChannel] = useState<Channel>('both');
  const [view, setView] = useState<View>('addresses');

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState('');

  // The address currently waiting for a pin, and the point the user last
  // clicked for it. Dropping a pin is a two-step act on purpose — pick the
  // address, then click the map — because a one-click version would mean
  // every stray click on the map moved somebody's house.
  const [pinning, setPinning] = useState<Unlocated | null>(null);
  const [pinAt, setPinAt] = useState<{ lat: number; lng: number } | null>(null);
  const [pinNote, setPinNote] = useState('');

  const mapRef = useRef<L.Map | null>(null);
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const pinMarkerRef = useRef<L.Marker | L.CircleMarker | null>(null);
  // Read inside the map's click handler, which is bound once — a state value
  // captured there would be the one from the render that bound it.
  const pinningRef = useRef<Unlocated | null>(null);
  pinningRef.current = pinning;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/marketing/customer-map?from=${from}&to=${to}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the customer map.');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  // Only while this view is the one on screen. The competitor view builds its
  // own report — which carries our side, computed by the same code — so
  // loading this one behind it would be a second Odoo round trip for figures
  // nobody is looking at.
  useEffect(() => {
    if (mode !== 'customers') return;
    load();
  }, [load, mode]);

  const preset = (weeks: number) => {
    setFrom(weeksAgo(weeks - 1));
    setTo(iso(new Date()));
  };

  // ---- What is actually drawn --------------------------------------------
  // Filtering happens here rather than on the server: the report carries both
  // sides in full, so switching between them is instant and no half of the
  // screen can be showing a side the other half is not.
  const points = useMemo(
    () => (report ? report.points.filter((point) => ordersOn(point, channel) > 0) : []),
    [report, channel],
  );
  const areas = useMemo(
    () =>
      report
        ? report.areas
            .filter((area) => ordersOn(area, channel) > 0)
            .sort((a, b) => ordersOn(b, channel) - ordersOn(a, channel) || revenueOn(b, channel) - revenueOn(a, channel))
        : [],
    [report, channel],
  );
  const unlocated = useMemo(
    () => (report ? report.unlocated.filter((row) => ordersOn(row, channel) > 0) : []),
    [report, channel],
  );

  const drawn = view === 'areas' ? areas : points;
  const busiest = drawn.reduce((max, row) => Math.max(max, ordersOn(row, channel)), 0);

  const shownOrders = drawn.reduce((sum, row) => sum + ordersOn(row, channel), 0);
  const shownRevenue = drawn.reduce((sum, row) => sum + revenueOn(row, channel), 0);
  const shownCustomers = areas.reduce((sum, area) => sum + area.customers, 0);

  // ---- The map ------------------------------------------------------------

  // Depends on `mode` because this view's map div only exists while this view
  // is rendered: leaving for the competitors unmounts it, and Leaflet holding
  // on to a detached element is a map that never draws again.
  useEffect(() => {
    if (mode !== 'customers') return undefined;
    if (mapRef.current || !mapElRef.current) return undefined;
    const map = L.map(mapElRef.current, { center: DEFAULT_CENTRE, zoom: DEFAULT_ZOOM, scrollWheelZoom: true });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (!pinningRef.current) return;
      setPinAt({ lat: event.latlng.lat, lng: event.latlng.lng });
    });
    mapRef.current = map;
    return () => {
      // Cancel any pan or zoom still animating. Leaving for the competitors
      // tears this map down, and a fitBounds part-way through its animation
      // wakes up on the next frame to find its container gone — Leaflet then
      // throws reading _leaflet_pos off nothing.
      map.stop();
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, [mode]);

  // Redraw the circles whenever the data, the side or the view changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    drawn.forEach((row) => {
      const orders = ordersOn(row, channel);
      const isArea = view === 'areas';
      const point = row as Point;
      const area = row as Area;
      const b2b = channel === 'B2B' || (channel === 'both' && row.b2bOrders > row.b2cOrders);
      const colour = b2b ? COLOR_B2B : COLOR_B2C;
      // Area circles are always a real place; an address circle is only as
      // precise as the lookup that placed it, and a dashed hollow ring is the
      // difference between "here" and "somewhere around here".
      const vague = !isArea && point.precision !== 'address';

      const marker = L.circleMarker([row.latitude, row.longitude], {
        radius: radiusFor(orders, busiest),
        color: colour,
        // A 2px ring in the surface colour keeps overlapping circles legible
        // as separate marks rather than one blob.
        weight: vague ? 1.5 : 2,
        dashArray: vague ? '3 3' : undefined,
        fillColor: colour,
        fillOpacity: vague ? 0.08 : 0.45,
        opacity: 1,
      });

      const heading = isArea ? area.name : point.names.join(', ') + (point.otherNames ? ` +${point.otherNames}` : '');
      const lines = isArea
        ? [
            `${grouped.format(orders)} order${orders === 1 ? '' : 's'} · ${money(revenueOn(area, channel))}`,
            `${grouped.format(area.customers)} customer${area.customers === 1 ? '' : 's'}, ${grouped.format(area.repeatCustomers)} of them repeat`,
            `${grouped.format(area.addresses)} address${area.addresses === 1 ? '' : 'es'}`,
          ]
        : [
            `${grouped.format(orders)} order${orders === 1 ? '' : 's'} · ${money(revenueOn(point, channel))}`,
            point.address,
            `Last ordered ${dayLabel(point.lastOrder)}`,
            PRECISION_NOTE[point.precision],
            point.provider === 'manual' ? 'Pinned by hand.' : '',
          ];

      marker.bindTooltip(
        `<strong>${escapeHtml(heading || 'Customer')}</strong>${lines
          .filter(Boolean)
          .map((line) => `<br/><span>${escapeHtml(line)}</span>`)
          .join('')}`,
        { direction: 'top', className: 'cmap-tip' },
      );
      layer.addLayer(marker);
    });
  }, [drawn, channel, view, busiest, mode]);

  // Fit the view to what is drawn — but only when the SET of places changes,
  // not on every render. Refitting on a re-render would yank the map back
  // from wherever the user had panned to, mid-read.
  const fitKey = drawn.map((row) => `${row.latitude},${row.longitude}`).join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!drawn.length) {
      map.setView(DEFAULT_CENTRE, DEFAULT_ZOOM);
      return;
    }
    map.fitBounds(
      L.latLngBounds(drawn.map((row) => [row.latitude, row.longitude] as [number, number])),
      { padding: [40, 40], maxZoom: 15 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, mode]);

  // The provisional pin, shown while somebody is placing one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (pinMarkerRef.current) {
      pinMarkerRef.current.remove();
      pinMarkerRef.current = null;
    }
    if (!pinAt) return;
    pinMarkerRef.current = L.circleMarker([pinAt.lat, pinAt.lng], {
      radius: 10,
      color: '#241a14',
      weight: 2,
      fillColor: '#ffffff',
      fillOpacity: 0.9,
    })
      .addTo(map)
      .bindTooltip('The pin goes here', { permanent: true, direction: 'top' });
  }, [pinAt, mode]);

  const flyTo = (lat: number, lon: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo([lat, lon], Math.max(map.getZoom(), 14), { duration: 0.6 });
    mapElRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // ---- The two write actions ---------------------------------------------

  const locate = async () => {
    setLocating(true);
    setLocateNote('');
    try {
      const resp = await fetch('/api/marketing/customer-map/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const data: LocateResult & { error?: string } = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'The lookup failed.');
      const parts = [`Looked up ${data.attempted}`, `${data.located} placed`, `${data.notFound} not found`];
      if (data.remaining > 0) parts.push(`${data.remaining} still to do — press again`);
      setLocateNote(`${parts.join(' · ')}${data.error ? ` · ${data.error}` : ''}`);
      await load();
    } catch (err) {
      setLocateNote(err instanceof Error ? err.message : String(err));
    } finally {
      setLocating(false);
    }
  };

  const savePin = async () => {
    if (!pinning || !pinAt) return;
    setPinNote('');
    try {
      const resp = await fetch('/api/marketing/customer-map/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: pinning.address,
          latitude: pinAt.lat,
          longitude: pinAt.lng,
          locality: pinning.city,
          postcode: pinning.zip,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not save the pin.');
      setPinning(null);
      setPinAt(null);
      await load();
    } catch (err) {
      setPinNote(err instanceof Error ? err.message : String(err));
    }
  };

  const odoo = report?.sources.odoo;
  const totals = report?.totals;
  const locatedPct = totals && totals.orders ? Math.round((totals.located.orders / totals.orders) * 100) : 0;

  return (
    <div className="mkt-roi">
      <div className="mkt-head">
        <h3>Customer Map</h3>
        <p>
          {mode === 'customers'
            ? 'Where the orders come from. One circle per address — or per neighbourhood — sized by how many orders came from it. Addresses are looked up once and remembered; nothing is sent to the geocoder unless you press the button.'
            : 'Who else is selling smoked meat, and how close they are to the neighbourhoods our orders come from. A hand-kept list, not a live feed — every rating is a snapshot of the day somebody looked it up.'}
        </p>
      </div>

      {/* The biggest control on the screen, because it changes what the map
          is OF rather than how it is drawn. Two views, one date range: the
          range below applies to both. */}
      <div className="cmap-modes" role="group" aria-label="Which map">
        {(['customers', 'competitors'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`cmap-mode${mode === option ? ' is-active' : ''}`}
            onClick={() => setMode(option)}
            aria-pressed={mode === option}
          >
            <span className="cmap-mode-icon" aria-hidden="true">
              {option === 'customers' ? '📍' : '🍖'}
            </span>
            <span className="cmap-mode-body">
              <span className="cmap-mode-label">{MODE_LABELS[option]}</span>
              <span className="cmap-mode-sub">
                {option === 'customers' ? 'Where our orders come from' : 'Who else is already there'}
              </span>
            </span>
          </button>
        ))}
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

        {mode === 'customers' ? (
        <div className="cmap-toggles">
          <div className="mkt-tabs fin-side-tabs" role="group" aria-label="Side of the business">
            {(['both', 'B2C', 'B2B'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`mkt-tab${channel === option ? ' is-active' : ''}`}
                onClick={() => setChannel(option)}
                aria-pressed={channel === option}
              >
                {CHANNEL_LABELS[option]}
              </button>
            ))}
          </div>
          <div className="mkt-tabs" role="group" aria-label="What the circles are">
            {(['addresses', 'areas'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`mkt-tab${view === option ? ' is-active' : ''}`}
                onClick={() => setView(option)}
                aria-pressed={view === option}
              >
                {option === 'addresses' ? 'By address' : 'By area'}
              </button>
            ))}
          </div>
        </div>
        ) : null}
      </div>

      {mode === 'competitors' ? (
        <CompetitorMap from={from} to={to} />
      ) : (
        <>
      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}

      {odoo && !odoo.configured ? (
        <div className="mkt-alert mkt-alert-warn">
          Odoo is not configured, so there are no orders to place. Set <code>ODOO_URL</code>, <code>ODOO_DB</code>,{' '}
          <code>ODOO_USERNAME</code> and <code>ODOO_API_KEY</code> in <code>.env</code> and restart the server.
        </div>
      ) : null}
      {odoo && odoo.configured && odoo.error ? (
        <div className="mkt-alert mkt-alert-error">Odoo said: {odoo.error}</div>
      ) : null}

      <div className="mkt-tiles">
        <div className="mkt-tile">
          <span className="mkt-tile-label">Customers</span>
          <span className="mkt-tile-value">{grouped.format(totals ? totals.customers : 0)}</span>
          <span className="mkt-tile-sub">
            {channel === 'both' ? 'Distinct accounts in the range' : `${shownCustomers} on the map right now`}
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Orders on the map</span>
          <span className="mkt-tile-value">{grouped.format(shownOrders)}</span>
          <span className="mkt-tile-sub">
            of {grouped.format(totals ? ordersOn(totals, channel) : 0)} in the range · {locatedPct}% placed
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Revenue shown</span>
          <span className="mkt-tile-value">{shortMoney(shownRevenue)}</span>
          <span className="mkt-tile-sub">From the circles currently drawn</span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Neighbourhoods</span>
          <span className="mkt-tile-value">{grouped.format(areas.length)}</span>
          <span className="mkt-tile-sub">
            {areas.length ? `Busiest: ${areas[0].name}` : 'Nothing placed yet'}
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Not on the map</span>
          <span className="mkt-tile-value">{grouped.format(totals ? totals.unlocated.addresses : 0)}</span>
          <span className="mkt-tile-sub">
            {totals ? `${totals.unlocated.pending} never looked up · ${totals.unlocated.notFound} not found` : '—'}
          </span>
        </div>
      </div>

      <div className="mkt-panel">
        <div className="mkt-panel-head">
          <div>
            <h4>{view === 'areas' ? 'Orders by neighbourhood' : 'Orders by address'}</h4>
            <span className="mkt-panel-hint">
              {loading ? 'Loading…' : `${dayLabel(from)} – ${dayLabel(to)}. Circle area is orders, not radius.`}
            </span>
          </div>
          <div className="mkt-legend">
            <span>
              <i className="mkt-swatch" style={{ background: COLOR_B2C }} /> B2C weekend
            </span>
            <span>
              <i className="mkt-swatch" style={{ background: COLOR_B2B }} /> B2B wholesale
            </span>
            <span>
              <i className="cmap-swatch-vague" /> Approximate — area only
            </span>
          </div>
        </div>

        {pinning ? (
          <div className="mkt-alert mkt-alert-warn cmap-pin-bar">
            <div>
              <strong>Click the map</strong> where “{pinning.address}” is.
              {pinAt ? ` Pin at ${pinAt.lat.toFixed(5)}, ${pinAt.lng.toFixed(5)}.` : ' Nothing picked yet.'}
              {pinNote ? ` ${pinNote}` : ''}
            </div>
            <div className="cmap-pin-actions">
              <button type="button" className="mkt-primary" disabled={!pinAt} onClick={savePin}>
                Save this pin
              </button>
              <button
                type="button"
                className="mkt-chip"
                onClick={() => {
                  setPinning(null);
                  setPinAt(null);
                  setPinNote('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div ref={mapElRef} className={`cmap-map${pinning ? ' is-pinning' : ''}`} />

        {!drawn.length && !loading ? (
          <p className="mkt-panel-hint">
            Nothing to draw yet. {totals && totals.unlocated.pending
              ? `${totals.unlocated.pending} address${totals.unlocated.pending === 1 ? '' : 'es'} in this range have never been looked up — use “Put these on the map” below.`
              : 'No confirmed orders with an address in this range.'}
          </p>
        ) : null}
      </div>

      <div className="mkt-panel">
        <div className="mkt-panel-head">
          <div>
            <h4>Neighbourhoods, busiest first</h4>
            <span className="mkt-panel-hint">
              The same figures as the map, as a table. Click a row to fly to it. “Repeat” is a customer with more than
              one order in the range.
            </span>
          </div>
        </div>
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Neighbourhood</th>
                <th className="mkt-num">Orders</th>
                <th className="mkt-num">Share</th>
                <th className="mkt-num">Customers</th>
                <th className="mkt-num">Repeat</th>
                <th className="mkt-num">Addresses</th>
                <th className="mkt-num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area.key} className="cmap-row" onClick={() => flyTo(area.latitude, area.longitude)}>
                  <td>
                    <strong>{area.locality || `PIN ${area.postcode}` || 'Area unknown'}</strong>
                    {area.postcode && area.locality ? <span className="mkt-muted"> · {area.postcode}</span> : null}
                  </td>
                  <td className="mkt-num">{grouped.format(ordersOn(area, channel))}</td>
                  <td className="mkt-num">{area.sharePct}%</td>
                  <td className="mkt-num">{grouped.format(area.customers)}</td>
                  <td className="mkt-num">{grouped.format(area.repeatCustomers)}</td>
                  <td className="mkt-num">{grouped.format(area.addresses)}</td>
                  <td className="mkt-num">{money(revenueOn(area, channel))}</td>
                </tr>
              ))}
              {!areas.length ? (
                <tr>
                  <td colSpan={7} className="mkt-muted">
                    No located orders in this range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mkt-panel">
        <div className="mkt-panel-head">
          <div>
            <h4>Not on the map yet</h4>
            <span className="mkt-panel-hint">
              Addresses from orders in this range that have no point. “Never looked up” is one press away; “not found”
              means the geocoder had nothing for it, which for an apartment name or a landmark is normal — drop a pin
              instead. Each address is sent to OpenStreetMap once and the answer is kept.
            </span>
          </div>
          <button
            type="button"
            className="mkt-primary"
            disabled={locating || !report || !report.totals.unlocated.pending}
            onClick={locate}
          >
            {locating ? 'Looking up…' : `Put these on the map (${report ? report.totals.unlocated.pending : 0})`}
          </button>
        </div>
        {locateNote ? <p className="mkt-panel-hint">{locateNote}</p> : null}
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>State</th>
                <th className="mkt-num">Orders</th>
                <th className="mkt-num">Revenue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {unlocated.map((row) => (
                <tr key={row.address}>
                  <td>{row.address}</td>
                  <td>
                    {row.status === 'pending' ? (
                      <span className="mkt-muted">Never looked up</span>
                    ) : (
                      <span className="mkt-bad">Not found</span>
                    )}
                  </td>
                  <td className="mkt-num">{grouped.format(ordersOn(row, channel))}</td>
                  <td className="mkt-num">{money(revenueOn(row, channel))}</td>
                  <td>
                    <button
                      type="button"
                      className="mkt-chip"
                      onClick={() => {
                        setPinning(row);
                        setPinAt(null);
                        setPinNote('');
                        mapElRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}
                    >
                      Drop a pin
                    </button>
                  </td>
                </tr>
              ))}
              {!unlocated.length ? (
                <tr>
                  <td colSpan={5} className="mkt-muted">
                    Every address in this range is on the map.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {report && report.noAddress.length ? (
        <div className="mkt-panel">
          <div className="mkt-panel-head">
            <div>
              <h4>No address on file</h4>
              <span className="mkt-panel-hint">
                Orders whose customer has no address in Odoo at all — a counter pickup, a pop-up sale, or a contact
                somebody never filled in. Nothing here can be geocoded; the fix is in Odoo.
              </span>
            </div>
          </div>
          <div className="mkt-table-wrap">
            <table className="mkt-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="mkt-num">Orders</th>
                  <th className="mkt-num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {report.noAddress.map((row) => (
                  <tr key={row.customer}>
                    <td>{row.customer}</td>
                    <td className="mkt-num">{grouped.format(row.orders)}</td>
                    <td className="mkt-num">{money(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
        </>
      )}
    </div>
  );
};

export default CustomerMap;
