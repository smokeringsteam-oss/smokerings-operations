// The Purchase Logger — every rupee that left the business, and what it was
// for.
//
// WHAT THIS IS FOR, GIVEN WEEKLY PURCHASING EXISTS
//
// Ops' Weekly Purchasing screen is a stock screen that happens to record
// money: you pick materials off the catalogue, it logs the buy and moves the
// walk-in count. It is the right tool for the Friday butcher run and the
// wrong one for a ₹1,200 print bill for posters, which has no material, no
// stock to move, and nothing to reorder.
//
// So both screens write the same `purchase` table — one spend ledger, no
// second book to reconcile, and every rollup that already reads that table
// (Spending vs Sales, the vendor totals, the per-client cost) picks this
// spend up for free. What this file adds on top is the dimension the table
// has had a column for since the CSV import and has never had a writer for:
// expense_category. See server/core/expenseCategories.js for the twelve and
// for why ad spend is not among them.
//
// THREE JOBS
//
//   log            record spend with a category on it, stock optional.
//   report         the log itself, plus category × channel rollups. The
//                  channel split is kept inside every category row because
//                  "equipment for B2B" and "posters for B2C" are the
//                  distinction this whole module exists to make.
//   categorise     put a category on lines already logged. The backfill for
//                  everything bought before today, and the standing queue for
//                  the ad hoc lines Weekly Purchasing leaves uncategorised.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not create vendors, move stock by itself, or invent a category for
// a line that has none. The first is the vendor book's job (POST
// /api/purchasing/vendors), the second is inventoryStore's and reaches this
// module only through recordPurchases, and the third is the point: an
// uncategorised line is a question for a human, and a default would answer it
// wrongly and silently.
import { all } from '../core/db.js';
import { transaction, update } from '../core/repo.js';
import { readPurchases } from '../core/kbViews.js';
import {
  EXPENSE_CATEGORIES,
  CATEGORY_NAMES,
  CATEGORY_LIST_TEXT,
  DEFAULT_MATERIAL_CATEGORY,
  normaliseExpenseCategory,
} from '../core/expenseCategories.js';
import { PURCHASE_CHANNELS, recordPurchases } from '../ops/shared/purchasing.js';

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  throw err;
};

const round = (value) => Math.round(value * 100) / 100;

const today = () => new Date().toISOString().slice(0, 10);

// ---- The vocabulary --------------------------------------------------------

// Handed to the screen so the dropdown and its hints come from the same place
// the writer validates against. A list typed a second time into the frontend
// is a list that drifts, and the drift shows up as a category that saves
// everywhere except through the UI.
function listExpenseCategories() {
  return {
    categories: EXPENSE_CATEGORIES,
    defaultForMaterials: DEFAULT_MATERIAL_CATEGORY,
    channels: PURCHASE_CHANNELS,
  };
}

// ---- Logging ---------------------------------------------------------------

// Records a buy with a category on it.
//
// Thin on purpose: recordPurchases already owns vendor validation, the id
// allocation, the transaction, the stock move and the report of which lines
// moved no stock, and re-implementing any of that here would give the app two
// ways to write a purchase that could disagree. What is added is the one rule
// this screen has that the ops one does not — a category is REQUIRED.
//
// That asymmetry is deliberate. Weekly Purchasing can fall back to "Raw
// materials" because that is what a catalogue buy on a butcher run is; this
// screen exists precisely for the spend where nobody can guess, so leaving
// the field blank here would defeat the entire reason it was built.
//
// Quantity defaults to 1. Most of what lands here is bought as a thing, not
// by the kilo — one print job, one thermometer, one gas refill — and forcing
// a quantity of 1 to be typed on every line is friction for nothing. The
// column is NOT NULL with a CHECK > 0, so it has to be something.
function logSpend({ vendorName, purchaseDate, channel, expenseCategory, lines, notes }) {
  const category = normaliseExpenseCategory(expenseCategory);
  if (!category) {
    badRequest(`An expense category is required. One of: ${CATEGORY_LIST_TEXT}.`);
  }
  if (!Array.isArray(lines) || !lines.length) {
    badRequest('At least one line is required.');
  }

  // Filled in before the handoff rather than left to recordPurchases, whose
  // own default of "drop the line" is right for a cart typed at a counter and
  // wrong for a form with one row on it: there, a missing quantity is a field
  // nobody filled, not a line nobody meant.
  const prepared = lines.map((line) => ({
    ...line,
    quantity: line.quantity == null || line.quantity === '' ? 1 : line.quantity,
    // The cart's note is the line's note when the line has none of its own.
    // One print bill with three sizes on it wants the same "Diwali menu"
    // against all three, and typing it three times invites two spellings.
    notes: line.notes || notes || null,
  }));

  const missing = prepared.find((line) => !line.itemName || !String(line.itemName).trim());
  if (missing) badRequest('Every line needs a description of what was bought.');

  return recordPurchases({
    vendorName,
    purchaseDate: purchaseDate || today(),
    channel,
    expenseCategory: category,
    lines: prepared,
  });
}

