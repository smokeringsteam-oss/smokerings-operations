// Weekly Purchasing module — reads/writes the shared knowledge-base data
// files (vendors, purchase log) that live in the separate `knowledge-base`
// repo, sibling to this project. Raw materials/inventory logic lives in
// server/core/inventoryStore.js (shared with server/ops/shared/smoking.js), and file
// locations live in server/core/knowledgeBase.js (shared by both).
//
// vendors.csv is master data this module never writes to — it only ever
// appends to purchase_log.csv (an append-only log, renamed from
// purchases.csv by the knowledge-base repo's v2 restructure; same columns)
// and, via inventoryStore.adjustInventory, updates on-hand quantities in
// materials.csv.
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from '../../core/csvStore.js';
import { requireFile, getConfig } from '../../core/knowledgeBase.js';
import {
  getRawMaterials,
  getInventory,
  getLowStock,
  adjustInventory,
  getInventoryAdjustments,
  addInventoryAdjustment,
} from '../../core/inventoryStore.js';

// Which side of the business a buy was made for. Purchases are otherwise
// channel-agnostic — the same vendors, the same materials.csv catalog, and
// crucially the same inventory pool: 20kg of pork bought "for B2B" still
// lands in one stock count that any smoking session draws from. The column
// records intent (whose money/plan this buy was against), which is what
// makes cost attribution per side of the book possible; it is deliberately
// NOT a separate stock bucket.
const PURCHASE_CHANNELS = ['B2C', 'B2B'];

// purchase_log.csv gained `channel` when B2B purchasing did, then three more
// columns when B2B cost attribution did. Same one-time migration as
// smoking_log.csv's session_purpose (see sessionsFile() in server/ops/shared/smoking.js)
// and for the same reason: writeCsvFile/appendCsvRows only ever write the
// columns the header names, so a file still on the old header would take the
// value and silently drop it on every save.
//
// What each of the newer three records:
//   client_id / client_name  — which B2B account this spend is FOR, so the
//     money side of the book can be totalled per account. Set on the buy
//     itself for things that never reach a smoker (packaging, bread), or
//     inherited from the session when a line is tagged to a cook.
//   smoking_session_id       — which cook this line was bought for. Written
//     at Start Smoking (see tagPurchasesToSession), NOT here: at buying time
//     the session usually doesn't exist yet, since a session row is only
//     created once brining starts.
//
// This is deliberately independent of smoking_log.csv's source_purchase_id.
// That column says which lot a session's raw weight was actually drawn from
// (it drives the FIFO "remaining" maths); this one says which cook a line of
// spend belongs to, which can cover the rub spices and the packaging too. A
// session normally has both and they normally agree, but they answer
// different questions and neither is derived from the other.
const ADDED_PURCHASE_COLUMNS = ['channel', 'client_id', 'client_name', 'smoking_session_id'];

// Existing rows backfill `channel` to B2C — every purchase logged before that
// column existed was for the weekend B2C flow, which is the only thing the
// module served. The other three backfill blank: there is no honest value to
// invent for "which account/cook was this for" after the fact.
let purchaseColumnsChecked = false;
function purchasesFile() {
  const path = requireFile('purchases');
  if (purchaseColumnsChecked) return path;

  const { header, rows } = readCsvFile(path);
  const missing = ADDED_PURCHASE_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length) {
    // Inserted as a block after purchase_date so the "who/what was this for"
    // columns read together, wherever the checkout's header started from.
    const migrated = [...header];
    const anchor = migrated.indexOf('purchase_date');
    migrated.splice(anchor >= 0 ? anchor + 1 : migrated.length, 0, ...missing);
    rows.forEach((row) => {
      missing.forEach((col) => {
        row[col] = row[col] || (col === 'channel' ? 'B2C' : '');
      });
    });
    writeCsvFile(path, migrated, rows);
  }
  purchaseColumnsChecked = true;
  return path;
}

function getVendors() {
  return readCsvFile(requireFile('vendors')).rows;
}

// Appends a new row to vendors.csv (master data this module otherwise never
// writes to — this is the one deliberate exception). Rejects an exact
// case-insensitive name match rather than creating a near-duplicate vendor.
function addVendor({ vendorName, vendorType, suppliesCategory, contactPerson, phone, email, address, notes }) {
  const name = (vendorName || '').trim();
  if (!name) {
    const err = new Error('vendorName is required.');
    err.status = 400;
    throw err;
  }

  const vendorsPath = requireFile('vendors');
  const { header, rows } = readCsvFile(vendorsPath);

  const existing = rows.find((r) => r.vendor_name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    const err = new Error(`Vendor "${name}" already exists (${existing.vendor_id}).`);
    err.status = 409;
    throw err;
  }

  const vendorId = nextSequentialId(rows, 'vendor_id', 'VEN');
  const row = {
    vendor_id: vendorId,
    vendor_name: name,
    vendor_type: vendorType || '',
    supplies_category: suppliesCategory || '',
    contact_person: contactPerson || '',
    phone: phone || '',
    email: email || '',
    address: address || '',
    notes: notes || '',
  };

  appendCsvRows(vendorsPath, header, [row]);
  return { vendor: row };
}

