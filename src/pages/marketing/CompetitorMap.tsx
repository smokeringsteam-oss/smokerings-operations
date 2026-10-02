import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  DEFAULT_CENTRE,
  DEFAULT_ZOOM,
  PRECISION_NOTE,
  TILE_ATTRIBUTION,
  TILE_URL,
  dayLabel,
  escapeHtml,
  grouped,
  km,
  money,
  radiusFor,
  shortMoney,
  type Area,
  type LocateResult,
  type OdooSource,
  type Point,
  type Precision,
} from './mapShared';

// Competitors — the other view of the Customer Map.
//
// The customer view answers "where are our orders coming from". This one
// answers the question that immediately follows it and that nothing on this
// dashboard could answer before: who is ALREADY there. Eleven orders in a
// neighbourhood with no rival within five kilometres and eleven orders in a
// neighbourhood with a 4.7-star brisket house on the same road are two very
// different facts, and the customer map draws them identically.
//
// WHAT IS FIGURE AND WHAT IS GROUND. This is the one screen where our own
// orders are not the subject. They are drawn underneath, in a neutral grey,
// deliberately quiet — they are the backdrop that makes a competitor's
// position mean something. Drawing them in the ember/purple the rest of the
// dashboard uses would put two loud things on one map and make neither
// readable, and colouring them by side of the business would invite a
// comparison ("their branch vs our wholesale") that the data cannot support.
//
// WHY THE RATING IS THE MARK. Seven competitors is few enough that the map
// can print the fact rather than encode it: each one is a chip with its
// Google rating in it. A colour ramp would need a legend, and a legend for
// seven points is a worse trade than seven numbers you can just read. A
// competitor with no rating recorded gets a grey chip with a dash, because
// "not recorded" and "badly rated" are opposite facts and must not look
// alike — see BOB'Z in server/marketing/competitors.js.
//
// THE REACH RING is drawn for one competitor at a time, never all of them.
// Seven overlapping three-kilometre discs over Bengaluru is a grey smear;
// one, on the competitor you just clicked, is the actual answer to "how much
// of ours is inside this?" — and the tile beside it counts it.
//
// A HAND-KEPT LIST, SAID OUT LOUD. The roster and its ratings are research
// somebody did on a day, not a feed. The date is on the screen next to the
// ratings rather than in a comment, because a competitor list that ages
// silently gets quoted in a decision a year later as though it were live.
//
// Backend: server/marketing/competitors.js. The points come from the same
// geocode cache as everything else on this screen — one lookup per address,
// ever, and only when somebody presses the button.

// One colour for all of them. See the note above on why the rating is printed
// rather than encoded: this hue only has to be clearly Not Ours against the
// warm grey backdrop and the OpenStreetMap tiles, and to carry white text.
// #0b4f6c on white is 8.9:1; white on #0b4f6c is the same, so the chip's
// number is legible at 12px.
const COLOR_RIVAL = '#0b4f6c';
// A competitor whose rating was never recorded. Warm grey rather than a pale
// version of the blue, so it reads as "no data" and not as "low score".
const COLOR_RIVAL_UNRATED = '#6f6259';
// Our own orders, as ground. Neutral on purpose — no channel is being claimed
// here, so no channel colour is used.
const COLOR_OURS = '#9a8c80';

// The radii the screen offers, in kilometres. Three is the default because it
// is roughly the reach a Bengaluru delivery kitchen and its customers share;
// one is "the same street", ten is "the same side of the city".
const RADIUS_OPTIONS = [1, 2, 3, 5, 10];

type Status = 'ok' | 'pending' | 'not_found';

type Competitor = {
  id: string;
  name: string;
  brand: string;
  category: string;
  area: string;
  address: string;
  street: string;
  city: string;
  rating: number | null;
  reviews: number | null;
  note: string;
  latitude: number | null;
  longitude: number | null;
  precision: Precision | null;
  provider: string;
  status: Status;
  locality: string;
  postcode: string;
  distanceFromKitchenKm: number | null;
  ordersNearby: number;
  revenueNearby: number;
  addressesNearby: number;
  nearestArea: string;
  nearestAreaKm: number | null;
};

type Contested = {
  key: string;
  name: string;
  locality: string;
  postcode: string;
  latitude: number;
  longitude: number;
  orders: number;
  revenue: number;
  customers: number;
  sharePct: number;
  competitor: string;
  competitorId: string;
  competitorRating: number | null;
  distanceKm: number | null;
  withinRadius: boolean;
};

