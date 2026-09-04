// The recipe behind one menu item — how much meat, which sides and sauces,
// and the packaging that goes with it — read from and written back to the
// bill-of-materials table (the knowledge-base repo's recipe_lines.csv, which
// this moved off in phase 1 of the SQLite migration).
//
// This is the other half of the Edit Menu screen. server/ops/menu/menuItems.js edits
// what the *customer* sees (name, price, picture, availability, all in Odoo);
// this edits what the *kitchen* makes, which Odoo has no model for and which
// recipe_lines.csv has always been the source of truth for. Odoo is never
// touched here.
//
// Why it exists: every downstream number — the weekend meat weight, the
// Swiggy list, the packing sheet — is computed from these rows
// (server/ops/b2c/recipes.js), so "16 burgers needs 1.92 kg of chicken" is really
// "16 × whatever this file says". Editing that by hand meant opening the CSV
// and knowing the one non-obvious rule below.
//
// THE RULE, enforced here so nobody has to remember it: a row carries the
// amount twice — `quantity` as a human would say it, and `base_quantity`,
// which is the figure the planners multiply out. Every calculation reads
// `base_quantity ?? quantity`, so base_quantity silently wins, and editing
// only the quantity column changes nothing downstream.
//
// Whether a save writes one number into both columns is decided by the row's
// `base_is_separate` flag. Where it is off, the two are one amount said twice:
// the editor shows a single input and the save writes both columns, which
// re-links a base_quantity that has drifted (110 against a planner's 120).
// Where it is on, they are two deliberate figures — foil entered as 2, planned
// as 0.0667 — so both stay editable side by side and the caller is told which
// one the planner uses.
//
// That flag used to be read off a unit column beside each amount. Units of
// measure are no longer recorded and the numbers alone cannot tell the two
// cases apart, so it is stored on the row; see the note on bom_line in
// server/core/schema.sql.
//
// Moved onto the database with server/ops/b2c/recipes.js rather than after it,
// deliberately. That module reads the BoM to build the shopping list; this one
// writes it. Leaving this on the CSV for a later phase would have split the
// two — a recipe edited here would have gone into a file the planner no longer
// reads, and the weekend's meat weight would quietly have gone on using the
// old amount with nothing to show anything had been missed.
import { readRecipeLines } from '../../core/kbViews.js';
import { selectOne, transaction, update } from '../../core/repo.js';

// recipe_lines.csv keys parents and children off three non-colliding id
// spaces — menu slugs, SR-xxx sub-recipes, IP-xxx smoked products — so the
// prefix says what a child is. Same test server/ops/b2c/recipes.js uses.
const isProductId = (id) => /^IP-/.test(id || '');
const isSubRecipeId = (id) => /^SR-/.test(id || '');

// What the editor groups a line under. Meat first because it's the number
// that drives the buy list, then the made-in-house sides, then everything
// bought as-is (buns and chips as much as foil and containers).
const groupOf = (childId) => (isProductId(childId) ? 'meat' : isSubRecipeId(childId) ? 'side' : 'material');
const GROUP_ORDER = { meat: 0, side: 1, material: 2 };

const clean = (value) => String(value == null ? '' : value).trim();