function getPurchases({ from, to, channel } = {}) {
  const rows = readCsvFile(purchasesFile()).rows;
  return rows
    .filter((row) => {
      // Rows written before the column existed read as B2C, same as the
      // backfill — so filtering to B2C never hides history.
      if (channel && (row.channel || 'B2C') !== channel) return false;
      if (!row.purchase_date) return true;
      if (from && row.purchase_date < from) return false;
      if (to && row.purchase_date > to) return false;
      return true;
    })
    .sort((a, b) => (a.purchase_date < b.purchase_date ? 1 : a.purchase_date > b.purchase_date ? -1 : 0));
}

// lines: [{ materialId, itemName, quantity, unit, unitPrice, clientId, clientName }]
// Appends one purchase_log.csv row per line, then bumps quantity_on_hand for
// any line whose materialId matches a known inventory row (lines without a
// materialId — e.g. an ad hoc item not yet in the catalog — are logged in
// purchase_log.csv but skipped for inventory update).
//
// The client tag is per line, not per purchase, because one trip to the
// butcher routinely covers two accounts, and one cart routinely mixes a
// client's meat with packaging bought for nobody in particular. Tagging the
// whole cart would force a lie on at least one of those lines. It is always
// optional — an untagged line is general overhead, which is a real answer,
// not a missing one.
function recordPurchases({ vendorName, purchaseDate, channel, lines }) {
  if (!vendorName) {
    const err = new Error('vendorName is required.');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(lines) || !lines.length) {
    const err = new Error('At least one line item is required.');
    err.status = 400;
    throw err;
  }

  const buyingFor = channel || 'B2C';
  if (!PURCHASE_CHANNELS.includes(buyingFor)) {
    const err = new Error(`channel must be one of: ${PURCHASE_CHANNELS.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const purchasesPath = purchasesFile();
  const { header: purchasesHeader, rows: existingPurchases } = readCsvFile(purchasesPath);

  // purchase_log.csv's real header is vendor_id/vendor_name, not a bare
  // "supplier" field — look the vendor up by name (same case-insensitive
  // exact match addVendor uses) so both land correctly. Falls back to just
  // the name if the vendor isn't in vendors.csv yet (e.g. logged before
  // being added there), so the row still records who it was bought from.
  const vendorRow = getVendors().find((v) => v.vendor_name.trim().toLowerCase() === vendorName.trim().toLowerCase());

  const date = purchaseDate || new Date().toISOString().slice(0, 10);
  const createdRows = [];
  const firstId = nextSequentialId(existingPurchases, 'purchase_id', 'PUR');
  const idWidth = firstId.split('-')[1].length;
  let nextNum = Number(firstId.split('-')[1]);

  lines.forEach((line) => {
    if (!line.itemName || !line.quantity) return;
    const purchaseId = `PUR-${String(nextNum).padStart(idWidth, '0')}`;
    nextNum += 1;

    const quantity = Number(line.quantity) || 0;
    const unitPrice = line.unitPrice != null && line.unitPrice !== '' ? Number(line.unitPrice) : '';
    const totalCost = unitPrice !== '' ? Math.round(quantity * unitPrice * 100) / 100 : '';

    createdRows.push({
      purchase_id: purchaseId,
      purchase_date: date,
      channel: buyingFor,
      // B2C has no account book to attribute to, so the tag is ignored there
      // rather than quietly stored on a row nothing will ever total by client.
      client_id: buyingFor === 'B2B' ? line.clientId || '' : '',
      client_name: buyingFor === 'B2B' ? line.clientName || '' : '',
      // Always blank here — filled later at Start Smoking, see
      // tagPurchasesToSession.
      smoking_session_id: '',
      vendor_id: vendorRow?.vendor_id || '',
      vendor_name: vendorName,
      item_type: line.materialId ? 'material' : '',
      material_id: line.materialId || '',
      item_name: line.itemName,
      quantity_purchased: quantity,
      unit_of_measure: line.unit || '',
      unit_price: unitPrice,
      total_cost: totalCost,
      currency: 'INR',
    });
  });

  if (!createdRows.length) {
    const err = new Error('No valid line items (each needs an item name and a quantity).');
    err.status = 400;
    throw err;
  }

  appendCsvRows(purchasesPath, purchasesHeader, createdRows);

  const adjustments = createdRows
    .filter((row) => row.material_id)
    .map((row) => ({ materialId: row.material_id, deltaQty: row.quantity_purchased, itemName: row.item_name }));
  const { applied: inventoryUpdated } = adjustInventory(adjustments, date);

  return { purchases: createdRows, inventoryUpdated };
}

// Writes the Odoo draft-PO id + line id back onto the purchase_log.csv rows
// created by a prior recordPurchases() call, once send-po succeeds — this is
// what lets deletePurchase() later remove the exact matching Odoo line
// instead of the whole PO. purchaseIds and lineIds are parallel arrays (same
// order as the `lines` sent to createPurchaseOrder).
function linkPurchasesToOdoo({ purchaseIds, poId, lineIds }) {
  if (!Array.isArray(purchaseIds) || !purchaseIds.length || !poId) return { linked: [] };

  const purchasesPath = purchasesFile();
  const { header, rows } = readCsvFile(purchasesPath);
  const linked = [];

  purchaseIds.forEach((purchaseId, idx) => {
    const row = rows.find((r) => r.purchase_id === purchaseId);
    if (!row) return;
    row.odoo_po_id = poId;
    row.odoo_po_line_id = lineIds?.[idx] || '';
    linked.push(purchaseId);
  });

  if (linked.length) writeCsvFile(purchasesPath, header, rows);
  return { linked };
}

// Removes a purchase_log.csv row entirely and reverses its effect on
// materials.csv (the opposite of recordPurchases' adjustInventory call).
// Does NOT touch Odoo itself — the caller (index.js) uses the returned
// odoo_po_id/odoo_po_line_id to remove the matching PO line separately, so a
// failed Odoo call doesn't block the CSV-side delete.
function deletePurchase(purchaseId) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }

  const purchasesPath = purchasesFile();
  const { header, rows } = readCsvFile(purchasesPath);
  const index = rows.findIndex((r) => r.purchase_id === purchaseId);
  if (index === -1) {
    const err = new Error(`No purchase found with id ${purchaseId}.`);
    err.status = 404;
    throw err;
  }

  const [deleted] = rows.splice(index, 1);
  writeCsvFile(purchasesPath, header, rows);

  let inventoryReversal = null;
  if (deleted.material_id) {
    const { applied } = adjustInventory(
      [{ materialId: deleted.material_id, deltaQty: -Number(deleted.quantity_purchased || 0), itemName: deleted.item_name }],
      new Date().toISOString().slice(0, 10),
    );
    inventoryReversal = applied[0] || null;
  }

  return { deleted, inventoryReversal };
}

// Records which cook a set of purchase_log.csv lines was bought for. Called
// at Start Smoking (see startSmoking in server/ops/shared/smoking.js), which is the
// first moment the session actually exists to point at — you buy the meat on
// Thursday and the SMK-xxx row is only created when it goes into the brine.
//
// `purchaseIds` is the complete set for this session, not a delta: anything
// currently tagged to it and absent from the list gets untagged, so the
// pitmaster unticking a line in the UI actually removes the tag. Lines
// already tagged to a DIFFERENT session are skipped rather than stolen —
// two cooks can't both have been the reason for the same buy, and silently
// re-pointing one would corrupt the earlier cook's cost with no trace.
//
// Untagging deliberately leaves client_id alone. Which account the money was
// for is a fact about the purchase that outlives any particular cook, and a
// line bought for a client stays bought for that client even if it ends up
// feeding a different session.
function tagPurchasesToSession({ sessionId, purchaseIds, clientId, clientName }) {
  if (!sessionId) {
    const err = new Error('sessionId is required.');
    err.status = 400;
    throw err;
  }

  const wanted = new Set(Array.isArray(purchaseIds) ? purchaseIds.filter(Boolean) : []);
  const purchasesPath = purchasesFile();
  const { header, rows } = readCsvFile(purchasesPath);

  const tagged = [];
  const untagged = [];
  const skipped = [];

  rows.forEach((row) => {
    const alreadyMine = row.smoking_session_id === sessionId;
    if (wanted.has(row.purchase_id)) {
      if (row.smoking_session_id && !alreadyMine) {
        skipped.push({ purchase_id: row.purchase_id, taggedTo: row.smoking_session_id });
        return;
      }
      row.smoking_session_id = sessionId;
      // A client set on the buy itself wins over the session's: whoever
      // logged the purchase said outright who it was for, which beats
      // inheriting it from whichever cook happened to consume the line.
      if (clientId && !row.client_id) {
        row.client_id = clientId;
        row.client_name = clientName || '';
      }
      tagged.push(row.purchase_id);
    } else if (alreadyMine) {
      row.smoking_session_id = '';
      untagged.push(row.purchase_id);
    }
  });

  if (tagged.length || untagged.length) writeCsvFile(purchasesPath, header, rows);
  return { tagged, untagged, skipped };
}

// Drops every purchase tag pointing at a session — used when the session row
// itself is deleted, so the spend goes back to being untagged rather than
// pointing at an SMK id that no longer resolves.
function clearSessionPurchaseTags(sessionId) {
  if (!sessionId) return { tagged: [], untagged: [], skipped: [] };
  return tagPurchasesToSession({ sessionId, purchaseIds: [] });
}

export {
  PURCHASE_CHANNELS,
  getConfig,
  getVendors,
  addVendor,
  getRawMaterials,
  getInventory,
  getLowStock,
  getPurchases,
  recordPurchases,
  linkPurchasesToOdoo,
  tagPurchasesToSession,
  clearSessionPurchaseTags,
  deletePurchase,
  getInventoryAdjustments,
  addInventoryAdjustment,
};
