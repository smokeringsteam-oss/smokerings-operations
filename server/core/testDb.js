// A throwaway SQLite database for tests.
//
// This exists because of a trap the CSV era didn't have. A test that only set
// KNOWLEDGE_BASE_DATA_DIR used to be fully isolated — every read and write
// went to files under that temp directory. Now that the stores read the
// database, a test that forgets KB_SQLITE_PATH silently falls through to
// db.js's default of server/data/smokerings.db and mutates the real
// catalogue: adjustInventory would move actual stock counts, and nothing in
// the test output would say so.
//
// So: call this before importing any module under test, and point
// KB_SQLITE_PATH at what it returns.
//
// The schema is inlined rather than read from server/core/schema.sql, which
// is the real one. A fixture that changes shape whenever the schema is edited
// fails for reasons unrelated to the code under test, and the real schema
// carries constraints a fixture wants to be able to violate on purpose — the
// data-gap tests seed a bill-of-materials line with no quantity, which is
// exactly what the production CHECK forbids. Only the columns the server
// actually reads are declared here; a mismatch that matters shows up as a
// failing query rather than a passing test against a fiction.
import fs from 'fs';
import os from 'os';
import path from 'path';
// Via db.js rather than a direct `node:sqlite` import — see the note there
// about Vite rewriting that specifier out from under us.
import { DatabaseSync, closeDb } from './db.js';

