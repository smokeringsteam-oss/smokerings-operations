// Following a Porter trip to its end, and telling Odoo when it gets there.
//
// The gap this closes: pasting the rider's tracking link moves an order to
// Out for Delivery, and then nothing moves it again until somebody comes back
// to the board and says Delivered — which is also what posts the invoice. On
// a busy weekend that is the step that gets forgotten, and an order sits in
// Out for Delivery for days with no invoice against it.
//
// So: when the link is saved, an order goes into this queue with a time to
// check it. At that time the trip is read off Porter's own tracking page
// (server/ops/shared/porterTracking.js), and if Porter says the trip ended,
// the order goes to Delivered through the same path the board's own button
// uses — Odoo's Fulfilment Status, the status tag, the invoice.
//
// What makes it safe to leave running:
//
//   It never decides. Delivered is set only when Porter's own status is
//   `ended` or `completed`. No timeout, no "it's been long enough", no
//   guessing from the rider's position. The ETA below decides when to LOOK,
//   never what to conclude — if the estimate is wrong the watcher just keeps
//   polling, and a trip that takes three hours is marked when it actually
//   ends.
//
//   It survives a restart. The queue is a table, not a setTimeout. This
//   server restarts on every backend edit and whenever the machine sleeps; a
//   timer in the process would take its pending deliveries with it and say
//   nothing. A row with a next_check_at in the past just fires on the next
//   tick, which is also the first tick after boot.
//
//   It does not close on a half-done job. Marking delivered is two things —
//   the local row, then Odoo — and only the first is guaranteed. If the Odoo
//   push fails, the watch stays open and tries again, because a watch closed
//   on a failed push is exactly the un-invoiced order this exists to prevent.
//   Re-running is safe: createAndPostInvoice reuses an existing invoice
//   rather than raising a second one.
//
//   It gives up loudly. A link that stops resolving, a trip Porter cancels,
//   an order still running after MAX_WATCH_HOURS — each closes the watch in a
//   state that says which, and pushes a notification to the phone. The one
//   thing it will not do is go quiet.
//
//   A human always wins. If somebody marks the order Delivered on the board
//   first, the watch closes as 'stopped' on its next look rather than
//   re-running the invoice step.
import { all, get } from '../../core/db.js';
import { selectOne, update, upsert } from '../../core/repo.js';
import { sendToAll } from '../../core/pushNotify.js';
import { isPorterLink, readPorterOrderWithEta } from './porterTracking.js';

// Never poll the same order more often than the floor, nor leave a gap bigger
// than the ceiling. The floor is politeness to Porter and keeps a nearly-there
// order from being hammered; the ceiling is what stops a long ETA (a drop
// across the city, or the flat default when there are no coordinates) from
// leaving an order unchecked for an hour after it actually landed.
const POLL_FLOOR_MIN = 2;
const POLL_CEILING_MIN = 10;

// Per-failure backoff, in minutes, then the last value repeats. Porter being
// briefly unreachable is common enough that the first retry is quick.
const RETRY_BACKOFF_MIN = [1, 2, 5, 10, 15];

// Twelve consecutive failures at that backoff is a bit over an hour of a link
// that cannot be read — long past the point where a human should look.
const MAX_ERRORS = 12;

// A Porter run inside Bengaluru is under an hour. Eight is the point at which
// an order still being watched means something went wrong that polling will
// not fix: the trip was abandoned, the link was for a different order, the
// rider never closed it in their app.
const MAX_WATCH_HOURS = 8;

// Orders per tick. The reads are sequential — one tracking page each, half a
// second apiece — so this bounds a tick at a few seconds even on the worst
// weekend. Anything past the batch is simply still due on the next tick.
const BATCH_SIZE = 8;

const minutesFromNow = (now, minutes) => new Date(now.getTime() + minutes * 60 * 1000).toISOString();
const hoursBetween = (from, to) => (to.getTime() - new Date(from).getTime()) / 3600000;

function rowToWatch(row) {
  if (!row) return null;
  return {
    orderId: String(row.order_id),
    orderName: row.order_name,
    trackingUrl: row.tracking_url,
    crn: row.crn || null,
    state: row.state,
    porterStatus: row.porter_status || null,
    etaAt: row.eta_at || null,
    etaBasis: row.eta_basis || null,
    nextCheckAt: row.next_check_at,
    checks: row.checks,
    errors: row.errors,
    lastError: row.last_error || null,
    lastCheckedAt: row.last_checked_at || null,
    rider: row.rider || null,
    porterEndedAt: row.porter_ended_at || null,
    closedAt: row.closed_at || null,
    closedReason: row.closed_reason || null,
  };
}

