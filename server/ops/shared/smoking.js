// Smoking Session module — a sequential flow against smoking_log.csv, one
// row per session moving through:
//   rub (created here as "brining") -> ready_to_smoke -> smoking -> resting -> shredding -> completed
// Brining and Rub are each logged in one pass (their own start+end times
// filled in together, since they're usually noted after the fact). Smoking
// splits into a start touchpoint and a finish touchpoint — same as the old
// two-tab flow — since a smoke runs for hours and is genuinely logged twice.
// Resting and Shredding are logged in one pass each, same as Brining/Rub.
// The Shredding stage only applies to sessions whose output_type is
// "Pulled" (pulled chicken/pork) — everything else (whole chicken served
// bone-in, ribs, burnt ends, ...) isn't shredded, so it completes straight
// off of Resting instead. See needsShredding() below.
// Meat items come from inventoryStore's Meat-category raw materials, same
// catalog the Purchasing module logs meat purchases against; inventory is
// decremented as soon as a session starts brining (that's when the meat
// is committed), same point the old flow decremented it.
//
// This ran off smoking_session_stages.csv until the knowledge-base repo's v2
// restructure deleted it — despite the name it was never a stage log, just a
// second copy of smoking_sessions.csv at the same grain and the poorer of
// the two. smoking_log.csv (v2's name for the richer table) is the same data
// with better column names, so the flow is unchanged and only the names it
// reads and writes moved:
//   who_is_it_for -> channel             material_id -> source_material_id
//   meat_item     -> source_material_name
//   brine_recipe  -> brine_recipe_name   rub_recipe  -> rub_recipe_name
// plus four columns the old file didn't have. Three of them this flow can
// fill honestly and now does — session_date, brine_recipe_id/rub_recipe_id
// (resolved from the picked recipe name), and yield_pct at Smoking Finish,
// which is exactly the raw-vs-finished ratio already recorded either side of
// it. output_product_id is left blank: nothing on file maps a cut plus an
// output type to a specific IP-xxx, and guessing one would be worse than the
// gap.
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from '../../core/csvStore.js';
import { LOSS_CATEGORY_BY_MATERIAL_ID, MEAT_CATEGORY_KEYS } from '../../core/meatConfig.js';
import { requireFile } from '../../core/knowledgeBase.js';
import { getMeatMaterials, adjustInventory } from '../../core/inventoryStore.js';
import { logStageChange } from './smokingStageLog.js';
import { tagPurchasesToSession, clearSessionPurchaseTags } from './purchasing.js';

const STAGE_ORDER = ['rub', 'ready_to_smoke', 'smoking', 'resting', 'shredding', 'completed'];

// Not every session ends up shredded — only sessions whose final product is
// "Pulled" (pulled chicken/pork for burgers, tacos, quesadillas) go through
// the Shredding stage. Everything else (whole chicken served bone-in, ribs,
// burnt ends, etc.) is done resting and skips straight to 'completed'.
const OUTPUT_TYPES = ['Pulled', 'Whole/Sliced'];

// Two independent facts about a session, which used to be squashed into the
// single `channel` column:
//   channel  — which side of the business the cook is for (B2C weekend
//              service, or a B2B wholesale/corporate account)
//   purpose  — why it was cooked: feeding a real order, a sample tray for a
//              B2B account to taste (see server/ops/b2b/b2bClients.js's Sampling
//              stage), or pure practice/recipe testing
// Splitting them is what lets B2B run the same stage flow as B2C without
// losing that most B2B cooks today are samples, not orders — the old single
// field could say "Practising Session" OR "B2B", never both. Both channels
// accept all three purposes: B2B samples and practice cooks are the common
// case now, but an Active B2B account ordering weekly is a real order too.
const CHANNELS = ['B2C', 'B2B'];
const SESSION_PURPOSES = ['Order', 'Sample', 'Practice'];
// What the picker starts on per channel — B2C sessions are nearly always
// feeding the weekend's orders, B2B ones are nearly always a sample tray.
const DEFAULT_PURPOSE_BY_CHANNEL = { B2C: 'Order', B2B: 'Sample' };
// The pre-split value that meant "practice" by occupying the channel column.
// Still accepted from old callers (mapped to purpose=Practice, no channel —
// which side it was for genuinely wasn't recorded), never written for new
// sessions.
const LEGACY_PRACTICE_CHANNEL = 'Practising Session';
const needsShredding = (row) => (row.output_type || 'Pulled') === 'Pulled'; // blank = legacy rows, treat as Pulled