// Kept deliberately close to server/core/schema.sql for the columns it
// covers, including the item/material split — a test fixture that flattened
// them back into one table would let a broken join pass.
const SCHEMA = `
CREATE TABLE item (
  item_id   TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  name      TEXT NOT NULL,
  is_active INTEGER,
  notes     TEXT
);

CREATE TABLE material (
  item_id            TEXT PRIMARY KEY REFERENCES item(item_id),
  category           TEXT,
  reorder_level      REAL,
  default_vendor_id  TEXT,
  standard_cost_inr  REAL,
  cost_basis         TEXT,
  shelf_life_days    INTEGER,
  storage            TEXT,
  order_multiple     REAL,
  quantity_on_hand   REAL,
  last_updated       TEXT,
  last_movement_ref  TEXT,
  stock_status       TEXT,
  stock_notes        TEXT,
  odoo_product_id    INTEGER
);

CREATE TABLE inventory_adjustment (
  adjustment_id    TEXT PRIMARY KEY,
  adjustment_date  TEXT,
  material_id      TEXT,
  item_name        TEXT,
  quantity         REAL,
  reason           TEXT,
  created_at       TEXT
);

CREATE TABLE menu_item (
  item_id         TEXT PRIMARY KEY REFERENCES item(item_id),
  category        TEXT,
  protein         TEXT,
  main_product_id TEXT,
  portion_size    REAL,
  price_inr       REAL,
  currency        TEXT,
  channel         TEXT,
  description     TEXT,
  odoo_product_id INTEGER
);

CREATE TABLE recipe (
  item_id                TEXT PRIMARY KEY REFERENCES item(item_id),
  kind                   TEXT,
  source_material_id     TEXT,
  output_quantity        REAL,
  portion_size           REAL,
  portions_per_batch     REAL,
  yield_pct              REAL,
  raw_weight_per_piece_g REAL,
  min_buy_unit_kg        REAL,
  batch_prep_day         TEXT,
  prepared_by            TEXT,
  shelf_life_days        INTEGER,
  storage                TEXT,
  ingredients_recorded   TEXT
);

CREATE TABLE recipe_applies_to (
  recipe_id TEXT NOT NULL REFERENCES recipe(item_id),
  item_id   TEXT NOT NULL,
  PRIMARY KEY (recipe_id, item_id)
);

CREATE TABLE bom_line (
  line_id       TEXT PRIMARY KEY,
  parent_id     TEXT NOT NULL REFERENCES item(item_id),
  child_id      TEXT NOT NULL REFERENCES item(item_id),
  quantity      REAL,
  base_quantity REAL,
  is_to_taste   INTEGER DEFAULT 0,
  status        TEXT,
  notes         TEXT,
  base_is_separate INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE b2b_client (
  client_id        TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  business_type    TEXT,
  stage            TEXT NOT NULL DEFAULT 'lead',
  contact_name     TEXT,
  contact_role     TEXT,
  phone            TEXT,
  email            TEXT,
  area             TEXT,
  address          TEXT,
  gstin            TEXT,
  lead_source      TEXT,
  order_day        TEXT,
  sample_sent_on   TEXT,
  sample_items     TEXT,
  sample_feedback  TEXT,
  sample_outcome   TEXT,
  onboarding_steps TEXT,
  price_list       TEXT,
  payment_terms    TEXT,
  onboarded_on     TEXT,
  lost_reason      TEXT,
  odoo_partner_id  INTEGER,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  payment_terms_days INTEGER NOT NULL DEFAULT 15 CHECK (payment_terms_days >= 0),
  odoo_pricelist_id   INTEGER,
  odoo_pricelist_name TEXT
);

-- The CHECK and the CASCADE are carried over from the real schema on
-- purpose: both are behaviour b2bClients.js relies on (a zeroed demand line
-- is a delete, not a 0 kg row), and a fixture that dropped them would let a
-- regression in either pass here and only show up in production.
CREATE TABLE b2b_client_demand (
  demand_id  TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES b2b_client(client_id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  qty_kg     REAL CHECK (qty_kg > 0),
  cadence    TEXT,
  notes      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every CHECK here is carried over from the real schema on purpose: they are
-- the guards b2bSales.js leans on rather than re-deriving (an overpayment, a
-- due date before the delivery, a settled flag on a part-paid invoice), and a
-- fixture that dropped them would let a regression in any of the three pass.
CREATE TABLE b2b_sale (
  sale_id         TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES b2b_client(client_id) ON DELETE CASCADE,
  delivered_on    TEXT NOT NULL,
  amount_inr      REAL NOT NULL CHECK (amount_inr > 0),
  payment_due_on  TEXT NOT NULL,
  amount_paid_inr REAL NOT NULL DEFAULT 0 CHECK (amount_paid_inr >= 0),
  paid_on         TEXT,
  invoice_number  TEXT,
  order_ref       TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  odoo_invoice_id    INTEGER,
  odoo_invoice_state TEXT,
  odoo_access_token  TEXT,
  odoo_error         TEXT,
  CONSTRAINT b2b_sale_not_overpaid CHECK (amount_paid_inr <= amount_inr),
  CONSTRAINT b2b_sale_due_after_delivery CHECK (payment_due_on >= delivered_on),
  CONSTRAINT b2b_sale_paid_in_full CHECK (paid_on IS NULL OR amount_paid_inr >= amount_inr)
);

CREATE TABLE b2b_sale_line (
  line_id         TEXT PRIMARY KEY,
  sale_id         TEXT NOT NULL REFERENCES b2b_sale(sale_id) ON DELETE CASCADE,
  position        INTEGER NOT NULL DEFAULT 0,
  odoo_product_id INTEGER,
  description     TEXT NOT NULL,
  unit_label      TEXT,
  quantity        REAL NOT NULL CHECK (quantity > 0),
  unit_price      REAL NOT NULL CHECK (unit_price >= 0),
  line_total      REAL NOT NULL CHECK (line_total >= 0)
);

-- The purchasing and smoking side. The foreign keys here are the point of
-- including them: db.js opens every connection with PRAGMA foreign_keys = ON,
-- so a purchase against a vendor that isn't in the book, or a session sourced
-- from a purchase that was deleted, fails in a test the same way it fails in
-- production. A fixture that dropped them would let exactly the bugs this
-- migration was meant to make impossible pass here.
CREATE TABLE vendor (
  vendor_id         TEXT PRIMARY KEY,
  vendor_name       TEXT NOT NULL,
  vendor_type       TEXT,
  supplies_category TEXT,
  contact_person    TEXT,
  phone             TEXT,
  email             TEXT,
  address           TEXT,
  lead_time_days    INTEGER,
  payment_terms     TEXT,
  account_owner     TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  notes             TEXT
);

CREATE TABLE purchase (
  purchase_id        TEXT PRIMARY KEY,
  purchase_date      TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
  client_id          TEXT,
  client_name        TEXT,
  smoking_session_id TEXT,
  vendor_id          TEXT NOT NULL REFERENCES vendor(vendor_id),
  item_type          TEXT CHECK (item_type IS NULL OR item_type IN ('material','service')),
  material_id        TEXT REFERENCES item(item_id),
  item_name          TEXT NOT NULL,
  quantity_purchased REAL NOT NULL CHECK (quantity_purchased > 0),
  unit_price         REAL,
  total_cost         REAL,
  currency           TEXT NOT NULL DEFAULT 'INR',
  expense_category   TEXT,
  odoo_po_id         INTEGER,
  odoo_po_line_id    INTEGER,
  notes              TEXT,
  weight_per_unit_kg REAL CHECK (weight_per_unit_kg IS NULL OR weight_per_unit_kg > 0)
);

CREATE TABLE sales_order (
  order_id            INTEGER PRIMARY KEY,
  order_name          TEXT NOT NULL UNIQUE,
  channel             TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
  status              TEXT NOT NULL,
  delivery_person     TEXT,
  tracking_url        TEXT,
  in_smoker_at        TEXT,
  prepping_at         TEXT,
  packed_at           TEXT,
  finding_partner_at  TEXT,
  assigned_partner_at TEXT,
  out_for_delivery_at TEXT,
  delivered_at        TEXT,
  invoice_number      TEXT,
  invoice_id          INTEGER,
  invoice_url         TEXT,
  invoice_error       TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The Porter delivery watch queue. The state CHECK is carried over from the
-- real schema on purpose: "which states exist" is the thing deliveryWatch.js
-- is most likely to drift on, and a fixture that took any string would let a
-- typo'd state close a watch here and fail in production.
CREATE TABLE delivery_watch (
  order_id        INTEGER PRIMARY KEY REFERENCES sales_order(order_id),
  order_name      TEXT NOT NULL,
  tracking_url    TEXT NOT NULL,
  track_url       TEXT,
  crn             TEXT,
  state           TEXT NOT NULL DEFAULT 'watching'
                    CHECK (state IN ('watching','delivered','cancelled','given_up','stopped')),
  porter_status   TEXT,
  eta_at          TEXT,
  eta_basis       TEXT,
  next_check_at   TEXT NOT NULL,
  checks          INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_checked_at TEXT,
  rider           TEXT,
  porter_ended_at TEXT,
  closed_at       TEXT,
  closed_reason   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The stage-order and yield CHECKs are carried over from the real schema
-- deliberately: smoking.js validates the same things itself, with a message
-- that names the fields, and these are what would catch it going the other
-- way round.
CREATE TABLE smoking_session (
  session_id                      TEXT PRIMARY KEY,
  session_date                    TEXT NOT NULL,
  channel                         TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
  client_id                       TEXT REFERENCES b2b_client(client_id),
  client_name                     TEXT,
  session_purpose                 TEXT,
  source_material_id              TEXT REFERENCES item(item_id),
  source_purchase_id              TEXT REFERENCES purchase(purchase_id),
  output_product_id               TEXT REFERENCES item(item_id),
  output_type                     TEXT,
  pitmaster                       TEXT,
  brine_recipe_id                 TEXT REFERENCES recipe(item_id),
  brine_start                     TEXT,
  brine_end                       TEXT,
  rub_recipe_id                   TEXT REFERENCES recipe(item_id),
  rub_start                       TEXT,
  rub_end                         TEXT,
  raw_weight_kg                   REAL CHECK (raw_weight_kg > 0),
  smoking_start                   TEXT,
  smoking_end                     TEXT,
  finished_weight_with_bone_kg    REAL CHECK (finished_weight_with_bone_kg > 0),
  finished_weight_without_bone_kg REAL CHECK (finished_weight_without_bone_kg > 0),
  yield_pct                       REAL CHECK (yield_pct > 0 AND yield_pct <= 100),
  rest_start                      TEXT,
  rest_end                        TEXT,
  shred_start                     TEXT,
  shred_end                       TEXT,
  tenderness_notes                TEXT,
  smoke_rings_formed              TEXT,
  bark_notes                      TEXT,
  juiciness                       TEXT,
  stage                           TEXT NOT NULL DEFAULT 'planned',
  data_quality_notes              TEXT,
  CONSTRAINT smk_rest_order  CHECK (rest_end IS NULL OR rest_start IS NULL OR rest_end >= rest_start),
  CONSTRAINT smk_yield_sane  CHECK (finished_weight_with_bone_kg IS NULL OR raw_weight_kg IS NULL
                                    OR finished_weight_with_bone_kg <= raw_weight_kg)
);

CREATE TABLE smoking_session_order (
  session_id TEXT    NOT NULL REFERENCES smoking_session(session_id) ON DELETE CASCADE,
  order_id   INTEGER NOT NULL REFERENCES sales_order(order_id),
  PRIMARY KEY (session_id, order_id)
);

CREATE TABLE smoking_stage_log (
  log_id               INTEGER PRIMARY KEY,
  changed_at           TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  session_date         TEXT,
  channel              TEXT,
  purpose              TEXT,
  from_stage           TEXT,
  to_stage             TEXT,
  source_material_name TEXT,
  output_type          TEXT,
  pitmaster            TEXT,
  detail               TEXT
);

CREATE TABLE weekend (
  weekend_start   TEXT PRIMARY KEY,
  weekend_end     TEXT NOT NULL,
  kitchen_status  TEXT,
  decision_reason TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  prep_status     TEXT,
  marked_at       TEXT,
  notes           TEXT
);

CREATE TABLE side_prep_status (
  weekend_start TEXT NOT NULL REFERENCES weekend(weekend_start) ON DELETE CASCADE,
  weekend_end   TEXT,
  side_key      TEXT NOT NULL,
  side_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','making','done')),
  started_at    TEXT,
  done_at       TEXT,
  PRIMARY KEY (weekend_start, side_key)
);

CREATE TABLE side_prep_log (
  log_id        INTEGER PRIMARY KEY,
  changed_at    TEXT NOT NULL,
  channel       TEXT,
  side_key      TEXT NOT NULL,
  side_name     TEXT,
  from_status   TEXT,
  to_status     TEXT,
  weekend_start TEXT,
  weekend_end   TEXT,
  source        TEXT
);

-- The marketing spend ledger. The CHECKs are the two the store leans on
-- rather than re-deriving: the category list (a typo'd category would start
-- its own bucket in the ROI rollup) and the period ordering (a backwards
-- period takes a negative share of itself into every overlap sum).
CREATE TABLE marketing_budget (
  budget_id    TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  campaign     TEXT,
  category     TEXT NOT NULL DEFAULT 'ads'
                    CHECK (category IN ('ads','commission','influencer','print','event','tooling','other')),
  amount_inr   REAL NOT NULL CHECK (amount_inr >= 0),
  vendor       TEXT,
  notes        TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT marketing_budget_period_order CHECK (period_end >= period_start)
);

-- The published tracked links and QR codes. The unique index is carried over
-- from the real schema rather than left out, because the store's save-is-an
-- -upsert behaviour is exactly what the tests exercise, and without the
-- index a bug that saved a duplicate would pass here and fail in production.
CREATE TABLE marketing_link (
  link_id      TEXT PRIMARY KEY,
  label        TEXT,
  destination  TEXT NOT NULL,
  utm_source   TEXT NOT NULL,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX marketing_link_placement_idx ON marketing_link(
  destination, utm_source, ifnull(utm_medium, ''), ifnull(utm_campaign, ''), ifnull(utm_content, '')
);

CREATE TABLE scheduled_task (
  task_id           TEXT PRIMARY KEY,
  day               TEXT NOT NULL,
  time_of_day       TEXT,
  task              TEXT NOT NULL,
  assigned_to       TEXT,
  category          TEXT,
  related_vendor_id TEXT,
  related_recipe_id TEXT,
  related_sop       TEXT,
  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE task_completion (
  week_key    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES scheduled_task(task_id) ON DELETE CASCADE,
  done        INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  time_of_day TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week_key, task_id)
);

-- Push notifications. Carried into the fixture because taskReminders.js both
-- reads the schedule and claims a delivery in the same pass, so a test of the
-- firing rules needs somewhere for that claim to land.
CREATE TABLE push_subscription (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  label         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at  TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE push_delivery (
  notify_key TEXT PRIMARY KEY,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE push_app_token (
  token         TEXT PRIMARY KEY,
  label         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_sent_at  TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

-- The shared note bubble. The CHECK is carried over from the real schema on
-- purpose: refusing a blank body is the store's one rule, and a fixture that
-- dropped it would let a regression in the trim() guard pass here.
CREATE TABLE shared_note (
  note_id    INTEGER PRIMARY KEY,
  author     TEXT,
  body       TEXT NOT NULL CHECK (trim(body) <> ''),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at    TEXT,
  done_by    TEXT,
  assigned_to TEXT,
  github_issue    INTEGER,
  github_category INTEGER
);
`;