// ---- The report ------------------------------------------------------------

// Read raw rather than through kbViews' projection, for the reason
// weeklyLedger.js gives at its own copy of this query: that projection turns
// nulls into blanks for the screens, and this file has to tell a line that
// cost nothing from a line nobody has priced yet. They are different facts
// and only one of them is a problem.
const LOG_SQL = `
  SELECT p.purchase_id,
         p.purchase_date,
         p.channel,
         p.expense_category,
         p.client_id,
         p.client_name,
         p.smoking_session_id,
         p.item_type,
         p.material_id,
         p.item_name,
         p.quantity_purchased,
         p.unit_price,
         p.total_cost,
         p.notes,
         p.vendor_id,
         v.vendor_name
    FROM purchase p
    LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
   WHERE p.purchase_date >= ? AND p.purchase_date <= ?
   ORDER BY p.purchase_date DESC, p.purchase_id DESC`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(value, what) {
  const text = String(value).trim();
  if (!DATE.test(text)) badRequest(`${what} must be a date like 2026-09-04.`);
  return text;
}

// A day 90 days back, which is the default window. Long enough that a
// quarterly pattern shows and short enough that the table is readable without
// a filter on a screen someone opens to answer one question.
function defaultFrom(to) {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 89);
  return d.toISOString().slice(0, 10);
}

// The spend log, and the two rollups that make it answer something.
//
// `categories` is the one this module was built for: every category with its
// total AND its b2c/b2b split, so the same row says both what the money
// bought and which side of the business bought it. A category that only ever
// appears on one side still gets both columns, one of them zero — dropping
// the empty column would make two rows in the same table mean different
// things.
//
// `needsFiling` is carried separately from the category list rather than as a
// thirteenth entry in it. It is not a kind of spending; it is a worklist, and
// it is what the screen's backfill queue is built from.
//
// Two kinds of row are on it, because both need the same fixing:
//
//   blank    — an off-catalogue line Weekly Purchasing left uncategorised on
//              purpose, or anything bought before this column had a writer.
//   retired  — a category string that is not one of the twelve. The live
//              database has these: "Raw Material - Meat" and "Software &
//              Subscriptions" came across in the CSV import and are not in
//              the vocabulary anything writes today. They are real spend
//              filed under a name nothing else uses, which totals in their
//              own one-row bucket and reads as a category when it is a
//              leftover.
//
// It ignores the filters on purpose. The queue is a standing chore, not a
// view of the current selection — narrowing to Fuel & gas must not make the
// unfiled lines look dealt with.
function getSpendLog({ from, to, channel, category, vendor, uncategorisedOnly } = {}) {
  const toDate = to ? cleanDate(to, 'The end of the range') : today();
  const fromDate = from ? cleanDate(from, 'The start of the range') : defaultFrom(toDate);
  if (fromDate > toDate) badRequest('The start of the range is after its end.');

  if (channel && !PURCHASE_CHANNELS.includes(channel)) {
    badRequest(`channel must be one of: ${PURCHASE_CHANNELS.join(', ')}.`);
  }
  // Validated even though it only filters: a mistyped category would
  // otherwise come back as an empty table, which reads as "nothing was spent
  // on that" rather than "that is not a category".
  const wantedCategory = normaliseExpenseCategory(category);

  const everything = all(LOG_SQL, fromDate, toDate);

  // The rollups are built over the range, NOT over the filtered rows. A
  // reader who has narrowed to Practice / R&D still needs the other eleven
  // totals beside it, or there is nothing to read the ₹4,000 against.
  const byCategory = new Map();
  const totals = { spend: 0, b2c: 0, b2b: 0, lines: 0, uncostedLines: 0 };
  const unfiled = { lines: 0, spend: 0, blankLines: 0, retiredLines: 0 };

  everything.forEach((row) => {
    const side = row.channel === 'B2B' ? 'b2b' : 'b2c';
    // Null total_cost is a line logged before the bill was known. It counts
    // as a line and adds nothing to the money, and it is counted separately
    // so a suspiciously cheap category can be recognised as an unpriced one.
    const cost = row.total_cost == null ? 0 : Number(row.total_cost) || 0;
    if (row.total_cost == null) totals.uncostedLines += 1;

    totals.spend += cost;
    totals[side] += cost;
    totals.lines += 1;

    // Counted before the early return so a retired category lands on the
    // worklist AND keeps its own rollup row — the money was spent and has to
    // total somewhere, even while it waits to be re-filed.
    if (!row.expense_category || !CATEGORY_NAMES.includes(row.expense_category)) {
      unfiled.lines += 1;
      unfiled.spend += cost;
      unfiled[row.expense_category ? 'retiredLines' : 'blankLines'] += 1;
    }

    if (!row.expense_category) return;

    const bucket = byCategory.get(row.expense_category) || {
      category: row.expense_category,
      spend: 0,
      b2c: 0,
      b2b: 0,
      lines: 0,
    };
    bucket.spend += cost;
    bucket[side] += cost;
    bucket.lines += 1;
    byCategory.set(row.expense_category, bucket);
  });

  // Ordered by the vocabulary rather than by size, so the list sits still
  // between two loads of the screen and the eye can find a row where it left
  // it. Anything not in the vocabulary — a category retired from the list
  // after rows were written under it — is appended rather than dropped: the
  // money was still spent.
  const known = CATEGORY_NAMES.filter((name) => byCategory.has(name));
  const legacy = [...byCategory.keys()].filter((name) => !CATEGORY_NAMES.includes(name)).sort();
  const categories = [...known, ...legacy].map((name) => {
    const row = byCategory.get(name);
    return {
      ...row,
      spend: round(row.spend),
      b2c: round(row.b2c),
      b2b: round(row.b2b),
      retired: !CATEGORY_NAMES.includes(name),
    };
  });

  // Capped, because a first run over a year of history is a worklist nobody
  // is going to finish in one sitting and a response nobody needs in full.
  // The count beside it is the true one, so the screen can say how much is
  // left rather than implying 200 is all there is.
  const NEEDS_FILING_CAP = 200;
  const needsFilingRows = everything.filter(
    (row) => !row.expense_category || !CATEGORY_NAMES.includes(row.expense_category),
  );

  const wantedVendor = (vendor || '').trim().toLowerCase();
  const rows = everything.filter((row) => {
    if (uncategorisedOnly && row.expense_category) return false;
    if (wantedCategory && row.expense_category !== wantedCategory) return false;
    if (channel && row.channel !== channel) return false;
    if (wantedVendor && (row.vendor_name || '').toLowerCase() !== wantedVendor) return false;
    return true;
  });

  return {
    range: { from: fromDate, to: toDate },
    filters: {
      channel: channel || null,
      category: wantedCategory,
      vendor: vendor || null,
      uncategorisedOnly: !!uncategorisedOnly,
    },
    rows,
    categories,
    needsFiling: {
      ...unfiled,
      spend: round(unfiled.spend),
      rows: needsFilingRows.slice(0, NEEDS_FILING_CAP),
      truncated: needsFilingRows.length > NEEDS_FILING_CAP,
    },
    totals: {
      ...totals,
      spend: round(totals.spend),
      b2c: round(totals.b2c),
      b2b: round(totals.b2b),
      // What the filter is showing, as against what the range holds. Both,
      // because a reader looking at four rows worth ₹900 needs to know
      // whether that is the week or a slice of it.
      shownLines: rows.length,
      shownSpend: round(rows.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0)),
    },
  };
}

