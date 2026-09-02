// Menu/recipe data — drives the Weekend Prep Planner's "Sides needed" +
// Swiggy shopping list (Step 2), replacing the old hardcoded/assumed recipe
// guesses with the real menu.csv / recipe_lines.csv / recipes.csv files.
//
// Data model (the knowledge-base repo's v2 restructure merged five recipe
// tables into two — see its Data/MIGRATION.md; this module was migrated onto
// them on 2026-08-19):
//   menu.csv         — the sellable dishes, keyed by menu_id slug.
//   recipe_lines.csv — one flat bill-of-materials table. Every row says
//                      "parent_id contains `quantity` of child_id", and it
//                      covers three parents that used to live in separate
//                      files:
//                        * a menu_id slug — the per-order BoM for a dish
//                          (was menu_recipe_ingredients.csv);
//                        * an SR-xxx sub-recipe — its raw ingredients (was
//                          sub_recipe_ingredients.csv);
//                        * an IP-xxx smoked product — its raw cut and its
//                          rub/brine (new in v2; those quantities aren't
//                          recorded yet, which is why rubs still don't reach
//                          the buy list).
//                      The three id spaces don't collide, so parent_id alone
//                      says which pass a row belongs to — that's what
//                      getMenuRecipeLines/getSubRecipeLines below split on.
//                      child_type is `material` (a materials.csv item) or
//                      `recipe` (a recipes.csv row). Note that `recipe`
//                      covers both sub-recipes and smoked products, which v1
//                      kept apart as component_type sub_recipe vs
//                      intermediate_product; here the IP- prefix on child_id
//                      is what tells them apart. An IP- child is the meat
//                      component ("Pulled chicken/pork", "Smoked pork ribs",
//                      …) and is excluded from the Swiggy list — that's the
//                      Smoking module's concern.
//                      quantity/unit is the human amount; base_quantity/
//                      base_unit is the same amount normalised to the
//                      child's own stock unit (g, ml, roll, …) via units.csv
//                      — that's the column this module sums, so mixed units
//                      across recipes (Lemon in g vs pcs, Garlic in g vs
//                      cloves, …) no longer need to match by hand to be
//                      added together.
//                      is_to_taste="yes" marks a qualitative line ("to
//                      taste", "pinch") that has no reliable quantity to
//                      extrapolate — skipped here and reported rather than
//                      guessed at. status="needs_confirmation" rows still get
//                      totalled (they have a real number) but are also
//                      surfaced as a gap so the open question isn't silently
//                      baked into a total.
//   recipes.csv      — everything we make: SR-xxx sub-recipes (rubs, brines,
//                      preps, sauces, sides — was sub_recipes.csv) and
//                      IP-xxx smoked products (was meat_yield_params.csv),
//                      told apart by `kind`. output_quantity/output_unit
//                      hold the batch yield where known.
// Read from SQLite as of phase 1, not from the three CSVs described above.
// The column names below are unchanged — kbViews re-flattens the normalized
// menu_item / recipe / bom_line rows back into exactly the shape these files
// had, so the batch maths and gap reporting in this module didn't have to be
// touched. The CSV names are kept throughout the comments here because they
// are still what the knowledge-base repo calls these tables, and the gap
// messages this module writes are read by whoever goes and fixes the data
// there.
import { readMenu, readRecipes, readRecipeLines } from '../../core/kbViews.js';
import { getRawMaterials } from '../../core/inventoryStore.js';
import { getVendors } from '../shared/purchasing.js';
// The meat categories, their loss %s and which cut each one is bought as —
// see server/core/meatConfig.js, the one file to edit when any of that changes.
import { MEAT_CATEGORY_KEYS, CATEGORY_BY_PRODUCT_ID, getMeatCategory } from '../../core/meatConfig.js';
// Which box each packable side goes into and how much it holds — see
// server/core/packagingConfig.js, the one file to edit when packaging changes.
import { getSideContainer, containersNeeded } from '../../core/packagingConfig.js';