// Creates the database and points the server at it. Returns the path so the
// caller can clean up; the temp directory is per-call, so parallel test files
// never share one.
function createTestDb({
  materials = [],
  menuItems = [],
  recipes = [],
  bomLines = [],
  vendors = [],
  purchases = [],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smokerings-db-'));
  const dbPath = path.join(dir, 'test.db');
  // Writes to the purchase and vendor tables mirror themselves out to CSV. A
  // test that didn't say where would rewrite the real knowledge-base repo's
  // purchase_log.csv with fixture rows, so the default here is a directory
  // that doesn't exist — the mirror skips. Tests about the mirror set their
  // own before calling this.
  if (!process.env.KNOWLEDGE_BASE_DATA_DIR) {
    process.env.KNOWLEDGE_BASE_DATA_DIR = path.join(dir, 'no-knowledge-base');
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  // Every fixture below seeds its item row alongside its subject row, because
  // the projections in kbViews join the two. A fixture that set up only the
  // subject row would read back as an empty result, which looks like a broken
  // query rather than a broken fixture.
  const addItem = (id, kind, name) =>
    db
      .prepare('INSERT OR IGNORE INTO item (item_id, kind, name, is_active) VALUES (?, ?, ?, 1)')
      .run(id, kind, name);

  // Seeded as item + material pairs, the way the real loader does it, so a
  // fixture can't accidentally describe a material with no item row — which
  // the catalogue's inner join would then drop, for reasons that would take a
  // while to find.
  materials.forEach((m) => {
    addItem(m.item_id, m.kind || 'raw_material', m.item_name || m.item_id);
    db.prepare(
      'INSERT INTO material (item_id, category, quantity_on_hand, reorder_level, standard_cost_inr, order_multiple, default_vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      m.item_id,
      m.category ?? null,
      m.quantity_on_hand ?? 0,
      m.reorder_level ?? null,
      m.standard_cost_inr ?? null,
      m.order_multiple ?? null,
      m.default_vendor_id ?? null,
    );
  });

  menuItems.forEach((mi) => {
    addItem(mi.item_id, 'menu_item', mi.item_name || mi.item_id);
    db.prepare(
      'INSERT INTO menu_item (item_id, category, portion_size, price_inr, currency, channel, description, odoo_product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      mi.item_id,
      mi.category ?? null,
      mi.portion_size ?? null,
      mi.price_inr ?? null,
      mi.currency ?? 'INR',
      mi.channel ?? 'B2C',
      mi.description ?? null,
      mi.odoo_product_id ?? null,
    );
  });

  recipes.forEach((r) => {
    // 'intermediate' for an IP-xxx smoked product, 'sub_recipe' for anything
    // else — the same split item.kind carries in the real database, and what
    // kbViews turns back into recipe_lines' child_type.
    addItem(r.item_id, r.kind === 'intermediate' ? 'intermediate' : 'sub_recipe', r.recipe_name || r.item_id);
    db.prepare(
      'INSERT INTO recipe (item_id, kind, output_quantity, source_material_id, yield_pct) VALUES (?, ?, ?, ?, ?)',
    ).run(
      r.item_id,
      r.recipe_kind ?? null,
      r.output_quantity ?? null,
      r.source_material_id ?? null,
      r.yield_pct ?? null,
    );
  });

  bomLines.forEach((b) => {
    db.prepare(
      'INSERT INTO bom_line (line_id, parent_id, child_id, quantity, base_quantity, is_to_taste, status, notes, base_is_separate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      b.line_id,
      b.parent_id,
      b.child_id,
      b.quantity ?? null,
      b.base_quantity ?? null,
      b.is_to_taste ? 1 : 0,
      b.status ?? 'ok',
      b.notes ?? null,
      b.base_is_separate ? 1 : 0,
    );
  });

  vendors.forEach((v) => {
    db.prepare(
      'INSERT INTO vendor (vendor_id, vendor_name, vendor_type, supplies_category) VALUES (?, ?, ?, ?)',
    ).run(v.vendor_id, v.vendor_name, v.vendor_type ?? null, v.supplies_category ?? null);
  });

  // A purchase needs its vendor in the book — that is a foreign key, not a
  // convention — so seed `vendors` alongside these.
  purchases.forEach((p) => {
    db.prepare(
      `INSERT INTO purchase (purchase_id, purchase_date, channel, client_id, client_name, smoking_session_id,
                             vendor_id, item_type, material_id, item_name, quantity_purchased,
                             unit_price, total_cost, weight_per_unit_kg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.purchase_id,
      p.purchase_date,
      p.channel ?? 'B2C',
      p.client_id ?? null,
      p.client_name ?? null,
      p.smoking_session_id ?? null,
      p.vendor_id,
      p.material_id ? 'material' : null,
      p.material_id ?? null,
      p.item_name,
      p.quantity_purchased,
      p.unit_price ?? null,
      p.total_cost ?? null,
      p.weight_per_unit_kg ?? null,
    );
  });

  db.close();
  process.env.KB_SQLITE_PATH = dbPath;
  return { dir, dbPath };
}

// Tear-down half of createTestDb — call it from afterAll instead of a bare
// fs.rmSync.
//
// Windows will not unlink a file that still has an open handle, and db.js
// holds one for the life of the process: the connection, plus the -wal and
// -shm side files WAL mode brings with it. So rmSync throws EPERM and fails
// the suite in afterAll, after every test in it has already passed — which
// reads like a real failure and is not one. Closing the connection first is
// the fix; the retries cover the moment Windows takes to release the handle.
function removeTestDb(dir) {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export { createTestDb, removeTestDb, SCHEMA };