function loadWatch(orderId) {
  return rowToWatch(selectOne('delivery_watch', { order_id: Number(orderId) }));
}

// orderIds: optional array — omit for every watch on file.
function getDeliveryWatches({ orderIds } = {}) {
  const ids = (orderIds || []).map(Number).filter(Number.isFinite);
  const rows = all(
    `SELECT * FROM delivery_watch${ids.length ? ` WHERE order_id IN (${ids.map(() => '?').join(', ')})` : ''}`,
    ...ids,
  );
  const byOrderId = {};
  rows.forEach((row) => {
    byOrderId[row.order_id] = rowToWatch(row);
  });
  return byOrderId;
}

function patchWatch(orderId, patch) {
  update(
    'delivery_watch',
    { order_id: Number(orderId) },
    { ...patch, updated_at: new Date().toISOString() },
    { required: false },
  );
}

function closeWatch(orderId, state, reason, extra = {}) {
  patchWatch(orderId, { state, closed_at: new Date().toISOString(), closed_reason: reason, ...extra });
}

// Notifications are best-effort in both directions: a push that fails must
// not fail the tick (the status change has already been made), and a machine
// with no subscriptions registered gets a console line instead of nothing.
async function notify({ title, body, tag }) {
  try {
    // '/' rather than a path for the board: the dashboard has no router, so
    // any other path would have the service worker navigate an already-open
    // tab (see public/sw.js) to a URL that just re-serves the app at its
    // default tab — losing whatever was on screen to land no closer.
    const result = await sendToAll({ title, body, tag, url: '/' });
    if (result?.skipped) console.log(`[delivery-watch] ${title} — ${body}`);
  } catch (err) {
    console.error('[delivery-watch] could not send notification —', err.message || err);
  }
}

// ---- Starting and stopping ---------------------------------------------

// Puts an order into the queue. Called when the tracking link is saved.
//
// The first read of the link happens here rather than at the first tick, so
// that the board can show the ETA the moment the link is pasted, and so a
// link that was mistyped or already expired is reported while whoever pasted
// it is still looking at it. It is bounded and caught: this runs inside
// saving the link, and saving the link must not fail because Porter was slow.
//
// A trip that has ALREADY ended when the link is pasted is not marked here —
// the row is simply queued as due now, and the next tick marks it. One code
// path marks an order delivered; this one only ever schedules.
async function startWatch({ orderId, orderName, trackingUrl, deps = {} } = {}) {
  const now = deps.now || new Date();
  const read = deps.readPorterOrder || readPorterOrderWithEta;

  if (!orderId || !orderName || !trackingUrl) {
    return { watched: false, reason: 'orderId, orderName and trackingUrl are required.' };
  }
  if (!isPorterLink(trackingUrl)) {
    // Another courier's link is a perfectly good thing to have on the order —
    // it just cannot be read, so nothing is queued and the board says so
    // rather than showing a watch that will never fire.
    return { watched: false, reason: 'not_porter' };
  }

  const base = {
    order_id: Number(orderId),
    order_name: orderName,
    tracking_url: trackingUrl,
    state: 'watching',
    // Re-pasting a link on an order whose watch had closed (given up,
    // cancelled, delivered in error) starts it over rather than leaving the
    // closed row in place: the paste is someone saying "this one, now".
    checks: 0,
    errors: 0,
    last_error: null,
    closed_at: null,
    closed_reason: null,
    porter_ended_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    next_check_at: now.toISOString(),
  };

  let order = null;
  let error = null;
  try {
    order = await read(trackingUrl, { now, timeoutMs: 8000 });
  } catch (err) {
    error = err.message || String(err);
  }

  if (order) {
    Object.assign(base, {
      track_url: order.trackUrl,
      crn: order.crn,
      porter_status: order.status,
      rider: order.partner?.name || null,
      eta_at: order.eta?.etaAt || null,
      eta_basis: order.eta?.basis || null,
      last_checked_at: now.toISOString(),
      checks: 1,
      // Due at the ETA, but never further out than the ceiling. A trip Porter
      // has already ended, or one it has cancelled, is due immediately — the
      // tick is what acts on either.
      next_check_at:
        order.phase === 'delivered' || order.phase === 'cancelled'
          ? now.toISOString()
          : nextCheckAt(now, order.eta?.etaAt),
    });
  } else {
    // The link could not be read this once. That is not a reason to skip the
    // watch — Porter is reachable far more often than not, and a link saved
    // during a blip should still be followed. It is queued for a retry.
    Object.assign(base, { last_error: error, errors: 1, next_check_at: minutesFromNow(now, RETRY_BACKOFF_MIN[0]) });
  }

  upsert('delivery_watch', ['order_id'], base);
  return {
    watched: true,
    watch: loadWatch(orderId),
    porter: order ? { status: order.status, phase: order.phase, eta: order.eta, rider: order.partner } : null,
    error,
  };
}