// Menu items don't carry a "dish type" field in menu.csv — this grouping
// mirrors the collections on the real menu (smokerings.in) and is the same
// split the old Weekend Prep Planner recipe model used.
const DISH_TYPES = [
  { id: 'burger', label: 'Burgers', itemIds: ['chicken-bbq-burger', 'chicken-glaze-burger', 'pork-bbq-burger', 'pork-glaze-burger'] },
  // jackfruit-tacos added 2026-08-17 (new meat category).
  { id: 'taco', label: 'Tacos', itemIds: ['chicken-tacos', 'pork-tacos', 'jackfruit-tacos'] },
  { id: 'quesadilla', label: 'Quesadillas', itemIds: ['chicken-quesadilla', 'pork-quesadilla'] },
  // beef-ribs-250g added 2026-08-17 (new meat category).
  { id: 'primeCut', label: 'Prime Cuts', itemIds: ['pork-burnt-ends', 'bbq-ribs-250g', 'bbq-ribs-half-rack', 'beef-ribs-250g'] },
];

// materials.csv categories that this module's "buy from Swiggy" list
// covers directly — everything else (Bakery, Meat, Fuel / Smoking,
// Packaging & Supplies) belongs to a different vendor/module and is left
// alone here, same three-vendor split the rest of Weekend Prep Planner uses.
const SWIGGY_CATEGORIES = new Set([
  'Sauces & Condiments',
  'Produce',
  'Dairy & Eggs',
  'Spices & Seasonings',
  'Sweeteners',
  'Oils & Liquids',
  'Snacks & Sides',
]);

// Ingredients that genuinely go into a recipe but are bulk pantry staples
// already sitting in stock — draw them down from inventory instead of
// reordering on the weekly Swiggy run. Started 2026-08-15 with Dabur honey
// (RM-031) at the pitmaster's request; extended the same day to the rest of
// the base spice rack/pantry (salt, pepper, sugars, oils, vinegar, mustard,
// Worcestershire, paprika, oregano, butter, garlic, onion) — all bought in
// bulk periodically, not per-order via Swiggy.
const SOURCE_FROM_INVENTORY_MATERIAL_IDS = new Set([
  'RM-001', // Worcestershire sauce
  'RM-005', // Maggie masala
  'RM-007', // Dijon mustard
  'RM-008', // White onion
  'RM-010', // Garlic
  'RM-021', // Unsalted butter
  'RM-023', // Smoked paprika
  'RM-024', // Black pepper
  'RM-025', // Salt
  'RM-026', // Cayenne pepper
  'RM-027', // Oregano
  'RM-029', // Brown sugar
  'RM-031', // Dabur honey
  'RM-032', // Oil (cooking, general)
  'RM-033', // Vegetable oil
  'RM-034', // Apple cider vinegar
]);

// What order the kitchen actually makes the sides in, confirmed by the
// pitmaster 2026-08-19. Not a derivable fact — it's about what keeps best and
// what blocks the pass, so it lives here rather than in the knowledge-base
// alongside the recipes themselves.
//
// Sour cream and BBQ sauce lead because everything downstream is plated
// against them; salsa verde and caramelised onions follow. Everything else
// made in-house is genuinely order-independent, and anything with no batch
// recipe (Chips) is a buy, not a prep, so it lands last.
const PREP_TIERS = [
  { tier: 1, label: 'Make first' },
  { tier: 2, label: 'Then' },
  { tier: 3, label: 'Flexible — any order' },
  { tier: 4, label: 'Buy, nothing to make' },
];
// Keyed the same way sides are keyed everywhere else: sub-recipe id where
// there is one, else material id. Anything unlisted falls to tier 3 if it has
// a batch recipe, tier 4 if it doesn't.
const SIDE_PREP_TIER = {
  'SR-013': 1, // Sour cream
  'SR-015': 1, // BBQ sauce
  'SR-014': 2, // Salsa verde
  'SR-012': 2, // Caramelised onions
};

