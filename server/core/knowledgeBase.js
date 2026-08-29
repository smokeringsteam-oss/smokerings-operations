// Shared file-location logic for the knowledge-base data files, used by
// server/ops/shared/purchasing.js, server/core/inventoryStore.js and server/ops/shared/smoking.js.
// The knowledge-base repo lives as a sibling to this project by default:
//   D:\Personal GIT\knowledge-base\Data\{Menu,Inventory,Purchase,Kitchen,B2B}\*.csv
// Override the location with KNOWLEDGE_BASE_DATA_DIR in .env if that repo
// lives somewhere else on a given machine.
//
// Every entry below is a path RELATIVE TO Data, not a bare filename: the
// 2026-08-19 reorganisation filed every CSV under a subject folder
// (Menu, Inventory, Purchase, Kitchen, Smoker, Tasks, B2B) — nothing is left
// at the Data root. Tasks/ holds the schedule and the two status files that
// track it: the weekly per-task log and weekend prep status.
// This map is the only place that knows the layout, so a future move is one
// edit here.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = {
  vendors: 'Purchase/vendors.csv',
  // raw_materials.csv + inventory.csv were merged into materials.csv by the
  // knowledge-base repo's v2 restructure — see its Data/MIGRATION.md. One
  // file, one row per item, carrying both the catalogue columns and the
  // stock count, so there's no separate `inventory` entry any more: the
  // key column is item_id (v1 material_id), and inventory.csv's status/notes
  // are now stock_status/stock_notes. server/core/inventoryStore.js reads and
  // writes it.
  rawMaterials: 'Inventory/materials.csv',
  // Same restructure, pure renames — identical columns to purchases.csv and
  // smoking_sessions.csv. v2's naming rule is "*_log.csv is append-only
  // history, everything else is current truth and safe to hand-edit".
  purchases: 'Purchase/purchase_log.csv',
  // smoking_session_stages.csv is gone. Despite the name it was never a
  // stage log — it was a second copy of smoking_sessions.csv at the same
  // grain (one row per session), and the poorer of the two: it lacked
  // session_date, output_product_id, source_purchase_id and yield_pct, and
  // it was missing SMK-0004 entirely. v2 folded its one unique column
  // (fed_order_refs) into the richer table and dropped it. server/ops/shared/smoking.js
  // now runs the whole stage flow off this one file.
  smokingSessions: 'Smoker/smoking_log.csv',
  // daily_view.csv -> weekly_schedule.csv ("it is a weekly cadence, not a
  // daily view") in the 2026-08-14 rename pass, which also gave it a real
  // task_id (WS-xx) primary key that recurringScheduleCsv.js uses instead of
  // a slugified day+label id. v2 shortened it again to schedule.csv; the
  // columns are unchanged.
  weeklySchedule: 'Tasks/schedule.csv',
  weeklyScheduleStatusLog: 'Tasks/weekly_schedule_status_log.csv',
  // The v2 restructure collapsed the five recipe tables into two (see the
  // knowledge-base repo's Data/MIGRATION.md):
  //   sub_recipes.csv + meat_yield_params.csv        -> recipes.csv
  //   menu_recipe_ingredients.csv
  //     + sub_recipe_ingredients.csv                 -> recipe_lines.csv
  // recipes.csv is every SR-xxx sub-recipe and IP-xxx smoked product in one
  // table; recipe_lines.csv is one flat "parent contains N of child" BoM
  // covering menu items, sub-recipes and smoked products alike.
  // server/ops/b2c/recipes.js does the splitting — see the data-model note at the
  // top of that file.
  menu: 'Menu/menu.csv',
  recipes: 'Menu/recipes.csv',
  recipeLines: 'Menu/recipe_lines.csv',
  // No intermediate_products.csv entry: the only thing this app read from it
  // was each smoked product's typical_yield_pct / source_material_id, and
  // both now live in server/core/meatConfig.js as editable config rather than
  // data on file. Keeping it listed would also make getConfig() report the
  // knowledge base as unconfigured, since the 2026-08-18 restructure
  // dropped the file.
  // v2 also renamed these two (prep_log.csv / packing_log.csv), but both are
  // files this app owns and creates on first use, and its copies carry
  // columns the v2 snapshots were built too early to have — the kitchen
  // open/closed decision here, the seven packing timestamps there. Left on
  // the names the writers already use rather than silently adopting a
  // narrower schema; worth reconciling with the knowledge-base repo.
  weekendPrepStatus: 'Tasks/weekend_prep_status.csv',
  // Renamed from Kitchen/order_packing_status.csv on 2026-08-19: the file is
  // one row per order carrying every stage stamp from in_smoker_at through
  // delivered_at plus the invoice, which is the order's whole life, so the
  // separate per-transition order_fulfilment_log.csv was retired into it at
  // the pitmaster's call rather than kept as a second trail of the same
  // moves. server/ops/shared/orderPackingStatus.js is the only writer.
  orderLifecycleLog: 'Kitchen/order_lifecycle_log.csv',
  // No inventory_adjustments.csv entry: it's created on first use rather
  // than shipped, so listing it here would make getConfig() report the
  // knowledge base as unconfigured until someone happens to log a manual
  // stock adjustment. Same reasoning as server/marketing/aiSeo.js's two files.
};

function getDataDir() {
  return process.env.KNOWLEDGE_BASE_DATA_DIR
    ? path.resolve(process.env.KNOWLEDGE_BASE_DATA_DIR)
    : path.resolve(__dirname, '../../../knowledge-base/Data');
}

function filePath(name) {
  return path.join(getDataDir(), FILES[name]);
}

function requireFile(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) {
    const err = new Error(
      `Can't find Data/${FILES[name]} at ${p}. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env if the knowledge-base repo lives somewhere else.`,
    );
    err.status = 503;
    throw err;
  }
  return p;
}

function getConfig() {
  const dataDir = getDataDir();
  const present = Object.fromEntries(
    Object.entries(FILES).map(([key, file]) => [key, fs.existsSync(path.join(dataDir, file))]),
  );
  return { dataDir, present, configured: Object.values(present).every(Boolean) };
}

export { FILES, getDataDir, filePath, requireFile, getConfig };
