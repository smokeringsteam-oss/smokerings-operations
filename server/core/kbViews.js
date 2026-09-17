// CSV-shaped reads over the normalized SQLite schema.
//
// The database the knowledge-base loader builds is normalized in a way the
// CSVs never were: the name, active flag and notes every file repeated
// per row live once on `item`, and the subject tables (`material`,
// `menu_item`, `recipe`) carry only what is specific to that kind of thing.
// bom_line likewise stores the parent/child ids and looks their names up.
//
// The modules reading this data — server/core/inventoryStore.js,
// server/ops/b2c/recipes.js and, later, the smoking and menu-recipe modules —
// were written against the flat CSV rows, and their logic is worth more than
// their column names: computeSwiggyPlan alone is ~200 lines of batch maths
// and gap reporting that has nothing to do with where the rows came from. So
// every query here re-flattens a row back into exactly the columns the CSV
// header had, and those modules keep working unchanged.
//
// That makes this file the whole translation layer, and the only place that
// knows both shapes. The aliasing is not cosmetic — three conventions differ
// between the two and each one is a silent wrong answer if it is dropped:
//
//   item.kind          'intermediate' -> the CSV's 'intermediate_product',
//                      which inventoryStore's raw-material filter tests for.
//   is_active          INTEGER 1/0/NULL -> 'yes'/'no'/'', the strings the
//                      callers compare against.
//   is_to_taste        INTEGER 1/0 -> 'yes'/'no'. recipes.js skips a line
//                      when this === 'yes'; a bare 1 there is never equal,
//                      so every to-taste ingredient would silently land on
//                      the shopping list with a real quantity.
//
// ORDER BY rowid everywhere, not by id: the loader inserted in CSV order and
// menu.csv's order is curated (chicken dishes, then pork, then prime cuts),
// not alphabetical. Sorting by item_id would reshuffle the dashboard's menu
// list for no reason.
import { all } from './db.js';

// 'yes'/'no'/'' from a nullable INTEGER flag. NULL stays blank rather than
// becoming 'no' — the CSVs distinguished "not active" from "never said".
const activeText = (column) =>
  `CASE ${column} WHEN 1 THEN 'yes' WHEN 0 THEN 'no' ELSE '' END`;

// materials.csv — the v2 file that merged raw_materials.csv and inventory.csv,
// so it carries both the catalogue columns and the stock count. item_id is
// the key; inventoryStore aliases it to material_id for its own callers.
const MATERIAL_SQL = `
  SELECT m.item_id,
         i.name AS item_name,
         CASE i.kind WHEN 'intermediate' THEN 'intermediate_product' ELSE i.kind END AS item_type,
         m.category,
         m.reorder_level,
         m.default_vendor_id,
         m.standard_cost_inr,
         m.cost_basis,
         m.shelf_life_days,
         m.storage,
         ${activeText('i.is_active')} AS is_active,
         m.odoo_product_id,
         m.order_multiple,
         i.notes,
         m.quantity_on_hand,
         m.last_updated,
         m.last_movement_ref,
         m.stock_status,
         m.stock_notes
    FROM material m
    JOIN item i USING (item_id)
   ORDER BY m.rowid`;

// menu.csv — the sellable dishes. The CSV called the key menu_id; the
// database calls it item_id, because a dish is an item like any other and
// bom_line points at it by that id.
const MENU_SQL = `
  SELECT mi.item_id AS menu_id,
         i.name AS item_name,
         mi.category,
         mi.protein,
         mi.main_product_id,
         mi.portion_size,
         mi.price_inr,
         mi.currency,
         ${activeText('i.is_active')} AS is_active,
         mi.channel,
         mi.odoo_product_id,
         mi.description,
         i.notes
    FROM menu_item mi
    JOIN item i USING (item_id)
   ORDER BY mi.rowid`;