// A session's purpose, tolerant of rows written before the column existed:
// the legacy channel value means Practice, anything else was feeding an
// order (the only other thing sessions were used for back then).
function purposeOf(row) {
  if (row.session_purpose) return row.session_purpose;
  return row.channel === LEGACY_PRACTICE_CHANNEL ? 'Practice' : 'Order';
}

// smoking_log.csv gained session_purpose when B2B sessions did, then
// client_id/client_name when B2B cost attribution did, so a knowledge-base
// checkout that predates either gets the columns added (right after channel,
// where they read) and backfilled on first use. Without this, writeCsvFile —
// which only ever writes the columns the header names — would silently drop
// the values off every save, the same trap orderPackingStatus.js's
// ensureFile() guards against.
//
// The client is which B2B account a cook is FOR: a sample tray is always
// aimed at somebody specific, and until now the row couldn't say who. It is
// also what lets the purchases tagged to a session inherit an account, which
// is how meat spend reaches the client book — see tagPurchasesToSession in
// server/ops/shared/purchasing.js. Optional even for B2B: a speculative sample cooked
// before anyone's asked for it has no client, and that's a real answer.
//
// Checked once per process: the file is small, but every stage step reads it
// and there's no point re-parsing it for a migration that's already run.
const ADDED_SESSION_COLUMNS = ['session_purpose', 'client_id', 'client_name'];

let sessionColumnsChecked = false;
function sessionsFile() {
  const path = requireFile('smokingSessions');
  if (sessionColumnsChecked) return path;

  const { header, rows } = readCsvFile(path);
  const missing = ADDED_SESSION_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length) {
    const migrated = [...header];
    const afterChannel = migrated.indexOf('channel');
    migrated.splice(afterChannel >= 0 ? afterChannel + 1 : migrated.length, 0, ...missing);
    rows.forEach((row) => {
      // session_purpose can be inferred from the pre-split rows; which client
      // a historic cook was for cannot, so those backfill blank.
      missing.forEach((col) => {
        row[col] = row[col] || (col === 'session_purpose' ? purposeOf(row) : '');
      });
    });
    writeCsvFile(path, migrated, rows);
  }
  sessionColumnsChecked = true;
  return path;
}

// One stage transition, onto smoking_stage_log.csv. Called after the session
// row itself is written, so a logging failure can't cost the stage change.
function logStage(row, fromStage, detail) {
  logStageChange({
    sessionId: row.session_id,
    sessionDate: row.session_date,
    channel: row.channel,
    purpose: purposeOf(row),
    fromStage,
    toStage: row.stage,
    materialName: row.source_material_name,
    outputType: row.output_type,
    pitmaster: row.pitmaster,
    detail,
  });
}

function getMeatItems() {
  return getMeatMaterials();
}

// Recipes live in recipes.csv — one table covering Brine/Rub/Sauce/Prep/… and
// the IP-xxx smoked products, told apart by `kind` (v1: sub_recipes.csv's
// `category`). Brining and Rub steps each filter this down to their own kind
// for the recipe dropdown; `category` is kept as the parameter name since
// that's what the API callers already pass.
function getRecipes({ category } = {}) {
  const rows = readCsvFile(requireFile('recipes')).rows;
  return category ? rows.filter((r) => r.kind === category) : rows;
}

function getSessions({ status, stage } = {}) {
  const rows = readCsvFile(sessionsFile()).rows;
  const filterStage = stage || status; // `status` kept as an alias so old callers/URLs still work
  const filtered = filterStage ? rows.filter((row) => row.stage === filterStage) : rows;
  return filtered.sort((a, b) => (a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0));
}