type Category = { id: string; label: string; blurb: string };

type Report = {
  range: { from: string; to: string; days: number };
  sources: { odoo: OdooSource; geocoder: { provider: string; cached: number } };
  ours: { points: Point[]; areas: Area[]; totals: { orders: number } };
  radiusKm: number;
  researchedOn: string;
  categories: Category[];
  competitors: Competitor[];
  unplaced: Competitor[];
  contested: Contested[];
  totals: {
    listed: number;
    placed: number;
    unplaced: number;
    pending: number;
    notFound: number;
    brands: number;
    ordersInReach: number;
    areasContested: number;
    avgRating: number | null;
  };
};

const ratingLabel = (rating: number | null) => (rating === null ? '—' : rating.toFixed(1));

// Two competitors on the same service road come back from the geocoder at the
// same neighbourhood centroid — Porkey's and BOB'Z are both "Service Road,
// Kammanahalli" and land on one point to five decimal places. Two chips at
// one point is one chip: the second is simply not there.
//
// So a coincident group is fanned around a small circle. Forty-five metres,
// which is well inside the slop a locality-accurate point already carries and
// is stated on the tooltip — nothing is being claimed here that the point was
// not already admitting. The fan is deterministic (index order, not random),
// so a competitor does not move between renders.
const FAN_METRES = 45;
const METRES_PER_DEGREE = 111320;

type Drawn = Competitor & { drawLat: number; drawLng: number; fanned: boolean };