// A finite number, or null for a blank/non-numeric cell — an is_to_taste row
// deliberately has no quantity, and that has to survive a round-trip through
// the editor rather than being saved back as 0.
function parseQty(value) {
  const text = clean(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Numbers go back as the shortest string that round-trips — 110, not 110.00,
// and 0.0667 unchanged — so a one-cell edit doesn't reformat the column.
const toCell = (n) => (n == null ? '' : String(n));

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}


// True when one number covers both columns, which is what lets the editor
// show a single input; false for a row carrying two deliberately different
// figures. See THE RULE at the top of the file.
const amountsLinked = (row) => !Number(row.base_is_separate);

function toLine(row) {
  const quantity = parseQty(row.quantity);
  const baseQuantity = parseQty(row.base_quantity);
  return {
    lineId: row.line_id,
    childId: row.child_id,
    childName: row.child_name || row.child_id,
    childType: row.child_type,
    group: groupOf(row.child_id),
    quantity,
    baseQuantity,
    amountsLinked: amountsLinked(row),
    // The number every planner actually multiplies by the order count. Shown
    // on the row so a stale base_quantity is visible instead of surprising
    // someone on Friday morning.
    plannerQuantity: baseQuantity ?? quantity,
    isToTaste: clean(row.is_to_taste).toLowerCase() === 'yes',
    status: clean(row.status),
    notes: clean(row.notes),
  };
}

function sortLines(lines) {
  return lines.sort(
    (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.childName.localeCompare(b.childName),
  );
}

// The whole BoM of one dish. menuId is the recipe_lines.csv parent_id, which
// is menu.csv's menu_id — the Odoo product carries it via the same match the
// CSV mirror uses (server/ops/menu/menuCsvMirror.js resolveMenuIds).
function getMenuItemRecipe({ menuId }) {
  const id = clean(menuId);
  if (!id) throw badRequest('A menu id is required to read a recipe.');
  // kbViews hands these back in recipe_lines.csv's exact column shape, so
  // toLine below is unchanged from the CSV version.
  const lines = readRecipeLines()
    .filter((row) => row.parent_id === id)
    .map(toLine);
  return { menuId: id, lines: sortLines(lines), editable: true };
}

// menu.csv states the dish's portion size next to its price, and it's the
// meat weight in every row that has one. It isn't what the planner computes
// from — that's the recipe line we just wrote — but leaving it behind means
// the menu advertises a portion the kitchen no longer plates, so a meat edit
// carries it along and says so.
//
// This used to copy the number across only where the menu's portion unit and
// the recipe line's agreed, and to say so instead of copying where they did
// not. Neither carries a unit any more, so the copy is unconditional: both
// numbers are meat weights on the same scale for every dish on file, and a
// menu portion that was written on some other scale would now be overwritten
// rather than flagged.
function mirrorPortionToMenuItem({ menuId, grams }) {
  try {
    const row = selectOne('menu_item', { item_id: menuId });
    if (!row) return null;
    if (parseQty(row.portion_size) === grams) return null;
    const was = clean(row.portion_size);
    update('menu_item', { item_id: menuId }, { portion_size: grams });
    return `Menu portion size updated ${was} → ${toCell(grams)} to match.`;
  } catch (err) {
    // The recipe write already succeeded and can't be rolled back honestly,
    // so this degrades to a note exactly like the Odoo -> menu mirror.
    return `Recipe saved, but the menu's portion size couldn't be updated: ${err.message || String(err)}`;
  }
}

// edits: [{ lineId, quantity, baseQuantity? }]
//   quantity      — the human number; '' or null clears the cell (to taste)
//   baseQuantity  — only meaningful for a line whose two amounts already
//                   differ, where the caller has to state both halves;
//                   ignored otherwise, since a linked line derives it from
//                   quantity
//
// Every edit is validated before anything is written, so a typo in the third
// row can't leave the first two saved and the rest not.
function updateMenuItemRecipe({ menuId, edits }) {
  const id = clean(menuId);
  if (!id) throw badRequest('A menu id is required to save a recipe.');
  if (!Array.isArray(edits) || !edits.length) throw badRequest('Nothing to save.');

  const byLineId = new Map(readRecipeLines().map((row) => [row.line_id, row]));

  const planned = [];
  edits.forEach((edit) => {
    const lineId = clean(edit && edit.lineId);
    const row = byLineId.get(lineId);
    if (!row) throw badRequest(`There's no recipe line ${lineId || '(blank)'}.`);
    // The dish being edited fences the write: a line id from another recipe
    // can't be repriced through this dish's editor.
    if (row.parent_id !== id) throw badRequest(`Line ${lineId} belongs to ${row.parent_id}, not ${id}.`);

    const readAmount = (value, label) => {
      const text = clean(value);
      if (!text) return null; // blank clears the cell — an is_to_taste line
      const n = Number(text);
      if (!Number.isFinite(n)) throw badRequest(`${label} for ${row.child_name || lineId} must be a number.`);
      if (n < 0) throw badRequest(`${label} for ${row.child_name || lineId} can't be negative.`);
      return n;
    };

    const quantity = readAmount(edit.quantity, 'Quantity');
    // Read off the row on file, not off the edit: a line flagged as carrying
    // two figures keeps carrying two, so a save that only touches the quantity
    // can't collapse the planner's number onto it.
    const linked = amountsLinked(row);
    const baseQuantity = linked
      ? quantity
      : edit.baseQuantity === undefined
        ? parseQty(row.base_quantity)
        : readAmount(edit.baseQuantity, 'Planner quantity');

    planned.push({ row, lineId, quantity, baseQuantity, linked });
  });

  const changed = planned.filter(
    ({ row, quantity, baseQuantity }) => parseQty(row.quantity) !== quantity || parseQty(row.base_quantity) !== baseQuantity,
  );
  // One transaction for the whole save. A recipe edit is several lines at
  // once and they only make sense together: half a saved recipe is a meat
  // weight computed from the new burger portion and the old sauce portion,
  // which is a number nobody asked for and nothing flags.
  if (changed.length) {
    transaction(() => {
      changed.forEach(({ row, quantity, baseQuantity }) => {
        update('bom_line', { line_id: row.line_id }, { quantity, base_quantity: baseQuantity });
      });
    });
  }
  const changedIds = changed.map(({ lineId }) => lineId);

  // A meat edit carries the menu's stated portion with it (see above). Only
  // one meat line per dish in practice; if there were two, the first written
  // is the one the portion follows.
  const notes = [];
  const meat = planned.find(({ row }) => isProductId(row.child_id) && changedIds.includes(row.line_id));
  if (meat) {
    const note = mirrorPortionToMenuItem({ menuId: id, grams: meat.baseQuantity });
    if (note) notes.push(note);
  }
  planned
    .filter(({ linked }) => !linked)
    .forEach(({ row, baseQuantity }) => {
      notes.push(
        `${row.child_name || row.line_id} carries a separate planner figure — the buy list uses ${toCell(baseQuantity)}, not the ${clean(row.quantity)} beside it.`,
      );
    });

  return { ...getMenuItemRecipe({ menuId: id }), changed: changedIds, notes };
}

export { getMenuItemRecipe, updateMenuItemRecipe };
