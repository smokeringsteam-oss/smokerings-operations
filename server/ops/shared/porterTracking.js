// Reading a Porter trip off its own public tracking link.
//
// The link the rider's app shares ("https://porter.in/rd/bb04ee9fda") is a
// short link. It 302s to
//   https://porter.in/track_live_order_v2?booking_id=CRN…&customer_uuid=…
// which is a Next.js page — and, usefully, one that renders on the server.
// The trip's whole state (status, the rider, both ends of the run, the
// delivery timestamp) is in the flight payload that page ships with, so a
// plain fetch reads it. No browser, no key, no Porter account: the link
// itself is the credential, which is why it must only ever be read for a link
// the board already has on an order.
//
// Asking for it with the `RSC: 1` header returns that payload on its own
// rather than wrapped in HTML — same data, an order of magnitude less of it,
// and no HTML entity decoding in the middle. The response is React's flight
// format (not JSON), so the order object is cut out of it by matching braces
// rather than parsed whole; everything this module needs is inside that one
// object.
//
// The ETA is the one thing the page does NOT server-render — it arrives over
// a websocket the live map subscribes to, keyed by a channel uuid that isn't
// in the payload. So it is estimated here instead, from the rider's live
// position and the drop, the same as-the-crow-flies-plus-a-fudge-factor way
// server/ops/shared/deliveryDistance.js measures a drop from the kitchen. It
// is deliberately an underestimate (see estimateArrival) because of what it
// is used for: server/ops/shared/deliveryWatch.js treats it as "don't bother
// checking before this", not as a promise about when the box lands.