// The Brining and Rub steps pick a recipe by name from the dropdown
// (/api/smoking/recipes -> recipes.csv), but smoking_log.csv records both
// the id and the name. Resolving one from the other keeps the id column real
// instead of blank; an unmatched name (hand-typed, or a recipe since renamed)
// just leaves the id empty rather than failing the step.
function recipeIdForName(recipeName) {
  if (!recipeName) return '';
  return getRecipes().find((r) => r.recipe_name === recipeName)?.recipe_id || '';
}

function loadRow(sessionId) {
  const path = sessionsFile();
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
// One smoking session can cover several meats brined/rubbed together as a
// batch (e.g. chicken thighs + pork shoulder go in the same brine at once) —
// `lines` is the multi-item shape ([{ materialId, outputType }, ...]); a
// bare materialId/outputType at the top level still works as a one-line
// batch, for callers that only ever smoke one thing at a time. Every line
// gets its own session_id and moves through the remaining stages (Rub,
// Smoking, Resting, Shredding) independently, since each meat finishes
// smoking/resting/shredding on its own schedule even when it started
// brining together — but they all share the same pitmaster/brine
// recipe/timing/order type, since that part of the batch genuinely happened
// together.
function startBrining({
  materialId,
  pitmaster,
  brineRecipe,
  brineStart,
  brineEnd,
  channel,
  purpose,
  clientId,
  clientName,
  orderType,
  outputType,
  lines,
}) {
  const items = Array.isArray(lines) && lines.length ? lines : materialId ? [{ materialId, outputType }] : [];
  if (!items.length) {
    const err = new Error('At least one meat item is required.');
    err.status = 400;
    throw err;
  }
  // `orderType` is the pre-split single field, still accepted so an older
  // caller doesn't break: 'B2C'/'B2B' are channels, 'Practising Session' is a
  // purpose that never said which channel it belonged to.
  const requested = channel || orderType || 'B2C';
  const isLegacyPractice = requested === LEGACY_PRACTICE_CHANNEL;
  const sessionChannel = isLegacyPractice ? '' : requested;
  const sessionPurpose =
    purpose || (isLegacyPractice ? 'Practice' : DEFAULT_PURPOSE_BY_CHANNEL[sessionChannel] || 'Order');

  if (sessionChannel && !CHANNELS.includes(sessionChannel)) {
    const err = new Error(`channel must be one of: ${CHANNELS.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  if (!SESSION_PURPOSES.includes(sessionPurpose)) {
    const err = new Error(`purpose must be one of: ${SESSION_PURPOSES.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  // Only B2B has an account book to point at. A client tag arriving on a B2C
  // cook is dropped rather than stored, so nothing downstream has to wonder
  // what a weekend service session is doing attributed to a wholesale
  // account. The id isn't validated against b2b_clients.csv here — this
  // module deliberately doesn't import that one (same reasoning as the
  // Data/B2B files being kept out of knowledgeBase.js's FILES map); the UI
  // picks from the real list, and index.js resolves the name.
  const sessionClientId = sessionChannel === 'B2B' ? clientId || '' : '';
  const sessionClientName = sessionClientId ? clientName || '' : '';

  // Resolve and validate every line up front so a bad item in a batch of
  // several doesn't leave a partial write behind.
  const resolved = items.map((item) => {
    if (!item.materialId) {
      const err = new Error('materialId is required for every meat item.');
      err.status = 400;
      throw err;
    }
    const meat = getMeatMaterials().find((m) => m.material_id === item.materialId);
    if (!meat) {
      const err = new Error('Unknown meat item — pick one from the Meat category.');
      err.status = 400;
      throw err;
    }
    if (item.outputType && !OUTPUT_TYPES.includes(item.outputType)) {
      const err = new Error(`outputType must be one of: ${OUTPUT_TYPES.join(', ')}.`);
      err.status = 400;
      throw err;
    }
    return { meat, outputType: item.outputType };
  });

  const path = sessionsFile();
  const { header, rows } = readCsvFile(path);
  const now = new Date().toISOString().slice(0, 16);
  const brineStartedAt = brineStart || now;

  const firstId = nextSequentialId(rows, 'session_id', 'SMK');
  const idWidth = firstId.split('-')[1].length;
  let nextNum = Number(firstId.split('-')[1]);

  const createdRows = resolved.map(({ meat, outputType: lineOutputType }) => {
    const sessionId = `SMK-${String(nextNum).padStart(idWidth, '0')}`;
    nextNum += 1;
    return {
      session_id: sessionId,
      // The day the session belongs to is the day it went into the brine,
      // not today — brine times are routinely logged after the fact, which
      // is why Brining is a one-pass step in the first place.
      session_date: brineStartedAt.slice(0, 10),
      channel: sessionChannel,
      session_purpose: sessionPurpose,
      client_id: sessionClientId,
      client_name: sessionClientName,
      source_material_id: meat.material_id,
      source_material_name: meat.item_name,
      source_purchase_id: '',
      output_product_id: '',
      output_type: lineOutputType || 'Pulled',
      pitmaster: pitmaster || '',
      brine_recipe_id: recipeIdForName(brineRecipe),
      brine_recipe_name: brineRecipe || '',
      brine_start: brineStartedAt,
      brine_end: brineEnd || now,
      rub_recipe_id: '',
      rub_recipe_name: '',
      rub_start: '',
      rub_end: '',
      raw_weight_kg: '',
      smoking_start: '',
      smoking_end: '',
      finished_weight_with_bone_kg: '',
      finished_weight_without_bone_kg: '',
      // Filled at Smoking Finish, once there is a raw and a finished weight
      // to divide — see finishSmoking.
      yield_pct: '',
      rest_start: '',
      rest_end: '',
      shred_start: '',
      shred_end: '',
      tenderness_notes: '',
      smoke_rings_formed: '',
      bark_notes: '',
      juiciness: '',
      fed_order_refs: '',
      stage: 'rub',
      data_quality_notes: '',
    };
  });

  appendCsvRows(path, header, createdRows);
  // One log row per session in the batch — they're brined together but move
  // through the remaining stages separately, so the history has to be
  // per-session from the start.
  createdRows.forEach((row) =>
    logStage(row, '', `Session created — brined with ${brineRecipe || 'no recipe recorded'}`),
  );
  return { session: createdRows[0], sessions: createdRows };
}

// ---- Stage 2: Rub ----------------------------------------------------------
function completeRub({ sessionId, rubRecipe, rubStart, rubEnd }) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'rub');

  row.rub_recipe_id = recipeIdForName(rubRecipe);
  row.rub_recipe_name = rubRecipe || '';
  row.rub_start = rubStart || '';
  row.rub_end = rubEnd || '';
  row.stage = 'ready_to_smoke';

  writeCsvFile(path, header, rows);
  logStage(row, 'rub', `Rubbed with ${rubRecipe || 'no recipe recorded'}`);
  return { session: row };
}

// ---- Purchase link (picked at Start Smoking) -------------------------------
// Every purchase_log.csv row for a material is a lot the pitmaster can pick
// from — "remaining" nets out whatever's already been claimed by other
// sessions' source_purchase_id, so the picker only ever shows real leftover
// stock, not the original purchase quantity. Sorted oldest-purchase-first
// (encourages FIFO even though the pick itself is manual, not automatic —
// see SmokingSession.tsx's "Sourced from purchase" dropdown).
function getAvailablePurchasesForMaterial(materialId, { excludeSessionId } = {}) {
  if (!materialId) return [];
  const purchases = readCsvFile(requireFile('purchases')).rows.filter((p) => p.material_id === materialId);
  if (!purchases.length) return [];

  const sessions = readCsvFile(sessionsFile()).rows;
  const consumedByPurchase = {};
  sessions.forEach((s) => {
    if (!s.source_purchase_id || s.session_id === excludeSessionId) return;
    consumedByPurchase[s.source_purchase_id] = (consumedByPurchase[s.source_purchase_id] || 0) + (Number(s.raw_weight_kg) || 0);
  });

  return purchases
    .map((p) => {
      const purchased = Number(p.quantity_purchased) || 0;
      const consumed = consumedByPurchase[p.purchase_id] || 0;
      return {
        purchase_id: p.purchase_id,
        purchase_date: p.purchase_date,
        vendor_name: p.vendor_name || '',
        quantity_purchased: purchased,
        unit_of_measure: p.unit_of_measure || '',
        remaining: Math.round((purchased - consumed) * 100) / 100,
      };
    })
    .sort((a, b) => (a.purchase_date < b.purchase_date ? -1 : a.purchase_date > b.purchase_date ? 1 : 0));
}

// ---- Purchase tagging (also picked at Start Smoking) -----------------------
// The wider list behind "which buys was this cook for": every purchase_log.csv
// line on the same side of the business, from the days leading up to the
// session, that isn't already claimed by a different cook.
//
// Deliberately NOT filtered to the session's meat, unlike
// getAvailablePurchasesForMaterial above. That one answers "where did this
// raw weight come from", so only lots of that exact material can answer it.
// This one answers "what did this cook cost", and the honest answer includes
// the rub spices, the wood and the packaging bought alongside the meat. Two
// questions, two lists, two columns — see the note above
// ADDED_PURCHASE_COLUMNS in server/ops/shared/purchasing.js.
//
// The lookback window exists because a purchase log grows without bound and a
// checklist of every buy ever made is a checklist nobody reads. Anchored on
// the session date rather than today so that logging a cook a week late still
// shows the buys that actually fed it.
const TAGGABLE_PURCHASE_LOOKBACK_DAYS = 21;

function getTaggablePurchases(sessionId, { days = TAGGABLE_PURCHASE_LOOKBACK_DAYS } = {}) {
  const { row } = loadRow(sessionId);

  const anchorDate = row.session_date || new Date().toISOString().slice(0, 10);
  const since = new Date(`${anchorDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString().slice(0, 10);

  // Blank channel reads as B2C, the same way it does everywhere else that
  // predates the column.
  const sessionChannel = row.channel || 'B2C';

  return readCsvFile(requireFile('purchases'))
    .rows.filter((p) => {
      if ((p.channel || 'B2C') !== sessionChannel) return false;
      if (p.smoking_session_id && p.smoking_session_id !== sessionId) return false;
      if (p.purchase_date && p.purchase_date < sinceIso) return false;
      return true;
    })
    .map((p) => ({
      purchase_id: p.purchase_id,
      purchase_date: p.purchase_date || '',
      vendor_name: p.vendor_name || '',
      item_name: p.item_name || '',
      quantity_purchased: Number(p.quantity_purchased) || 0,
      unit_of_measure: p.unit_of_measure || '',
      total_cost: p.total_cost === '' || p.total_cost == null ? null : Number(p.total_cost),
      client_name: p.client_name || '',
      // Already pointing at this session — the UI starts these ticked, since
      // re-opening the step shouldn't look like nothing was ever tagged.
      tagged: p.smoking_session_id === sessionId,
      // This cook's own meat, so the checklist can float it to the top: it's
      // the line the pitmaster is nearly always looking for.
      isSessionMaterial: !!row.source_material_id && p.material_id === row.source_material_id,
    }))
    .sort(
      (a, b) =>
        Number(b.isSessionMaterial) - Number(a.isSessionMaterial) ||
        (a.purchase_date < b.purchase_date ? 1 : a.purchase_date > b.purchase_date ? -1 : 0),
    );
}

// ---- Stage 3a: Smoking — start ---------------------------------------------
// sourcePurchaseId records which purchase_log.csv lot the raw weight came from
// — required whenever there's at least one purchase on file for this
// material (closes the "which purchase did this come from" gap), but left
// optional when there's genuinely nothing logged yet for that material (e.g.
// a cut that's never been purchased through this system), so that data gap
// surfaces on its own rather than blocking the smoke.
//
// taggedPurchaseIds is the separate, wider "what did this cook cost" set (see
// getTaggablePurchases) written onto purchase_log.csv's smoking_session_id.
// The sourced-from lot is folded into it automatically — a lot this session
// is literally eating is a cost of this session by definition, so making the
// pitmaster tick it twice would only create a way to get it wrong.
function startSmoking({ sessionId, rawWeightKg, smokingStart, sourcePurchaseId, taggedPurchaseIds }) {
  if (!rawWeightKg) {
    const err = new Error('rawWeightKg is required.');
    err.status = 400;
    throw err;
  }
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'ready_to_smoke');

  const weight = Number(rawWeightKg) || 0;
  const start = smokingStart || new Date().toISOString().slice(0, 16);

  const available = getAvailablePurchasesForMaterial(row.source_material_id, { excludeSessionId: sessionId });
  let purchaseWarning = null;
  if (sourcePurchaseId) {
    const purchase = available.find((p) => p.purchase_id === sourcePurchaseId);
    if (!purchase) {
      const err = new Error(`${sourcePurchaseId} isn't a purchase on file for ${row.source_material_name}.`);
      err.status = 400;
      throw err;
    }
    if (purchase.remaining < weight) {
      purchaseWarning = `${sourcePurchaseId} only has ${purchase.remaining}${purchase.unit_of_measure || 'kg'} left on file, but ${weight}kg was logged against it — check the purchase log.`;
    }
  } else if (available.length) {
    const err = new Error(`Pick which purchase this was sourced from — ${available.length} on file for ${row.source_material_name}.`);
    err.status = 400;
    throw err;
  }

  row.raw_weight_kg = weight;
  row.source_purchase_id = sourcePurchaseId || '';
  row.smoking_start = start;
  row.stage = 'smoking';

  writeCsvFile(path, header, rows);
  logStage(
    row,
    'ready_to_smoke',
    `On the smoker — ${weight}kg raw${sourcePurchaseId ? ` from ${sourcePurchaseId}` : ''}`,
  );

  // After the session row is safely written, and swallowing its failures the
  // same way logStageChange does: the meat is going on the smoker either way,
  // and losing the stage change over a bookkeeping write would cost far more
  // than the tags are worth. Reported back so the UI can say so rather than
  // implying the spend was attributed when it wasn't.
  const toTag = Array.from(new Set([...(taggedPurchaseIds || []), ...(sourcePurchaseId ? [sourcePurchaseId] : [])]));
  let purchaseTags = null;
  let purchaseTagError = null;
  try {
    purchaseTags = tagPurchasesToSession({
      sessionId: row.session_id,
      purchaseIds: toTag,
      clientId: row.client_id,
      clientName: row.client_name,
    });
  } catch (err) {
    purchaseTagError = err.message || String(err);
    console.error(`Failed to tag purchases to ${row.session_id}:`, purchaseTagError);
  }

  const { applied, skipped } = adjustInventory(
    [{ materialId: row.source_material_id, deltaQty: -weight, itemName: row.source_material_name }],
    start.slice(0, 10),
  );

  return {
    session: row,
    inventoryAdjustment: applied[0] || null,
    inventoryWarning: skipped[0] || null,
    purchaseWarning,
    purchaseTags,
    purchaseTagError,
  };
}

// ---- Stage 3b: Smoking — finish --------------------------------------------
// Both weights are now on the row, so this is where yield_pct gets recorded.
// It's a stored restatement of finished/raw, not a new measurement — the same
// arithmetic getRealizedLossStats does on the fly, kept on the row because
// smoking_log.csv already carries the column and hand-entered rows fill it.
// With-bone weight wins when both are present, matching the loss stats below.
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
  row.yield_pct = yieldPctFor(row);
  row.stage = 'resting';

  writeCsvFile(path, header, rows);
  logStage(
    row,
    'smoking',
    `Off the smoker${row.yield_pct !== '' ? ` — ${row.yield_pct}% yield` : ''}`,
  );
  return { session: row };
}

