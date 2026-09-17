// What one plate costs to make, walked out of the bill of materials.
//
// The question is "how much does a burger cost us", and the honest answer has
// three layers under it, each of which this file walks:
//
//   raw material   a bun, a tortilla, 400 g of tomato. Priced from what was
//                  actually paid for it — the newest line in the purchase log
//                  — falling back to the standard cost on the catalogue.
//   sub-recipe     BBQ sauce, coleslaw, the salad dressing. Costed as a whole
//                  batch out of its own ingredients and then divided by the
//                  batch's output, because that is what a 30 g portion of it
//                  is a thirtieth of.
//   smoked product pulled chicken, ribs, burnt ends. A BoM line asks for 110 g
//                  of FINISHED meat, and finished meat is bought as raw meat
//                  that loses half its weight in the smoker. So the raw
//                  weight behind the portion is grossed up by the loss % in
//                  meatConfig.js before it is priced — the same number the
//                  Weekend Prep Planner buys against, so the cost of a burger
//                  and the meat bought for it can never disagree.
//
// Everything is flattened to leaves
// ---------------------------------
// A dish is not costed as a list of its own BoM lines. Every line is exploded
// down to the raw materials underneath it and the arithmetic is done there,
// for one reason: a sub-recipe whose ingredients are only half priced would
// otherwise contribute a confident-looking partial number and count as a
// costed line. BBQ sauce has thirteen ingredients and two of them have a
// price; costed as one line it reads as done. Costed as thirteen leaves it
// reads as 2/13, which is what it is.
//
// So a burger's cost is the sum of its leaves, its coverage is the share of
// its leaves that carry a price, and both are computed over the same set.
//
// What this file will not do
// --------------------------
// Guess. Roughly two thirds of the catalogue has no price on file and no
// stated pack size, and both are needed before a quantity can become rupees
// (see server/core/purchaseUnits.js for why the pack size is the harder half).
// Rather than fill those in with market estimates, every unpriceable leaf is
// reported by name and left out of the total. Every cost this file produces
// is therefore an UNDERSTATEMENT, and always carries the coverage figure that
// says by how much. A screen that shows one without the other is misreading
// it.
//
// That choice makes the gap list the useful half of the output: it names the
// materials standing between the report and a real cost, ordered by how many
// dishes each one blocks. Log a purchase for the top few and the numbers
// close themselves.
import { readMaterials, readMenu, readRecipes, readRecipeLines, readPurchases } from '../core/kbViews.js';
import { basisOf } from '../core/purchaseUnits.js';
import { CATEGORY_BY_PRODUCT_ID, getMeatCategory } from '../core/meatConfig.js';

const isSubRecipeId = (id) => /^SR-/.test(id || '');
const isProductId = (id) => /^IP-/.test(id || '');

// Cost buckets, off the material's own category. Four rather than the
// catalogue's eleven, because the question a bucket answers is "which part of
// this plate is the money, and which part of it don't we know yet" — and at
// eleven categories the answer is a list nobody reads. Meat is its own bucket
// because it is most of every plate's cost; packaging is its own because it
// is the largest block of unpriced material and lumping it into "other" would
// hide that.
const GROUPS = ['Meat', 'Bread', 'Sauces, sides & produce', 'Packaging'];
const GROUP_BY_CATEGORY = {
  Meat: 'Meat',
  Bakery: 'Bread',
  'Packaging & Supplies': 'Packaging',
};
const groupOf = (category) => GROUP_BY_CATEGORY[category] || 'Sauces, sides & produce';

// '' is what csvShaped hands back for an empty cell, and Number('') is 0 —
// which would silently cost a missing quantity as free. Anything that is not
// a finite number comes back null so the caller can call it a gap.
function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// base_quantity is the number every planner multiplies by the order count and
// it wins wherever both are set — the same precedence recipes.js applies.
const qtyOf = (line) => num(line.base_quantity) ?? num(line.quantity);

const round2 = (value) => Math.round(value * 100) / 100;
const round4 = (value) => Math.round(value * 10000) / 10000;

