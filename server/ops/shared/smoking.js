// Smoking Session module — a sequential flow over the `smoking_session`
// table, one row per session moving through:
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
// Migrated off Smoker/smoking_log.csv. The rows the screen reads keep the
// CSV's exact column names — server/core/kbViews.js readSessions() re-flattens
// them, joining the meat's and the two recipes' names back in and rebuilding
// fed_order_refs from the smoking_session_order join table — so the whole
// flow and the Smoking Session screen were unchanged by the move.
//
// What the database adds, and the file could not:
//
//   * The stage timings are checked. A rest that ends before it starts, or a
//     finished weight heavier than the raw weight, is a typo the CSV would
//     have taken silently and quietly wrong-footed every yield number since.
//     Each one is caught here with a message naming the two fields, rather
//     than left to surface as a constraint error.
//   * Creating a batch is one transaction, so three meats brined together
//     either all get a session or none do.
import { LOSS_CATEGORY_BY_MATERIAL_ID, MEAT_CATEGORY_KEYS } from '../../core/meatConfig.js';
import { all } from '../../core/db.js';
import { insert, nextId, remove, selectOne, transaction, update } from '../../core/repo.js';
import { readRecipes, readSessions } from '../../core/kbViews.js';
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
// Still accepted from old callers (mapped to purpose=Practice, channel B2C —
// the channel column is NOT NULL now, and the weekend service is where every
// practice cook this predates actually happened), never written for new
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

// Empty strings are what the screen sends for a field left blank, and what
// the CSV stored. A column that means "not recorded" should hold NULL, not a
// zero-length string: the stage-order CHECKs below compare timestamps, and ''
// compares as less than every real one.
const orNull = (value) => (value === '' || value === undefined ? null : value);
const numberOrNull = (value) => (value === '' || value == null ? null : Number(value));

// One stage transition, onto the stage log. Called after the session row
// itself is written, so a logging failure can't cost the stage change.
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

// Recipes are one table covering Brine/Rub/Sauce/Prep/… and the IP-xxx smoked
// products, told apart by `kind`. Brining and Rub steps each filter this down
// to their own kind for the recipe dropdown; `category` is kept as the
// parameter name since that's what the API callers already pass.
function getRecipes({ category } = {}) {
  const rows = readRecipes();
  return category ? rows.filter((r) => r.kind === category) : rows;
}

function getSessions({ status, stage } = {}) {
  const filterStage = stage || status; // `status` kept as an alias so old callers/URLs still work
  const rows = readSessions();
  return filterStage ? rows.filter((row) => row.stage === filterStage) : rows;
}

// The Brining and Rub steps pick a recipe by name from the dropdown
// (/api/smoking/recipes), but the session records the id and reads the name
// back through the join. Resolving one from the other is what keeps the id
// column real instead of blank; an unmatched name (hand-typed, or a recipe
// since renamed) just leaves it empty rather than failing the step.
function recipeIdForName(recipeName) {
  if (!recipeName) return null;
  return getRecipes().find((r) => r.recipe_name === recipeName)?.recipe_id || null;
}

// The session as the screen sees it — through the same projection getSessions
// uses, so a step's response and a later list refresh can't disagree.
function loadRow(sessionId) {
  const row = readSessions().find((r) => r.session_id === sessionId);
  if (!row) {
    const err = new Error(`No smoking session found with id ${sessionId}.`);
    err.status = 404;
    throw err;
  }
  return row;
}

function requireStage(row, expected) {
  if (row.stage !== expected) {
    const err = new Error(`Session ${row.session_id} is at stage "${row.stage}", not "${expected}".`);
    err.status = 400;
    throw err;
  }
}

// A stage whose end is before its start is a typo — usually a date picker
// left on the wrong day — and it is worth catching at the point it is typed.
// The database refuses it either way (see the smk_*_order constraints), but a
// constraint error names a constraint; this names the two fields.
function requireOrder(label, start, end) {
  if (start && end && end < start) {
    const err = new Error(`${label} ends before it starts (${start} → ${end}).`);
    err.status = 400;
    throw err;
  }
}

