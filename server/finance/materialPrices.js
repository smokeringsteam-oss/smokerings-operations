// The price sheet — the form on the Cost to Make screen that closes the gaps
// server/finance/unitCost.js reports.
//
// unitCost.js will not guess: a material with no price, or no statement of
// what one purchased unit of it IS, is left out of every dish's cost and
// named in the gap list. That list is only useful if closing a gap is a
// minute's work, and before this it meant editing purchaseUnits.js. So this
// is the other half: every raw material, what the books already know about
// it, and the two things a person may need to add.
//
// What the purchase log already answers
// -------------------------------------
// A material that has been bought has a price — the newest line, exactly as
// unitCost.js reads it — and what is missing is the pack size behind that
// line's "1". So for those the sheet asks ONLY the pack size, and shows the
// purchases it would apply to so the person answering can see which "1" they
// are describing. A price typed over a real receipt would lose to the
// receipt anyway (newest purchase beats standard cost), so the sheet does not
// offer to.
//
// Three more things are read out of the log to save typing, all of them
// suggestions shown beside their source and saved only when someone presses
// Save:
//
//   * a pack size in a purchase line's wording — "Amul Blend Diced Cheese
//     200 g", or the "logged at the counter as ..." trail linkPurchaseToMaterial
//     leaves in the notes when it renames a line;
//   * a piece weight recorded on the purchase (weight_per_unit_kg);
//   * for purchases that were never linked to a material at all, the three
//     catalogue names they most resemble (materialMatch.js's local scorer —
//     no Gemini call, this is a read on every page load). Linking one is the
//     Purchasing screen's existing POST .../link, which moves its stock too.
//
// What stays out
// --------------
// The rub and brine gaps. Those are recipe lines with no quantity, and the
// rubs themselves have no ingredients or batch size recorded, so no price
// typed here could cost them. They are passed through as `recipeGaps` so the
// screen can say so rather than going quiet about them.
import { costMenuItems, priceMaterials } from './unitCost.js';
import { readMaterials, readMenu, readRecipes, readRecipeLines, readPurchases } from '../core/kbViews.js';
import { basisOf, formatCostBasis, packFromText, PACK_UNITS } from '../core/purchaseUnits.js';
import { setMaterialCost } from '../core/inventoryStore.js';
import { scoreMaterials } from '../ops/shared/materialMatch.js';

const isRawMaterial = (row) => (row.item_type || 'raw_material') === 'raw_material';

function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// How many of each shown on a row. Enough to see that the "1 at ₹100" is the
// same pot every time, few enough that the row stays a row.
const PURCHASES_SHOWN = 4;
const CANDIDATES_SHOWN = 3;
// Below this a "candidate" shares a stray bigram and nothing else ("Panini-
// Medium" against aluminium foil). The screen still offers every material in
// a dropdown; this only decides which get a one-click button.
const CANDIDATE_MIN_SCORE = 0.25;

// A basis back into the words the sheet's two inputs speak. A column basis
// already carries them; a purchaseUnits.js entry is stored in BoM units, so
// 1000 g is shown as 1 kg rather than as a pack of 1000.
function packOf(basis) {
  if (!basis) return null;
  if (basis.packUnit) return { packSize: basis.packSize, packUnit: basis.packUnit };
  if (basis.unit === 'g' && basis.bomUnits % 1000 === 0) return { packSize: basis.bomUnits / 1000, packUnit: 'kg' };
  if (basis.unit === 'ml' && basis.bomUnits % 1000 === 0) return { packSize: basis.bomUnits / 1000, packUnit: 'L' };
  return { packSize: basis.bomUnits, packUnit: PACK_UNITS[basis.unit] ? basis.unit : 'pcs' };
}