// ---- What a raw material costs, per BoM unit -----------------------------
//
// Two independent things have to be known and either can be missing on its
// own: what a unit of it cost, and what a unit IS. A price with no basis is
// as useless as a basis with no price, so they are reported as separate gaps
// — they are closed by different actions.
//
// Price precedence is newest-purchase before standard cost, deliberately.
// The catalogue's standard_cost_inr is a planning figure somebody typed; the
// purchase log is what the vendor charged last week. Where both exist they
// currently agree (pork shoulder at 520/kg, buns at 25 each), and where they
// drift the receipt is the truth.
function priceMaterials({ materials, purchases }) {
  const newestPurchase = new Map();
  // readPurchases comes back newest first, so the first line seen for a
  // material is its latest — no date comparison needed, and none that could
  // disagree with the order the purchasing screen shows.
  for (const row of purchases) {
    const materialId = row.material_id;
    if (!materialId || newestPurchase.has(materialId)) continue;
    const unitPrice = num(row.unit_price);
    const quantity = num(row.quantity_purchased);
    const total = num(row.total_cost);
    // unit_price is optional on a purchase line; a line that only carries a
    // total is still a price if it says how much it bought.
    const perUnit =
      unitPrice != null && unitPrice > 0
        ? unitPrice
        : total != null && total > 0 && quantity != null && quantity > 0
          ? total / quantity
          : null;
    if (perUnit == null) continue;
    newestPurchase.set(materialId, { perUnit, date: row.purchase_date || '', ref: row.purchase_id || '' });
  }

  const costs = new Map();
  for (const material of materials) {
    const id = material.item_id;
    const bought = newestPurchase.get(id);
    const standard = num(material.standard_cost_inr);
    const price = bought
      ? { perUnit: bought.perUnit, source: 'purchase', asOf: bought.date, ref: bought.ref }
      : standard != null && standard > 0
        ? { perUnit: standard, source: 'standard', asOf: '', ref: '' }
        : null;
    const basis = basisOf(id, material.cost_basis);

    costs.set(id, {
      materialId: id,
      name: material.item_name || id,
      category: material.category || '',
      group: groupOf(material.category),
      price,
      basis,
      // Rupees per gram, per millilitre or per piece, whichever the BoM is
      // counting in. Null when either half is missing.
      perBomUnit: price && basis ? price.perUnit / basis.bomUnits : null,
      gap: price && basis
        ? null
        : !price && !basis
          ? 'no price or pack size on file'
          : !price
            ? 'no price on file'
            : 'no pack size on file',
    });
  }
  return costs;
}

// A leaf: one raw material, the amount of it one plate uses, and what that
// amount cost — or why it could not be priced. The unit of account for
// everything above.
function leaf({ materialId, name, group, quantity, unit, perUnit, cost, gap, via }) {
  return { materialId, name, group, quantity, unit, perUnit, cost, gap, via };
}

// ---- One BoM line, exploded ----------------------------------------------
//
// Returns the leaves under it, each already scaled to one plate. `scale` is
// how much of the parent one plate carries: 1 at the top, and a fraction of a
// batch inside a sub-recipe.
//
// Rub and brine lines are the shape to notice: they carry no quantity at all
// ("QUANTITY PER KG NOT YET RECORDED" in their notes) and are marked
// needs_confirmation. They are a real gap — a rub is salt and paprika and
// costs something — so they come back as an unpriced leaf rather than being
// skipped, and they are why a smoked dish never reads as fully covered.
//
// A to-taste line is different and is NOT a gap: a pinch of something,
// deliberately unquantified and worth a rounding error. It produces no leaf
// at all, so it cannot drag a dish's coverage down for being what it is.
function explodeLine(line, scale, ctx) {
  const childId = line.child_id;
  const name = line.child_name || childId;
  if (line.is_to_taste === 'yes') return [];

  const quantity = qtyOf(line);
  if (quantity == null) {
    // No quantity, so nothing to scale — but the ingredient is real and its
    // absence is the gap. Named after whatever it is (a rub, a raw cut) so
    // the gap list points at something a person can act on.
    const child = ctx.materialCosts.get(childId);
    return [
      leaf({
        materialId: childId,
        name,
        group: child ? child.group : 'Sauces, sides & produce',
        quantity: null,
        unit: '',
        perUnit: null,
        cost: null,
        gap: 'no quantity recorded',
        via: line.parent_name || '',
      }),
    ];
  }

  if (isSubRecipeId(childId)) return explodeSubRecipe(childId, quantity * scale, ctx, name);
  if (isProductId(childId)) return explodeSmoked(childId, quantity * scale, ctx);

  const material = ctx.materialCosts.get(childId);
  const amount = quantity * scale;
  if (!material) {
    return [
      leaf({
        materialId: childId,
        name,
        group: 'Sauces, sides & produce',
        quantity: round4(amount),
        unit: '',
        perUnit: null,
        cost: null,
        gap: 'not in the material catalogue',
        via: '',
      }),
    ];
  }
  return [
    leaf({
      materialId: childId,
      name: material.name,
      group: material.group,
      quantity: round4(amount),
      unit: material.basis?.unit || '',
      perUnit: material.perBomUnit == null ? null : round4(material.perBomUnit),
      cost: material.perBomUnit == null ? null : amount * material.perBomUnit,
      gap: material.gap,
      via: '',
    }),
  ];
}

