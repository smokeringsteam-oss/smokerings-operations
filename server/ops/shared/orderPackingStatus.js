// Order Management's per-order kitchen+delivery pipeline state — In Smoker
// -> Prepping -> Packed -> Finding Partner -> Partner Assigned -> Out for
// Delivery -> Delivered (see STATUS_STEPS below) — one row per order in
// `sales_order`, keyed by Odoo's sale.order id.
//
// That single row is the audit trail: it holds the whole life of the order,
// every stage's timestamp, the delivery person and the invoice. A separate
// per-transition log was retired into it on 2026-08-19 at the pitmaster's
// call, since it recorded the same moves a second time. What the row does not
// keep is the tail of a walked-back order (re-advancing overwrites that
// stage's stamp) and the per-push Odoo errors, which only reach the console.
//
// Migrated off Kitchen/order_lifecycle_log.csv. One thing the table adds: a
// smoking session can point at an order (see setFedOrders), so an order the
// packing board has never touched may already exist here as a stub with
// status 'pending'. The upsert below fills such a row in rather than
// colliding with it.
//
// The status change is always written here first (it's the one thing that
// must never silently fail to save), then pushed on to Odoo's Fulfilment
// Status field, the status tag, and the invoice — all best-effort, see
// server/integrations/odoo.js setFulfilmentStatus / tagSaleOrderStatus /
// createAndPostInvoice. If Odoo is briefly unreachable the change here still
// sticks and those steps can be retried without walking the order back.
//
// The board itself *displays* Odoo's Fulfilment Status rather than this row
// (src/pages/ops/shared/orderFulfilment.tsx effectiveStatus), so what Odoo took is
// echoed back on save as odooFulfilment — otherwise the board would re-render
// the pre-save value it fetched and appear to undo the change.
import { all } from '../../core/db.js';
import { selectOne, update, upsert } from '../../core/repo.js';
import { startWatch, stopWatch } from './deliveryWatch.js';
import {
  tagSaleOrderStatus,
  setFulfilmentStatus,
  setDeliveryTrackingUrl,
  createAndPostInvoice,
} from '../../integrations/odoo.js';

// The full order pipeline, in order — kept here as the single source of
// truth for validation, the per-status "_at" column it stamps, and (via
// jsonKey) the camelCase field each stamp comes back as over the API. UI
// (src/pages/ops/shared/OrderPacking.tsx) mirrors this list to render stage badges and
// the "advance to next stage" button; keep the two in sync if this changes.
const STATUS_STEPS = [
  { status: 'in_smoker', atField: 'in_smoker_at', jsonKey: 'inSmokerAt' },
  { status: 'prepping', atField: 'prepping_at', jsonKey: 'preppingAt' },
  { status: 'packed', atField: 'packed_at', jsonKey: 'packedAt' },
  { status: 'finding_partner', atField: 'finding_partner_at', jsonKey: 'findingPartnerAt' },
  { status: 'assigned_partner', atField: 'assigned_partner_at', jsonKey: 'assignedPartnerAt' },
  { status: 'out_for_delivery', atField: 'out_for_delivery_at', jsonKey: 'outForDeliveryAt' },
  { status: 'delivered', atField: 'delivered_at', jsonKey: 'deliveredAt' },
];
const VALID_STATUSES = STATUS_STEPS.map((s) => s.status);

function rowToStatus(row) {
  const stageTimes = {};
  STATUS_STEPS.forEach((s) => {
    stageTimes[s.jsonKey] = row[s.atField] || null;
  });
  return {
    orderId: String(row.order_id),
    channel: row.channel || null,
    status: row.status || 'pending',
    deliveryPerson: row.delivery_person || null,
    trackingUrl: row.tracking_url || null,
    ...stageTimes,
    invoice: row.invoice_number
      ? { number: row.invoice_number, id: row.invoice_id == null ? null : String(row.invoice_id), url: row.invoice_url || null }
      : null,
    invoiceError: row.invoice_error || null,
  };
}

// orderIds: optional array (string or number) — omit to get every order that
// has a status on file.
function getPackingStatuses({ orderIds } = {}) {
  const ids = (orderIds || []).map(Number).filter(Number.isFinite);
  const rows = all(
    `SELECT * FROM sales_order${ids.length ? ` WHERE order_id IN (${ids.map(() => '?').join(', ')})` : ''}`,
    ...ids,
  );
  const byOrderId = {};
  rows.forEach((row) => {
    byOrderId[row.order_id] = rowToStatus(row);
  });
  return byOrderId;
}

function loadOrder(orderId) {
  return selectOne('sales_order', { order_id: Number(orderId) });
}

