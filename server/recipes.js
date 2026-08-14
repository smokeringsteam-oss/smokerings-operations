// Menu/recipe data — drives the Weekend Prep Planner's "Sides needed" +
// Swiggy shopping list (Step 2), replacing the old hardcoded/assumed recipe
// guesses with the real menu.csv / recipe_ingredients.csv / rub_recipes.csv
// / rub_recipe_ingredients.csv files.
//
// Data model:
//   menu.csv               — the 11 sellable dishes
//   recipe_ingredients.csv — per-order ingredient lines for each dish. A row
//                            either points at a tracked raw material
//                            (material_id set) or is blank material_id,
//                            meaning it's either the meat component ("Pulled
//                            chicken/pork" — excluded here, that's the
//                            Smoking module's concern) or an in-house PREP
//                            side (BBQ sauce, Coleslaw, …) or an item not yet
//                            in raw_materials.csv (Taco shell, Tortilla,
//                            Cheese). The notes column links prep sides to
//                            their recipe via a literal "SR-0xx" reference —
//                            that's used here as the join key instead of
//                            fuzzy name-matching.
//   rub_recipes.csv        — sub-recipes (rubs/brines/preps/sauces/sides),
//                            keyed SR-xxx. output_quantity/output_unit hold
//                            the batch yield where known.
//   rub_recipe_ingredients.csv — raw-ingredient breakdown per sub-recipe, for
//                            the ones made in-house (Prep/Sauce/Salad/Dressing
//                            category). Some quantities are non-numeric
//                            ("pinch", "to taste") or corrupted by a
//                            spreadsheet date auto-conversion (e.g. "04-May"
//                            for what was almost certainly "4-5") — those are
//                            skipped rather than guessed at, and reported.
import fs from 'fs';
import { readCsvFile, parseCsv } from './csvStore.js';
import { requireFile } from './knowledgeBase.js';
import { getRawMaterials } from './inventoryStore.js';

// Menu items don't carry a "dish type" field in menu.csv — this grouping
// mirrors the collections on the real menu (smokerings.in) and is the same
// split the old Weekend Prep Planner recipe model used.
const DISH_TYPES = [
  { id: 'burger', label: 'Burgers', itemIds: ['chicken-bbq-burger', 'chicken-glaze-burger', 'pork-bbq-burger', 'pork-glaze-burger'] },
  { id: 'taco', label: 'Tacos', itemIds: ['chicken-tacos', 'pork-tacos'] },
  { id: 'quesadilla', label: 'Quesadillas', itemIds: ['chicken-quesadilla', 'pork-quesadilla'] },
  { id: 'primeCut', label: 'Prime Cuts', itemIds: ['pork-burnt-ends', 'bbq-ribs-250g', 'bbq-ribs-half-rack'] },
];

// raw_materials.csv categories that this module's "buy from Swiggy" list
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

function getMenu() {
  return readCsvFile(requireFile('menu')).rows;
}

// recipe_ingredients.csv has a known header bug as of this writing: an
// "item_name" column was added to the data (between menu_item and
// material_id) without updating the header row, which silently shifts every
// field one column left under normal parsing (material_id reads as the dish
// name, ingredient_name reads as the sub-recipe id, etc). Patched in memory
// here rather than rewriting the file — it's liable to be open/edited by
// hand (e.g. in Excel) — and this check no-ops harmlessly once the header is
// fixed for real.
const BROKEN_RECIPE_INGREDIENTS_HEADER = 'recipe_id,menu_item,material_id,sub_recipe_id,ingredient_name,quantity,unit,notes,';
const FIXED_RECIPE_INGREDIENTS_HEADER = 'recipe_id,menu_item,item_name,material_id,sub_recipe_id,ingredient_name,quantity,unit,notes';

