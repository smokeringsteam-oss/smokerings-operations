// What one purchased unit of a material is, in the unit its bill-of-materials
// lines count in — the missing half of every cost-per-dish sum.
//
// The problem this solves
// -----------------------
// A BoM line says "110" of pulled chicken and "1" of a bun. A purchase line
// says 7 of chicken whole legs at ₹260 and 12 buns at ₹25. Multiply the two
// naively and the burger costs ₹28,600 of chicken. The 110 is grams and the
// 260 is rupees per kilo; the 1 and the 25 are both pieces. Nothing in the
// database records which — units of measure were dropped from the schema in
// the 2026-08 restructure (see the base_is_separate note in schema.sql), and
// the columns that are left cannot tell 2 sheets of foil from 0.0667 of a
// roll.
//
// So the answer is stated here, once, per material: how many BoM units one
// purchased unit buys. 1000 for anything bought by the kilo and counted in
// grams; 1 for anything bought and counted by the piece.
//
// Why this file is short, and must stay honest
// --------------------------------------------
// Only materials whose basis is actually EVIDENCED are listed. Two kinds of
// evidence count:
//
//   * materials.cost_basis says it outright ('per kg', 'per pcs'). Those are
//     not repeated below — basisOf() reads the column. Five materials.
//   * the purchase log and the BoM agree on a count. Tortillas were bought
//     10 at ₹20 and a quesadilla uses 1; chicken legs were bought 7 at ₹260,
//     which is a price per kilo and not per bird.
//
// Everything else is a guess and is deliberately absent. "Amul cream, 1 at
// ₹100" is a 250 ml pack or a litre carton depending on which one was in the
// trolley, and a sour cream costed off the wrong one is wrong by four times.
// A material with no basis here is reported as a gap by the unit-economics
// report rather than costed on a hunch — an understated cost that says so
// beats a complete one that quietly invented half of itself.
//
// To close a gap: enter the pack size on the Cost to Make screen's price
// sheet (which writes cost_basis — see server/finance/materialPrices.js), or
// add a line below with the evidence in the comment. Either is a minute's
// work and each one moves a dish's coverage up.
//
// Grams and millilitres are the same unit here
// --------------------------------------------
// The BoM does not record whether 30 of hot sauce is 30 g or 30 ml, so a
// pack stated in ml is costed per ml and a BoM line is assumed to count in
// whichever of the two the pack was stated in. For water-like liquids that is
// exact; for honey (≈1.4 g/ml) it overstates the volume a gram occupies by
// about a third. Close enough for a cost floor, and the alternative — a
// density table — would be a guess dressed as precision.

// Materials whose basis the cost_basis column does not state, but the books
// do. `bomUnits` is how many BoM units one purchased unit is.
const PURCHASE_UNITS = {
  // Meat is bought by weight from VEN-005/VEN-003 and priced per kilo:
  // ₹170 for 3.5 of whole chicken, ₹260 for 7 of legs, ₹300 for 2.5 of
  // breast are all per-kg rates, and meatConfig.js's minBuyKg treats the same
  // quantities as kilos. BoM lines for the smoked products they become are in
  // grams.
  'RM-047': { bomUnits: 1000, unit: 'g', why: 'Bought by the kilo (PUR-0005: 3.5 at ₹170)' },
  'RM-048': { bomUnits: 1000, unit: 'g', why: 'Bought by the kilo (PUR-0006: 7 at ₹260)' },
  'RM-050': { bomUnits: 1000, unit: 'g', why: 'Bought by the kilo (PUR-0007: 2.5 at ₹300)' },
  // Tortillas: bought 10 at ₹20 (PUR-0023), and a quesadilla's BoM line is 1.
  // Both sides are counting the same pieces.
  'RM-056': { bomUnits: 1, unit: 'pcs', why: 'Bought by the piece (PUR-0023: 10 at ₹20); BoM counts 1 per quesadilla' },
};

