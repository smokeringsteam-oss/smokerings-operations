// Order Packing tile's per-order kitchen+delivery pipeline state — In Smoker
// -> Prepping -> Packed -> Finding Partner -> Partner Assigned -> Out for
// Delivery -> Delivered (see STATUS_STEPS below) — tracked in a small shared
// knowledge-base CSV (same "shared status, not localStorage" pattern as
// server/ops/b2c/weekendStatus.js) so whoever opens the dashboard next sees the same
// state, keyed by Odoo sale.order id.
//
// One row per order, holding the whole life of it: the current status, every
// stage's timestamp, the delivery person and the invoice. That single row is
// the audit trail — the separate per-transition order_fulfilment_log.csv was
// retired into it on 2026-08-19 at the pitmaster's call, since it recorded
// the same moves a second time. What the row does not keep is the tail of a
// walked-back order (re-advancing overwrites that stage's stamp) and the
// per-push Odoo errors, which now only reach the console.
//
// The status change is always written here first (it's the one thing that
// must never silently fail to save), then pushed on to Odoo's Fulfilment
// Status field, the status tag, and the invoice — all best-effort, see
// server/integrations/odoo.js setFulfilmentStatus / tagSaleOrderStatus /
// createAndPostInvoice. If Odoo is briefly unreachable the change here still
// sticks and those steps can be retried without walking the order back.
//
// The board itself *displays* Odoo's Fulfilment Status rather than this CSV
// (src/pages/ops/shared/orderFulfilment.tsx effectiveStatus), so what Odoo took is
// echoed back on save as odooFulfilment — otherwise the board would re-render
// the pre-save value it fetched and appear to undo the change.
import { readCsvFile, writeCsvFile } from '../../core/csvStore.js';
import { filePath } from '../../core/knowledgeBase.js';
import fs from 'fs';
import { tagSaleOrderStatus, setFulfilmentStatus, createAndPostInvoice } from '../../integrations/odoo.js';

const HEADER = [
  'order_id',
  'order_name',
  // B2C or B2B — which board the order was packed from. Same convention as
  // the channel column on smoking_stage_log.csv: one table for both sides,
  // told apart by a column rather than split into two files. It moved here
  // when order_fulfilment_log.csv was retired into this file; rows written
  // before that are blank (the pipeline is keyed by Odoo order id, which
  // doesn't say which board touched it).
  'channel',
  'status',
  'delivery_person',
  'in_smoker_at',
  'prepping_at',
  'packed_at',
  'finding_partner_at',
  'assigned_partner_at',
  'out_for_delivery_at',
  'delivered_at',
  'invoice_number',
  'invoice_id',
  'invoice_url',
  'invoice_error',
  'updated_at',
];

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

// Columns that were renamed rather than added, old name -> new name, so a
// file written before the rename carries its values across instead of
// losing them. 'dispatched_at' was this pipeline's single "on its way"
// stamp, before it split into finding_partner / assigned_partner /
// out_for_delivery.
const RENAMED_COLUMNS = { dispatched_at: 'out_for_delivery_at' };

// The file ships with just a header row — created here on first use too, in
// case a fresh knowledge-base checkout doesn't have it yet.
//
// An existing file's header is migrated up to HEADER here too, because
// writeCsvFile only ever writes the columns the header names: a file still
// carrying an older schema takes the status fine and then silently drops
// every stage timestamp HEADER has gained since — on every save, with
// no error to show for it.
function ensureFile() {
  const p = filePath('orderLifecycleLog');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `${HEADER.join(',')}\r\n`, 'utf8');
    return p;
  }

  const { header, rows } = readCsvFile(p);
  if (HEADER.every((column) => header.includes(column))) return p;

  rows.forEach((row) => {
    Object.entries(RENAMED_COLUMNS).forEach(([from, to]) => {
      if (row[from] && !row[to]) row[to] = row[from];
    });
  });
  writeCsvFile(p, HEADER, rows);
  return p;
}

function loadRows() {
  const path = ensureFile();
  return { path, ...readCsvFile(path) };
}

function rowToStatus(row) {
  const stageTimes = {};
  STATUS_STEPS.forEach((s) => {
    stageTimes[s.jsonKey] = row[s.atField] || null;
  });
  return {
    orderId: row.order_id,
    channel: row.channel || null,
    status: row.status || 'pending',
    deliveryPerson: row.delivery_person || null,
    ...stageTimes,
    invoice: row.invoice_number ? { number: row.invoice_number, id: row.invoice_id || null, url: row.invoice_url || null } : null,
    invoiceError: row.invoice_error || null,
  };
}