// Finished weight as a % of raw, to one decimal — or '' when either weight is
// missing or the raw weight is zero, so the column stays honestly blank
// rather than reading 0% or NaN.
function yieldPctFor(row) {
  const raw = Number(row.raw_weight_kg) || 0;
  const finished = finishedWeightOf(row);
  if (!raw || finished == null) return '';
  return Math.round((finished / raw) * 1000) / 10;
}

// The finished weight to compare against raw: with-bone when it's there,
// otherwise without-bone. Shared by yield_pct and getRealizedLossStats so
// the stored number and the computed one can't drift apart.
function finishedWeightOf(row) {
  const value =
    row.finished_weight_with_bone_kg !== '' && row.finished_weight_with_bone_kg != null
      ? row.finished_weight_with_bone_kg
      : row.finished_weight_without_bone_kg;
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---- Stage 4: Resting -------------------------------------------------------
// Sessions producing a "Pulled" output move on to Shredding as before.
// Everything else is done once it's rested, so the tasting notes normally
// captured at Shredding are captured here instead and the session completes.
function completeResting({ sessionId, restStart, restEnd, tendernessNotes, smokeRingsFormed, barkNotes, juiciness }) {
  const { path, header, rows, row } = loadRow(sessionId);
  requireStage(row, 'resting');

  row.rest_start = restStart || '';
  row.rest_end = restEnd || '';

  if (needsShredding(row)) {
    row.stage = 'shredding';
  } else {
    row.tenderness_notes = tendernessNotes || '';
    row.smoke_rings_formed = smokeRingsFormed || '';
    row.bark_notes = barkNotes || '';
    row.juiciness = juiciness || '';
    row.stage = 'completed';
  }

  writeCsvFile(path, header, rows);
  // A non-Pulled session finishes here rather than at Shredding, so the same
  // call logs either resting -> shredding or resting -> completed.
  logStage(row, 'resting', row.stage === 'completed' ? 'Rested — not shredded, session complete' : 'Rested');
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
  logStage(row, 'shredding', 'Shredded — session complete');
  return { session: row };
}

// ---- Order link (which orders this session fed) ----------------------------
// Deliberately not gated to a particular stage — real batches are often
// smoked ahead of the orders that'll eventually claim them (Thu/Fri prep for
// a weekend that isn't fully confirmed yet), so "which order(s) did this
// feed" is frequently only knowable once packing happens, well after the
// session itself completed. Callable any time; overwrites whatever was
// linked before rather than appending, so re-opening the picker to fix a
// mistake just replaces the list.
function setFedOrders({ sessionId, orders }) {
  const { path, header, rows, row } = loadRow(sessionId);
  const list = Array.isArray(orders) ? orders : [];
  row.fed_order_refs = list.map((o) => `${o.id}:${o.name}`).join(';');
  writeCsvFile(path, header, rows);
  return { session: row };
}

// ---- Realized smoking loss (feeds the Weekend Prep Planner) ----------------
// Maps a session's raw material to one of the planner's meat categories.
// The material -> category map is derived from server/core/meatConfig.js (each
// category's cut plus its listed alternates), so buying chicken breast
// instead of legs needs no change here. Matched by material_id first,
// falling back to a keyword match on the item name so a materials.csv
// row that isn't in the config at all still lands in the right bucket —
// same "match, or fall back" spirit as odoo.js's product matching.

function lossCategoryFor(row) {
  const byId = LOSS_CATEGORY_BY_MATERIAL_ID[row.source_material_id];
  if (byId) return byId;
  const name = (row.source_material_name || '').toLowerCase();
  // Checked before the generic 'rib' match below so "beef ribs" doesn't
  // land in the pork ribs bucket.
  if (name.includes('beef')) return 'beefRibs';
  if (name.includes('jackfruit')) return 'jackfruit';
  if (name.includes('belly')) return 'porkBelly';
  if (name.includes('rib')) return 'ribs';
  if (name.includes('shoulder')) return 'pulledPork';
  if (name.includes('chicken')) return 'chicken';
  return null;
}

// Realized yield per category from every session with both a raw and a
// finished weight on file — as soon as Smoking Finish is logged, not only
// once the session fully completes, since those two weights don't change
// after that point. Weighted by kg (not a plain average of percentages) so
// one big batch doesn't get drowned out by several small ones. A category
// with no sessions yet on file comes back null — the Weekend Prep Planner
// falls back to its static starting-guess default in that case.
function getRealizedLossStats() {
  const rows = readCsvFile(sessionsFile()).rows;
  const totals = {}; // category -> { rawKg, finishedKg, sessionCount }

  rows.forEach((row) => {
    const raw = Number(row.raw_weight_kg) || 0;
    const finished = finishedWeightOf(row);
    if (!raw || finished == null) return;

    const category = lossCategoryFor(row);
    if (!category) return;

    if (!totals[category]) totals[category] = { rawKg: 0, finishedKg: 0, sessionCount: 0 };
    totals[category].rawKg += raw;
    totals[category].finishedKg += finished;
    totals[category].sessionCount += 1;
  });

  const result = {};
  MEAT_CATEGORY_KEYS.forEach((category) => {
    const t = totals[category];
    if (!t || t.rawKg <= 0) {
      result[category] = null;
      return;
    }
    result[category] = {
      lossPct: Math.round(((t.rawKg - t.finishedKg) / t.rawKg) * 1000) / 10,
      sessionCount: t.sessionCount,
      rawKg: Math.round(t.rawKg * 100) / 100,
      finishedKg: Math.round(t.finishedKg * 100) / 100,
    };
  });
  return result;
}

// Removes a smoking_log.csv row entirely and, if the session had
// already reached the smoking stage (i.e. startSmoking had already
// decremented inventory for it), reverses that inventory adjustment — the
// opposite of the adjustInventory call in startSmoking(). Sessions deleted
// before smoke-start never touched inventory, so raw_weight_kg is empty and
// no reversal is needed.
function deleteSession(sessionId) {
  const { path, header, rows, row } = loadRow(sessionId);
  const index = rows.indexOf(row);

  rows.splice(index, 1);
  writeCsvFile(path, header, rows);
  // Not a stage move, but the one event that makes a session vanish from
  // smoking_log.csv — logged so the history still explains where it went.
  logStageChange({
    sessionId: row.session_id,
    sessionDate: row.session_date,
    channel: row.channel,
    purpose: purposeOf(row),
    fromStage: row.stage,
    toStage: 'deleted',
    materialName: row.source_material_name,
    outputType: row.output_type,
    pitmaster: row.pitmaster,
    detail: 'Session deleted',
  });

  let inventoryReversal = null;
  if (row.source_material_id && row.raw_weight_kg !== '' && row.raw_weight_kg != null) {
    const { applied } = adjustInventory(
      [
        {
          materialId: row.source_material_id,
          deltaQty: Number(row.raw_weight_kg) || 0,
          itemName: row.source_material_name,
        },
      ],
      new Date().toISOString().slice(0, 10),
    );
    inventoryReversal = applied[0] || null;
  }

  // Any spend tagged to this cook goes back to untagged rather than pointing
  // at an SMK id that no longer resolves. The purchases themselves stay —
  // deleting a mis-logged session shouldn't erase the money that was spent.
  const purchaseTags = clearSessionPurchaseTags(row.session_id);

  return { deleted: row, inventoryReversal, purchaseTags };
}

export {
  STAGE_ORDER,
  OUTPUT_TYPES,
  CHANNELS,
  SESSION_PURPOSES,
  DEFAULT_PURPOSE_BY_CHANNEL,
  purposeOf,
  getMeatItems,
  getRecipes,
  getSessions,
  startBrining,
  completeRub,
  getAvailablePurchasesForMaterial,
  getTaggablePurchases,
  startSmoking,
  finishSmoking,
  completeResting,
  completeShredding,
  setFedOrders,
  getRealizedLossStats,
  deleteSession,
};