// Writes the patch, then hands back the freshly projected row. Every step
// below ends this way rather than returning the object it just built, so what
// the screen renders after a step is what a reload would show.
function patchSession(sessionId, patch) {
  update('smoking_session', { session_id: sessionId }, patch);
  return loadRow(sessionId);
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
  const sessionChannel = isLegacyPractice ? 'B2C' : requested;
  const sessionPurpose =
    purpose || (isLegacyPractice ? 'Practice' : DEFAULT_PURPOSE_BY_CHANNEL[sessionChannel] || 'Order');

  if (!CHANNELS.includes(sessionChannel)) {
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
  // account. The id isn't checked against the client book here — this module
  // deliberately doesn't read the B2B side at all; the UI picks from the real
  // list, index.js resolves the name, and the foreign key catches the rest.
  const sessionClientId = sessionChannel === 'B2B' ? clientId || null : null;
  const sessionClientName = sessionClientId ? clientName || null : null;

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

  const now = new Date().toISOString().slice(0, 16);
  const brineStartedAt = brineStart || now;
  const brineEndedAt = brineEnd || now;
  requireOrder('The brine', brineStartedAt, brineEndedAt);
  const brineRecipeId = recipeIdForName(brineRecipe);

  const created = transaction(() =>
    resolved.map(({ meat, outputType: lineOutputType }) => {
      const sessionId = nextId('smoking_session', 'session_id', 'SMK');
      insert('smoking_session', {
        session_id: sessionId,
        // The day the session belongs to is the day it went into the brine,
        // not today — brine times are routinely logged after the fact, which
        // is why Brining is a one-pass step in the first place.
        session_date: brineStartedAt.slice(0, 10),
        channel: sessionChannel,
        client_id: sessionClientId,
        client_name: sessionClientName,
        session_purpose: sessionPurpose,
        source_material_id: meat.material_id,
        output_type: lineOutputType || 'Pulled',
        pitmaster: pitmaster || null,
        brine_recipe_id: brineRecipeId,
        brine_start: brineStartedAt,
        brine_end: brineEndedAt,
        stage: 'rub',
      });
      return sessionId;
    }),
  );

  const sessions = created.map(loadRow);
  // One log row per session in the batch — they're brined together but move
  // through the remaining stages separately, so the history has to be
  // per-session from the start.
  sessions.forEach((row) =>
    logStage(row, '', `Session created — brined with ${brineRecipe || 'no recipe recorded'}`),
  );
  return { session: sessions[0], sessions };
}

// ---- Stage 2: Rub ----------------------------------------------------------
function completeRub({ sessionId, rubRecipe, rubStart, rubEnd }) {
  const existing = loadRow(sessionId);
  requireStage(existing, 'rub');
  requireOrder('The rub', rubStart, rubEnd);

  const row = patchSession(sessionId, {
    rub_recipe_id: recipeIdForName(rubRecipe),
    rub_start: orNull(rubStart),
    rub_end: orNull(rubEnd),
    stage: 'ready_to_smoke',
  });

  logStage(row, 'rub', `Rubbed with ${rubRecipe || 'no recipe recorded'}`);
  return { session: row };
}

// ---- Purchase link (picked at Start Smoking) -------------------------------
// Every purchase of a material is a lot the pitmaster can pick from —
// "remaining" nets out whatever's already been claimed by other sessions'
// source_purchase_id, so the picker only ever shows real leftover stock, not
// the original purchase quantity. Sorted oldest-purchase-first (encourages
// FIFO even though the pick itself is manual, not automatic — see
// SmokingSession.tsx's "Sourced from purchase" dropdown).
//
// The netting is a correlated subquery rather than a pass over every session
// in JavaScript: it is the same arithmetic, but it only touches the sessions
// that actually claimed one of these lots.
//
// It also has to be done in one unit, and raw_weight_kg only ever speaks kg.
// That is fine for a lot bought by weight, where quantity_purchased is kg
// already, and wrong for one bought by the piece: four whole chickens minus a
// 1.6 kg cook is not "2.4 birds left". So a lot that records what one piece
// weighs is converted to kg first and reports `remaining` in kg;
// `remaining_unit` says which of the two the number is in, since the picker
// prints it. A piece-bought lot logged before anyone weighed it has no
// conversion available and stays on the old, honest-but-blunt count.
function getAvailablePurchasesForMaterial(materialId, { excludeSessionId } = {}) {
  if (!materialId) return [];
  return all(
    `SELECT p.purchase_id,
            p.purchase_date,
            coalesce(v.vendor_name, '')    AS vendor_name,
            p.quantity_purchased,
            coalesce(p.unit_of_measure, '') AS unit_of_measure,
            p.weight_per_unit_kg,
            round(p.quantity_purchased * coalesce(p.weight_per_unit_kg, 1) - coalesce(
              (SELECT sum(s.raw_weight_kg)
                 FROM smoking_session s
                WHERE s.source_purchase_id = p.purchase_id
                  AND s.session_id <> coalesce(?, '')), 0), 2) AS remaining,
            CASE WHEN p.weight_per_unit_kg IS NOT NULL THEN 'kg'
                 ELSE coalesce(p.unit_of_measure, '') END      AS remaining_unit
       FROM purchase p
       LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
      WHERE p.material_id = ?
      ORDER BY p.purchase_date, p.purchase_id`,
    excludeSessionId || null,
    materialId,
  );
}

// ---- Purchase tagging (also picked at Start Smoking) -----------------------
// The wider list behind "which buys was this cook for": every purchase line on
// the same side of the business, from the days leading up to the session, that
// isn't already claimed by a different cook.
//
// Deliberately NOT filtered to the session's meat, unlike
// getAvailablePurchasesForMaterial above. That one answers "where did this
// raw weight come from", so only lots of that exact material can answer it.
// This one answers "what did this cook cost", and the honest answer includes
// the rub spices, the wood and the packaging bought alongside the meat. Two
// questions, two lists, two columns — see the note on the attribution columns
// in server/ops/shared/purchasing.js.
//
// The lookback window exists because a purchase log grows without bound and a
// checklist of every buy ever made is a checklist nobody reads. Anchored on
// the session date rather than today so that logging a cook a week late still
// shows the buys that actually fed it.
const TAGGABLE_PURCHASE_LOOKBACK_DAYS = 21;

function getTaggablePurchases(sessionId, { days = TAGGABLE_PURCHASE_LOOKBACK_DAYS } = {}) {
  const row = loadRow(sessionId);

  const anchorDate = row.session_date || new Date().toISOString().slice(0, 10);
  const since = new Date(`${anchorDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString().slice(0, 10);

  return all(
    `SELECT p.purchase_id,
            p.purchase_date,
            coalesce(v.vendor_name, '')     AS vendor_name,
            p.item_name,
            p.quantity_purchased,
            coalesce(p.unit_of_measure, '') AS unit_of_measure,
            p.total_cost,
            coalesce(p.client_name, '')     AS client_name,
            -- Already pointing at this session — the UI starts these ticked,
            -- since re-opening the step shouldn't look like nothing was ever
            -- tagged.
            p.smoking_session_id = ? AS tagged,
            -- This cook's own meat, so the checklist can float it to the top:
            -- it's the line the pitmaster is nearly always looking for.
            (? IS NOT NULL AND p.material_id = ?) AS isSessionMaterial
       FROM purchase p
       LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
      WHERE p.channel = ?
        AND (p.smoking_session_id IS NULL OR p.smoking_session_id = ?)
        AND p.purchase_date >= ?
      ORDER BY isSessionMaterial DESC, p.purchase_date DESC, p.purchase_id DESC`,
    sessionId,
    row.source_material_id || null,
    row.source_material_id || null,
    row.channel,
    sessionId,
    sinceIso,
  ).map((p) => ({
    ...p,
    total_cost: p.total_cost == null ? null : Number(p.total_cost),
    tagged: !!p.tagged,
    isSessionMaterial: !!p.isSessionMaterial,
  }));
}

// ---- Stage 3a: Smoking — start ---------------------------------------------
// sourcePurchaseId records which purchase lot the raw weight came from —
// required whenever there's at least one purchase on file for this material
// (closes the "which purchase did this come from" gap), but left optional when
// there's genuinely nothing logged yet for that material (e.g. a cut that's
// never been purchased through this system), so that data gap surfaces on its
// own rather than blocking the smoke.
//
// taggedPurchaseIds is the separate, wider "what did this cook cost" set (see
// getTaggablePurchases) written onto the purchases' smoking_session_id. The
// sourced-from lot is folded into it automatically — a lot this session is
// literally eating is a cost of this session by definition, so making the
// pitmaster tick it twice would only create a way to get it wrong.
function startSmoking({ sessionId, rawWeightKg, smokingStart, sourcePurchaseId, taggedPurchaseIds }) {
  if (!rawWeightKg) {
    const err = new Error('rawWeightKg is required.');
    err.status = 400;
    throw err;
  }
  const existing = loadRow(sessionId);
  requireStage(existing, 'ready_to_smoke');

  const weight = Number(rawWeightKg) || 0;
  if (weight <= 0) {
    const err = new Error('rawWeightKg must be greater than 0.');
    err.status = 400;
    throw err;
  }
  const start = smokingStart || new Date().toISOString().slice(0, 16);

  const available = getAvailablePurchasesForMaterial(existing.source_material_id, {
    excludeSessionId: sessionId,
  });
  let purchaseWarning = null;
  if (sourcePurchaseId) {
    const purchase = available.find((p) => p.purchase_id === sourcePurchaseId);
    if (!purchase) {
      const err = new Error(
        `${sourcePurchaseId} isn't a purchase on file for ${existing.source_material_name}.`,
      );
      err.status = 400;
      throw err;
    }
    if (purchase.remaining < weight) {
      purchaseWarning = `${sourcePurchaseId} only has ${purchase.remaining}${purchase.unit_of_measure || 'kg'} left on file, but ${weight}kg was logged against it — check the purchase log.`;
    }
  } else if (available.length) {
    const err = new Error(
      `Pick which purchase this was sourced from — ${available.length} on file for ${existing.source_material_name}.`,
    );
    err.status = 400;
    throw err;
  }

  const row = patchSession(sessionId, {
    raw_weight_kg: weight,
    source_purchase_id: sourcePurchaseId || null,
    smoking_start: start,
    stage: 'smoking',
  });

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
// hand-entered sessions fill it in too. With-bone weight wins when both are
// present, matching the loss stats below.
function finishSmoking({ sessionId, smokingEnd, finishedWeightWithBoneKg, finishedWeightWithoutBoneKg }) {
  const existing = loadRow(sessionId);
  requireStage(existing, 'smoking');

  const end = smokingEnd || new Date().toISOString().slice(0, 16);
  requireOrder('The smoke', existing.smoking_start, end);

  const candidate = {
    ...existing,
    finished_weight_with_bone_kg: numberOrNull(finishedWeightWithBoneKg),
    finished_weight_without_bone_kg: numberOrNull(finishedWeightWithoutBoneKg),
  };
  const raw = Number(existing.raw_weight_kg) || 0;
  const finished = finishedWeightOf(candidate);
  // Meat only ever loses weight on a smoker, so a finished weight above the
  // raw one is a mistyped number — and left alone it would put a yield over
  // 100% into the stats the Weekend Prep Planner buys meat against.
  if (finished != null && raw > 0 && finished > raw) {
    const err = new Error(
      `Finished weight (${finished}kg) is heavier than the ${raw}kg that went on the smoker — check the weights.`,
    );
    err.status = 400;
    throw err;
  }

  const row = patchSession(sessionId, {
    smoking_end: end,
    finished_weight_with_bone_kg: candidate.finished_weight_with_bone_kg,
    finished_weight_without_bone_kg: candidate.finished_weight_without_bone_kg,
    yield_pct: yieldPctFor(candidate),
    stage: 'resting',
  });

  logStage(row, 'smoking', `Off the smoker${row.yield_pct !== '' ? ` — ${row.yield_pct}% yield` : ''}`);
  return { session: row };
}