// recipes.csv — every SR-xxx sub-recipe and IP-xxx smoked product.
//
// applies_to was a semicolon-joined list in the CSV ("IP-001;IP-002") and is
// a proper child table here, so it is re-joined back into that one string.
// group_concat has no defined order, hence the ordered subquery: an unstable
// "IP-002;IP-001" would show up as a spurious diff the moment anything
// exports these rows back to CSV.
const RECIPE_SQL = `
  SELECT r.item_id AS recipe_id,
         i.name AS recipe_name,
         r.kind,
         (SELECT group_concat(a.item_id, ';')
            FROM (SELECT item_id FROM recipe_applies_to
                   WHERE recipe_id = r.item_id
                   ORDER BY item_id) a) AS applies_to,
         r.source_material_id,
         r.output_quantity,
         r.portion_size,
         r.portions_per_batch,
         r.yield_pct,
         r.raw_weight_per_piece_g,
         r.min_buy_unit_kg,
         r.batch_prep_day,
         r.prepared_by,
         r.shelf_life_days,
         r.storage,
         r.ingredients_recorded,
         ${activeText('i.is_active')} AS is_active,
         i.notes
    FROM recipe r
    JOIN item i USING (item_id)
   ORDER BY r.rowid`;

// recipe_lines.csv — the one flat "parent contains N of child" bill of
// materials, covering menu items, sub-recipes and smoked products alike.
//
// child_type is derived rather than stored: the CSV's 'material' vs 'recipe'
// is exactly the raw_material / not-raw_material split that item.kind already
// records, so keeping a second copy of it would only be a way for the two to
// disagree.
//
// LEFT JOIN on both sides deliberately. Every id resolves today, but an inner
// join would make a line vanish entirely if one ever didn't — and a missing
// ingredient that silently disappears from the shopping list is far worse
// than one that shows up with a blank name, which the gap reporting in
// recipes.js already knows how to complain about.
const RECIPE_LINE_SQL = `
  SELECT b.line_id,
         b.parent_id,
         p.name AS parent_name,
         CASE c.kind WHEN 'raw_material' THEN 'material' ELSE 'recipe' END AS child_type,
         b.child_id,
         c.name AS child_name,
         b.quantity,
         b.base_quantity,
         b.base_is_separate,
         CASE b.is_to_taste WHEN 1 THEN 'yes' ELSE 'no' END AS is_to_taste,
         b.status,
         b.notes
    FROM bom_line b
    LEFT JOIN item p ON p.item_id = b.parent_id
    LEFT JOIN item c ON c.item_id = b.child_id
   ORDER BY b.rowid`;

// The last difference between the two shapes, and the easiest to overlook:
// the CSV parser had no concept of null. An empty cell parsed to '', so every
// caller downstream was written against '' — `line.notes || ''`, `qty === ''`,
// and a good few bare `${row.child_name}` interpolations in the gap messages.
// Handing those a real null turns a blank cell into the literal text "null"
// on the prep sheet, and JSON.stringify sends the same null to the dashboard.
//
// Numbers are left as numbers rather than pushed back to strings: the CSVs
// gave every column as text and every caller already funnels them through
// Number() or parseQty(), both of which treat '' and a real number the same
// way. So this only fills the holes.
function csvShaped(rows) {
  return rows.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) out[key] = row[key] == null ? '' : row[key];
    return out;
  });
}

// vendors.csv — master data the purchasing screen picks from. Flat and 1:1
// with the table apart from the active flag, but it goes through here anyway
// so every projection the screens read lives in one file.
const VENDOR_SQL = `
  SELECT v.vendor_id,
         v.vendor_name,
         v.vendor_type,
         v.supplies_category,
         v.contact_person,
         v.phone,
         v.email,
         v.address,
         v.lead_time_days,
         v.payment_terms,
         v.account_owner,
         ${activeText('v.is_active')} AS is_active,
         v.notes
    FROM vendor v
   ORDER BY v.rowid`;