// Closes an open watch. Called when the board marks the order Delivered by
// hand — the work is done, and a watch left open would re-run the invoice
// step when Porter's trip ends a few minutes later.
function stopWatch(orderId, reason = 'closed_by_hand') {
  const row = selectOne('delivery_watch', { order_id: Number(orderId) });
  if (!row || row.state !== 'watching') return null;
  closeWatch(orderId, 'stopped', reason);
  return loadWatch(orderId);
}

// When to look next: at the ETA, but not sooner than the floor and not later
// than the ceiling.
function nextCheckAt(now, etaAt) {
  const floor = now.getTime() + POLL_FLOOR_MIN * 60 * 1000;
  const ceiling = now.getTime() + POLL_CEILING_MIN * 60 * 1000;
  const eta = etaAt ? new Date(etaAt).getTime() : floor;
  const target = Number.isFinite(eta) ? eta : floor;
  return new Date(Math.min(ceiling, Math.max(floor, target))).toISOString();
}

// ---- The tick -----------------------------------------------------------

// setPackingStatus is reached through a late import because the two modules
// point at each other: orderPackingStatus.js starts a watch when the link is
// saved, and this marks an order delivered through it. A static import either
// way round is a cycle, and a cycle here would be one of the quiet kinds —
// one module getting a half-initialised copy of the other at load time.
async function markDeliveredInOdoo({ orderId, orderName, channel }) {
  const { setPackingStatus } = await import('./orderPackingStatus.js');
  return setPackingStatus({ orderId, orderName, status: 'delivered', channel });
}