// ---- A sub-recipe, exploded ----------------------------------------------
//
// `amount` is how much of the batch one plate carries, in the batch's own
// units. Dividing by output_quantity turns it into the fraction of the batch
// to scale every ingredient by — output_quantity and not portions_per_batch,
// because a BoM line asks for 30 of BBQ sauce out of a 900 batch and that is
// a thirtieth of it whether or not the recipe also calls 30 a portion.
//
// Recursion with a cycle guard, because a sub-recipe is allowed to contain
// another one. None does today — every SR line points at a raw material — but
// a recipe editor that let someone build one would otherwise hang the server.
function explodeSubRecipe(recipeId, amount, ctx, fallbackName) {
  const recipe = ctx.recipeById.get(recipeId);
  const name = recipe?.recipe_name || fallbackName || recipeId;
  const output = recipe ? num(recipe.output_quantity) : null;
  const lines = ctx.linesByParent.get(recipeId) || [];

  const unpriceable = (gap) => [
    leaf({
      materialId: recipeId,
      name,
      group: 'Sauces, sides & produce',
      quantity: round4(amount),
      unit: 'of a batch',
      perUnit: null,
      cost: null,
      gap,
      via: '',
    }),
  ];

  if (!recipe) return unpriceable('sub-recipe is not in the recipe table');
  if (output == null || output <= 0) return unpriceable('no batch output quantity on file');
  if (lines.length === 0) return unpriceable('no ingredients recorded');
  if (ctx.visiting.has(recipeId)) return unpriceable('recipe contains itself');

  ctx.visiting.add(recipeId);
  const leaves = lines.flatMap((line) => explodeLine(line, amount / output, ctx));
  ctx.visiting.delete(recipeId);
  // Stamped with the sauce they came from, so a gap list can say "black
  // pepper, in BBQ sauce" rather than leaving someone to find it.
  return leaves.map((entry) => ({ ...entry, via: entry.via || name }));
}

// ---- A smoked product, exploded ------------------------------------------
//
// The gross-up is the whole point. 110 g of pulled chicken on a burger is
// 220 g of chicken legs in the smoker at meatConfig's 50% loss, and it is the
// 220 that was paid for. Using the finished weight would understate every
// meat dish by exactly the yield — the largest single error this report could
// make, since meat is most of what a plate costs.
//
// The loss % comes from meatConfig.js rather than recipe.yield_pct for the
// reason that file gives: it is the planning number the buying is done
// against, and a cost that used a different one would not reconcile with the
// meat actually bought. recipe.yield_pct is the fallback for a product
// meatConfig has no category for.
//
// The product's own BoM lines are walked too, for the rub and the brine. Its
// raw-cut line is skipped: that cut is priced here, off the yield, and
// costing it twice would double the meat on every plate.
function explodeSmoked(productId, finishedGrams, ctx) {
  const recipe = ctx.recipeById.get(productId);
  const name = recipe?.recipe_name || productId;
  const category = CATEGORY_BY_PRODUCT_ID[productId];
  const config = category ? getMeatCategory(category) : null;

  const yieldPct = config ? 100 - config.lossPct : num(recipe?.yield_pct);
  const cutId = config?.sourceMaterialId || recipe?.source_material_id || null;
  const cut = cutId ? ctx.materialCosts.get(cutId) : null;
  const rawGrams = yieldPct != null && yieldPct > 0 ? finishedGrams / (yieldPct / 100) : null;

  const meatLeaf = leaf({
    materialId: cutId || productId,
    name: cut?.name || cutId || name,
    group: 'Meat',
    quantity: rawGrams == null ? null : round2(rawGrams),
    unit: 'g raw',
    perUnit: cut?.perBomUnit == null ? null : round4(cut.perBomUnit),
    cost: cut?.perBomUnit != null && rawGrams != null ? rawGrams * cut.perBomUnit : null,
    gap: !cutId
      ? 'no raw cut mapped to this smoked product'
      : !cut
        ? `raw cut ${cutId} is not in the material catalogue`
        : cut.perBomUnit != null && rawGrams == null
          ? 'no yield % on file'
          : cut.gap,
    via: name,
  });

  // Rub and brine. Scaled by raw weight where it is known — a rub is applied
  // per kilo of meat — but every one of them has a null quantity today, so in
  // practice they all come back as named gaps.
  const others = (ctx.linesByParent.get(productId) || [])
    .filter((line) => line.child_id !== cutId)
    .flatMap((line) => explodeLine(line, rawGrams == null ? 0 : rawGrams / 1000, ctx))
    .map((entry) => ({ ...entry, via: entry.via || name }));

  return [meatLeaf, ...others];
}