// The first pack size the purchase log offers for a material, newest buy
// first: wording on the line or its notes, then a recorded piece weight.
function suggestPack(bought) {
  for (const row of bought) {
    const fromText = packFromText(row.item_name) || packFromText(row.notes);
    if (fromText) return { ...fromText, from: row.purchase_id, why: 'in the purchase wording' };
    const pieceKg = num(row.weight_per_unit_kg);
    if (pieceKg != null && pieceKg > 0) {
      return pieceKg < 1
        ? { packSize: Math.round(pieceKg * 1000), packUnit: 'g', from: row.purchase_id, why: 'piece weight on the purchase' }
        : { packSize: pieceKg, packUnit: 'kg', from: row.purchase_id, why: 'piece weight on the purchase' };
    }
  }
  return null;
}

const purchaseView = (row) => ({
  purchaseId: row.purchase_id,
  date: row.purchase_date || '',
  vendor: row.vendor_name || row.vendor_id || '',
  itemName: row.item_name || '',
  quantity: num(row.quantity_purchased),
  unitPrice: num(row.unit_price),
  total: num(row.total_cost),
  notes: row.notes || '',
});

// Pure, like costMenuItems: the five tables in, the sheet out.
function buildPriceSheet({ materials, menu, recipes, recipeLines, purchases }) {
  const tables = { materials, menu, recipes, recipeLines, purchases };
  const book = costMenuItems(tables);
  const costs = priceMaterials({ materials, purchases });

  // Which dishes reach each material, off the walked leaves — so black pepper
  // inside the BBQ sauce counts against every burger the sauce is on.
  const dishesByMaterial = new Map();
  for (const item of book.items) {
    for (const entry of item.leaves) {
      if (!dishesByMaterial.has(entry.materialId)) dishesByMaterial.set(entry.materialId, new Set());
      dishesByMaterial.get(entry.materialId).add(item.name);
    }
  }

  const purchasesByMaterial = new Map();
  for (const row of purchases) {
    if (!row.material_id) continue;
    if (!purchasesByMaterial.has(row.material_id)) purchasesByMaterial.set(row.material_id, []);
    purchasesByMaterial.get(row.material_id).push(row);
  }

  // The BoM lines that use each material directly, with what they are a
  // quantity OF. The sheet shows these so a pack size can be sanity-checked
  // against the scale the recipe counts in: a coleslaw that uses 125 of egg
  // is counting grams, and a pack typed as "30 pcs" would make it cost ₹600.
  const menuIds = new Set(menu.map((dish) => dish.menu_id));
  const recipeById = new Map(recipes.map((recipe) => [recipe.recipe_id, recipe]));
  const usageByMaterial = new Map();
  for (const line of recipeLines) {
    const quantity = num(line.base_quantity) ?? num(line.quantity);
    if (quantity == null || line.is_to_taste === 'yes') continue;
    const isDish = menuIds.has(line.parent_id);
    const recipe = recipeById.get(line.parent_id);
    if (!isDish && !recipe) continue;
    if (!usageByMaterial.has(line.child_id)) usageByMaterial.set(line.child_id, []);
    usageByMaterial.get(line.child_id).push({
      parentId: line.parent_id,
      parentName: line.parent_name || line.parent_id,
      quantity,
      per: isDish ? 'plate' : 'batch',
      batchOutput: recipe ? num(recipe.output_quantity) : null,
    });
  }

  const raw = materials.filter(isRawMaterial);
  const rows = raw.map((material) => {
    const id = material.item_id;
    const cost = costs.get(id);
    const bought = purchasesByMaterial.get(id) || [];
    const basis = basisOf(id, material.cost_basis);
    const dishes = [...(dishesByMaterial.get(id) || [])];
    return {
      materialId: id,
      name: material.item_name || id,
      category: material.category || '',
      group: cost.group,
      dishes,
      dishCount: dishes.length,
      gap: cost.gap,
      // What the cost walk prices it at today, and from where.
      price: cost.price,
      standardCostInr: num(material.standard_cost_inr),
      costBasis: material.cost_basis || '',
      pack: packOf(basis),
      // 'sheet' is the column (anything typed here, or set before it
      // existed); 'books' is a purchaseUnits.js entry the column overrides.
      packFrom: !basis ? null : basis.packUnit ? 'sheet' : 'books',
      perBomUnit: cost.perBomUnit,
      bomUnit: basis?.unit || '',
      purchases: bought.slice(0, PURCHASES_SHOWN).map(purchaseView),
      purchaseCount: bought.length,
      suggestion: basis ? null : suggestPack(bought),
      usage: usageByMaterial.get(id) || [],
    };
  });

  // Worst first, the same order as the gap list: what blocks the most dishes
  // at the top, then everything already priced, then what no dish uses.
  const rank = (row) => (row.dishCount === 0 ? 2 : row.gap ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || b.dishCount - a.dishCount || a.name.localeCompare(b.name));

  // Bought, paid for, and never tied to a material — so its price reaches no
  // dish. Services (the Odoo subscription) are not ingredients and are left
  // out rather than offered as a match for one.
  const unlinked = purchases
    .filter((row) => !row.material_id && row.item_type !== 'service')
    .map((row) => ({
      ...purchaseView(row),
      pack: packFromText(row.item_name) || packFromText(row.notes),
      candidates: scoreMaterials(row.item_name, raw)
        .filter(({ score }) => score >= CANDIDATE_MIN_SCORE)
        .slice(0, CANDIDATES_SHOWN)
        .map(({ material, score }) => ({ materialId: material.item_id, name: material.item_name, score })),
    }));

  const used = rows.filter((row) => row.dishCount > 0);
  return {
    rows,
    unlinked,
    recipeGaps: book.gaps
      .filter((gap) => !/^RM-/.test(gap.id))
      .map((gap) => ({ id: gap.id, name: gap.name, reason: gap.reason, dishCount: gap.dishCount })),
    packUnits: Object.keys(PACK_UNITS),
    totals: {
      used: used.length,
      usedPriced: used.filter((row) => !row.gap).length,
      missing: used.filter((row) => row.gap).length,
      needPackOnly: used.filter((row) => row.gap === 'no pack size on file').length,
    },
  };
}

