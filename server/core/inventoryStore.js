// Shared inventory read/adjust logic for materials.csv — used by both
// server/ops/shared/purchasing.js (adds stock) and server/ops/shared/smoking.js (consumes stock),
// so the on-hand quantity is one running number moved by whichever module
// touches it, not two separate copies of the same logic.
//
// The knowledge-base repo's v2 restructure folded inventory.csv into
// raw_materials.csv to make materials.csv: one row per item carrying both
// the catalogue columns and the stock count, keyed item_id (v1:
// material_id), with inventory.csv's status/notes now stock_status/
// stock_notes and its inventory_id/location columns dropped. This module
// keeps speaking material_id/status/notes to its callers — that's the shape
// the Purchasing screen and server/ops/shared/smoking.js already read — and does the
// translation at the file boundary.
import fs from 'fs';
import path from 'path';
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from './csvStore.js';
import { requireFile, getDataDir } from './knowledgeBase.js';

function readMaterials() {
  return readCsvFile(requireFile('rawMaterials'));
}

const isRawMaterial = (row) => (row.item_type || 'raw_material') === 'raw_material';
const toMaterial = (row) => ({ ...row, material_id: row.item_id });

// The buyable catalogue: materials.csv minus the IP-xxx intermediate
// products it also carries now (raw_materials.csv never did), with item_id
// aliased to material_id for callers.
function getRawMaterials() {
  return readMaterials().rows.filter(isRawMaterial).map(toMaterial);
}

function getMeatMaterials() {
  return getRawMaterials().filter((m) => m.category === 'Meat');
}

// Every stock-carrying row, including the IP-xxx intermediate products —
// v1's inventory.csv held those too, and the Purchasing screen's stock table
// is where a "never counted" smoked output should still be visible. category
// and reorder_level used to be joined in from raw_materials.csv; they're
// columns on the same row now.
function getInventory() {
  return readMaterials().rows.map((row) => ({
    ...toMaterial(row),
    status: row.stock_status || '',
    notes: row.stock_notes || '',
  }));
}

function getLowStock() {
  return getInventory().filter((row) => {
    const onHand = Number(row.quantity_on_hand);
    const reorder = Number(row.reorder_level);
    return Number.isFinite(onHand) && Number.isFinite(reorder) && reorder > 0 && onHand < reorder;
  });
}

// Applies one or more { materialId, deltaQty, itemName } adjustments to
// materials.csv in a single read/rewrite. Positive deltaQty = stock added
// (purchasing), negative = stock consumed (smoking). Adjustments with no
// materialId, or no matching row, are reported in `skipped` rather than
// failing the whole batch — e.g. an ad hoc purchase line that isn't in the
// catalog yet.
//
// Stock and catalogue now share a file, so this rewrite touches the rows the
// vendor/cost data sits on. Only quantity_on_hand and last_updated are
// assigned; every other column travels back untouched on the same row
// object, and csvStore hands rows nothing changed on back verbatim.
function adjustInventory(adjustments, date) {
  const inventoryPath = requireFile('rawMaterials');
  const { header, rows } = readCsvFile(inventoryPath);
  const applied = [];
  const skipped = [];

  adjustments.forEach(({ materialId, deltaQty, itemName }) => {
    if (!materialId) {
      skipped.push({ itemName, reason: 'no material_id' });
      return;
    }
    const row = rows.find((r) => r.item_id === materialId);
    if (!row) {
      skipped.push({ itemName, materialId, reason: 'not found in materials.csv' });
      return;
    }
    const current = Number(row.quantity_on_hand) || 0;
    const next = Math.round((current + deltaQty) * 100) / 100;
    row.quantity_on_hand = next;
    row.last_updated = date;
    applied.push({ material_id: materialId, item_name: row.item_name, newQuantity: next, wentNegative: next < 0 });
  });

  if (applied.length) {
    writeCsvFile(inventoryPath, header, rows);
  }

  return { applied, skipped };
}

// ---- Manual inventory additions (stock counts, initial stock, returns) ----
// Adds stock outside of a vendor purchase — e.g. an opening stock count, a
// return, or a correction found while counting the walk-in. Logged to its
// own inventory_adjustments.csv (an append-only audit trail, same "ships
// with just a header, created on first use" pattern as
// server/ops/shared/orderPackingStatus.js) since there's no vendor/price to record it
// against in purchase_log.csv, then applied via adjustInventory — the same
// function purchasing/smoking use, so on-hand quantity stays one running
// number moved by whichever module touches it.
const ADJUSTMENTS_HEADER = [
  'adjustment_id',
  'adjustment_date',
  'material_id',
  'item_name',
  'quantity',
  'unit_of_measure',
  'reason',
  'created_at',
];

// Deliberately not in knowledgeBase.js's FILES map — see the note there.
const ADJUSTMENTS_FILE = 'inventory_adjustments.csv';

function ensureAdjustmentsFile() {
  const p = path.join(getDataDir(), ADJUSTMENTS_FILE);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `${ADJUSTMENTS_HEADER.join(',')}\r\n`, 'utf8');
  }
  return p;
}

function getInventoryAdjustments() {
  const path = ensureAdjustmentsFile();
  return readCsvFile(path)
    .rows.sort((a, b) => (a.adjustment_date < b.adjustment_date ? 1 : a.adjustment_date > b.adjustment_date ? -1 : 0));
}

function addInventoryAdjustment({ materialId, quantity, reason, date }) {
  if (!materialId) {
    const err = new Error('materialId is required.');
    err.status = 400;
    throw err;
  }
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    const err = new Error('quantity must be greater than 0.');
    err.status = 400;
    throw err;
  }
  const material = getRawMaterials().find((m) => m.material_id === materialId);
  if (!material) {
    const err = new Error('Unknown material — pick one from the catalog.');
    err.status = 400;
    throw err;
  }

  const adjustDate = date || new Date().toISOString().slice(0, 10);
  const { applied, skipped } = adjustInventory(
    [{ materialId, deltaQty: qty, itemName: material.item_name }],
    adjustDate,
  );

  const path = ensureAdjustmentsFile();
  const { header, rows } = readCsvFile(path);
  const row = {
    adjustment_id: nextSequentialId(rows, 'adjustment_id', 'ADJ'),
    adjustment_date: adjustDate,
    material_id: materialId,
    item_name: material.item_name,
    quantity: qty,
    unit_of_measure: material.unit_of_measure || '',
    reason: reason || '',
    created_at: new Date().toISOString(),
  };
  appendCsvRows(path, header.length ? header : ADJUSTMENTS_HEADER, [row]);

  return { adjustment: row, inventoryUpdated: applied[0] || null, inventorySkipped: skipped[0] || null };
}

export {
  getRawMaterials,
  getMeatMaterials,
  getInventory,
  getLowStock,
  adjustInventory,
  getInventoryAdjustments,
  addInventoryAdjustment,
};