// orderIds: optional array (string or number) — omit to get every order that
// has a status on file.
function getPackingStatuses({ orderIds } = {}) {
  const { rows } = loadRows();
  const idSet = orderIds && orderIds.length ? new Set(orderIds.map(String)) : null;
  const byOrderId = {};
  rows.forEach((row) => {
    if (idSet && !idSet.has(String(row.order_id))) return;
    byOrderId[row.order_id] = rowToStatus(row);
  });
  return byOrderId;
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

  const { path, header, rows } = loadRows();
  let row = rows.find((r) => String(r.order_id) === String(orderId));
  if (!row) {
    row = { order_id: String(orderId) };
    rows.push(row);
  }

  const now = new Date().toISOString();
  row.order_name = orderName;
  row.status = status;
  // Blank on rows first written before the column existed, and never cleared
  // by a call that omits it.
  if (channel) row.channel = channel;
  // The delivery person's name is normally captured on the "partner assigned"
  // step, but the packing board also lets it be corrected at any later stage
  // (wrong name typed, partner swapped), so any non-empty value sent in wins.
  // An omitted/blank one never clears what's already on file.
  if (deliveryPerson && String(deliveryPerson).trim()) row.delivery_person = String(deliveryPerson).trim();
  const step = STATUS_STEPS.find((s) => s.status === status);
  if (step) row[step.atField] = now;
  row.updated_at = now;

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
    try {
      const invoice = await createAndPostInvoice({ orderId });
      row.invoice_number = invoice.invoiceNumber;
      row.invoice_id = String(invoice.invoiceId);
      row.invoice_url = invoice.invoiceUrl || '';
      row.invoice_error = '';
      // Odoo's Fulfilment Status has one stage past DELIVERED — INVOICED —
      // which isn't a local pipeline stage, so it's set here off the back of
      // the invoice actually posting rather than from a status change.
      let invoicedError = '';
      try {
        odooFulfilment = (await setFulfilmentStatus({ orderId, status: 'invoiced' })) || odooFulfilment;
      } catch (err) {
        invoicedError = err.message || String(err);
        console.error(`Failed to set Odoo Fulfilment Status on ${orderName} to invoiced:`, invoicedError);
      }
      // INVOICED is a stage past DELIVERED in Odoo with no local equivalent,
      // so it isn't a pipeline status here — the invoice columns above are
      // this row's record that it happened, and a failure to set it in Odoo
      // is only worth the console line above.
      if (invoicedError) row.invoice_error = invoicedError;
    } catch (err) {
      row.invoice_error = err.message || String(err);
      console.error(`Failed to create/post Odoo invoice for ${orderName}:`, row.invoice_error);
    }
  }

  writeCsvFile(path, header.length ? header : HEADER, rows);
  return { ...rowToStatus(row), odooError: odooError || null, odooFulfilment };
}

// Re-runs just the invoice step — for retrying after a failure (Odoo down,
// nothing marked "To Invoice" yet, etc.) without re-sending the order through
// the earlier pipeline stages again. Only valid once the order is already
// Delivered.
async function retryInvoice({ orderId, orderName }) {
  const { path, header, rows } = loadRows();
  const row = rows.find((r) => String(r.order_id) === String(orderId));
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
    row.invoice_error = err.message || String(err);
    writeCsvFile(path, header.length ? header : HEADER, rows);
    throw err;
  }
  row.invoice_number = invoice.invoiceNumber;
  row.invoice_id = String(invoice.invoiceId);
  row.invoice_url = invoice.invoiceUrl || '';
  row.invoice_error = '';
  const now = new Date().toISOString();
  row.updated_at = now;

  let odooFulfilment = null;
  let odooError = '';
  try {
    odooFulfilment = await setFulfilmentStatus({ orderId, status: 'invoiced' });
  } catch (err) {
    odooError = err.message || String(err);
    console.error(`Failed to set Odoo Fulfilment Status on ${orderName || orderId} to invoiced:`, odooError);
  }

  writeCsvFile(path, header.length ? header : HEADER, rows);
  return { ...rowToStatus(row), odooFulfilment };
}

export { getPackingStatuses, setPackingStatus, retryInvoice };