function readTables() {
  return {
    materials: readMaterials(),
    menu: readMenu(),
    recipes: readRecipes(),
    recipeLines: readRecipeLines(),
    purchases: readPurchases(),
  };
}

const buildMaterialPriceSheet = () => buildPriceSheet(readTables());

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// One row of the sheet saved. The pack size is required — it is the half the
// purchase log can never supply — and the price is optional, because a
// material the log already prices only needs the pack.
//
// Returns the whole sheet rebuilt, so the screen shows the new cost per gram
// and the new totals from the same walk the report will use.
function saveMaterialPrice({ materialId, priceInr, packSize, packUnit }) {
  const material = readMaterials().find((row) => row.item_id === materialId && isRawMaterial(row));
  if (!material) {
    const err = new Error(`No raw material found with id ${materialId}.`);
    err.status = 404;
    throw err;
  }

  const costBasis = formatCostBasis(packSize, packUnit);
  if (!costBasis) {
    throw badRequest(`Pack size needs a number above zero and one of: ${Object.keys(PACK_UNITS).join(', ')}.`);
  }

  let standardCostInr;
  if (priceInr !== undefined && priceInr !== null && priceInr !== '') {
    standardCostInr = Number(priceInr);
    // Zero is refused rather than stored: unitCost.js reads a zero standard
    // cost as no price at all, so saving one would look like it worked and
    // change nothing.
    if (!Number.isFinite(standardCostInr) || standardCostInr <= 0) {
      throw badRequest('Price needs to be a number of rupees above zero.');
    }
  }

  setMaterialCost({ materialId, costBasis, standardCostInr });
  return { savedId: materialId, ...buildMaterialPriceSheet() };
}

export { buildPriceSheet, buildMaterialPriceSheet, saveMaterialPrice, suggestPack, packOf };