// ---- The cost book --------------------------------------------------------
//
// Pure: hand it the five tables and it does no I/O, which is what lets the
// gross-up, the batch division and the gap accounting be tested for what they
// are rather than against whatever happens to be in the catalogue this week.
function costMenuItems({ materials, menu, recipes, recipeLines, purchases }) {
  const materialCosts = priceMaterials({ materials: materials || [], purchases: purchases || [] });
  const linesByParent = new Map();
  for (const line of recipeLines || []) {
    if (!linesByParent.has(line.parent_id)) linesByParent.set(line.parent_id, []);
    linesByParent.get(line.parent_id).push(line);
  }
  const ctx = {
    materialCosts,
    linesByParent,
    recipeById: new Map((recipes || []).map((recipe) => [recipe.recipe_id, recipe])),
    visiting: new Set(),
  };

  // How many dishes each unpriceable material is standing in the way of.
  // Counted across the whole walk — including the ones reached inside a sauce
  // — because "black pepper blocks nine dishes" is the sentence that decides
  // what to go and price first.
  const blockers = new Map();

  const items = (menu || []).map((dish) => {
    const dishId = dish.menu_id;
    const leaves = (linesByParent.get(dishId) || []).flatMap((line) => explodeLine(line, 1, ctx));
    const priced = leaves.filter((entry) => entry.cost != null);
    const missing = leaves.filter((entry) => entry.cost == null);

    for (const entry of missing) {
      const key = entry.materialId;
      if (!blockers.has(key)) {
        blockers.set(key, { id: key, name: entry.name, group: entry.group, reason: entry.gap, dishes: new Set() });
      }
      blockers.get(key).dishes.add(dishId);
    }

    const cost = priced.reduce((total, entry) => total + entry.cost, 0);
    const price = num(dish.price_inr);

    const groups = GROUPS.map((group) => {
      const inGroup = leaves.filter((entry) => entry.group === group);
      return {
        group,
        cost: round2(inGroup.filter((entry) => entry.cost != null).reduce((total, entry) => total + entry.cost, 0)),
        priced: inGroup.filter((entry) => entry.cost != null).length,
        total: inGroup.length,
        missing: inGroup.filter((entry) => entry.cost == null).map((entry) => entry.name),
      };
    }).filter((group) => group.total > 0);

    return {
      itemId: dishId,
      name: dish.item_name || dishId,
      category: dish.category || '',
      isActive: dish.is_active !== 'no',
      price,
      // Understated by construction — see the file header. Never render it
      // without coveragePct beside it.
      costInr: round2(cost),
      // Share of the dish's leaves that carry a price. The blunt measure, and
      // the honest one: weighting by rupees would be circular, since the
      // rupees of the missing leaves are exactly what is unknown.
      leavesPriced: priced.length,
      leavesTotal: leaves.length,
      coveragePct: leaves.length ? Math.round((priced.length / leaves.length) * 1000) / 10 : 0,
      // Rupees of the menu price that the KNOWN cost eats. A floor under the
      // real food-cost percentage, never a margin — the unpriced leaves can
      // only push it up.
      knownCostPct: price != null && price > 0 ? Math.round((cost / price) * 1000) / 10 : null,
      groups,
      leaves: leaves.map((entry) => ({ ...entry, cost: entry.cost == null ? null : round2(entry.cost) })),
      missing: missing.map((entry) => ({ materialId: entry.materialId, name: entry.name, via: entry.via, gap: entry.gap })),
    };
  });

  const gaps = [...blockers.values()]
    .map((blocker) => ({ ...blocker, dishes: [...blocker.dishes], dishCount: blocker.dishes.size }))
    .sort((a, b) => b.dishCount - a.dishCount || a.name.localeCompare(b.name));

  const materialRows = [...materialCosts.values()];
  return {
    items,
    gaps,
    materials: materialRows.map((material) => ({
      materialId: material.materialId,
      name: material.name,
      category: material.category,
      group: material.group,
      perBomUnit: material.perBomUnit == null ? null : round4(material.perBomUnit),
      unit: material.basis?.unit || '',
      priceSource: material.price?.source || null,
      pricedAt: material.price?.asOf || '',
      gap: material.gap,
    })),
    totals: {
      dishes: items.length,
      // Dishes with nothing at all costed. A different problem from a thin
      // one, and the only case where the number on screen is a flat zero.
      dishesUncosted: items.filter((item) => item.leavesPriced === 0).length,
      materialsPriced: materialRows.filter((material) => material.perBomUnit != null).length,
      materialsTotal: materialRows.length,
    },
  };
}

// The same thing, off the live catalogue.
function buildCostBook() {
  return costMenuItems({
    materials: readMaterials(),
    menu: readMenu(),
    recipes: readRecipes(),
    recipeLines: readRecipeLines(),
    purchases: readPurchases(),
  });
}

export { buildCostBook, costMenuItems, priceMaterials, explodeLine, explodeSubRecipe, explodeSmoked, GROUPS };