// purchase_log.csv — one row per line bought.
//
// vendor_name is joined rather than stored: the log recorded both, and the
// two could disagree the moment a vendor was renamed. The join means a rename
// reaches the history too, which is what someone reading last month's spend
// actually wants.
//
// Newest first, which is the order the purchasing screen shows and the order
// the CSV reader sorted into after reading. Ties break on purchase_id
// descending so a day's buys keep the order they were logged in rather than
// coming back in whatever order the query planner found them.
const PURCHASE_SQL = `
  SELECT p.purchase_id,
         p.purchase_date,
         p.channel,
         p.purpose,
         p.client_id,
         p.client_name,
         p.smoking_session_id,
         p.vendor_id,
         v.vendor_name,
         p.item_type,
         p.material_id,
         p.item_name,
         p.quantity_purchased,
         -- The piece-bought pair: what one of them weighs, and what the line
         -- comes to in kg. Derived rather than stored, so a corrected piece
         -- weight can never disagree with the total sitting beside it. Null
         -- (blank, after csvShaped) for everything bought by weight — those
         -- lines are already in kg and quantity_purchased is the answer.
         p.weight_per_unit_kg,
         round(p.quantity_purchased * p.weight_per_unit_kg, 3) AS total_weight_kg,
         p.unit_price,
         p.total_cost,
         p.currency,
         p.expense_category,
         p.odoo_po_id,
         p.odoo_po_line_id,
         p.notes
    FROM purchase p
    LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
   ORDER BY p.purchase_date DESC, p.purchase_id DESC`;

// smoking_log.csv — one row per cook.
//
// Three names are joined in the same spirit as vendor_name above: the meat,
// the brine recipe and the rub recipe are stored as ids and read back with
// the names the Smoking Session screen renders. The CSV kept both halves of
// each pair; a rename in the catalogue used to leave the old spelling sitting
// in the session history forever.
//
// fed_order_refs is rebuilt from smoking_session_order, the join table that
// replaced the semicolon-joined "id:name;id:name" string. The UI still parses
// that string (parseFedOrders in SmokingSession.tsx), so it is re-joined here
// in id order — a stable order, unlike group_concat's own.
const SESSION_SQL = `
  SELECT s.session_id,
         s.session_date,
         s.channel,
         s.client_id,
         s.client_name,
         s.session_purpose,
         s.source_material_id,
         mat.name AS source_material_name,
         s.source_purchase_id,
         s.output_product_id,
         s.output_type,
         s.pitmaster,
         s.brine_recipe_id,
         brine.name AS brine_recipe_name,
         s.brine_start,
         s.brine_end,
         s.rub_recipe_id,
         rub.name AS rub_recipe_name,
         s.rub_start,
         s.rub_end,
         s.raw_weight_kg,
         s.smoking_start,
         s.smoking_end,
         s.finished_weight_with_bone_kg,
         s.finished_weight_without_bone_kg,
         s.yield_pct,
         s.rest_start,
         s.rest_end,
         s.shred_start,
         s.shred_end,
         s.tenderness_notes,
         s.smoke_rings_formed,
         s.bark_notes,
         s.juiciness,
         (SELECT group_concat(ref, ';')
            FROM (SELECT so.order_id || ':' || so.order_name AS ref
                    FROM smoking_session_order sso
                    JOIN sales_order so ON so.order_id = sso.order_id
                   WHERE sso.session_id = s.session_id
                   ORDER BY so.order_id)) AS fed_order_refs,
         s.stage,
         s.data_quality_notes
    FROM smoking_session s
    LEFT JOIN item mat   ON mat.item_id   = s.source_material_id
    LEFT JOIN item brine ON brine.item_id = s.brine_recipe_id
    LEFT JOIN item rub   ON rub.item_id   = s.rub_recipe_id
   ORDER BY s.session_id DESC`;

const readMaterials = () => csvShaped(all(MATERIAL_SQL));
const readMenu = () => csvShaped(all(MENU_SQL));
const readRecipes = () => csvShaped(all(RECIPE_SQL));
const readRecipeLines = () => csvShaped(all(RECIPE_LINE_SQL));
const readVendors = () => csvShaped(all(VENDOR_SQL));
const readPurchases = () => csvShaped(all(PURCHASE_SQL));
const readSessions = () => csvShaped(all(SESSION_SQL));

export {
  readMaterials,
  readMenu,
  readRecipes,
  readRecipeLines,
  readVendors,
  readPurchases,
  readSessions,
  csvShaped,
};