const fanCoincident = (rows: Competitor[]): Drawn[] => {
  const groups = new Map<string, Competitor[]>();
  for (const row of rows) {
    if (row.latitude === null || row.longitude === null) continue;
    const key = `${row.latitude.toFixed(5)},${row.longitude.toFixed(5)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const drawn: Drawn[] = [];
  groups.forEach((bucket) => {
    bucket.forEach((row, index) => {
      const lat = row.latitude as number;
      const lng = row.longitude as number;
      if (bucket.length === 1) {
        drawn.push({ ...row, drawLat: lat, drawLng: lng, fanned: false });
        return;
      }
      const angle = (2 * Math.PI * index) / bucket.length;
      const dLat = (FAN_METRES * Math.cos(angle)) / METRES_PER_DEGREE;
      const dLng = (FAN_METRES * Math.sin(angle)) / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
      drawn.push({ ...row, drawLat: lat + dLat, drawLng: lng + dLng, fanned: true });
    });
  });
  return drawn;
};

const CompetitorMap = ({ from, to }: { from: string; to: string }) => {
  const [radiusKm, setRadiusKm] = useState(3);
  const [showOurs, setShowOurs] = useState(true);
  // The competitor whose reach ring is drawn. One at a time — see the note at
  // the top on why every ring at once is a smear rather than a map.
  const [selected, setSelected] = useState('');

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState('');

  // The same two-step pin as the customer view: pick the competitor, then
  // click the map. A restaurant that opened last quarter is exactly the kind
  // of address a geocoder has never heard of.
  const [pinning, setPinning] = useState<Competitor | null>(null);
  const [pinAt, setPinAt] = useState<{ lat: number; lng: number } | null>(null);
  const [pinNote, setPinNote] = useState('');

  const mapRef = useRef<L.Map | null>(null);
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const oursRef = useRef<L.LayerGroup | null>(null);
  const rivalsRef = useRef<L.LayerGroup | null>(null);
  const reachRef = useRef<L.Circle | null>(null);
  const pinMarkerRef = useRef<L.Marker | L.CircleMarker | null>(null);
  // Read inside the map's click handler, which is bound once — a state value
  // captured there would be the one from the render that bound it.
  const pinningRef = useRef<Competitor | null>(null);
  pinningRef.current = pinning;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/marketing/competitors?from=${from}&to=${to}&radius=${radiusKm}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not build the competitor map.');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, radiusKm]);

  useEffect(() => {
    load();
  }, [load]);

  const competitors = report ? report.competitors : [];
  const unplaced = report ? report.unplaced : [];
  const contested = report ? report.contested : [];
  const ourPoints = useMemo(() => (report ? report.ours.points : []), [report]);
  const busiest = ourPoints.reduce((max, point) => Math.max(max, point.orders), 0);

  // The one worth being told about first: the best-rated competitor that has
  // any of our business inside its radius. A 4.7 on the far side of the city
  // is a competitor; a 4.7 next to our busiest street is a problem.
  const toughest = useMemo(
    () =>
      competitors
        .filter((row) => row.ordersNearby > 0 && row.rating !== null)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))[0] || null,
    [competitors],
  );

  // ---- The map ------------------------------------------------------------

  useEffect(() => {
    if (mapRef.current || !mapElRef.current) return undefined;
    const map = L.map(mapElRef.current, { center: DEFAULT_CENTRE, zoom: DEFAULT_ZOOM, scrollWheelZoom: true });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
    // Ours first so it sits under theirs: this view's subject is the
    // competitors, and a customer circle drawn over a rival chip would hide
    // the thing the screen is about.
    oursRef.current = L.layerGroup().addTo(map);
    rivalsRef.current = L.layerGroup().addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      if (!pinningRef.current) return;
      setPinAt({ lat: event.latlng.lat, lng: event.latlng.lng });
    });
    mapRef.current = map;
    return () => {
      // See the same call in CustomerMap: a fitBounds still animating when
      // the view is torn down throws on the next frame.
      map.stop();
      map.remove();
      mapRef.current = null;
      oursRef.current = null;
      rivalsRef.current = null;
      reachRef.current = null;
    };
  }, []);

  // Our orders, as ground.
  useEffect(() => {
    const layer = oursRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showOurs) return;
    ourPoints.forEach((point) => {
      const vague = point.precision !== 'address';
      L.circleMarker([point.latitude, point.longitude], {
        radius: radiusFor(point.orders, busiest),
        color: COLOR_OURS,
        // The customer view drops an approximate circle to a 6% fill because
        // there it is the exception, sitting among solid ones that make the
        // difference obvious. Here almost every point of ours is
        // locality-accurate — Bengaluru addresses being what they are — so
        // the same treatment would erase the entire backdrop against the map
        // tiles, which is exactly what it did the first time this was drawn.
        // The dashed edge still carries the precision; the fill stays legible.
        weight: 1.5,
        dashArray: vague ? '3 3' : undefined,
        fillColor: COLOR_OURS,
        fillOpacity: vague ? 0.22 : 0.38,
        opacity: 0.95,
      })
        .bindTooltip(
          `<strong>${escapeHtml(point.area || 'Our customer')}</strong>` +
            `<br/><span>${grouped.format(point.orders)} order${point.orders === 1 ? '' : 's'} · ${money(point.revenue)}</span>` +
            `<br/><span>${escapeHtml(point.address)}</span>` +
            `<br/><span>Last ordered ${dayLabel(point.lastOrder)}</span>`,
          { direction: 'top', className: 'cmap-tip' },
        )
        .addTo(layer);
    });
  }, [ourPoints, busiest, showOurs]);

  const drawnRivals = useMemo(() => fanCoincident(competitors), [competitors]);

  // Them, as figure.
  useEffect(() => {
    const layer = rivalsRef.current;
    if (!layer) return;
    layer.clearLayers();
    drawnRivals.forEach((rival) => {
      const unrated = rival.rating === null;
      const vague = rival.precision !== 'address';
      const marker = L.marker([rival.drawLat, rival.drawLng], {
        icon: L.divIcon({
          className: 'cmap-rival-icon',
          html:
            `<span class="cmap-rival-chip${unrated ? ' is-unrated' : ''}${vague ? ' is-vague' : ''}"` +
            ` style="--chip: ${unrated ? COLOR_RIVAL_UNRATED : COLOR_RIVAL}">${escapeHtml(ratingLabel(rival.rating))}</span>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        // Above our circles whatever the draw order, because this view is
        // about them.
        zIndexOffset: 500,
      });

      const lines = [
        rival.rating === null
          ? 'No rating recorded'
          : `${rival.rating.toFixed(1)} on Google${rival.reviews ? ` from ${grouped.format(rival.reviews)} reviews` : ''}`,
        rival.area,
        rival.ordersNearby
          ? `${grouped.format(rival.ordersNearby)} of our orders within ${radiusKm} km · ${money(rival.revenueNearby)}`
          : `None of our orders within ${radiusKm} km`,
        rival.nearestArea ? `Nearest of ours: ${rival.nearestArea}, ${km(rival.nearestAreaKm)}` : '',
        rival.distanceFromKitchenKm === null ? '' : `${km(rival.distanceFromKitchenKm)} from our kitchen`,
        vague && rival.precision ? PRECISION_NOTE[rival.precision] : '',
        rival.fanned ? 'Shares a point with another competitor — nudged a few metres so both are visible.' : '',
        rival.provider === 'manual' ? 'Pinned by hand.' : '',
        rival.note,
      ];

      marker.bindTooltip(
        `<strong>${escapeHtml(rival.name)}</strong>${lines
          .filter(Boolean)
          .map((line) => `<br/><span>${escapeHtml(line)}</span>`)
          .join('')}`,
        { direction: 'top', className: 'cmap-tip', offset: [0, -14] },
      );
      marker.on('click', () => setSelected((current) => (current === rival.id ? '' : rival.id)));
      layer.addLayer(marker);
    });
  }, [drawnRivals, radiusKm]);

  // The reach ring, for the one that is selected.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (reachRef.current) {
      reachRef.current.remove();
      reachRef.current = null;
    }
    const rival = competitors.find((row) => row.id === selected);
    if (!rival || rival.latitude === null || rival.longitude === null) return;
    reachRef.current = L.circle([rival.latitude, rival.longitude], {
      radius: radiusKm * 1000,
      color: COLOR_RIVAL,
      weight: 1.5,
      dashArray: '5 5',
      fillColor: COLOR_RIVAL,
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
  }, [selected, competitors, radiusKm]);

  // Fit to everything on screen — theirs and ours — but only when the SET of
  // places changes, so a re-render never yanks the map back mid-read.
  const fitKey = competitors
    .map((row) => `${row.latitude},${row.longitude}`)
    .concat(showOurs ? ourPoints.map((point) => `${point.latitude},${point.longitude}`) : [])
    .join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds: [number, number][] = [];
    competitors.forEach((row) => {
      if (row.latitude !== null && row.longitude !== null) bounds.push([row.latitude, row.longitude]);
    });
    if (showOurs) ourPoints.forEach((point) => bounds.push([point.latitude, point.longitude]));
    if (!bounds.length) {
      map.setView(DEFAULT_CENTRE, DEFAULT_ZOOM);
      return;
    }
    map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

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
  }, [pinAt]);

  const flyTo = (lat: number | null, lon: number | null) => {
    const map = mapRef.current;
    if (!map || lat === null || lon === null) return;
    map.flyTo([lat, lon], Math.max(map.getZoom(), 13), { duration: 0.6 });
    mapElRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const pick = (rival: Competitor) => {
    setSelected((current) => (current === rival.id ? '' : rival.id));
    flyTo(rival.latitude, rival.longitude);
  };

  // ---- The two write actions ---------------------------------------------

  const locate = async () => {
    setLocating(true);
    setLocateNote('');
    try {
      const resp = await fetch('/api/marketing/competitors/locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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

  // The same endpoint the customer view pins with, because it is the same
  // cache and the same rule: a hand-dropped pin is never overwritten by a
  // later lookup.
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
          locality: pinning.area,
          postcode: '',
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

  const totals = report ? report.totals : null;
  const ourOrders = report ? report.ours.totals.orders : 0;
  const reachPct = totals && ourOrders ? Math.round((totals.ordersInReach / ourOrders) * 100) : 0;

  return (
    <>
      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}

      {report && report.sources.odoo.configured && report.sources.odoo.error ? (
        <div className="mkt-alert mkt-alert-warn">
          Odoo said: {report.sources.odoo.error}. The competitors are still drawn — only our own orders underneath
          them are missing.
        </div>
      ) : null}

      <div className="cmap-rival-controls">
        <label className="cmap-radius">
          <span>Counts as “near” within</span>
          <select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))}>
            {RADIUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option} km
              </option>
            ))}
          </select>
        </label>
        <label className="cmap-check">
          <input type="checkbox" checked={showOurs} onChange={(event) => setShowOurs(event.target.checked)} />
          <span>Show our orders underneath</span>
        </label>
        {report ? (
          <span className="mkt-panel-hint cmap-asof">
            Roster and ratings checked by hand on {dayLabel(report.researchedOn)}
          </span>
        ) : null}
      </div>

      <div className="mkt-tiles">
        <div className="mkt-tile">
          <span className="mkt-tile-label">Competitors listed</span>
          <span className="mkt-tile-value">{grouped.format(totals ? totals.listed : 0)}</span>
          <span className="mkt-tile-sub">
            {totals
              ? `${totals.placed} on the map · ${totals.brands} brand${totals.brands === 1 ? '' : 's'}`
              : '—'}
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Our orders in their reach</span>
          <span className="mkt-tile-value">{grouped.format(totals ? totals.ordersInReach : 0)}</span>
          <span className="mkt-tile-sub">
            {reachPct}% of {grouped.format(ourOrders)} — within {radiusKm} km of at least one
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Neighbourhoods contested</span>
          <span className="mkt-tile-value">{grouped.format(totals ? totals.areasContested : 0)}</span>
          <span className="mkt-tile-sub">
            of {grouped.format(contested.length)} we sell into, with one inside {radiusKm} km
          </span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Their average rating</span>
          <span className="mkt-tile-value">{totals && totals.avgRating !== null ? totals.avgRating.toFixed(1) : '—'}</span>
          <span className="mkt-tile-sub">Across the ones with a rating recorded</span>
        </div>
        <div className="mkt-tile">
          <span className="mkt-tile-label">Closest to our business</span>
          <span className="mkt-tile-value cmap-tile-name">{toughest ? toughest.name : '—'}</span>
          <span className="mkt-tile-sub">
            {toughest
              ? `${toughest.rating?.toFixed(1)} · ${grouped.format(toughest.ordersNearby)} of our orders within ${radiusKm} km`
              : 'None of them has our orders in reach'}
          </span>
        </div>
      </div>

      <div className="mkt-panel">
        <div className="mkt-panel-head">
          <div>
            <h4>Who else is smoking meat</h4>
            <span className="mkt-panel-hint">
              {loading
                ? 'Loading…'
                : `${dayLabel(from)} – ${dayLabel(to)}. Each chip is a competitor, with its Google rating in it. Click one for its ${radiusKm} km reach.`}
            </span>
          </div>
          <div className="mkt-legend">
            <span>
              <i className="cmap-swatch-rival" style={{ background: COLOR_RIVAL }} /> Competitor
            </span>
            <span>
              <i className="cmap-swatch-rival" style={{ background: COLOR_RIVAL_UNRATED }} /> No rating recorded
            </span>
            <span>
              <i className="mkt-swatch" style={{ background: COLOR_OURS }} /> Our orders
            </span>
          </div>
        </div>

        {pinning ? (
          <div className="mkt-alert mkt-alert-warn cmap-pin-bar">
            <div>
              <strong>Click the map</strong> where “{pinning.name}” is — {pinning.area}.
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

        {report && report.categories.length ? (
          <p className="mkt-panel-hint cmap-cats">
            {report.categories.map((category) => (
              <span key={category.id}>
                <strong>{category.label}:</strong> {category.blurb}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="mkt-panel">
        <div className="mkt-panel-head">
          <div>
            <h4>The roster</h4>
            <span className="mkt-panel-hint">
              Sorted by how much of our business sits within {radiusKm} km of them — not by how good they are. Click
              a row to fly to it and draw its reach. Distances are straight-line, hence the “~”.
            </span>
          </div>
        </div>
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Competitor</th>
                <th>Area</th>
                <th className="mkt-num">Rating</th>
                <th className="mkt-num">Reviews</th>
                <th className="mkt-num">From kitchen</th>
                <th className="mkt-num">Our orders near</th>
                <th className="mkt-num">Revenue near</th>
                <th>Nearest area of ours</th>
              </tr>
            </thead>
            <tbody>
              {competitors.map((rival) => (
                <tr
                  key={rival.id}
                  className={`cmap-row${selected === rival.id ? ' is-selected' : ''}`}
                  onClick={() => pick(rival)}
                >
                  <td>
                    <strong>{rival.name}</strong>
                    {rival.provider === 'manual' ? <span className="mkt-muted"> · pinned</span> : null}
                    {rival.precision && rival.precision !== 'address' ? (
                      <span className="mkt-muted"> · approximate</span>
                    ) : null}
                    {rival.note ? <div className="mkt-muted cmap-note">{rival.note}</div> : null}
                  </td>
                  <td>{rival.area}</td>
                  <td className="mkt-num">{ratingLabel(rival.rating)}</td>
                  <td className="mkt-num">{rival.reviews === null ? '—' : grouped.format(rival.reviews)}</td>
                  <td className="mkt-num">{km(rival.distanceFromKitchenKm)}</td>
                  <td className="mkt-num">
                    {rival.ordersNearby ? grouped.format(rival.ordersNearby) : <span className="mkt-muted">0</span>}
                  </td>
                  <td className="mkt-num">{rival.revenueNearby ? shortMoney(rival.revenueNearby) : '—'}</td>
                  <td>
                    {rival.nearestArea ? (
                      <>
                        {rival.nearestArea} <span className="mkt-muted">{km(rival.nearestAreaKm)}</span>
                      </>
                    ) : (
                      <span className="mkt-muted">Nothing of ours placed yet</span>
                    )}
                  </td>
                </tr>
              ))}
              {!competitors.length ? (
                <tr>
                  <td colSpan={8} className="mkt-muted">
                    {unplaced.length
                      ? 'None of them is on the map yet — use “Put these on the map” below.'
                      : 'No competitors listed.'}
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
            <h4>Contested neighbourhoods</h4>
            <span className="mkt-panel-hint">
              Our own areas, busiest first, with whoever is nearest to each. A highlighted row has a competitor
              inside {radiusKm} km. This says they are close, which is a fact — it does not say they are taking
              anything, which nothing on this machine could tell you.
            </span>
          </div>
        </div>
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Our neighbourhood</th>
                <th className="mkt-num">Our orders</th>
                <th className="mkt-num">Share</th>
                <th className="mkt-num">Customers</th>
                <th>Nearest competitor</th>
                <th className="mkt-num">Their rating</th>
                <th className="mkt-num">Distance</th>
              </tr>
            </thead>
            <tbody>
              {contested.map((area) => (
                <tr
                  key={area.key}
                  className={`cmap-row${area.withinRadius ? ' is-contested' : ''}`}
                  onClick={() => flyTo(area.latitude, area.longitude)}
                >
                  <td>
                    <strong>{area.locality || (area.postcode ? `PIN ${area.postcode}` : 'Area unknown')}</strong>
                    {area.postcode && area.locality ? <span className="mkt-muted"> · {area.postcode}</span> : null}
                  </td>
                  <td className="mkt-num">{grouped.format(area.orders)}</td>
                  <td className="mkt-num">{area.sharePct}%</td>
                  <td className="mkt-num">{grouped.format(area.customers)}</td>
                  <td>{area.competitor || <span className="mkt-muted">None placed</span>}</td>
                  <td className="mkt-num">{ratingLabel(area.competitorRating)}</td>
                  <td className="mkt-num">{km(area.distanceKm)}</td>
                </tr>
              ))}
              {!contested.length ? (
                <tr>
                  <td colSpan={7} className="mkt-muted">
                    No located orders in this range, so there is nothing to contest yet.
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
              A restaurant that opened recently, or that trades under a name the map has never carried, will not be
              found — that is normal, and a pin is the fix. Each address goes to OpenStreetMap once and the answer is
              kept, the same as a customer address.
            </span>
          </div>
          <button
            type="button"
            className="mkt-primary"
            disabled={locating || !totals || !totals.pending}
            onClick={locate}
          >
            {locating ? 'Looking up…' : `Put these on the map (${totals ? totals.pending : 0})`}
          </button>
        </div>
        {locateNote ? <p className="mkt-panel-hint">{locateNote}</p> : null}
        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>Competitor</th>
                <th>Area</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {unplaced.map((rival) => (
                <tr key={rival.id}>
                  <td>
                    <strong>{rival.name}</strong>
                    {rival.note ? <div className="mkt-muted cmap-note">{rival.note}</div> : null}
                  </td>
                  <td>{rival.area}</td>
                  <td>
                    {rival.status === 'pending' ? (
                      <span className="mkt-muted">Never looked up</span>
                    ) : (
                      <span className="mkt-bad">Not found</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mkt-chip"
                      onClick={() => {
                        setPinning(rival);
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
              {!unplaced.length ? (
                <tr>
                  <td colSpan={4} className="mkt-muted">
                    Every competitor on the list is on the map.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default CompetitorMap;
