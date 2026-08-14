// Smoking Session module — a 6-touchpoint sequential flow against
// smoking_session_stages.csv, one row per session moving through:
//   rub (created here as "brining") -> ready_to_smoke -> smoking -> resting -> shredding -> completed
// Brining and Rub are each logged in one pass (their own start+end times
// filled in together, since they're usually noted after the fact). Smoking
// splits into a start touchpoint and a finish touchpoint — same as the old
// two-tab flow — since a smoke runs for hours and is genuinely logged twice.
// Resting and Shredding are logged in one pass each, same as Brining/Rub.
// Meat items come from inventoryStore's Meat-category raw materials, same
// catalog the Purchasing module logs meat purchases against; inventory is
// decremented as soon as a session starts brining (that's when the meat
// is committed), same point the old flow decremented it.
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from './csvStore.js';
import { requireFile } from './knowledgeBase.js';
import { getMeatMaterials, adjustInventory } from './inventoryStore.js';

const STAGE_ORDER = ['rub', 'ready_to_smoke', 'smoking', 'resting', 'shredding', 'completed'];

function getMeatItems() {
  return getMeatMaterials();
}

// Recipes live in rub_recipes.csv (despite the filename, it covers Brine/Rub/etc
// categories) — Brining and Rub steps each filter this down to their own category
// for the recipe dropdown.
function getRecipes({ category } = {}) {
  const rows = readCsvFile(requireFile('rubRecipes')).rows;
  return category ? rows.filter((r) => r.category === category) : rows;
}

function getSessions({ status, stage } = {}) {
  const rows = readCsvFile(requireFile('smokingSessionStages')).rows;
  const filterStage = stage || status; // `status` kept as an alias so old callers/URLs still work
  const filtered = filterStage ? rows.filter((row) => row.stage === filterStage) : rows;
  return filtered.sort((a, b) => (a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0));
}

function loadRow(sessionId) {
  const path = requireFile('smokingSessionStages');
  const { header, rows } = readCsvFile(path);
  const row = rows.find((r) => r.session_id === sessionId);
  if (!row) {
    const err = new Error(`No smoking session found with id ${sessionId}.`);
    err.status = 404;
    throw err;
  }
  return { path, header, rows, row };
}

function requireStage(row, expected) {
  if (row.stage !== expected) {
    const err = new Error(`Session ${row.session_id} is at stage "${row.stage}", not "${expected}".`);
    err.status = 400;
    throw err;
  }
}

// ---- Stage 1: Brining (creates the session) --------------------------------
function startBrining({ materialId, pitmaster, brineRecipe, brineStart, brineEnd }) {
  if (!materialId) {
    const err = new Error('materialId is required.');
    err.status = 400;
    throw err;
  }
  const meat = getMeatMaterials().find((m) => m.material_id === materialId);
  if (!meat) {
    const err = new Error('Unknown meat item — pick one from the Meat category.');
    err.status = 400;
    throw err;
  }

  const path = requireFile('smokingSessionStages');
  const { header, rows } = readCsvFile(path);
  const sessionId = nextSequentialId(rows, 'session_id', 'SMK');
  const now = new Date().toISOString().slice(0, 16);

  const row = {
    session_id: sessionId,
    material_id: materialId,
    meat_item: meat.item_name,
    pitmaster: pitmaster || '',
    brine_recipe: brineRecipe || '',
    brine_start: brineStart || now,
    brine_end: brineEnd || now,
    rub_recipe: '',
    rub_start: '',
    rub_end: '',
    raw_weight_kg: '',
    smoking_start: '',
    smoking_end: '',
    finished_weight_with_bone_kg: '',
    finished_weight_without_bone_kg: '',
    rest_start: '',
    rest_end: '',
    shred_start: '',
    shred_end: '',
    tenderness_notes: '',
    smoke_rings_formed: '',
    bark_notes: '',
    juiciness: '',
    stage: 'rub',
  };

  appendCsvRows(path, header, [row]);
  return { session: row };
}

// ---- Stage 2: Rub ----------------------------------------------------------
function completeRub({ sessionId, rubRecipe, rubStart, rubEnd }) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'rub');

  row.rub_recipe = rubRecipe || '';
  row.rub_start = rubStart || '';
  row.rub_end = rubEnd || '';
  row.stage = 'ready_to_smoke';

  writeCsvFile(path, header, rows);
  return { session: row };
}

// ---- Stage 3a: Smoking — start ---------------------------------------------
function startSmoking({ sessionId, rawWeightKg, smokingStart }) {
  if (!rawWeightKg) {
    const err = new Error('rawWeightKg is required.');
    err.status = 400;
    throw err;
  }
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'ready_to_smoke');

  const weight = Number(rawWeightKg) || 0;
  const start = smokingStart || new Date().toISOString().slice(0, 16);

  row.raw_weight_kg = weight;
  row.smoking_start = start;
  row.stage = 'smoking';

  writeCsvFile(path, header, rows);

  const { applied, skipped } = adjustInventory(
    [{ materialId: row.material_id, deltaQty: -weight, itemName: row.meat_item }],
    start.slice(0, 10),
  );

  return { session: row, inventoryAdjustment: applied[0] || null, inventoryWarning: skipped[0] || null };
}

// ---- Stage 3b: Smoking — finish --------------------------------------------
function finishSmoking({ sessionId, smokingEnd, finishedWeightWithBoneKg, finishedWeightWithoutBoneKg }) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'smoking');

  row.smoking_end = smokingEnd || new Date().toISOString().slice(0, 16);
  row.finished_weight_with_bone_kg =
    finishedWeightWithBoneKg != null && finishedWeightWithBoneKg !== '' ? Number(finishedWeightWithBoneKg) : '';
  row.finished_weight_without_bone_kg =
    finishedWeightWithoutBoneKg != null && finishedWeightWithoutBoneKg !== ''
      ? Number(finishedWeightWithoutBoneKg)
      : '';
  row.stage = 'resting';

  writeCsvFile(path, header, rows);
  return { session: row };
}

// ---- Stage 4: Resting -------------------------------------------------------
function completeResting({ sessionId, restStart, restEnd }) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'resting');

  row.rest_start = restStart || '';
  row.rest_end = restEnd || '';
  row.stage = 'shredding';

  writeCsvFile(path, header, rows);
  return { session: row };
}

// ---- Stage 5: Shredding (marks the session completed) ---------------------
function completeShredding({
  sessionId,
  shredStart,
  shredEnd,
  tendernessNotes,
  smokeRingsFormed,
  barkNotes,
  juiciness,
}) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'shredding');

  row.shred_start = shredStart || '';
  row.shred_end = shredEnd || '';
  row.tenderness_notes = tendernessNotes || '';
  row.smoke_rings_formed = smokeRingsFormed || '';
  row.bark_notes = barkNotes || '';
  row.juiciness = juiciness || '';
  row.stage = 'completed';

  writeCsvFile(path, header, rows);
  return { session: row };
}

export {
  STAGE_ORDER,
  getMeatItems,
  getRecipes,
  getSessions,
  startBrining,
  completeRub,
  startSmoking,
  finishSmoking,
  completeResting,
  completeShredding,
};