// ---- Backfill --------------------------------------------------------------

// Puts a category on lines that already exist.
//
// Two uses, and they are the same operation: the one-off backfill of
// everything bought before this column had a writer, and the standing chore of
// the ad hoc lines Weekly Purchasing leaves blank by design.
//
// It will overwrite a category that is already set. That is not a slip — a
// line filed as Packaging that turns out to have been the practice cook's
// foil is exactly the correction this is for, and refusing it would mean the
// only way to fix a category is to delete the purchase and retype it, which
// loses the stock move with it. One transaction, so a list of forty either
// all move or none do.
//
// Passing a blank category clears one back to uncategorised, which is how a
// line put in the wrong bucket by a bulk select gets un-done.
function categorisePurchases({ purchaseIds, expenseCategory }) {
  const ids = (Array.isArray(purchaseIds) ? purchaseIds : [purchaseIds])
    .map((id) => (id == null ? '' : String(id).trim()))
    .filter(Boolean);
  if (!ids.length) badRequest('At least one purchaseId is required.');

  const category = normaliseExpenseCategory(expenseCategory);

  const known = new Map(readPurchases().map((row) => [row.purchase_id, row]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    const err = new Error(`No purchase found with id ${missing.join(', ')}.`);
    err.status = 404;
    throw err;
  }

  transaction(() => {
    ids.forEach((id) => update('purchase', { purchase_id: id }, { expense_category: category }));
  });

  const after = new Map(readPurchases().map((row) => [row.purchase_id, row]));
  return {
    expenseCategory: category,
    updated: ids.length,
    purchases: ids.map((id) => after.get(id)),
  };
}

export { listExpenseCategories, logSpend, getSpendLog, categorisePurchases };
