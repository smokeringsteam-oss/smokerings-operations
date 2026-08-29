// Shared inventory read/adjust logic for raw_materials.csv/inventory.csv —
// used by both server/purchasing.js (adds stock) and server/smoking.js
// (consumes stock), so the on-hand quantity is one running number moved by
// whichever module touches it, not two separate copies of the same logic.
import { readCsvFile, writeCsvFile } from './csvStore.js';
import { requireFile } from './knowledgeBase.js';

function getRawMaterials() {
  return readCsvFile(requireFile('rawMaterials')).rows;
}

function getMeatMaterials() {
  return getRawMaterials().filter((m) => m.category === 'Meat');
}

function getInventory() {
  const materialsById = new Map(getRawMaterials().map((m) => [m.material_id, m]));
  return readCsvFile(requireFile('inventory')).rows.map((row) => {
    const material = materialsById.get(row.material_id);
    return {
      ...row,
      category: material?.category || '',
      reorder_level: material?.reorder_level || '',
    };
  });
}

function getLowStock() {
  return getInventory().filter((row) => {
    const onHand = Number(row.quantity_on_hand);
    const reorder = Number(row.reorder_level);
    return Number.isFinite(onHand) && Number.isFinite(reorder) && reorder > 0 && onHand < reorder;
  });
}

// Applies one or more { materialId, deltaQty, itemName } adjustments to
// inventory.csv in a single read/rewrite. Positive deltaQty = stock added
// (purchasing), negative = stock consumed (smoking). Adjustments with no
// materialId, or no matching inventory row, are reported in `skipped`
// rather than failing the whole batch — e.g. an ad hoc purchase line that
// isn't in the catalog yet.
function adjustInventory(adjustments, date) {
  const inventoryPath = requireFile('inventory');
  const { header, rows } = readCsvFile(inventoryPath);
  const applied = [];
  const skipped = [];

  adjustments.forEach(({ materialId, deltaQty, itemName }) => {
    if (!materialId) {
      skipped.push({ itemName, reason: 'no material_id' });
      return;
    }
    const row = rows.find((r) => r.material_id === materialId);
    if (!row) {
      skipped.push({ itemName, materialId, reason: 'not found in inventory.csv' });
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

export { getRawMaterials, getMeatMaterials, getInventory, getLowStock, adjustInventory };
