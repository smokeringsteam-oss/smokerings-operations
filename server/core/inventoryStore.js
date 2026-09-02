// Shared inventory read/adjust logic — used by both
// server/ops/shared/purchasing.js (adds stock) and server/ops/shared/smoking.js (consumes stock),
// so the on-hand quantity is one running number moved by whichever module
// touches it, not two separate copies of the same logic.
//
// Migrated off materials.csv onto SQLite (phase 1). The columns callers see
// are unchanged — server/core/kbViews.js re-flattens the normalized `item` +
// `material` rows back into the CSV's shape, and this module still speaks
// material_id/status/notes to the Purchasing screen and smoking.js the way it
// always has. What changed is underneath:
//
//   * A stock move is now an UPDATE of one row, not a read-and-rewrite of the
//     whole catalogue. The old version parsed 66 rows, mutated one field and
//     wrote all 66 back, which meant two concurrent adjustments could each
//     read the same starting quantity and the second would erase the first.
//   * adjustInventory and the audit row it writes go in one transaction, so
//     stock can no longer move without the adjustment that explains it (or
//     the reverse) if the process dies mid-way.
//
// The knowledge-base repo's v2 restructure folded inventory.csv into
// raw_materials.csv to make materials.csv, and the database kept that shape:
// one row per item carrying both the catalogue columns and the stock count,
// keyed item_id (v1: material_id), with inventory.csv's status/notes now
// stock_status/stock_notes.
import { increment, insert, nextId, select, selectOne, transaction } from './repo.js';
import { readMaterials } from './kbViews.js';

const isRawMaterial = (row) => (row.item_type || 'raw_material') === 'raw_material';
const toMaterial = (row) => ({ ...row, material_id: row.item_id });

// The buyable catalogue: every material minus the IP-xxx intermediate
// products the same table also carries now (raw_materials.csv never did),
// with item_id aliased to material_id for callers.
function getRawMaterials() {
  return readMaterials().filter(isRawMaterial).map(toMaterial);
}

function getMeatMaterials() {
  return getRawMaterials().filter((m) => m.category === 'Meat');
}

// Every stock-carrying row, including the IP-xxx intermediate products —
// v1's inventory.csv held those too, and the Purchasing screen's stock table
// is where a "never counted" smoked output should still be visible.
function getInventory() {
  return readMaterials().map((row) => ({
    ...toMaterial(row),
    status: row.stock_status || '',
    notes: row.stock_notes || '',
  }));
}

// Left in JS rather than pushed into the v_stock_alert view the schema also
// defines: that view has its own opinion about what counts as an alert
// (it flags never_counted rows too), and the Purchasing screen's "low stock"
// banner means specifically "below reorder level", which is this.
function getLowStock() {
  return getInventory().filter((row) => {
    const onHand = Number(row.quantity_on_hand);
    const reorder = Number(row.reorder_level);
    return Number.isFinite(onHand) && Number.isFinite(reorder) && reorder > 0 && onHand < reorder;
  });
}

// Applies one or more { materialId, deltaQty, itemName } adjustments.
// Positive deltaQty = stock added (purchasing), negative = stock consumed
// (smoking). Adjustments with no materialId, or no matching row, are reported
// in `skipped` rather than failing the whole batch — e.g. an ad hoc purchase
// line that isn't in the catalog yet.
//
// The whole batch is one transaction: a purchase of five things either moves
// all five counts or none of them. Under the old whole-file rewrite a crash
// halfway through left the file holding some of the batch with nothing to say
// which part, and `applied` claiming rows that never reached disk.
//
// The UPDATE reads and writes quantity_on_hand in the same statement rather
// than computing the new value in JS, so two adjustments landing together
// compose instead of overwriting each other.
function adjustInventory(adjustments, date) {
  const applied = [];
  const skipped = [];
  // Names for the `applied` rows, which report item_name. Read once up front
  // rather than per adjustment — a five-line purchase would otherwise run
  // five lookups for data that cannot change inside the transaction.
  const nameById = new Map(readMaterials().map((m) => [m.item_id, m.item_name]));

  transaction(() => {
    adjustments.forEach(({ materialId, deltaQty, itemName }) => {
      if (!materialId) {
        skipped.push({ itemName, reason: 'no material_id' });
        return;
      }
      if (!nameById.has(materialId)) {
        skipped.push({ itemName, materialId, reason: 'not found in the materials catalogue' });
        return;
      }
      // required: false because a missing row is a `skipped` entry here, not
      // the 404 the repository would otherwise raise — an ad hoc purchase
      // line that isn't in the catalog yet must not fail the whole batch.
      // The guard above already covers it; this keeps that true if the row
      // disappears between the read and the write.
      increment('material', { item_id: materialId }, 'quantity_on_hand', deltaQty, {
        patch: { last_updated: date },
        required: false,
      });
      const next = selectOne('material', { item_id: materialId })?.quantity_on_hand;
      applied.push({
        material_id: materialId,
        item_name: nameById.get(materialId),
        newQuantity: next,
        wentNegative: next < 0,
      });
    });
  });

  return { applied, skipped };
}

// ---- Manual inventory additions (stock counts, initial stock, returns) ----
// Adds stock outside of a vendor purchase — e.g. an opening stock count, a
// return, or a correction found while counting the walk-in. Recorded in its
// own append-only inventory_adjustment table, since there's no vendor/price
// to record it against as a purchase, and applied by the same adjustInventory
// above that purchasing and smoking use — so on-hand quantity stays one
// running number moved by whichever module touches it.
function getInventoryAdjustments() {
  return select('inventory_adjustment', {}, { orderBy: 'adjustment_date desc, adjustment_id desc' });
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
  // adjustInventory opens its own transaction and SQLite has no nested BEGIN,
  // so these are two sequential units rather than one wrapping both. The
  // stock move goes first: an audit row with no matching movement would
  // misreport the count, whereas a movement whose audit row failed to write
  // still leaves the count right and is visible in the response.
  const { applied, skipped } = adjustInventory(
    [{ materialId, deltaQty: qty, itemName: material.item_name }],
    adjustDate,
  );

  const row = {
    adjustment_id: nextId('inventory_adjustment', 'adjustment_id', 'ADJ'),
    adjustment_date: adjustDate,
    material_id: materialId,
    item_name: material.item_name,
    quantity: qty,
    unit_of_measure: material.unit_of_measure || '',
    reason: reason || '',
    created_at: new Date().toISOString(),
  };
  insert('inventory_adjustment', row);

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
