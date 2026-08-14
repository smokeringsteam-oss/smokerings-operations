// Weekly Purchasing module — reads/writes the shared knowledge-base data
// files (vendors, purchases) that live in the separate `knowledge-base`
// repo, sibling to this project. Raw materials/inventory logic lives in
// server/inventoryStore.js (shared with server/smoking.js), and file
// locations live in server/knowledgeBase.js (shared by both).
//
// vendors.csv and raw_materials.csv are master data this module never
// writes to — it only ever appends to purchases.csv (an append-only log)
// and, via inventoryStore.adjustInventory, updates on-hand quantities in
// inventory.csv.
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from './csvStore.js';
import { requireFile, getConfig } from './knowledgeBase.js';
import { getRawMaterials, getInventory, getLowStock, adjustInventory } from './inventoryStore.js';

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

function getPurchases({ from, to } = {}) {
  const rows = readCsvFile(requireFile('purchases')).rows;
  return rows
    .filter((row) => {
      if (!row.purchase_date) return true;
      if (from && row.purchase_date < from) return false;
      if (to && row.purchase_date > to) return false;
      return true;
    })
    .sort((a, b) => (a.purchase_date < b.purchase_date ? 1 : a.purchase_date > b.purchase_date ? -1 : 0));
}

// lines: [{ materialId, itemName, quantity, unit, unitPrice }]
// Appends one purchases.csv row per line, then bumps quantity_on_hand for
// any line whose materialId matches a known inventory row (lines without a
// materialId — e.g. an ad hoc item not yet in the catalog — are logged in
// purchases.csv but skipped for inventory update).
function recordPurchases({ vendorName, purchaseDate, lines }) {
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

  const purchasesPath = requireFile('purchases');
  const { header: purchasesHeader, rows: existingPurchases } = readCsvFile(purchasesPath);

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
      material_id: line.materialId || '',
      item_name: line.itemName,
      purchase_date: date,
      quantity_purchased: quantity,
      unit_of_measure: line.unit || '',
      unit_price: unitPrice,
      total_cost: totalCost,
      currency: 'INR',
      supplier: vendorName,
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

// Writes the Odoo draft-PO id + line id back onto the purchases.csv rows
// created by a prior recordPurchases() call, once send-po succeeds — this is
// what lets deletePurchase() later remove the exact matching Odoo line
// instead of the whole PO. purchaseIds and lineIds are parallel arrays (same
// order as the `lines` sent to createPurchaseOrder).
function linkPurchasesToOdoo({ purchaseIds, poId, lineIds }) {
  if (!Array.isArray(purchaseIds) || !purchaseIds.length || !poId) return { linked: [] };

  const purchasesPath = requireFile('purchases');
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

// Removes a purchases.csv row entirely and reverses its effect on
// inventory.csv (the opposite of recordPurchases' adjustInventory call).
// Does NOT touch Odoo itself — the caller (index.js) uses the returned
// odoo_po_id/odoo_po_line_id to remove the matching PO line separately, so a
// failed Odoo call doesn't block the CSV-side delete.
function deletePurchase(purchaseId) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }

  const purchasesPath = requireFile('purchases');
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

export {
  getConfig,
  getVendors,
  addVendor,
  getRawMaterials,
  getInventory,
  getLowStock,
  getPurchases,
  recordPurchases,
  linkPurchasesToOdoo,
  deletePurchase,
};