function getMenu() {
  return readMenu();
}

// recipe_lines.csv keys everything off ids from three non-colliding spaces —
// menu_id slugs, SR-xxx sub-recipes and IP-xxx smoked products — so a prefix
// test is all it takes to say which kind of thing an id names, on either end
// of a BoM row. See the data-model note at the top of this file.
const isSubRecipeId = (id) => /^SR-/.test(id || '');
const isProductId = (id) => /^IP-/.test(id || '');
const isMenuId = (id) => !!id && !isSubRecipeId(id) && !isProductId(id);

function getRecipeLines() {
  return readRecipeLines();
}

// The per-order BoM of each sellable dish (v1: menu_recipe_ingredients.csv).
function getMenuRecipeLines() {
  return getRecipeLines().filter((line) => isMenuId(line.parent_id));
}

// Every SR-xxx sub-recipe and IP-xxx smoked product (v1: sub_recipes.csv,
// now merged with meat_yield_params.csv). Keyed recipe_id either way, so the
// SR-xxx lookups below are unaffected by the IP-xxx rows sharing the file.
function getRecipes() {
  return readRecipes();
}

// The raw-ingredient breakdown of each SR-xxx sub-recipe (v1:
// sub_recipe_ingredients.csv). IP-xxx parents are deliberately not included:
// their lines carry no quantities yet, and the raw cut they name is the
// Smoking module's, not the Swiggy list's.
function getSubRecipeLines() {
  return getRecipeLines().filter((line) => isSubRecipeId(line.parent_id));
}