// The pack units the price sheet offers, and what one of each is in BoM
// units. kg and L are stored as themselves ('per kg', 'per 2 L') rather than
// converted to grams on the way in, so cost_basis still reads the way the
// label on the pack does.
const PACK_UNITS = {
  g: { bomUnits: 1, unit: 'g' },
  kg: { bomUnits: 1000, unit: 'g' },
  ml: { bomUnits: 1, unit: 'ml' },
  L: { bomUnits: 1000, unit: 'ml' },
  pcs: { bomUnits: 1, unit: 'pcs' },
  dozen: { bomUnits: 12, unit: 'pcs' },
  roll: { bomUnits: 1, unit: 'roll' },
};

// Spellings a person or an older row might use, onto the PACK_UNITS keys.
// Longest first inside the regex below, so 'litres' is not read as 'l' + junk
// and 'nos' is not read as 'no'.
const UNIT_ALIASES = {
  kgs: 'kg',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  grams: 'g',
  gram: 'g',
  gms: 'g',
  gm: 'g',
  g: 'g',
  ml: 'ml',
  litres: 'L',
  litre: 'L',
  liters: 'L',
  liter: 'L',
  ltr: 'L',
  l: 'L',
  pieces: 'pcs',
  piece: 'pcs',
  pcs: 'pcs',
  pc: 'pcs',
  nos: 'pcs',
  no: 'pcs',
  each: 'pcs',
  dozen: 'dozen',
  dz: 'dozen',
  rolls: 'roll',
  roll: 'roll',
};
const UNIT_PATTERN = Object.keys(UNIT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|');
const COST_BASIS_RE = new RegExp(`^per\\s*(\\d+(?:\\.\\d+)?)?\\s*(${UNIT_PATTERN})\\b`, 'i');

// A pack size and unit, in the one spelling the price sheet writes:
// 'per kg', 'per 250 ml', 'per 30 pcs', 'per roll'. The count is left off at
// one, which is also how the rows written before the sheet existed read.
function formatCostBasis(packSize, packUnit) {
  const size = Number(packSize);
  if (!PACK_UNITS[packUnit] || !Number.isFinite(size) || size <= 0) return null;
  return size === 1 ? `per ${packUnit}` : `per ${size} ${packUnit}`;
}

// 'per kg', 'per 250 ml', 'per 2 L', 'per 30 pcs', with the trailing
// parenthetical some rows carry ('per pcs (2-ft baguette, ~30 slices)').
// Anything else — a blank, or free text nobody has normalised — is not a
// basis and does not become one by being guessed at.
function basisFromCostBasis(costBasis) {
  const text = String(costBasis || '').trim();
  const match = COST_BASIS_RE.exec(text);
  if (!match) return null;
  const size = match[1] == null ? 1 : Number(match[1]);
  const packUnit = UNIT_ALIASES[match[2].toLowerCase()];
  if (!(size > 0) || !packUnit) return null;
  const { bomUnits, unit } = PACK_UNITS[packUnit];
  return { bomUnits: size * bomUnits, unit, packSize: size, packUnit, why: `materials.cost_basis "${costBasis}"` };
}

// The basis for one material, or null when there is no honest answer.
//
// The column wins over the declared table. The column is what somebody set on
// the price sheet, looking at the pack in their hand; the table is the
// fallback for the handful of materials whose basis was worked out from the
// purchase log before the sheet existed. A pack size entered on screen is the
// newer evidence, and a table that silently overrode it would make the sheet
// look broken.
function basisOf(materialId, costBasis) {
  return basisFromCostBasis(costBasis) || PURCHASE_UNITS[materialId] || null;
}

// A pack size read out of free text — a purchase line's item name ("Amul
// Blend Diced Cheese 200 g", "Coriander Bunch 100 g") or its notes. Only a
// suggestion for the price sheet to pre-fill: it is shown beside the
// purchase it came from and saved only when someone presses Save.
const PACK_IN_TEXT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, 'i');
function packFromText(text) {
  const match = PACK_IN_TEXT_RE.exec(String(text || ''));
  if (!match) return null;
  const size = Number(match[1]);
  const packUnit = UNIT_ALIASES[match[2].toLowerCase()];
  if (!(size > 0) || !packUnit) return null;
  return { packSize: size, packUnit };
}

export { PURCHASE_UNITS, PACK_UNITS, basisOf, basisFromCostBasis, formatCostBasis, packFromText };
