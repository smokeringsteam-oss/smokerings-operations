// Which container each packable side actually goes into, and how much it
// holds — the one file to edit when the packaging catalog or a side's box
// changes.
//
// Why this lives in code rather than the knowledge-base: materials.csv
// carries the packaging catalog (RM-039…RM-046, RM-059) and
// recipe_lines.csv says how many pieces each DISH carries, but
// nothing records which SIDE goes in which box. That mapping was confirmed
// by the pitmaster on 2026-08-19:
//   • sauces/dips (BBQ sauce, coleslaw, salsa verde, sour cream, dressing)
//     → 30 ml portion cup
//   • bulk sides (salad mix, lettuce) → 30 oz packaging
// and extended 2026-08-19:
//   • caramelised onions, chopped onion → 2 oz container, one portion each
//   • chips → aluminium foil, six portions to a sheet
//
// Two ways to size a box, because sides come in two shapes:
//   * capacity — millilitres, divided into the side's own quantity. Solid
//     sides are measured in grams, treated 1 g ≈ 1 ml — close enough for
//     salad/slaw volumes and the only way to compare grams to a container.
//   * portionCapacity — how many PORTIONS fit, used where the kitchen thinks
//     in servings rather than volume (one onion per tub; six chip portions
//     per foil sheet). It wins over capacity when both are on file, and it's
//     the only thing that works for sides recorded in "burger portion" /
//     "taco portion" units, which have no volume to divide at all.

// Catalog — capacity in ml, material_id matching materials.csv so the
// container is orderable from Hyperpure (VEN-009) off the same id.
const CONTAINERS = {
  sauceCup: { materialId: 'RM-059', name: '30 ml portion cup', capacity: 30 },
  small: { materialId: 'RM-040', name: '100 ml packaging', capacity: 100 },
  round: { materialId: 'RM-041', name: '500 ml round container', capacity: 500 },
  // 30 US fl oz = 887 ml.
  tray: { materialId: 'RM-039', name: '30 oz packaging', capacity: 887 },
  square: { materialId: 'RM-042', name: '1000 ml square container', capacity: 1000 },
  // 2 US fl oz = 59 ml, but what matters is that one onion portion fills
  // one — so it's sized in portions, not volume (RM-064, added 2026-08-19).
  twoOz: { materialId: 'RM-064', name: '2 oz container', capacity: 59, portionCapacity: 1 },
  // Sold by the roll, used by the sheet: six chip portions wrap into one.
  foil: { materialId: 'RM-043', name: 'aluminium foil sheet', capacity: null, portionCapacity: 6 },
};

// Keyed the same way computeSwiggyPlan/getPackableSidesByItem key sides:
// sub-recipe id where there is one, else material id.
const SIDE_CONTAINERS = {
  'SR-013': 'sauceCup', // Sour cream
  'SR-014': 'sauceCup', // Salsa verde
  'SR-015': 'sauceCup', // BBQ sauce
  'SR-016': 'sauceCup', // Coleslaw
  'SR-018': 'sauceCup', // Salad dressing
  'SR-017': 'tray', // Salad mix
  'SR-012': 'twoOz', // Caramelised onions — one burger portion per tub
  'SR-019': 'twoOz', // Chopped onion — one taco portion per tub
  'RM-037': 'foil', // Chips — 6 portions to a foil sheet
  'RM-016': 'tray', // Green lettuce
  'RM-017': 'tray', // Iceberg lettuce — not currently on a BoM, mapped so it
  //                   doesn't fall through to the default if it ever is
};

// Sides with no explicit mapping fall back on their unit: anything poured
// (ml) is a dip and gets a cup, anything weighed (g) is bulk and gets a tray.
// Anything counted (pcs, "burger portion", …) has no volume to divide by —
// returns null, and the caller falls back to one container per order, which
// is what the boards did everywhere before this file existed.
const DEFAULT_BY_UNIT = { ml: 'sauceCup', g: 'tray' };

function getSideContainer(key, baseUnit) {
  const slot = SIDE_CONTAINERS[key] || DEFAULT_BY_UNIT[String(baseUnit || '').toLowerCase()];
  const container = slot ? CONTAINERS[slot] : null;
  if (!container) return null;
  // Both sizing fields always present on the wire so the boards can branch on
  // a value rather than on whether a key happens to exist.
  return { capacity: null, portionCapacity: null, ...container };
}

// How many of `container` a side needs. Portions win over volume where a
// portionCapacity is on file — "one onion per tub" and "6 chip portions per
// foil sheet" are how the kitchen counts these, and sides measured in
// "burger portion" have no millilitres to divide anyway. A side with a
// container but no usable quantity still needs at least one box.
function containersNeeded(qty, container, portions) {
  if (!container) return 1;
  if (container.portionCapacity > 0) {
    if (!(portions > 0)) return 1;
    return Math.ceil(portions / container.portionCapacity);
  }
  if (!container.capacity) return 1;
  if (!(qty > 0)) return 1;
  return Math.ceil(qty / container.capacity);
}

export { CONTAINERS, SIDE_CONTAINERS, getSideContainer, containersNeeded };