// Returns a finite number, or null for blank/non-numeric values (e.g. an
// is_to_taste="yes" line whose quantity column is deliberately blank).
function parseQty(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// orderCounts: { [menuItemId]: totalQuantityOrdered }
function computeSwiggyPlan({ orderCounts }) {
  const counts = orderCounts || {};
  const menu = getMenu();
  const menuById = new Map(menu.map((m) => [m.menu_id, m]));
  const recipeLines = getMenuRecipeLines();
  const subRecipeById = new Map(getRecipes().map((r) => [r.recipe_id, r]));
  const subRecipeLines = getSubRecipeLines();
  const rawMaterialsById = new Map(getRawMaterials().map((m) => [m.material_id, m]));

  const gaps = [];

  // ---- Dish type summary ---------------------------------------------------
  const dishTypeTotals = DISH_TYPES.map((def) => ({
    id: def.id,
    label: def.label,
    total: def.itemIds.reduce((sum, itemId) => sum + (counts[itemId] || 0), 0),
    items: def.itemIds
      .filter((itemId) => (counts[itemId] || 0) > 0)
      .map((itemId) => ({ itemId, name: menuById.get(itemId)?.item_name || itemId, count: counts[itemId] || 0 })),
  }));

  Object.entries(counts).forEach(([itemId, count]) => {
    if (count > 0 && !menuById.has(itemId)) {
      gaps.push(`"${itemId}" has ${count} order(s) but no entry in menu.csv — skipped.`);
    }
  });

  const itemIdsWithRecipeRows = new Set(recipeLines.map((r) => r.parent_id));
  Object.entries(counts).forEach(([itemId, count]) => {
    if (count > 0 && menuById.has(itemId) && !itemIdsWithRecipeRows.has(itemId)) {
      gaps.push(
        `${menuById.get(itemId).item_name} has ${count} order(s) logged but no recipe_lines.csv rows yet — its sides aren't counted below.`,
      );
    }
  });

  // ---- Sides needed (everything the Swiggy-relevant vendor covers) --------
  // Keyed by sub-recipe id / material id — the same side ordered across
  // different dishes (e.g. Sour cream on both tacos and quesadillas)
  // accumulates into one row.
  const sides = new Map();

  recipeLines.forEach((line) => {
    const count = counts[line.parent_id] || 0;
    if (!count) return;
    // The meat component itself (raw or smoked) is the Smoking module's
    // concern, not Swiggy's — it's a child_type="recipe" line pointing at an
    // IP-xxx smoked product (covers "Pulled chicken/pork" and "Smoked pork
    // belly/ribs").
    if (isProductId(line.child_id)) return;
    // Some rows are a purchased ingredient but not something that gets
    // packed as its own side — they're mixed/assembled straight into the
    // dish before it's boxed (cheese folded into a quesadilla, same idea as
    // the bun/tortilla already excluded below via category). Flagged in
    // notes with "not a packable side" rather than a name guess here.
    if (/not a packable side/i.test(line.notes || '')) return;

    const isSubRecipe = isSubRecipeId(line.child_id);
    const materialId = isSubRecipe ? null : line.child_id || null;
    const material = materialId ? rawMaterialsById.get(materialId) : null;
    // A direct material line only belongs on the Swiggy list if its category
    // is one Swiggy actually covers (excludes Bakery/Meat/Packaging/Fuel).
    if (materialId && !(material && SWIGGY_CATEGORIES.has(material.category))) return;

    // base_quantity/base_unit is the amount normalised to the material's own
    // stock unit — sum that, not the human quantity/unit, so the same
    // ingredient recorded in different units across dishes still accumulates
    // correctly instead of silently mixing g with pcs.
    const qty = parseQty(line.base_quantity ?? line.quantity);
    const unit = line.base_unit || line.unit;
    const subRecipeId = isSubRecipe ? line.child_id : null;
    // Group by sub-recipe id when there is one — the same prep gets typed
    // inconsistently across recipe rows (e.g. "Salad (Salad mix)" vs "Veg
    // salad (Salad mix)", both SR-017), but the id is authoritative. Falls
    // back to material id, then the raw ingredient name, for lines with
    // neither.
    const key = subRecipeId || materialId || line.child_name;
    const displayName = subRecipeId ? subRecipeById.get(subRecipeId)?.recipe_name || line.child_name : line.child_name;

    const bucket = sides.get(key) || {
      name: displayName,
      materialId,
      subRecipeId,
      unit,
      portions: 0,
      totalQty: 0,
      hasUnparsedQty: false,
      notes: line.notes || '',
      container: getSideContainer(key, unit),
      boxes: 0,
    };
    bucket.portions += count;
    if (qty != null) bucket.totalQty += qty * count;
    else bucket.hasUnparsedQty = true;
    // Boxes, counted one plate at a time: a side can only be combined
    // within a single customer's order, and this function only ever sees
    // slot totals, so the honest number here is "nothing combines". The
    // boards recompute it per order (and it drops) once the individual
    // orders are on hand — see src/pages/ops/shared/packing.ts sideBoxTotals.
    bucket.boxes += count * containersNeeded(qty, bucket.container, 1);
    sides.set(key, bucket);
  });

  // ---- Raw-ingredient extrapolation for prep sides with a known batch yield ----
  // Two buckets: swiggyIngredients (buy fresh) and inventoryIngredients
  // (already-stocked pantry staples — SOURCE_FROM_INVENTORY_MATERIAL_IDS —
  // that get drawn from inventory instead, so they never inflate the buy list).
  const swiggyIngredients = new Map(); // key: material_id or ingredient name -> { name, unit, qty, materialId }
  const inventoryIngredients = new Map(); // same shape, for pantry staples
  const addQtyToMap = (map, name, materialId, unit, qty) => {
    const key = materialId || name;
    const existing = map.get(key);
    if (existing && existing.unit === unit) {
      existing.qty += qty;
    } else if (!existing) {
      map.set(key, { name, materialId, unit, qty });
    } else {
      // Same ingredient, different unit than what's already accumulated — rare, flag rather than silently mis-add.
      gaps.push(`${name}: mixed units (${existing.unit} vs ${unit}) across recipes — totals shown separately, please reconcile.`);
      map.set(`${key}|${unit}`, { name, materialId, unit, qty });
    }
  };
  const addToSwiggyList = (name, materialId, unit, qty) => {
    const map = materialId && SOURCE_FROM_INVENTORY_MATERIAL_IDS.has(materialId) ? inventoryIngredients : swiggyIngredients;
    addQtyToMap(map, name, materialId, unit, qty);
  };

  const sideRows = Array.from(sides.values()).map((side) => {
    let batchInfo = null;

    if (side.materialId) {
      // Already a purchasable raw material — it IS the buy item.
      if (side.totalQty > 0) addToSwiggyList(side.name, side.materialId, side.unit, side.totalQty);
    } else if (side.subRecipeId) {
      const subRecipe = subRecipeById.get(side.subRecipeId);
      const outputQty = parseQty(subRecipe?.output_quantity);
      if (!subRecipe) {
        gaps.push(`${side.name} references ${side.subRecipeId}, which isn't in recipes.csv.`);
      } else if (outputQty == null || !subRecipe.output_unit) {
        gaps.push(`${side.name} (${side.subRecipeId}) has no batch yield recorded in recipes.csv — can't work out how many batches to make.`);
      } else if (subRecipe.output_unit.toLowerCase() !== (side.unit || '').toLowerCase()) {
        gaps.push(
          `${side.name} (${side.subRecipeId}): recipe is consumed in ${side.unit} per order but its batch yield is recorded in ${subRecipe.output_unit} — can't convert without a unit match.`,
        );
      } else {
        const batches = Math.ceil(side.totalQty / outputQty);
        batchInfo = { batches, batchYield: outputQty, batchUnit: subRecipe.output_unit };

        const ingredientRows = subRecipeLines.filter((r) => r.parent_id === side.subRecipeId);
        ingredientRows.forEach((row) => {
          if (row.child_type !== 'material') {
            // v2 lets a recipe hold another recipe; nothing does yet. If
            // something starts to, say so rather than dropping its raw
            // ingredients out of the buy list in silence.
            gaps.push(
              `${side.subRecipeId} (${side.name}) contains ${row.child_name} (${row.child_id}), itself a recipe — nested recipes aren't broken down into raw ingredients yet.`,
            );
            return;
          }
          if (row.is_to_taste === 'yes') {
            gaps.push(
              `${side.subRecipeId} (${side.name}): ${row.child_name} is "${row.quantity || 'to taste'}" per batch — used to taste, not counted in the shopping list.`,
            );
            return;
          }
          const rowQty = parseQty(row.base_quantity ?? row.quantity);
          const rowUnit = row.base_unit || row.unit;
          if (rowQty == null) {
            gaps.push(
              `${side.subRecipeId} (${side.name}) has a non-numeric ingredient quantity for "${row.child_name}" (${row.quantity || '(blank)'}) — skipped rather than guessed at. Worth fixing in recipe_lines.csv.`,
            );
            return;
          }
          if (row.status === 'needs_confirmation' && row.notes) {
            gaps.push(`${side.subRecipeId} (${side.name}) ${row.child_name}: ${row.notes}`);
          }
          addToSwiggyList(row.child_name, row.child_id || null, rowUnit, rowQty * batches);
        });
      }
    } else if (side.notes) {
      // The source row usually explains why (e.g. "Which lettuce — Green
      // lettuce (RM-016) or Iceberg lettuce (RM-017)? Please confirm.") —
      // surface that directly rather than a generic "add it" message.
      gaps.push(`${side.name}: ${side.notes}`);
    } else {
      gaps.push(`${side.name} isn't in materials.csv and has no sub-recipe on file — add it to the catalog to make it purchasable.`);
    }

    // Same key computeSwiggyPlan grouped by (sub-recipe id, else material
    // id, else name) so a board holding individual orders can match its
    // own per-order box counts onto these rows.
    const key = side.subRecipeId || side.materialId || side.name;

    return {
      key,
      // Where this side sits in the prep run. Explicit tier where one is on
      // file; otherwise "flexible" for anything made in-house and "buy" for
      // anything with no batch recipe behind it.
      prepTier: SIDE_PREP_TIER[key] || (batchInfo ? 3 : 4),
      name: side.name,
      portions: side.portions,
      totalQty: Math.round(side.totalQty * 100) / 100,
      unit: side.unit,
      hasUnparsedQty: side.hasUnparsedQty,
      subRecipeId: side.subRecipeId,
      batchInfo,
      container: side.container,
      boxes: side.boxes,
    };
  });

  // A specific, known gap worth surfacing explicitly: Salad dressing/
  // vinaigrette (SR-018) has a batch yield on file but no
  // recipe_lines.csv row points at it yet for any dish. (The
  // burger recipes used to carry a standalone "Apple cider vinegar" line as
  // a stand-in guess for this — that was removed 2026-08-15 since ACV isn't
  // a dish-level ingredient on its own, it's already accounted for as a
  // component of BBQ sauce (SR-015) and would be one of Salad dressing
  // (SR-018) too, once something references it.)
  const dressingReferenced = recipeLines.some((r) => r.child_id === 'SR-018');
  if (!dressingReferenced) {
    gaps.push(
      'Salad dressing / vinaigrette (SR-018, 90g batch yield) has a yield on file but no recipe_lines.csv row references it yet for any dish — nothing currently uses it.',
    );
  }

  sideRows.sort((a, b) => b.portions - a.portions);
  const swiggyList = Array.from(swiggyIngredients.values())
    .map((row) => ({ ...row, qty: Math.round(row.qty * 100) / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fromInventory = Array.from(inventoryIngredients.values())
    .map((row) => ({ ...row, qty: Math.round(row.qty * 100) / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // prepTiers travels with the plan so the tier labels live in one place
  // rather than being restated on every board that renders the sides.
  return { dishTypeTotals, sides: sideRows, prepTiers: PREP_TIERS, swiggyList, fromInventory, gaps };
}

// ---- Meat needed (Weekend Prep Planner's "Meat needed" tiles) -------------
// Two inputs, from two deliberately different places:
//   * the per-order finished weight — a measurement, so it stays on file as
//     a recipe_lines.csv row whose child is an IP-xxx smoked product (e.g.
//     chicken-bbq-burger -> 120 g of IP-001 Pulled chicken);
//   * the loss % and the cut we buy to cover it — business config, so both
//     come from server/core/meatConfig.js (see the header there for why).
//
// Nothing in here reads intermediate_products.csv or menu.csv any more:
// meatConfig maps IP-xxx straight to a category, and the recipe rows already
// carry parent_name for labels. That's what makes the tiles work through the
// knowledge-base repo's 2026-08-18 restructure, which dropped both files.
function computeMeatPlan({ orderCounts }) {
  const counts = orderCounts || {};
  const recipeLines = getMenuRecipeLines().filter((r) => isProductId(r.child_id));

  const gaps = [];
  const categories = {};
  MEAT_CATEGORY_KEYS.forEach((cat) => {
    categories[cat] = { breakdown: [], outputGrams: 0, productIds: new Set() };
  });

  recipeLines.forEach((line) => {
    const count = counts[line.parent_id] || 0;
    if (!count) return;
    const category = CATEGORY_BY_PRODUCT_ID[line.child_id];
    if (!category) {
      gaps.push(
        `${line.parent_name}: ${line.child_name || line.child_id} isn't mapped to a meat category — add its ${line.child_id} to a category's productIds in server/core/meatConfig.js.`,
      );
      return;
    }
    const gramsPerOrder = parseQty(line.base_quantity ?? line.quantity) || 0;
    const grams = gramsPerOrder * count;
    const bucket = categories[category];
    bucket.breakdown.push({ label: line.parent_name, count, gramsPerOrder, grams });
    bucket.outputGrams += grams;
    bucket.productIds.add(line.child_id);
  });

  const result = { gaps };
  MEAT_CATEGORY_KEYS.forEach((category) => {
    const bucket = categories[category];
    const config = getMeatCategory(category);

    result[category] = {
      label: config.label,
      productId: Array.from(bucket.productIds)[0] || config.productIds[0] || null,
      productName: config.productName,
      sourceMaterialId: config.sourceMaterialId,
      sourceMaterialName: config.sourceMaterialName,
      breakdown: bucket.breakdown,
      outputGrams: Math.round(bucket.outputGrams),
      // The planner works in loss %, and so does the Smoking module's
      // realized-yield feed — one unit, no 100-minus conversions on the way
      // through. lossSource says whether this meat names its own % or fell
      // through to meatConfig's catch-all; preferRealizedLoss says whether
      // measured sessions are allowed to override it.
      lossPct: config.lossPct,
      lossSource: config.lossSource,
      preferRealizedLoss: config.preferRealizedLoss,
      orderMultipleG: config.minBuyGrams,
    };
  });

  return result;
}

// ---- Prep needed before packing (Bakery components) ----------------------
// Buns, taco shells, tortillas and garlic bread are raw_material lines too,
// but they're deliberately excluded from computeSwiggyPlan's "sides" above
// (SWIGGY_CATEGORIES skips the Bakery category — that's a warm/toast-it-
// yourself step, not something packed as its own side). For the Order
// Packing tile, that's exactly the "how much bread do I need to toast, how
// many tortillas/taco shells to warm" number staff need — so it gets its own
// small aggregation, same per-order BoM walk as the sides loop, scoped to
// Bakery instead. No sub-recipe extrapolation needed here: every Bakery line
// is a direct raw-material quantity per dish, never a prepped sub-recipe.
//
// Category is NOT the vendor, though — Bread Time Stories (VEN-001) supplies
// buns/taco shells/garlic bread, while Tortilla (RM-056) is a Bakery item
// bought on the Swiggy run (VEN-002, noted 2026-08-18). So each row carries
// its own default_vendor_id/vendor name and the Weekend Prep Planner groups
// the buy tables by vendor; the Order Packing prep tile ignores the vendor
// and shows every Bakery line, since it's all warmed the same way whoever
// sold it.
const PREP_CATEGORY = 'Bakery';

// orderCounts: { [menuItemId]: totalQuantityOrdered }
function computePrepPlan({ orderCounts }) {
  const counts = orderCounts || {};
  const recipeLines = getMenuRecipeLines();
  const rawMaterialsById = new Map(getRawMaterials().map((m) => [m.material_id, m]));
  const vendorNameById = new Map(getVendors().map((v) => [v.vendor_id, v.vendor_name]));

  const prep = new Map();
  recipeLines.forEach((line) => {
    const count = counts[line.parent_id] || 0;
    if (!count) return;
    if (line.child_type !== 'material') return;
    const material = rawMaterialsById.get(line.child_id);
    if (!material || material.category !== PREP_CATEGORY) return;

    const qty = parseQty(line.base_quantity ?? line.quantity);
    const unit = line.base_unit || line.unit;
    const key = line.child_id;
    const bucket = prep.get(key) || {
      name: line.child_name,
      materialId: line.child_id,
      unit,
      portions: 0,
      totalQty: 0,
      hasUnparsedQty: false,
      // materials.csv order_multiple/standard_cost_inr — the Weekend
      // Prep Planner's Bread Time Stories buy table used to hardcode these
      // per item (BREAD_TIME_STORIES_CATALOG); now sourced from the same
      // data these quantities already come from.
      unitPriceInr: parseQty(material.standard_cost_inr),
      orderMultiple: parseQty(material.order_multiple),
      // Who this line is actually ordered from — see the vendor note above
      // PREP_CATEGORY. Blank default_vendor_id stays null so the UI can say
      // "unassigned" rather than silently folding it into a real vendor.
      vendorId: material.default_vendor_id || null,
      vendorName: vendorNameById.get(material.default_vendor_id) || null,
    };
    bucket.portions += count;
    if (qty != null) bucket.totalQty += qty * count;
    else bucket.hasUnparsedQty = true;
    prep.set(key, bucket);
  });

  const rows = Array.from(prep.values())
    .map((row) => {
      const totalQty = Math.round(row.totalQty * 100) / 100;
      const multiple = row.orderMultiple && row.orderMultiple > 0 ? row.orderMultiple : null;
      const orderQty = multiple ? Math.ceil(totalQty / multiple) * multiple : totalQty;
      const costInr = row.unitPriceInr != null ? Math.round(orderQty * row.unitPriceInr * 100) / 100 : null;
      return { ...row, totalQty, orderQty, costInr };
    })
    .sort((a, b) => b.totalQty - a.totalQty);
  return { prep: rows };
}

// ---- Packable sides, per menu item (static reference — no order counts) --
// Same "is this actually a packable side" filtering computeSwiggyPlan uses
// (excludes the meat component, excludes non-packable-side rows like cheese/
// tortilla, excludes non-Swiggy categories like Bakery/Packaging), just kept
// per-item instead of pre-aggregated across an order/slot — this is what the
// Order Packing tile's per-order "pack these together" grouping is built
// from: look up each ordered item's sides, then group same-side lines within
// one order to see what can share a container. Uses the human quantity/unit
// (not base_quantity/base_unit) since this is a kitchen-facing display, not
// a purchasing total — every raw-material line here already carries the same
// unit across every dish that uses it, so there's no accumulation risk.
function getPackableSidesByItem() {
  const recipeLines = getMenuRecipeLines();
  const rawMaterialsById = new Map(getRawMaterials().map((m) => [m.material_id, m]));
  const subRecipeById = new Map(getRecipes().map((r) => [r.recipe_id, r]));

  const byItem = {};
  recipeLines.forEach((line) => {
    if (isProductId(line.child_id)) return;
    if (/not a packable side/i.test(line.notes || '')) return;

    const isSubRecipe = isSubRecipeId(line.child_id);
    const materialId = isSubRecipe ? null : line.child_id || null;
    const material = materialId ? rawMaterialsById.get(materialId) : null;
    if (materialId && !(material && SWIGGY_CATEGORIES.has(material.category))) return;

    const qty = parseQty(line.quantity);
    const subRecipeId = isSubRecipe ? line.child_id : null;
    const key = subRecipeId || materialId || line.child_name;
    const displayName = subRecipeId ? subRecipeById.get(subRecipeId)?.recipe_name || line.child_name : line.child_name;

    // qty/unit stays the human amount the packing boards already show ("1
    // pcs" of lettuce); baseQty/baseUnit is the same amount normalised to
    // the material's stock unit (80 g), which is the only one a container
    // capacity can be divided into. Both travel so the display doesn't
    // change while the box maths gets a number it can use.
    const baseQty = parseQty(line.base_quantity ?? line.quantity);
    const baseUnit = line.base_unit || line.unit;

    if (!byItem[line.parent_id]) byItem[line.parent_id] = [];
    byItem[line.parent_id].push({
      key,
      name: displayName,
      qty,
      unit: line.unit,
      baseQty,
      baseUnit,
      container: getSideContainer(key, baseUnit),
    });
  });
  return byItem;
}

export {
  getMenu,
  getRecipeLines,
  getMenuRecipeLines,
  getRecipes,
  getSubRecipeLines,
  computeSwiggyPlan,
  computeMeatPlan,
  computePrepPlan,
  getPackableSidesByItem,
};