// Finished weight as a % of raw, to one decimal — or null when either weight
// is missing or the raw weight is zero, so the column stays honestly empty
// rather than reading 0% or NaN.
function yieldPctFor(row) {
  const raw = Number(row.raw_weight_kg) || 0;
  const finished = finishedWeightOf(row);
  if (!raw || finished == null) return null;
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
  const existing = loadRow(sessionId);
  requireStage(existing, 'resting');
  requireOrder('The rest', restStart, restEnd);

  const patch = {
    rest_start: orNull(restStart),
    rest_end: orNull(restEnd),
    stage: needsShredding(existing) ? 'shredding' : 'completed',
  };
  if (patch.stage === 'completed') {
    patch.tenderness_notes = orNull(tendernessNotes);
    patch.smoke_rings_formed = orNull(smokeRingsFormed);
    patch.bark_notes = orNull(barkNotes);
    patch.juiciness = orNull(juiciness);
  }

  const row = patchSession(sessionId, patch);
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
  const existing = loadRow(sessionId);
  requireStage(existing, 'shredding');
  requireOrder('The shred', shredStart, shredEnd);

  const row = patchSession(sessionId, {
    shred_start: orNull(shredStart),
    shred_end: orNull(shredEnd),
    tenderness_notes: orNull(tendernessNotes),
    smoke_rings_formed: orNull(smokeRingsFormed),
    bark_notes: orNull(barkNotes),
    juiciness: orNull(juiciness),
    stage: 'completed',
  });

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
//
// The links live in smoking_session_order now, where the CSV had a
// semicolon-joined "id:name" string. That means the order has to exist in
// sales_order to be pointed at, and most of these are orders the packing
// board hasn't touched yet — so a stub row is written for any that are
// missing, carrying the name and channel the picker already knows. The
// packing board fills the rest in when the order reaches it.
function setFedOrders({ sessionId, orders }) {
  const existing = loadRow(sessionId);
  const list = (Array.isArray(orders) ? orders : []).filter((o) => o?.id && o?.name);

  transaction(() => {
    list.forEach((order) => {
      // Written only when the order is genuinely new here. An upsert would
      // overwrite the packing board's row — an order that has already been
      // delivered and invoiced would drop back to 'pending' just because a
      // session was linked to it afterwards, which is the normal order of
      // events.
      if (selectOne('sales_order', { order_id: Number(order.id) })) return;
      insert('sales_order', {
        order_id: Number(order.id),
        order_name: order.name,
        channel: existing.channel || 'B2C',
        // Not a packing status: this order hasn't been through the board yet.
        status: 'pending',
      });
    });
    // required: false — a session that fed nothing yet has no links to clear,
    // and re-picking the same orders is a legitimate no-op.
    remove('smoking_session_order', { session_id: sessionId }, { required: false });
    list.forEach((order) => insert('smoking_session_order', { session_id: sessionId, order_id: Number(order.id) }));
  });

  return { session: loadRow(sessionId) };
}

// ---- Realized smoking loss (feeds the Weekend Prep Planner) ----------------
// Maps a session's raw material to one of the planner's meat categories.
// The material -> category map is derived from server/core/meatConfig.js (each
// category's cut plus its listed alternates), so buying chicken breast
// instead of legs needs no change here. Matched by material_id first,
// falling back to a keyword match on the item name so a catalogue row that
// isn't in the config at all still lands in the right bucket — same "match,
// or fall back" spirit as odoo.js's product matching.

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
  const totals = {}; // category -> { rawKg, finishedKg, sessionCount }

  readSessions().forEach((row) => {
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

// Removes a session entirely and, if it had already reached the smoking stage
// (i.e. startSmoking had already decremented inventory for it), reverses that
// inventory adjustment — the opposite of the adjustInventory call in
// startSmoking(). Sessions deleted before smoke-start never touched inventory,
// so raw_weight_kg is empty and no reversal is needed.
function deleteSession(sessionId) {
  const row = loadRow(sessionId);

  // The order links go with it (smoking_session_order cascades on the foreign
  // key); the stage log does not, which is the point of it.
  remove('smoking_session', { session_id: sessionId });
  // Not a stage move, but the one event that makes a session vanish — logged
  // so the history still explains where it went.
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