async function setPackingStatus({ orderId, orderName, status, deliveryPerson, channel }) {
  if (!orderId || !orderName) {
    const err = new Error('orderId and orderName are required.');
    err.status = 400;
    throw err;
  }
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const existing = loadOrder(orderId);
  const now = new Date().toISOString();
  const row = {
    order_id: Number(orderId),
    order_name: orderName,
    status,
    // Blank on rows first written before the column existed, and never
    // cleared by a call that omits it. channel is NOT NULL on the table, so a
    // brand new row with nothing said falls back to the weekend board.
    channel: channel || existing?.channel || 'B2C',
    updated_at: now,
  };
  // The delivery person's name is normally captured on the "partner assigned"
  // step, but the packing board also lets it be corrected at any later stage
  // (wrong name typed, partner swapped), so any non-empty value sent in wins.
  // An omitted/blank one never clears what's already on file.
  if (deliveryPerson && String(deliveryPerson).trim()) row.delivery_person = String(deliveryPerson).trim();
  const step = STATUS_STEPS.find((s) => s.status === status);
  if (step) row[step.atField] = now;

  upsert('sales_order', ['order_id'], row);

  // Best-effort — a tagging hiccup shouldn't block the status change from
  // saving locally, so it's caught and logged rather than thrown.
  try {
    await tagSaleOrderStatus({ orderId, status });
  } catch (err) {
    console.error(`Failed to tag Odoo order ${orderName} as ${status}:`, err.message || err);
  }

  // Same best-effort deal for Odoo's own Fulfilment Status selection field —
  // the one that shows on the sale order form. Its failure is surfaced to the
  // caller (odooError) rather than only logged, because unlike the tag this
  // is the field staff read in Odoo, so a silent no-op would be misleading.
  let odooError = '';
  let odooFulfilment = null;
  try {
    odooFulfilment = await setFulfilmentStatus({ orderId, status });
  } catch (err) {
    odooError = err.message || String(err);
    console.error(`Failed to set Odoo Fulfilment Status on ${orderName} to ${status}:`, odooError);
  }

  if (status === 'delivered') {
    const invoicePatch = { updated_at: new Date().toISOString() };
    try {
      const invoice = await createAndPostInvoice({ orderId });
      invoicePatch.invoice_number = invoice.invoiceNumber;
      invoicePatch.invoice_id = Number(invoice.invoiceId);
      invoicePatch.invoice_url = invoice.invoiceUrl || null;
      invoicePatch.invoice_error = null;
      // Odoo's Fulfilment Status has one stage past DELIVERED — INVOICED —
      // which isn't a local pipeline stage, so it's set here off the back of
      // the invoice actually posting rather than from a status change. A
      // failure to set it is worth recording on the row, but it isn't a
      // failure of the invoice itself.
      try {
        odooFulfilment = (await setFulfilmentStatus({ orderId, status: 'invoiced' })) || odooFulfilment;
      } catch (err) {
        invoicePatch.invoice_error = err.message || String(err);
        console.error(`Failed to set Odoo Fulfilment Status on ${orderName} to invoiced:`, invoicePatch.invoice_error);
      }
    } catch (err) {
      invoicePatch.invoice_error = err.message || String(err);
      console.error(`Failed to create/post Odoo invoice for ${orderName}:`, invoicePatch.invoice_error);
    }
    update('sales_order', { order_id: Number(orderId) }, invoicePatch);
    // The order is delivered, however it got here, so nothing is left for the
    // Porter watch to do. Closed rather than left to notice on its own: an
    // open watch would come back when Porter's trip ends and run this whole
    // block a second time.
    try {
      stopWatch(orderId, 'delivered_on_the_board');
    } catch (err) {
      console.error(`Failed to close the delivery watch on ${orderName}:`, err.message || err);
    }
  }

  return { ...rowToStatus(loadOrder(orderId)), odooError: odooError || null, odooFulfilment };
}

// Re-runs just the invoice step — for retrying after a failure (Odoo down,
// nothing marked "To Invoice" yet, etc.) without re-sending the order through
// the earlier pipeline stages again. Only valid once the order is already
// Delivered.
async function retryInvoice({ orderId, orderName }) {
  const row = loadOrder(orderId);
  if (!row || row.status !== 'delivered') {
    const err = new Error(`Order ${orderName || orderId} isn't marked Delivered yet — mark it delivered first.`);
    err.status = 400;
    throw err;
  }

  let invoice;
  try {
    invoice = await createAndPostInvoice({ orderId });
  } catch (err) {
    // The failed attempt is recorded on the row itself before it's surfaced
    // to the caller, so a retry that never succeeds still leaves a trace.
    update('sales_order', { order_id: Number(orderId) }, { invoice_error: err.message || String(err) });
    throw err;
  }

  update(
    'sales_order',
    { order_id: Number(orderId) },
    {
      invoice_number: invoice.invoiceNumber,
      invoice_id: Number(invoice.invoiceId),
      invoice_url: invoice.invoiceUrl || null,
      invoice_error: null,
      updated_at: new Date().toISOString(),
    },
  );

  let odooFulfilment = null;
  try {
    odooFulfilment = await setFulfilmentStatus({ orderId, status: 'invoiced' });
  } catch (err) {
    console.error(
      `Failed to set Odoo Fulfilment Status on ${orderName || orderId} to invoiced:`,
      err.message || err,
    );
  }

  return { ...rowToStatus(loadOrder(orderId)), odooFulfilment };
}