function getRecipeIngredients() {
  const path = requireFile('recipeIngredients');
  const raw = fs.readFileSync(path, 'utf8');
  const firstLineEnd = raw.indexOf('\n');
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '');
  const patched =
    firstLine === BROKEN_RECIPE_INGREDIENTS_HEADER ? FIXED_RECIPE_INGREDIENTS_HEADER + raw.slice(firstLineEnd) : raw;
  // Some hand-typed notes have an em dash that didn't survive as valid UTF-8
  // (reads as U+FFFD "�") — a pre-existing encoding mismatch in the file
  // itself, not something to silently guess-fix in the data, but cleaned up
  // here since these notes get shown directly in the UI as gap messages.
  const cleaned = patched.replace(/�/g, '—');
  return parseCsv(cleaned).rows;
}

function getSubRecipes() {
  return readCsvFile(requireFile('rubRecipes')).rows;
}

function getSubRecipeIngredients() {
  return readCsvFile(requireFile('rubRecipeIngredients')).rows;
}

// Returns a finite number, or null for blank/non-numeric/corrupted values
// (e.g. "pinch", "to taste", or "04-May" — almost certainly "4-5" mangled
// into a date by a spreadsheet at some point).
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
  const recipeLines = getRecipeIngredients();
  const subRecipes = getSubRecipes();
  const subRecipeById = new Map(subRecipes.map((r) => [r.recipe_id, r]));
  const subRecipeIngredients = getSubRecipeIngredients();
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

  const itemIdsWithRecipeRows = new Set(recipeLines.map((r) => r.menu_item));
  Object.entries(counts).forEach(([itemId, count]) => {
    if (count > 0 && menuById.has(itemId) && !itemIdsWithRecipeRows.has(itemId)) {
      gaps.push(
        `${menuById.get(itemId).item_name} has ${count} order(s) logged but no recipe_ingredients.csv rows yet — its sides aren't counted below.`,
      );
    }
  });

  // ---- Sides needed (everything the Swiggy-relevant vendor covers) --------
  // Keyed by ingredient_name — the same side ordered across different dishes
  // (e.g. Sour cream on both tacos and quesadillas) accumulates into one row.
  const sides = new Map();

  recipeLines.forEach((line) => {
    const count = counts[line.menu_item] || 0;
    if (!count) return;
    // The meat component itself (raw or smoked) is the Smoking module's
    // concern, not Swiggy's — every such row is consistently flagged in
    // notes as "not a purchased raw material" rather than needing a name
    // guess (covers "Pulled chicken/pork" and "Smoked pork belly/ribs").
    if (/not a purchased raw material/i.test(line.notes || '')) return;

    const material = line.material_id ? rawMaterialsById.get(line.material_id) : null;
    // A direct material line only belongs on the Swiggy list if its category
    // is one Swiggy actually covers (excludes Bakery/Meat/Packaging/Fuel).
    if (line.material_id && !(material && SWIGGY_CATEGORIES.has(material.category))) return;

    const qty = parseQty(line.quantity);
    const subRecipeId = line.sub_recipe_id || null;
    // Group by sub-recipe id when there is one — the same prep gets typed
    // inconsistently across recipe rows (e.g. "Salad (Salad mix)" vs "Veg
    // salad (Salad mix)", both SR-017), but the id is authoritative. Falls
    // back to material id, then the raw ingredient name, for lines with
    // neither.
    const key = subRecipeId || line.material_id || line.ingredient_name;
    const displayName = subRecipeId ? subRecipeById.get(subRecipeId)?.recipe_name || line.ingredient_name : line.ingredient_name;

    const bucket = sides.get(key) || {
      name: displayName,
      materialId: line.material_id || null,
      subRecipeId,
      unit: line.unit,
      portions: 0,
      totalQty: 0,
      hasUnparsedQty: false,
      notes: line.notes || '',
    };
    bucket.portions += count;
    if (qty != null) bucket.totalQty += qty * count;
    else bucket.hasUnparsedQty = true;
    sides.set(key, bucket);
  });

  // ---- Raw-ingredient extrapolation for prep sides with a known batch yield ----
  const swiggyIngredients = new Map(); // key: material_id or ingredient name -> { name, unit, qty, materialId }
  const addToSwiggyList = (name, materialId, unit, qty) => {
    const key = materialId || name;
    const existing = swiggyIngredients.get(key);
    if (existing && existing.unit === unit) {
      existing.qty += qty;
    } else if (!existing) {
      swiggyIngredients.set(key, { name, materialId, unit, qty });
    } else {
      // Same ingredient, different unit than what's already accumulated — rare, flag rather than silently mis-add.
      gaps.push(`${name}: mixed units (${existing.unit} vs ${unit}) across recipes — totals shown separately, please reconcile.`);
      swiggyIngredients.set(`${key}|${unit}`, { name, materialId, unit, qty });
    }
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
        gaps.push(`${side.name} references ${side.subRecipeId}, which isn't in rub_recipes.csv.`);
      } else if (outputQty == null || !subRecipe.output_unit) {
        gaps.push(`${side.name} (${side.subRecipeId}) has no batch yield recorded in rub_recipes.csv — can't work out how many batches to make.`);
      } else if (subRecipe.output_unit.toLowerCase() !== (side.unit || '').toLowerCase()) {
        gaps.push(
          `${side.name} (${side.subRecipeId}): recipe is consumed in ${side.unit} per order but its batch yield is recorded in ${subRecipe.output_unit} — can't convert without a unit match.`,
        );
      } else {
        const batches = Math.ceil(side.totalQty / outputQty);
        batchInfo = { batches, batchYield: outputQty, batchUnit: subRecipe.output_unit };

        const ingredientRows = subRecipeIngredients.filter((r) => r.recipe_id === side.subRecipeId);
        ingredientRows.forEach((row) => {
          const rowQty = parseQty(row.quantity);
          if (rowQty == null) {
            gaps.push(
              `${side.subRecipeId} (${side.name}) has a non-numeric ingredient quantity for "${row.ingredient_name}" (${row.quantity || '(blank)'}) — skipped rather than guessed at. Worth fixing in rub_recipe_ingredients.csv.`,
            );
            return;
          }
          addToSwiggyList(row.ingredient_name, row.material_id || null, row.unit, rowQty * batches);
        });
      }
    } else if (side.notes) {
      // The source row usually explains why (e.g. "Which lettuce — Green
      // lettuce (RM-016) or Iceberg lettuce (RM-017)? Please confirm.") —
      // surface that directly rather than a generic "add it" message.
      gaps.push(`${side.name}: ${side.notes}`);
    } else {
      gaps.push(`${side.name} isn't in raw_materials.csv and has no sub-recipe on file — add it to the catalog to make it purchasable.`);
    }

    return {
      name: side.name,
      portions: side.portions,
      totalQty: Math.round(side.totalQty * 100) / 100,
      unit: side.unit,
      hasUnparsedQty: side.hasUnparsedQty,
      subRecipeId: side.subRecipeId,
      batchInfo,
    };
  });

  // A specific, known gap worth surfacing explicitly (found while wiring this
  // up): Salad dressing/vinaigrette (SR-018) has a batch yield on file but no
  // recipe_ingredients.csv row points at it yet — the burger recipes instead
  // have a plain "Apple cider vinegar" line marked "assumed... confirm if
  // this is meant to be Salad dressing (SR-018) instead".
  const dressingReferenced = recipeLines.some((r) => r.sub_recipe_id === 'SR-018');
  if (!dressingReferenced) {
    gaps.push(
      'Salad dressing / vinaigrette (SR-018, 90g batch yield) has a yield on file but no recipe_ingredients.csv row references it yet — the burger recipes currently show a separate "Apple cider vinegar" line marked as an assumption instead. Worth confirming whether that should point to SR-018.',
    );
  }

  sideRows.sort((a, b) => b.portions - a.portions);
  const swiggyList = Array.from(swiggyIngredients.values())
    .map((row) => ({ ...row, qty: Math.round(row.qty * 100) / 100 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { dishTypeTotals, sides: sideRows, swiggyList, gaps };
}

export { getMenu, getRecipeIngredients, getSubRecipes, getSubRecipeIngredients, computeSwiggyPlan };