// Every status string the tracking page knows how to render, taken from the
// page's own tripStatusText map, grouped into what the watcher does about it:
//
//   searching    open, allocated       — no rider on it yet
//   on_the_way   accepted, live,       — a rider has it (loading/unloading are
//                loading, unloading      at the two ends of the run)
//   delivered    ended, completed      — "Driver has delivered the goods"
//   cancelled    cancelled, rescheduled
//
// `unloading` is NOT delivered on purpose: it is the handover in progress.
// Only Porter's own two end states are taken as delivered, because that is
// the fact this whole thing turns into an invoice in Odoo.
const PHASE_BY_STATUS = {
  open: 'searching',
  allocated: 'searching',
  accepted: 'on_the_way',
  live: 'on_the_way',
  loading: 'on_the_way',
  unloading: 'on_the_way',
  ended: 'delivered',
  completed: 'delivered',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

// A status Porter has never sent before. Treated as "still going" rather than
// as delivered or as an error: the watcher keeps polling, which is the safe
// reading of an unknown state — it can only cost another poll, where guessing
// 'delivered' would post an invoice for a box that never arrived.
const UNKNOWN_PHASE = 'on_the_way';

function phaseFor(status) {
  return PHASE_BY_STATUS[String(status || '').toLowerCase()] || UNKNOWN_PHASE;
}

// Porter's short links and the tracking page both live on porter.in. Any
// other courier's link is not refused anywhere in the app (see cleanTrackingUrl
// in orderPackingStatus.js) — it just can't be read, so the watcher says so
// rather than pretending to watch it.
function isPorterLink(url) {
  try {
    return /(^|\.)porter\.in$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Wraps fetch in a deadline. Porter sits behind Akamai, and a request that
// hangs would otherwise hold a watcher tick open indefinitely — the tick runs
// its orders one after another, so one stuck request would stall the rest.
async function fetchWithTimeout(url, { timeoutMs = 10000, ...init } = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Follows the /rd/ short link by hand rather than letting fetch do it, so the
// booking id and customer uuid in the Location header can be read off. Manual
// redirects also mean a short link that has been re-pointed somewhere off
// porter.in stops here instead of being fetched.
async function resolveTrackingLink(trackingUrl, { fetchImpl = fetch, timeoutMs } = {}) {
  let url = String(trackingUrl || '');
  if (!isPorterLink(url)) {
    const err = new Error('Not a Porter link — only porter.in links can be read.');
    err.code = 'NOT_PORTER';
    throw err;
  }

  for (let hop = 0; hop < 5; hop += 1) {
    const parsed = new URL(url);
    // Already the tracking page itself: either the saved link was the long
    // form, or the hop above landed on it.
    if (/track_live_order/i.test(parsed.pathname) && parsed.searchParams.get('booking_id')) {
      return {
        trackUrl: url,
        crn: parsed.searchParams.get('booking_id'),
        customerUuid: parsed.searchParams.get('customer_uuid'),
      };
    }
    const res = await fetchWithTimeout(url, { redirect: 'manual', timeoutMs }, fetchImpl);
    const location = res.headers.get('location');
    if (!location) {
      const err = new Error(
        res.status >= 400
          ? `Porter returned ${res.status} for that tracking link — it may have expired.`
          : 'That Porter link did not lead to a tracking page.',
      );
      err.code = res.status >= 400 ? 'PORTER_HTTP' : 'NO_BOOKING';
      err.status = res.status;
      throw err;
    }
    const next = new URL(location, url);
    if (!isPorterLink(next.href)) {
      const err = new Error(`That link redirects off porter.in (to ${next.hostname}) — not following it.`);
      err.code = 'NOT_PORTER';
      throw err;
    }
    url = next.href;
  }
  const err = new Error('That Porter link redirects in circles.');
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

// Cuts one JSON object out of the flight payload: find the key, find the `{`
// after it, then walk forward counting braces while skipping anything inside
// a string. The payload is not JSON as a whole — it is React's line-oriented
// flight format, with the page's props embedded as JSON fragments — so a
// JSON.parse of the response would fail, and a regex for the closing brace
// would stop at the first nested object.
function sliceObject(text, key) {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return null;
  const start = text.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Porter's epoch-seconds timestamps, as ISO. Guarded rather than trusted: a
// null trip_ended_time is the normal case for a trip still running, and a
// zero or a millisecond value would otherwise become a date in 1970 that the
// board would show as the delivery time.
function isoFromEpochSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coord(node) {
  const lat = Number(node?.location?.lat ?? node?.lat);
  const lng = Number(node?.location?.lng ?? node?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// Reads the trip behind a tracking link. Throws on anything that isn't a
// clear answer (link dead, Porter down, payload in a shape this doesn't
// know) — the watcher retries those rather than acting on them.
async function readPorterOrder(trackingUrl, { fetchImpl = fetch, timeoutMs } = {}) {
  const { trackUrl, crn, customerUuid } = await resolveTrackingLink(trackingUrl, { fetchImpl, timeoutMs });

  const res = await fetchWithTimeout(trackUrl, { headers: { RSC: '1' }, timeoutMs }, fetchImpl);
  if (!res.ok) {
    const err = new Error(`Porter returned ${res.status} for that tracking page.`);
    err.code = 'PORTER_HTTP';
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  const raw = sliceObject(text, 'order_details');
  if (!raw) {
    // Porter changed the page, or served something else entirely (a bot
    // challenge, a maintenance page). Either way there is nothing to read and
    // nothing to guess at.
    const err = new Error('Porter’s tracking page did not contain the order details.');
    err.code = 'NO_ORDER_DETAILS';
    throw err;
  }

  let details;
  try {
    details = JSON.parse(raw);
  } catch {
    const err = new Error('Porter’s order details could not be read.');
    err.code = 'BAD_ORDER_DETAILS';
    throw err;
  }

  const status = String(details.status || '').toLowerCase();
  return {
    trackUrl,
    crn: details.crn || crn || null,
    customerUuid: customerUuid || null,
    status,
    phase: phaseFor(status),
    known: Object.prototype.hasOwnProperty.call(PHASE_BY_STATUS, status),
    acceptedAt: isoFromEpochSeconds(details.trip_accepted_time),
    // Porter's own delivery timestamp — the one the board shows, in
    // preference to the moment this happened to notice.
    endedAt: isoFromEpochSeconds(details.trip_ended_time),
    partner: details.partner?.name
      ? {
          name: details.partner.name,
          mobile: details.partner.mobile || null,
          vehicle: details.partner.vehicleNumber || null,
          vehicleType: details.partner.vehicleType || details.vehicle?.vehicle_type || null,
        }
      : null,
    // null until a rider is on it, and again once the trip has ended.
    riderAt: coord(details.partnerLocation),
    pickupAt: coord(details.pickupLocation),
    dropAt: coord(details.dropLocation),
    dropLandmark: details.dropLocation?.landmark || null,
  };
}

// ---- ETA ----------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Straight-line kilometres are not road kilometres. 1.4 is the usual detour
// ratio for a dense grid and matches what Bengaluru drops actually run; the
// speed is a two-wheeler in city traffic, which is what every Porter order
// this board places has used. Both are tunable without a code change because
// a kitchen that moves, or a city that isn't Bengaluru, would want different
// numbers — and because getting them wrong only shifts when the first check
// happens, never what it concludes.
const ROAD_FACTOR = () => envNumber('PORTER_ROAD_FACTOR', 1.4);
const SPEED_KMPH = () => envNumber('PORTER_SPEED_KMPH', 18);
// Finding the flat, getting to the door, handing over.
const HANDOVER_MIN = () => envNumber('PORTER_HANDOVER_MIN', 4);
// Added while Porter is still looking for a rider, on top of the run itself.
const ALLOCATION_MIN = () => envNumber('PORTER_ALLOCATION_MIN', 8);
// An estimate below the floor would have the watcher checking a trip that has
// barely started; one above the ceiling is a sign the drop is nowhere near
// the kitchen, and a check every few minutes is cheap enough either way.
const MIN_ETA_MIN = 3;
const MAX_ETA_MIN = 180;

// When the box should land, and on what basis.
//
// Deliberately optimistic. This is used to decide when to START checking, and
// the watcher keeps checking afterwards until Porter says the trip ended, so
// an estimate that is early costs one extra poll. An estimate that is late
// would leave a delivered order sitting un-invoiced in Odoo until it drifted
// past — which is the thing this is here to prevent. Every poll recomputes it
// from where the rider actually is, so it converges as the run goes on.
//
//   basis 'rider'   — measured from the rider's live position (the good case)
//   basis 'pickup'  — no rider position yet, so measured from the kitchen
//   basis 'default' — no coordinates at all; a flat guess, purely so there IS
//                     a next check time
function estimateArrival(order, now = new Date()) {
  const from = order?.riderAt || order?.pickupAt || null;
  const to = order?.dropAt || null;
  const searching = order?.phase === 'searching';

  let minutes;
  let basis;
  let distanceKm = null;
  if (from && to) {
    distanceKm = haversineKm(from, to);
    basis = order.riderAt ? 'rider' : 'pickup';
    minutes = (distanceKm * ROAD_FACTOR() * 60) / SPEED_KMPH() + HANDOVER_MIN();
  } else {
    basis = 'default';
    minutes = envNumber('PORTER_DEFAULT_ETA_MIN', 30);
  }
  if (searching) minutes += ALLOCATION_MIN();

  minutes = Math.min(MAX_ETA_MIN, Math.max(MIN_ETA_MIN, Math.round(minutes)));
  return {
    etaMinutes: minutes,
    etaAt: new Date(now.getTime() + minutes * 60 * 1000).toISOString(),
    basis,
    distanceKm: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
  };
}

// The link, read and estimated in one go — what both the watcher and the
// board's "check now" button want.
async function readPorterOrderWithEta(trackingUrl, { fetchImpl, timeoutMs, now = new Date() } = {}) {
  const order = await readPorterOrder(trackingUrl, { fetchImpl, timeoutMs });
  // A finished trip has no arrival left to estimate, and its rider position
  // comes back null, so the estimate would be the flat default — which would
  // read on the card as "another 30 minutes" for a box already delivered.
  const eta = order.phase === 'delivered' || order.phase === 'cancelled' ? null : estimateArrival(order, now);
  return { ...order, eta };
}

export {
  PHASE_BY_STATUS,
  estimateArrival,
  haversineKm,
  isPorterLink,
  phaseFor,
  readPorterOrder,
  readPorterOrderWithEta,
  resolveTrackingLink,
  sliceObject,
};