async function checkOne(row, now, deps) {
  const read = deps.readPorterOrder || readPorterOrderWithEta;
  const markDelivered = deps.markDelivered || markDeliveredInOdoo;
  const orderId = row.order_id;

  // What the board says about this order right now, which may have moved
  // since the watch was made.
  const order = selectOne('sales_order', { order_id: orderId });
  if (order?.status === 'delivered') {
    closeWatch(orderId, 'stopped', 'already_delivered');
    return { orderId, outcome: 'already_delivered' };
  }
  // The link was changed on the order after this watch was made — the watch
  // is following the wrong trip. startWatch rewrites the row on a re-paste,
  // so this only catches a link changed some other way; either way, following
  // a stale link could mark an order delivered off somebody else's trip.
  if (order?.tracking_url && order.tracking_url !== row.tracking_url) {
    closeWatch(orderId, 'stopped', 'tracking_link_changed');
    return { orderId, outcome: 'link_changed' };
  }

  if (hoursBetween(row.created_at, now) > MAX_WATCH_HOURS) {
    closeWatch(orderId, 'given_up', `still running after ${MAX_WATCH_HOURS}h`);
    await notify({
      title: `${row.order_name}: still not delivered`,
      body: `Porter has had this trip for over ${MAX_WATCH_HOURS} hours (${row.porter_status || 'unknown'}). Check it and set the status by hand.`,
      tag: `delivery-watch-${orderId}`,
    });
    return { orderId, outcome: 'given_up' };
  }

  let porter;
  try {
    porter = await read(row.tracking_url, { now, timeoutMs: 10000 });
  } catch (err) {
    const errors = (row.errors || 0) + 1;
    const message = err.message || String(err);
    // A link that isn't Porter's at all, or that redirects off it, will never
    // become readable — there is nothing to back off from.
    const fatal = err.code === 'NOT_PORTER' || errors >= MAX_ERRORS;
    if (fatal) {
      closeWatch(orderId, 'given_up', message, { errors, last_error: message, last_checked_at: now.toISOString() });
      await notify({
        title: `${row.order_name}: tracking link can't be read`,
        body: `${message} Set this order's status by hand.`,
        tag: `delivery-watch-${orderId}`,
      });
      return { orderId, outcome: 'given_up', error: message };
    }
    patchWatch(orderId, {
      errors,
      last_error: message,
      last_checked_at: now.toISOString(),
      next_check_at: minutesFromNow(now, RETRY_BACKOFF_MIN[Math.min(errors - 1, RETRY_BACKOFF_MIN.length - 1)]),
    });
    return { orderId, outcome: 'error', error: message };
  }

  const common = {
    checks: (row.checks || 0) + 1,
    last_checked_at: now.toISOString(),
    porter_status: porter.status,
    crn: porter.crn || row.crn,
    track_url: porter.trackUrl || row.track_url,
    rider: porter.partner?.name || row.rider,
    // A read that worked clears the error count: the failures that matter are
    // consecutive ones, not one blip an hour ago.
    errors: 0,
    last_error: null,
  };

  if (porter.phase === 'cancelled') {
    // Nothing is pushed to Odoo. A cancelled trip is not a delivery, and what
    // should happen next — rebook, refund, drive it over — is not a decision
    // this can make.
    closeWatch(orderId, 'cancelled', `Porter status: ${porter.status}`, common);
    await notify({
      title: `${row.order_name}: Porter trip cancelled`,
      body: 'The trip was cancelled, so the order has NOT been marked delivered. It needs a new rider.',
      tag: `delivery-watch-${orderId}`,
    });
    return { orderId, outcome: 'cancelled' };
  }

  if (porter.phase !== 'delivered') {
    // Still going. The ETA is recomputed from where the rider actually is, so
    // it tightens as the run goes on rather than standing on the guess made
    // when the link was pasted.
    patchWatch(orderId, {
      ...common,
      eta_at: porter.eta?.etaAt || null,
      eta_basis: porter.eta?.basis || null,
      next_check_at: nextCheckAt(now, porter.eta?.etaAt),
    });
    return { orderId, outcome: 'waiting', status: porter.status };
  }

  // Porter says the trip ended. This is the only branch that marks an order
  // delivered, and it only runs on Porter's own word.
  let result;
  try {
    result = await markDelivered({
      orderId,
      orderName: row.order_name,
      channel: order?.channel || 'B2C',
    });
  } catch (err) {
    // setPackingStatus swallows its own Odoo failures, so reaching here means
    // the local write itself failed — the database is the problem. Retry.
    const message = err.message || String(err);
    patchWatch(orderId, {
      ...common,
      // Explicitly: setPackingStatus closes this watch as part of reaching
      // Delivered (see stopWatch in orderPackingStatus.js), which is right
      // when it succeeds and wrong when it is going to be retried. A watch
      // left closed here is a delivery nothing ever comes back to.
      state: 'watching',
      closed_at: null,
      closed_reason: null,
      errors: (row.errors || 0) + 1,
      last_error: message,
      next_check_at: minutesFromNow(now, RETRY_BACKOFF_MIN[0]),
    });
    return { orderId, outcome: 'error', error: message };
  }

  // The local row is now Delivered whatever happened next, but Odoo is the
  // record the kitchen and the accountant read. If its Fulfilment Status
  // push failed, the watch stays open and tries the whole step again — the
  // invoice call reuses an existing invoice, so a second attempt cannot raise
  // a second one.
  if (result?.odooError) {
    const errors = (row.errors || 0) + 1;
    if (errors < MAX_ERRORS) {
      patchWatch(orderId, {
        ...common,
        // Re-opened deliberately — see the note in the catch above.
        state: 'watching',
        closed_at: null,
        closed_reason: null,
        errors,
        last_error: `Odoo: ${result.odooError}`,
        porter_ended_at: porter.endedAt,
        next_check_at: minutesFromNow(now, RETRY_BACKOFF_MIN[Math.min(errors - 1, RETRY_BACKOFF_MIN.length - 1)]),
      });
      return { orderId, outcome: 'odoo_retry', error: result.odooError };
    }
    closeWatch(orderId, 'given_up', `Odoo never took the status: ${result.odooError}`, {
      ...common,
      errors,
      porter_ended_at: porter.endedAt,
    });
    await notify({
      title: `${row.order_name}: delivered, but Odoo didn't take it`,
      body: `Porter delivered this order. Odoo refused the status: ${result.odooError}`,
      tag: `delivery-watch-${orderId}`,
    });
    return { orderId, outcome: 'given_up', error: result.odooError };
  }

  closeWatch(orderId, 'delivered', `Porter status: ${porter.status}`, {
    ...common,
    porter_ended_at: porter.endedAt,
  });
  await notify({
    title: `${row.order_name} delivered`,
    body: result?.invoiceError
      ? `Porter delivered it and Odoo is updated, but the invoice failed: ${result.invoiceError}`
      : `Porter delivered it${porter.partner?.name ? ` (${porter.partner.name})` : ''}. Odoo is updated and invoiced.`,
    tag: `delivery-watch-${orderId}`,
  });
  return { orderId, outcome: 'delivered', invoiceError: result?.invoiceError || null };
}