// A Porter tracking link, as pasted. Porter's share text puts words around
// the link ("Track your order: https://porter.in/..."), so the first URL in
// whatever was pasted is taken rather than rejecting the lot. Any http(s) URL
// is accepted, not only porter.in — the day a different courier is used, the
// field should not refuse its link. Porter's share sheet often drops the
// scheme ("porter.in/rd/b98a3b5ba4"), so a host-and-path with no scheme is
// taken too and given https — a path is required there, so a sentence with a
// stray "e.g." in it isn't mistaken for a link.
function cleanTrackingUrl(raw) {
  const text = String(raw || '');
  const found =
    text.match(/https?:\/\/[^\s<>"']+/i) || text.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+/i);
  if (!found) return null;
  const link = found[0].replace(/[).,;]+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// What goes into Odoo's Delivery Tracking URL field. For a Porter link that's
// only the part after the host ("rd/b98a3b5ba4") — the pitmaster's call, to
// keep the field short on the order form. The public tracker on the website
// (smokey-rings api/lib/delivery_tracking.php) puts https://porter.in/ back in
// front. Any other courier's link goes in whole, since nothing could rebuild it.
function odooTrackingValue(url) {
  const parsed = new URL(url);
  if (!/(^|\.)porter\.in$/i.test(parsed.hostname)) return url;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, '');
}

// Saves the tracking link, and with `advance` also moves the order to Out
// for Delivery through the normal status path (Odoo field, tag and all). The
// board decides `advance` because it knows the stage Odoo shows, which this
// row may lag. Without it only the link changes — correcting a link on a
// Delivered order must not re-run the invoice step.
async function setTrackingLink({ orderId, orderName, trackingUrl, channel, advance }) {
  if (!orderId || !orderName) {
    const err = new Error('orderId and orderName are required.');
    err.status = 400;
    throw err;
  }
  const url = cleanTrackingUrl(trackingUrl);
  if (!url) {
    const err = new Error("That doesn't look like a tracking link — paste the https:// link Porter shares.");
    err.status = 400;
    throw err;
  }

  const existing = loadOrder(orderId);
  upsert('sales_order', ['order_id'], {
    order_id: Number(orderId),
    order_name: orderName,
    status: existing?.status || 'pending',
    channel: channel || existing?.channel || 'B2C',
    tracking_url: url,
    updated_at: new Date().toISOString(),
  });

  // Best-effort like the Fulfilment Status push: the link is saved here
  // either way, and a failure comes back so the card can say Odoo missed it.
  let odooTrackingError = null;
  try {
    await setDeliveryTrackingUrl({ orderId, value: odooTrackingValue(url) });
  } catch (err) {
    odooTrackingError = err.message || String(err);
    console.error(`Failed to set Odoo Delivery Tracking URL on ${orderName}:`, odooTrackingError);
  }

  const result = advance
    ? await setPackingStatus({ orderId, orderName, status: 'out_for_delivery', channel })
    : rowToStatus(loadOrder(orderId));

  // Start following the trip. Best-effort in the strongest sense: the link is
  // already saved and the order already moved, so nothing here is allowed to
  // turn a successful save into an error the board shows. What it gives back
  // — the ETA, the rider, whether Porter could be read at all — rides along on
  // the response so the card can show it straight away.
  //
  // Deliberately after the stage change: startWatch reads the order row to
  // decide what it is looking at, and that read should see the order as it now
  // stands. A watch is started even for an order already past Out for Delivery
  // (a link corrected on an order in flight) — the only status it will not
  // start against is Delivered, which stopWatch has already closed.
  let watch = null;
  if (loadOrder(orderId)?.status !== 'delivered') {
    try {
      watch = await startWatch({ orderId, orderName, trackingUrl: url });
    } catch (err) {
      console.error(`Could not start the delivery watch on ${orderName}:`, err.message || err);
      watch = { watched: false, reason: err.message || String(err) };
    }
  }

  return { ...result, odooTrackingError, watch };
}

export { getPackingStatuses, setPackingStatus, setTrackingLink, retryInvoice, cleanTrackingUrl, odooTrackingValue };
