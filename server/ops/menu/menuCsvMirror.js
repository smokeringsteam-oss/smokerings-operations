// Mirrors a menu-item edit made in Odoo onto the knowledge-base menu.csv row.
//
// Odoo stays the source of truth: this runs *after* the Odoo write succeeded
// and copies the read-back record onto the matching CSV row, so the two can't
// drift the moment someone reprices a dish. menu.csv isn't decorative —
// server/ops/b2c/recipes.js reads it to turn weekend order counts into a prep plan
// (item names, and the menu_id every recipe line hangs off), and the AI SEO /
// content prompts quote its descriptions. A price or name changed only in
// Odoo would leave the prep sheet and the copy quoting last month's menu.
//
// A failed mirror never fails the request. The Odoo write has already
// happened and can't be rolled back honestly, and the knowledge-base repo
// may not even be checked out on this machine — so every path here returns
// { mirrored, reason } and the dashboard surfaces it as a note.
import { readCsvFile, writeCsvFile } from '../../core/csvStore.js';
import { filePath, FILES } from '../../core/knowledgeBase.js';
import { matchProduct } from '../../integrations/odoo.js';
import fs from 'fs';

// Which menu.csv column each mirrorable field lands in. Odoo's picture has no
// column here at all, which is why setMenuItemImage doesn't call this.
const COLUMNS = {
  name: 'item_name',
  price: 'price_inr',
  description: 'description',
  available: 'is_active',
};

// The column that pins a CSV row to its Odoo product. It ships blank for
// every row, so the first successful match backfills it — after that a
// rename in Odoo still finds the same row, which name matching alone
// could not survive.
const PIN_COLUMN = 'odoo_product_id';

function normalize(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function pinOf(row) {
  return String(row[PIN_COLUMN] == null ? '' : row[PIN_COLUMN]).trim();
}

// Match order runs strongest-evidence-first, and every fallback is restricted
// to rows that aren't already pinned to some *other* Odoo product — otherwise
// a keyword guess could hijack a row that was deliberately matched earlier.
function findRow(rows, item) {
  const odooId = String(item.id);

  const pinned = rows.find((row) => pinOf(row) === odooId);
  if (pinned) return { row: pinned, matchedBy: 'odoo_product_id' };

  const free = rows.filter((row) => !pinOf(row));

  // Odoo's internal reference is the natural place to have typed the menu_id.
  if (item.code) {
    const byCode = free.find((row) => normalize(row.menu_id) === normalize(item.code));
    if (byCode) return { row: byCode, matchedBy: 'internal reference' };
  }

  const byName = free.find((row) => normalize(row.item_name) === normalize(item.name));
  if (byName) return { row: byName, matchedBy: 'name' };

  // Same keyword matcher the weekend order importer uses to place Odoo order
  // lines, so a product renamed in Odoo ("Smoky Pork Tacos") still lands on
  // pork-tacos instead of silently stopping the mirror.
  const guessed = matchProduct(item.name);
  if (guessed) {
    const byGuess = free.find((row) => row.menu_id === guessed);
    if (byGuess) return { row: byGuess, matchedBy: 'name keywords' };
  }

  return { row: null, matchedBy: null };
}

// `fields` names which of COLUMNS this edit actually touched, so an edit that
// only changed the price can't overwrite a hand-written CSV description with
// whatever Odoo happens to hold in description_sale.
function mirrorMenuItemToCsv(item, fields = []) {
  try {
    const path = filePath('menu');
    if (!fs.existsSync(path)) {
      return {
        mirrored: false,
        reason: `Saved to Odoo, but ${FILES.menu} isn't at ${path}, so the knowledge-base copy wasn't updated. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env if that repo lives somewhere else.`,
      };
    }

    const { header, rows, eol } = readCsvFile(path);
    const { row, matchedBy } = findRow(rows, item);
    if (!row) {
      return {
        mirrored: false,
        reason: `Saved to Odoo, but no row in ${FILES.menu} matches "${item.name}". Add one (or put ${item.id} in its ${PIN_COLUMN} column) to keep the knowledge base in step.`,
      };
    }

    const changed = [];
    const set = (column, value) => {
      if (!header.includes(column) || row[column] === value) return;
      row[column] = value;
      changed.push(column);
    };

    if (fields.includes('name')) set(COLUMNS.name, item.name);
    // Odoo hands prices back as numbers; String() keeps 349 as "349" rather
    // than "349.00", matching how the column is already written by hand.
    if (fields.includes('price')) set(COLUMNS.price, String(item.price));
    if (fields.includes('description')) set(COLUMNS.description, item.description);
    // Odoo splits "on the menu" across sale_ok and active; menu.csv has one
    // flag, so an item that is archived OR marked unavailable reads as no.
    if (fields.includes('available')) set(COLUMNS.available, item.isAvailable && !item.isArchived ? 'yes' : 'no');

    // Backfills the pin on every successful match, including one where no
    // value actually changed — that's what makes the *next* rename findable.
    set(PIN_COLUMN, String(item.id));

    if (changed.length) writeCsvFile(path, header, rows, eol);

    return { mirrored: true, menuId: row.menu_id, matchedBy, changed };
  } catch (err) {
    return { mirrored: false, reason: `Saved to Odoo, but ${FILES.menu} couldn't be updated: ${err.message || String(err)}` };
  }
}

// Which menu.csv row each Odoo product belongs to, resolved without writing
// anything. The recipe editor needs a dish's menu_id to find its BoM rows in
// recipe_lines.csv, and that lookup is exactly the match this file already
// does for the mirror — so it runs here rather than growing a second, subtly
// different matcher next to it.
//
// One pass over the whole list, with each matched row claimed as it goes, so
// two same-named Odoo products can't both resolve to the same CSV row. A
// missing or unreadable menu.csv yields an empty map: the recipe panel then
// says the dish has no knowledge-base row, which is the truth.
function resolveMenuIds(items) {
  const resolved = new Map();
  try {
    const path = filePath('menu');
    if (!fs.existsSync(path)) return resolved;
    const { rows } = readCsvFile(path);
    const claimed = new Set();
    (items || []).forEach((item) => {
      const { row } = findRow(rows.filter((candidate) => !claimed.has(candidate)), item);
      if (!row) return;
      claimed.add(row);
      resolved.set(item.id, row.menu_id);
    });
  } catch {
    return resolved;
  }
  return resolved;
}

export { mirrorMenuItemToCsv, resolveMenuIds };
