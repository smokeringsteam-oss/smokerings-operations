// Meat buying config — the one place the "how much raw meat do I buy" numbers
// live. Edit this file, restart the server, done.
//
// Before this, the two numbers behind every Meat needed tile came from the
// knowledge-base CSVs: the loss % from intermediate_products.csv's
// typical_yield_pct and the cut to buy from that same row's
// source_material_id. That indirection meant a kitchen-floor decision ("we
// pull chicken off legs, not breast") could only be changed by editing a
// spreadsheet in another repo — and it broke outright once that repo's
// 2026-08-18 restructure dropped intermediate_products.csv. Both numbers are
// business config, not observations, so they live in code now.
//
// What stays in the CSVs: the per-order finished weights
// (recipe_lines.csv — 120 g of pulled chicken per burger, …) and
// the realized raw-vs-finished weights from actual smoking sessions
// (smoking_log.csv). Those are measurements. This file is the
// plan.
//
// To change what a category is made from — the "later I might do breast to
// pulled chicken too" case — move the cut you want into `cut` and drop the
// old one into `otherCuts`. Nothing else needs touching: the buy figure, the
// tile's "Buy X of <cut>" line and the Smoking module's loss bucketing all
// read from here.

// "For the rest of the meat it is 30% loss" — every category that doesn't
// name its own lossPct below.
const DEFAULT_LOSS_PCT = 30;

// Whether a category's buy figure should follow the realized loss % measured
// from completed smoking sessions (GET /api/smoking/yield-stats) instead of
// the lossPct on file here. Off by default and deliberately so: one session
// can swing the number wildly (SMK-0003, a bone-in whole bird, measured 18.8%
// against pulled chicken's 50% and would have driven the chicken buy figure
// down by a third off a single cook). The planner still SHOWS the realized %
// next to the planned one — this only decides which one the buy figure uses.
const PREFER_REALIZED_LOSS = false;

// cut          — what we actually buy for this category. minBuyKg is the
//                vendor's minimum buy unit, rounded up to when set.
// otherCuts    — other raw materials that still count as this category when
//                one shows up in a smoking session (so realized-loss stats
//                bucket correctly), and the documented swap-in options.
// productIds   — the IP-xxx smoked-product ids recipe_lines.csv
//                uses for this category's per-order weights.
// lossPct      — % of raw weight lost between purchase and served portion.
//                Omit to take DEFAULT_LOSS_PCT.
const MEAT_CATEGORIES = {
  chicken: {
    label: 'Shredded Chicken',
    productName: 'Pulled chicken',
    productIds: ['IP-001'],
    lossPct: 50,
    cut: { materialId: 'RM-048', name: 'Chicken whole legs', minBuyKg: null },
    // Swap RM-050 into `cut` above to move pulled chicken onto breast. Breast
    // yields differently from legs — set lossPct at the same time rather than
    // carrying 50% over.
    otherCuts: [
      { materialId: 'RM-050', name: 'Chicken breast' },
      { materialId: 'RM-049', name: 'Chicken thighs' },
      { materialId: 'RM-047', name: 'Whole chicken' },
    ],
  },
  pulledPork: {
    label: 'Pulled Pork',
    productName: 'Pulled pork',
    productIds: ['IP-003'],
    lossPct: 56,
    // 1.2 kg is the meat vendor's minimum buy unit for shoulder — the buy
    // figure rounds up to a multiple of it, and the leftover shows as
    // wastage on the tile.
    cut: { materialId: 'RM-051', name: 'Pork shoulder', minBuyKg: 1.2 },
    otherCuts: [],
  },
  ribs: {
    label: 'Pork Ribs',
    productName: 'Smoked pork ribs',
    productIds: ['IP-004'],
    cut: { materialId: 'RM-052', name: 'Pork ribs', minBuyKg: null },
    otherCuts: [],
  },
  porkBelly: {
    label: 'Pork Belly',
    productName: 'Pork belly burnt ends',
    productIds: ['IP-005'],
    cut: { materialId: 'RM-053', name: 'Pork belly', minBuyKg: null },
    otherCuts: [],
  },
  jackfruit: {
    label: 'Pulled Jackfruit',
    productName: 'Pulled jackfruit',
    productIds: ['IP-007'],
    cut: { materialId: 'RM-062', name: 'Young jackfruit', minBuyKg: null },
    otherCuts: [],
  },
  beefRibs: {
    label: 'Beef Ribs',
    productName: 'Smoked beef ribs',
    productIds: ['IP-008'],
    cut: { materialId: 'RM-063', name: 'Beef ribs', minBuyKg: null },
    otherCuts: [],
  },
};

// Tile/report order — also the order the Weekend Prep Planner renders in.
const MEAT_CATEGORY_KEYS = Object.keys(MEAT_CATEGORIES);

const MEAT_CATEGORY_LABELS = Object.fromEntries(
  MEAT_CATEGORY_KEYS.map((key) => [key, MEAT_CATEGORIES[key].label]),
);

// IP-xxx -> category, for reading recipe_lines.csv's
// IP-xxx child lines (server/ops/b2c/recipes.js computeMeatPlan).
const CATEGORY_BY_PRODUCT_ID = {};
MEAT_CATEGORY_KEYS.forEach((key) => {
  (MEAT_CATEGORIES[key].productIds || []).forEach((productId) => {
    CATEGORY_BY_PRODUCT_ID[productId] = key;
  });
});

// RM-xxx -> category, covering the cut we buy plus every alternate. Used by
// the Smoking module to bucket a session's realized loss (server/ops/shared/smoking.js
// lossCategoryFor, which keeps a keyword fallback for materials not listed
// here at all).
const LOSS_CATEGORY_BY_MATERIAL_ID = {};
MEAT_CATEGORY_KEYS.forEach((key) => {
  const config = MEAT_CATEGORIES[key];
  [config.cut, ...(config.otherCuts || [])].forEach((cut) => {
    if (cut?.materialId) LOSS_CATEGORY_BY_MATERIAL_ID[cut.materialId] = key;
  });
});

// A category with every default resolved — lossPct filled in from
// DEFAULT_LOSS_PCT where the category doesn't name one, minBuyKg normalised
// to grams (the unit everything downstream of computeMeatPlan works in).
function getMeatCategory(category) {
  const config = MEAT_CATEGORIES[category];
  if (!config) return null;
  const usesDefaultLoss = config.lossPct == null;
  return {
    key: category,
    label: config.label,
    productName: config.productName,
    productIds: config.productIds || [],
    lossPct: usesDefaultLoss ? DEFAULT_LOSS_PCT : config.lossPct,
    // Tells the planner whether this number was set for this meat
    // specifically or is just the catch-all — worth surfacing, since a
    // catch-all is the first thing to re-check once real sessions exist.
    lossSource: usesDefaultLoss ? 'default' : 'configured',
    preferRealizedLoss: config.preferRealizedLoss ?? PREFER_REALIZED_LOSS,
    sourceMaterialId: config.cut?.materialId || null,
    sourceMaterialName: config.cut?.name || null,
    minBuyGrams: config.cut?.minBuyKg ? config.cut.minBuyKg * 1000 : null,
  };
}

export {
  DEFAULT_LOSS_PCT,
  PREFER_REALIZED_LOSS,
  MEAT_CATEGORIES,
  MEAT_CATEGORY_KEYS,
  MEAT_CATEGORY_LABELS,
  CATEGORY_BY_PRODUCT_ID,
  LOSS_CATEGORY_BY_MATERIAL_ID,
  getMeatCategory,
};