// One pass over everything that is due. Safe to call as often as you like:
// with nothing due it is a single indexed read that returns no rows.
//
// Orders are read one after another rather than in parallel, so a weekend's
// worth of open trips is a handful of sequential requests to Porter rather
// than a burst that looks like something worth blocking.
async function runDeliveryWatchTick(now = new Date(), deps = {}) {
  const rows = all(
    "SELECT * FROM delivery_watch WHERE state = 'watching' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?",
    now.toISOString(),
    BATCH_SIZE,
  );
  const results = [];
  for (const row of rows) {
    try {
      results.push(await checkOne(row, now, deps));
    } catch (err) {
      // A bug in the handling of one order must not stop the others being
      // looked at, and must not leave that order due forever in a loop that
      // throws every tick.
      console.error(`[delivery-watch] ${row.order_name} failed to check —`, err.message || err);
      patchWatch(row.order_id, {
        errors: (row.errors || 0) + 1,
        last_error: err.message || String(err),
        next_check_at: minutesFromNow(now, POLL_CEILING_MIN),
      });
      results.push({ orderId: row.order_id, outcome: 'error', error: err.message || String(err) });
    }
  }
  const tally = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    checked: results.length,
    delivered: tally('delivered'),
    cancelled: tally('cancelled'),
    gaveUp: tally('given_up'),
    errors: tally('error') + tally('odoo_retry'),
    results,
  };
}

// Checks one order now, whatever its next_check_at said — the board's "check
// now" button. Returns the same shape as a tick result for that one order.
async function checkWatchNow(orderId, deps = {}) {
  const row = selectOne('delivery_watch', { order_id: Number(orderId) });
  if (!row) {
    const err = new Error('That order is not being watched — save its Porter link first.');
    err.status = 404;
    throw err;
  }
  if (row.state !== 'watching') {
    return { orderId: String(orderId), outcome: row.state, watch: rowToWatch(row) };
  }
  const result = await checkOne(row, deps.now || new Date(), deps);
  return { ...result, watch: loadWatch(orderId) };
}

// How many watches are open — for the startup line, so a server that comes up
// with deliveries pending says so.
function openWatchCount() {
  return get("SELECT count(*) AS n FROM delivery_watch WHERE state = 'watching'")?.n || 0;
}

// Orders that are out with a Porter link but have no watch on them — because
// the link was saved before any of this existed, or during a restart that
// caught startWatch between reading Porter and writing the row.
//
// Deliberately scoped to orders that went out inside the watch window rather
// than to every such order ever. Sweeping history would be the wrong kind of
// thorough: marking a month-old order Delivered posts an invoice in Odoo, and
// an invoice raised by a backfill is not something anyone asked for. What
// this covers is what is actually still in flight.
//
// Nothing here reads Porter or touches Odoo — it only queues, and the tick
// does the rest through the same checks as any other order.
function backfillWatches(now = new Date()) {
  const since = new Date(now.getTime() - MAX_WATCH_HOURS * 3600000).toISOString();
  const rows = all(
    `SELECT o.order_id, o.order_name, o.tracking_url
       FROM sales_order o
       LEFT JOIN delivery_watch w ON w.order_id = o.order_id
      WHERE o.tracking_url IS NOT NULL
        AND o.status NOT IN ('delivered', 'pending')
        AND o.out_for_delivery_at IS NOT NULL
        AND o.out_for_delivery_at >= ?
        AND w.order_id IS NULL`,
    since,
  );
  const queued = rows.filter((row) => isPorterLink(row.tracking_url));
  queued.forEach((row) => {
    upsert('delivery_watch', ['order_id'], {
      order_id: row.order_id,
      order_name: row.order_name,
      tracking_url: row.tracking_url,
      state: 'watching',
      // Due now: the first tick reads Porter and takes it from there.
      next_check_at: now.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  });
  return queued.map((row) => row.order_name);
}

export {
  MAX_WATCH_HOURS,
  POLL_CEILING_MIN,
  POLL_FLOOR_MIN,
  backfillWatches,
  checkWatchNow,
  getDeliveryWatches,
  nextCheckAt,
  openWatchCount,
  runDeliveryWatchTick,
  startWatch,
  stopWatch,
};
