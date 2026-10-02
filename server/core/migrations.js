// Brings an existing database up to server/core/schema.sql.
//
// The schema used to live in the knowledge-base repo, where `npm run kb:import`
// applied it once and every later change meant reseeding from the CSVs. That
// worked while the CSVs were the source of truth. Now that they aren't — the
// database holds rows no CSV has ever seen — a schema change has to be an
// alteration of the live database, not a rebuild of it.
//
// So: this runs on every open, and each step decides for itself whether it
// still has anything to do by looking at the actual shape of the database
// (is that column there? does that table exist?) rather than at a version
// number. That is what makes it safe to run against a fresh `npm run db:init`
// database — every step simply finds its work already done — and what stops a
// half-applied migration from being recorded as finished.
//
// When you change server/core/schema.sql, add the matching step here. The two
// are checked against each other by migrations.test.js, which builds a
// database each way and diffs the resulting schemas.
//
// Called by db.js after the journal pragmas and BEFORE `PRAGMA foreign_keys =
// ON`: the table rebuilds below drop and recreate tables that other tables
// point at, which foreign key enforcement would refuse mid-way.

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((c) => c.name === column);
}

function hasView(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?").get(name);
}

// The stored CREATE text of a table, for the one guard a column list cannot
// answer: whether a CHECK constraint still allows a particular value.
function tableSql(db, name) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return (row && row.sql) || '';
}

// SQLite cannot alter a CHECK constraint or a primary key in place, so the two
// steps that need one do the documented twelve-step dance
// (https://sqlite.org/lang_altertable.html#otheralter): build the new table
// beside the old, copy the rows across, drop the old, rename. Foreign keys are
// already off (see the note at the top), and the whole thing is one
// transaction, so a failure anywhere leaves the original table untouched.
function rebuild(db, table, createSql, copySql, indexes) {
  db.exec('BEGIN');
  try {
    db.exec(createSql);
    db.exec(copySql);
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${table}_new" RENAME TO "${table}"`);
    indexes.forEach((sql) => db.exec(sql));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- The steps ------------------------------------------------------------

// Cost attribution, which purchase_log.csv grew after the database was seeded
// from it: which B2B account a line of spend was for, and which cook it was
// bought for. Both are deliberately plain columns rather than foreign keys —
// deleting a client, or a mis-logged session, must not be blocked by (or
// silently take with it) the record that money was spent.
//
// Four columns lose their NOT NULL at the same time, all for the same reason:
// the CSV allowed them to be blank and blank was a real answer.
//   item_type        — an ad hoc buy that isn't in the materials catalogue
//                      (butcher paper, a bag of ice) is neither a 'material'
//                      nor a 'service'; the constraint would force the writer
//                      to pick one and be wrong.
//   unit_of_measure,
//   unit_price,
//   total_cost       — a line logged before the bill arrives has a quantity
//                      and no price. Storing 0 there would be a lie that
//                      totals up, which is worse than a gap that shows.
function purchaseAttribution(db) {
  if (hasColumn(db, 'purchase', 'smoking_session_id')) return null;
  rebuild(
    db,
    'purchase',
    `CREATE TABLE purchase_new (
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
        unit_of_measure    TEXT,
        unit_price         REAL CHECK (unit_price IS NULL OR unit_price >= 0),
        total_cost         REAL CHECK (total_cost IS NULL OR total_cost >= 0),
        currency           TEXT NOT NULL DEFAULT 'INR',
        expense_category   TEXT,
        odoo_po_id         INTEGER,
        odoo_po_line_id    INTEGER,
        notes              TEXT,
        CONSTRAINT purchase_material_required
            CHECK (item_type <> 'material' OR material_id IS NOT NULL)
     )`,
    `INSERT INTO purchase_new (purchase_id, purchase_date, channel, vendor_id, item_type, material_id,
                               item_name, quantity_purchased, unit_of_measure, unit_price, total_cost,
                               currency, expense_category, odoo_po_id, odoo_po_line_id, notes)
     SELECT purchase_id, purchase_date, channel, vendor_id, item_type, material_id,
            item_name, quantity_purchased, unit_of_measure, unit_price, total_cost,
            currency, expense_category, odoo_po_id, odoo_po_line_id, notes
       FROM purchase`,
    [
      'CREATE INDEX purchase_date_idx     ON purchase(purchase_date)',
      'CREATE INDEX purchase_material_idx ON purchase(material_id)',
      'CREATE INDEX purchase_vendor_idx   ON purchase(vendor_id)',
      'CREATE INDEX purchase_session_idx  ON purchase(smoking_session_id)',
    ],
  );
  return (
    'purchase: client_id, client_name and smoking_session_id added; ' +
    'item_type, unit_of_measure, unit_price and total_cost made optional'
  );
}

// Two things smoking_log.csv could say that the table it was loaded into
// could not.
//
//   client_name — which B2B account the cook was for, spelled out. The id
//     already had a foreign key to b2b_client; the name rides along so the row
//     reads on its own, since "CLI-002" means nothing on a printed sheet.
//   smoke_rings_formed — the pitmaster picks Yes, Partial or No. It was
//     loaded as a 0/1 flag, which has no room for the middle answer, and a
//     partial ring is the interesting one: it is what a cook that nearly
//     worked looks like. The flag's 1/0 become 'Yes'/'No' on the way across.
//
// A rebuild rather than an ALTER for the second of those, and the first comes
// along for the ride rather than being appended by an ALTER, so the column
// order matches schema.sql exactly.
function smokingSessionFields(db) {
  if (hasColumn(db, 'smoking_session', 'client_name')) return null;
  rebuild(
    db,
    'smoking_session',
    `CREATE TABLE smoking_session_new (
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
        CONSTRAINT smk_brine_order CHECK (brine_end   IS NULL OR brine_start   IS NULL OR brine_end   >= brine_start),
        CONSTRAINT smk_rub_order   CHECK (rub_end     IS NULL OR rub_start     IS NULL OR rub_end     >= rub_start),
        CONSTRAINT smk_smoke_order CHECK (smoking_end IS NULL OR smoking_start IS NULL OR smoking_end >= smoking_start),
        CONSTRAINT smk_rest_order  CHECK (rest_end    IS NULL OR rest_start    IS NULL OR rest_end    >= rest_start),
        CONSTRAINT smk_shred_order CHECK (shred_end   IS NULL OR shred_start   IS NULL OR shred_end   >= shred_start),
        CONSTRAINT smk_yield_sane  CHECK (finished_weight_with_bone_kg IS NULL OR raw_weight_kg IS NULL
                                          OR finished_weight_with_bone_kg <= raw_weight_kg)
     )`,
    `INSERT INTO smoking_session_new
     SELECT session_id, session_date, channel, client_id, NULL, session_purpose,
            source_material_id, source_purchase_id, output_product_id, output_type, pitmaster,
            brine_recipe_id, brine_start, brine_end, rub_recipe_id, rub_start, rub_end,
            raw_weight_kg, smoking_start, smoking_end,
            finished_weight_with_bone_kg, finished_weight_without_bone_kg, yield_pct,
            rest_start, rest_end, shred_start, shred_end, tenderness_notes,
            CASE smoke_rings_formed WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' ELSE NULL END,
            bark_notes, juiciness, stage, data_quality_notes
       FROM smoking_session`,
    ['CREATE INDEX smk_date_idx ON smoking_session(session_date)'],
  );
  return 'smoking_session: client_name added, smoke_rings_formed widened to Yes/Partial/No';
}

// The deferred mismatch between what this table was seeded as and what the
// Weekend Prep Planner actually tracks. The loader keyed it (weekend_start,
// recipe_id) with a foreign key to recipe, but the planner groups a weekend's
// sides by whatever identifies them: a sub-recipe id where there is one, else
// a material id, else the bare name. Two of those three are not recipe ids and
// never will be, so the key becomes side_key, the foreign key goes, and the
// name comes along denormalised so the row is readable by itself.
//
// The rows already on file are all recipe ids, so they carry across as
// side_keys unchanged and pick their names up from the catalogue.
function sidePrepSideKey(db) {
  if (hasColumn(db, 'side_prep_status', 'side_key')) return null;
  rebuild(
    db,
    'side_prep_status',
    `CREATE TABLE side_prep_status_new (
        weekend_start TEXT NOT NULL REFERENCES weekend(weekend_start) ON DELETE CASCADE,
        weekend_end   TEXT,
        side_key      TEXT NOT NULL,
        side_name     TEXT,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','making','done')),
        started_at    TEXT,
        done_at       TEXT,
        PRIMARY KEY (weekend_start, side_key),
        CONSTRAINT side_prep_order CHECK (done_at IS NULL OR started_at IS NULL OR done_at >= started_at)
     )`,
    `INSERT INTO side_prep_status_new (weekend_start, weekend_end, side_key, side_name, status, started_at, done_at)
     SELECT s.weekend_start, w.weekend_end, s.recipe_id, i.name, s.status, s.started_at, s.done_at
       FROM side_prep_status s
       LEFT JOIN weekend w ON w.weekend_start = s.weekend_start
       LEFT JOIN item    i ON i.item_id       = s.recipe_id`,
    [],
  );
  return 'side_prep_status: rekeyed on side_key, with weekend_end and side_name added';
}

// The two append-only trails that were still CSVs of their own — see the note
// above them in schema.sql for why neither carries a foreign key.
function appendOnlyLogs(db) {
  const created = [];
  if (!hasTable(db, 'smoking_stage_log')) {
    db.exec(`
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
      CREATE INDEX smoking_stage_log_session_idx ON smoking_stage_log(session_id);
      CREATE INDEX smoking_stage_log_changed_idx ON smoking_stage_log(changed_at);
    `);
    created.push('smoking_stage_log');
  }
  if (!hasTable(db, 'side_prep_log')) {
    db.exec(`
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
      CREATE INDEX side_prep_log_weekend_idx ON side_prep_log(weekend_start);
    `);
    created.push('side_prep_log');
  }
  return created.length ? `created ${created.join(' and ')}` : null;
}

// What one piece of a piece-bought line weighs — the whole-chicken case. The
// log could already say "4 pcs at ₹450 each"; it had nowhere to say that
// those four birds are 6.4 kg, which is the number every plan downstream of
// the buy is actually in (a session's raw_weight_kg, a client's kg/week
// demand, the meat plan). Storing the count and the piece weight keeps both
// answers without either being a re-derivation of the other.
//
// A plain ADD COLUMN rather than a rebuild: the column is nullable with no
// default, so every row already on file gets the right answer (null — nobody
// weighed those) and nothing has to be copied. It lands last, which is where
// schema.sql puts it too.
function purchasePieceWeight(db) {
  if (hasColumn(db, 'purchase', 'weight_per_unit_kg')) return null;
  db.exec(
    'ALTER TABLE purchase ADD COLUMN weight_per_unit_kg REAL ' +
      'CHECK (weight_per_unit_kg IS NULL OR weight_per_unit_kg > 0)',
  );
  return 'purchase: weight_per_unit_kg added';
}

// Order vs Practice on a buy. Every row already on file was logged before the
// question existed, so the default ('Order') is the honest answer for them.
function purchasePurpose(db) {
  if (hasColumn(db, 'purchase', 'purpose')) return null;
  db.exec(
    "ALTER TABLE purchase ADD COLUMN purpose TEXT NOT NULL DEFAULT 'Order' " +
      "CHECK (purpose IN ('Order','Practice'))",
  );
  return 'purchase: purpose added';
}

// The Porter tracking link on an order, which replaced typing the delivery
// partner's name. delivery_person stays for the rows that already have one.
function salesOrderTrackingUrl(db) {
  if (!hasTable(db, 'sales_order') || hasColumn(db, 'sales_order', 'tracking_url')) return null;
  db.exec('ALTER TABLE sales_order ADD COLUMN tracking_url TEXT');
  return 'sales_order: tracking_url added';
}

// The Porter delivery watch — the queue of orders whose trip is being followed
// to its end so Odoo gets told about the delivery without anyone going back to
// the board. See server/ops/shared/deliveryWatch.js.
function deliveryWatchQueue(db) {
  if (hasTable(db, 'delivery_watch')) return null;
  db.exec(`
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
    CREATE INDEX delivery_watch_due_idx ON delivery_watch(state, next_check_at);
  `);
  return 'delivery_watch added';
}

// The AI SEO tracker, removed. Its two tables came out of schema.sql with it,
// so a database that still has them is no longer the shape a fresh install
// builds — which is the one thing this file exists to prevent. Dropped rather
// than left in place: nothing reads them any more, and a table nothing writes
// is a table the next person has to work out the status of.
//
// aiseo_run points at aiseo_prompt, so it goes first. Foreign keys are off
// here anyway (see the note at the top), but the order costs nothing and
// keeps the step correct if that ever changes.
function dropAiSeoTracker(db) {
  if (!hasTable(db, 'aiseo_prompt') && !hasTable(db, 'aiseo_run')) return null;
  db.exec('DROP TABLE IF EXISTS aiseo_run');
  db.exec('DROP TABLE IF EXISTS aiseo_prompt');
  return 'aiseo_prompt and aiseo_run dropped: the AI SEO tracker is gone';
}

// Units of measure, removed root and branch.
//
// The database used to carry a `uom` table of unit codes (kg, g, ml, pcs,
// tbsp, "burger portion", ...), a `uom_conversion` table of factors between
// them (a tablespoon is 15 ml; one clove of garlic is 3 g), and a unit column
// on everything that held an amount. None of it is recorded any more:
// quantities are bare numbers, and what they count is whatever the person
// reading the screen already knows it to be.
//
// Nine columns across six tables go, plus both tables and the conversion
// index. Nothing is renamed and no quantity is touched -- only the labels come
// off -- so every row survives with its numbers intact.
//
// ALTER TABLE ... DROP COLUMN here rather than the twelve-step rebuild the
// steps above use, for two reasons. Half of these tables (item, material,
// recipe, menu_item) are pointed at by other tables, and a rebuild has to drop
// the table it is rebuilding -- which foreign key enforcement refuses, and
// node:sqlite turns enforcement ON by default, so "foreign keys aren't on
// yet" is not true here the way the note at the top of this file assumes.
// DROP COLUMN never drops the table, so the question doesn't arise. It also
// leaves the surviving columns in place and in order, which is exactly what
// schema.sql now describes, without a second copy of six CREATE TABLE bodies
// in this file to drift out of step with it.
//
// Two knock-on removals, both units of measure wearing a different hat:
//   * material.stock_status could be 'unit_mismatch', meaning a count in one
//     unit had a figure in another subtracted from it. That verdict cannot be
//     reached without units, so the value leaves the CHECK and the row holding
//     it becomes 'never_counted' -- which is what its stock_notes already asks
//     for ("Recount in pcs"), minus the unit. A CHECK cannot be altered in
//     place, so this one is a rebuild, and the only place foreign keys have to
//     be turned off for the length of a step.
//   * v_data_gaps reported unconfirmed conversion factors. That branch goes
//     with the table it read.
//
// Order matters. SQLite refuses to drop a column a view still names, so all
// four views come down first and go back up last.
const UOM_COLUMNS = [
  ['bom_line', 'unit'],
  ['bom_line', 'base_unit'],
  ['inventory_adjustment', 'unit_of_measure'],
  ['item', 'uom_code'],
  ['menu_item', 'portion_unit'],
  ['purchase', 'unit_of_measure'],
  ['recipe', 'output_unit'],
  ['recipe', 'portion_unit'],
];

// v_menu_cost names no unit column itself, but it selects from
// v_bom_explosion, so it comes down with it and goes back unchanged.
const UOM_VIEWS = ['v_bom_explosion', 'v_data_gaps', 'v_stock_alert', 'v_menu_cost'];

const UOM_VIEW_SQL = {
  v_bom_explosion: `CREATE VIEW v_bom_explosion AS
WITH RECURSIVE tree AS (
    SELECT  b.parent_id AS root_id, b.child_id, b.quantity, b.base_quantity,
            b.status, 1 AS depth,
            b.parent_id || ' > ' || b.child_id AS path
    FROM bom_line b
    UNION ALL
    SELECT  t.root_id, b.child_id, b.quantity, b.base_quantity,
            b.status, t.depth + 1,
            t.path || ' > ' || b.child_id
    FROM tree t
    JOIN bom_line b ON b.parent_id = t.child_id
    WHERE t.depth < 10
)
SELECT t.root_id, r.name AS root_name, t.child_id, c.name AS child_name,
       c.kind AS child_kind, t.base_quantity, t.status, t.depth, t.path
FROM tree t
JOIN item r ON r.item_id = t.root_id
JOIN item c ON c.item_id = t.child_id`,

  v_data_gaps: `CREATE VIEW v_data_gaps AS
SELECT 'recipe has no ingredients' AS gap, r.item_id AS ref, i.name AS detail
FROM recipe r JOIN item i ON i.item_id = r.item_id
WHERE r.ingredients_recorded = 'no'
UNION ALL
SELECT 'bom line needs confirmation', b.line_id, b.parent_id || ' -> ' || b.child_id
FROM bom_line b WHERE b.status = 'needs_confirmation'
UNION ALL
SELECT 'menu item has no recipe', m.item_id, i.name
FROM menu_item m JOIN item i ON i.item_id = m.item_id
WHERE NOT EXISTS (SELECT 1 FROM bom_line b WHERE b.parent_id = m.item_id)
UNION ALL
SELECT 'material has no standard cost', mt.item_id, i.name
FROM material mt JOIN item i ON i.item_id = mt.item_id
WHERE mt.standard_cost_inr IS NULL`,

  v_stock_alert: `CREATE VIEW v_stock_alert AS
SELECT  i.item_id, i.name, m.category, m.quantity_on_hand, m.reorder_level,
        m.stock_status, v.vendor_name AS default_vendor, v.lead_time_days,
        CASE
            WHEN m.stock_status = 'negative_balance' THEN 'negative — unrecorded purchase'
            WHEN m.stock_status = 'never_counted'    THEN 'never counted'
            WHEN m.reorder_level IS NOT NULL
                 AND m.quantity_on_hand <= m.reorder_level THEN 'at or below reorder level'
        END AS alert
FROM material m
JOIN item i ON i.item_id = m.item_id
LEFT JOIN vendor v ON v.vendor_id = m.default_vendor_id
WHERE m.stock_status <> 'ok'
   OR (m.reorder_level IS NOT NULL AND m.quantity_on_hand <= m.reorder_level)`,

  v_menu_cost: `CREATE VIEW v_menu_cost AS
SELECT  mi.item_id, i.name, mi.price_inr,
        round(sum(e.base_quantity * mt.standard_cost_inr), 2) AS known_cost_inr,
        count(*) FILTER (WHERE mt.standard_cost_inr IS NULL)  AS lines_missing_cost,
        count(*)                                              AS total_leaf_lines
FROM menu_item mi
JOIN item i ON i.item_id = mi.item_id
LEFT JOIN v_bom_explosion e ON e.root_id = mi.item_id AND e.child_kind = 'raw_material'
LEFT JOIN material mt ON mt.item_id = e.child_id
GROUP BY mi.item_id, i.name, mi.price_inr`,
};

function dropUnitMismatchStatus(db) {
  // The rebuild drops `material`, which inventory_adjustment points at, so
  // enforcement goes off for the length of it and back to whatever it was.
  // Not inside the transaction: SQLite ignores the pragma there.
  const wasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (wasOn) db.exec('PRAGMA foreign_keys = OFF');
  try {
    rebuild(
      db,
      'material',
      `CREATE TABLE material_new (
          item_id             TEXT PRIMARY KEY REFERENCES item(item_id) ON DELETE CASCADE,
          category            TEXT,
          reorder_level       REAL CHECK (reorder_level >= 0),
          default_vendor_id   TEXT REFERENCES vendor(vendor_id),
          standard_cost_inr   REAL CHECK (standard_cost_inr >= 0),
          cost_basis          TEXT,
          shelf_life_days     INTEGER CHECK (shelf_life_days > 0),
          storage             TEXT,
          order_multiple      REAL CHECK (order_multiple > 0),
          quantity_on_hand    REAL NOT NULL DEFAULT 0,
          last_updated        TEXT,
          last_movement_ref   TEXT,
          stock_status        TEXT NOT NULL DEFAULT 'never_counted'
                                   CHECK (stock_status IN ('ok','never_counted','negative_balance')),
          stock_notes         TEXT,
          odoo_product_id     INTEGER
       )`,
      `INSERT INTO material_new (item_id, category, reorder_level, default_vendor_id,
                                 standard_cost_inr, cost_basis, shelf_life_days, storage,
                                 order_multiple, quantity_on_hand, last_updated, last_movement_ref,
                                 stock_status, stock_notes, odoo_product_id)
       SELECT item_id, category, reorder_level, default_vendor_id,
              standard_cost_inr, cost_basis, shelf_life_days, storage,
              order_multiple, quantity_on_hand, last_updated, last_movement_ref,
              CASE stock_status WHEN 'unit_mismatch' THEN 'never_counted' ELSE stock_status END,
              stock_notes, odoo_product_id
         FROM material`,
      [
        'CREATE INDEX material_status_idx ON material(stock_status)',
        'CREATE INDEX material_vendor_idx ON material(default_vendor_id)',
      ],
    );
  } finally {
    if (wasOn) db.exec('PRAGMA foreign_keys = ON');
  }
}

// The one thing the unit columns said that the numbers beside them cannot:
// whether a line's quantity and base_quantity are one amount said twice or two
// figures kept apart on purpose. Recorded as a column of its own before the
// units it is derived from are dropped -- see the note on bom_line in
// schema.sql for why the distinction has to survive at all.
//
// A blank base_unit meant "same as unit" to every reader of these rows, so it
// counts as matching rather than as separate.
function captureSeparateBaseQuantity(db) {
  if (hasColumn(db, 'bom_line', 'base_is_separate')) return;
  db.exec(
    'ALTER TABLE bom_line ADD COLUMN base_is_separate INTEGER NOT NULL DEFAULT 0 ' +
      'CHECK (base_is_separate IN (0,1))',
  );
  db.exec(`UPDATE bom_line
              SET base_is_separate = 1
            WHERE trim(coalesce(base_unit, '')) <> ''
              AND lower(trim(coalesce(base_unit, ''))) <> lower(trim(coalesce(unit, '')))`);
}

function dropUnitsOfMeasure(db) {
  const columns = UOM_COLUMNS.filter(([table, column]) => hasColumn(db, table, column));
  const statusOwed = tableSql(db, 'material').includes('unit_mismatch');
  const uomTables = ['uom_conversion', 'uom'].filter((t) => hasTable(db, t));
  if (!columns.length && !statusOwed && !uomTables.length) return null;

  const views = UOM_VIEWS.filter((v) => hasView(db, v));
  views.forEach((v) => db.exec(`DROP VIEW "${v}"`));

  // Before the columns it reads are gone.
  if (hasColumn(db, 'bom_line', 'base_unit')) captureSeparateBaseQuantity(db);

  columns.forEach(([table, column]) => db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`));
  if (statusOwed) dropUnitMismatchStatus(db);
  // The conversion index goes with its table; DROP TABLE takes it.
  uomTables.forEach((t) => db.exec(`DROP TABLE "${t}"`));

  // Only the views that were there before go back up, minus the unit columns
  // and the conversion gap.
  views.forEach((v) => db.exec(UOM_VIEW_SQL[v]));

  const stripped = columns.map(([table, column]) => `${table}.${column}`);
  if (statusOwed) stripped.push("material.stock_status 'unit_mismatch'");
  const tail = uomTables.length ? `; ${uomTables.join(' and ')} dropped` : '';
  return `units of measure removed: ${stripped.join(', ')}${tail}`;
}

// The B2B sales book: what a wholesale account was billed and whether they
// have paid. Nothing to migrate — there is no CSV or earlier column behind
// this, it is new ground — so the step is a create-if-absent, and the
// `payment_terms_days` column beside it is an ADD COLUMN with the house
// default already in it.
//
// Written out here rather than read from schema.sql because that file is
// applied wholesale to a fresh database; a half-applied `db.exec` of it
// against a live one would be a much worse failure than a duplicated CREATE
// that migrations.test.js diffs against the real thing on every run.
function b2bSalesBook(db) {
  const done = [];

  if (!hasColumn(db, 'b2b_client', 'payment_terms_days')) {
    // NOT NULL with a default is allowed on ADD COLUMN precisely because
    // SQLite can fill the existing rows from it — every account already on
    // the book gets the house 15-day cycle, which is what they were on.
    db.exec(
      'ALTER TABLE b2b_client ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 15 ' +
        'CHECK (payment_terms_days >= 0)',
    );
    done.push('b2b_client.payment_terms_days added (default 15)');
  }

  if (!hasTable(db, 'b2b_sale')) {
    db.exec(`CREATE TABLE b2b_sale (
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
    CONSTRAINT b2b_sale_not_overpaid CHECK (amount_paid_inr <= amount_inr),
    CONSTRAINT b2b_sale_due_after_delivery CHECK (payment_due_on >= delivered_on),
    CONSTRAINT b2b_sale_paid_in_full CHECK (paid_on IS NULL OR amount_paid_inr >= amount_inr)
)`);
    db.exec('CREATE INDEX b2b_sale_client_idx ON b2b_sale(client_id)');
    db.exec('CREATE INDEX b2b_sale_due_idx    ON b2b_sale(payment_due_on)');
    done.push('b2b_sale created: the B2B revenue and receivables book');
  }

  return done.length ? done.join('; ') : null;
}

// The invoice half of the sales book: the lines a sale is billed on, and the
// Odoo invoice it was raised as. Split from b2bSalesBook above rather than
// folded into it because that step has already run on the live database —
// each step decides for itself what is left to do (see the note at the top),
// and a step that has finished must not be edited into one that has not.
function b2bInvoiceLines(db) {
  const done = [];

  const columns = [
    ['odoo_invoice_id', 'INTEGER'],
    ['odoo_invoice_state', 'TEXT'],
    ['odoo_access_token', 'TEXT'],
    ['odoo_error', 'TEXT'],
  ].filter(([column]) => !hasColumn(db, 'b2b_sale', column));

  if (columns.length) {
    // All four are nullable with no default: a sale that has never been sent
    // to Odoo genuinely has no answer for any of them, which is what NULL is
    // for. Nothing to backfill.
    columns.forEach(([column, type]) => db.exec(`ALTER TABLE b2b_sale ADD COLUMN ${column} ${type}`));
    done.push(`b2b_sale gains ${columns.map(([c]) => c).join(', ')}`);
  }

  const clientColumns = [
    ['odoo_pricelist_id', 'INTEGER'],
    ['odoo_pricelist_name', 'TEXT'],
  ].filter(([column]) => !hasColumn(db, 'b2b_client', column));

  if (clientColumns.length) {
    clientColumns.forEach(([column, type]) => db.exec(`ALTER TABLE b2b_client ADD COLUMN ${column} ${type}`));
    done.push(`b2b_client gains ${clientColumns.map(([c]) => c).join(', ')}`);
  }

  if (!hasTable(db, 'b2b_sale_line')) {
    db.exec(`CREATE TABLE b2b_sale_line (
    line_id         TEXT PRIMARY KEY,
    sale_id         TEXT NOT NULL REFERENCES b2b_sale(sale_id) ON DELETE CASCADE,
    position        INTEGER NOT NULL DEFAULT 0,
    odoo_product_id INTEGER,
    description     TEXT NOT NULL,
    unit_label      TEXT,
    quantity        REAL NOT NULL CHECK (quantity > 0),
    unit_price      REAL NOT NULL CHECK (unit_price >= 0),
    line_total      REAL NOT NULL CHECK (line_total >= 0)
)`);
    db.exec('CREATE INDEX b2b_sale_line_sale_idx ON b2b_sale_line(sale_id)');
    db.exec('CREATE INDEX b2b_sale_line_product_idx ON b2b_sale_line(odoo_product_id)');
    done.push('b2b_sale_line created: what each invoice is made of');
  }

  return done.length ? done.join('; ') : null;
}

// The spend side of marketing, which had nowhere to live at all: revenue per
// channel was always answerable out of Odoo, and what we paid to get it was
// answerable out of nobody's records. Creates the table only -- there is
// nothing to backfill, because there was no earlier home for these figures.
function marketingBudget(db) {
  if (hasTable(db, 'marketing_budget')) return null;

  // The CHECKs are carried over from schema.sql rather than left to the
  // server, for the two things that would corrupt the rollup silently: a
  // category typo starting its own bucket, and a period that ends before it
  // starts taking a negative share of itself into every overlap sum.
  db.exec(`CREATE TABLE marketing_budget (
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
)`);
  db.exec('CREATE INDEX marketing_budget_period_idx  ON marketing_budget(period_start, period_end)');
  db.exec('CREATE INDEX marketing_budget_channel_idx ON marketing_budget(channel)');

  return 'marketing_budget created: what each channel and campaign cost';
}

// The published-link record, which nothing kept before: a QR code went to a
// printer and the only copy of what it pointed at was in whoever generated
// it's browser history. Table only -- there is nothing to backfill, because
// the links that are already in the world were never written down.
function marketingLinks(db) {
  if (hasTable(db, 'marketing_link')) return null;

  db.exec(`CREATE TABLE marketing_link (
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
)`);
  // Over ifnull() rather than the bare columns -- see the note in
  // schema.sql: SQLite counts NULLs as distinct, so the bare version would
  // not catch two saves of the same untagged link.
  db.exec(`CREATE UNIQUE INDEX marketing_link_placement_idx ON marketing_link(
    destination, utm_source, ifnull(utm_medium, ''), ifnull(utm_campaign, ''), ifnull(utm_content, '')
)`);
  db.exec('CREATE INDEX marketing_link_campaign_idx ON marketing_link(utm_campaign)');

  return 'marketing_link created: the tracked links and QR codes we have published';
}

// The weekly content cadence, as rows in the schedule everything else lives
// in rather than a second list somewhere: Daily View reads scheduled_task, so
// a posting day that isn't a row there is a posting day nobody is reminded
// about. Category 'Marketing' is what puts them in their own Daily View card,
// away from the kitchen and procurement tasks.
//
// Per-row rather than all-or-nothing, so a row someone retires by hand stays
// retired instead of coming back on the next server start.
const MARKETING_CADENCE = [
  ['WS-17', 'Monday', 'Social posts - order delivered reel (IG, FB, WhatsApp, YouTube, Story)'],
  ['WS-18', 'Tuesday', 'Poster content post (Instagram, YouTube)'],
  ['WS-19', 'Wednesday', 'Social posts - CTA to place orders (IG, FB, WhatsApp, YouTube, Story)'],
  ['WS-20', 'Wednesday', 'Community posts - LinkedIn, WhatsApp community, Reddit community'],
  ['WS-21', 'Thursday', 'Social posts - CTA to place orders (IG, FB, WhatsApp, YouTube, Story)'],
  ['WS-22', 'Friday', 'Reel content'],
  ['WS-23', 'Saturday', 'Social posts - BTS (IG, FB, WhatsApp, YouTube, Story)'],
  ['WS-24', 'Sunday', 'Social posts - BTS (IG, FB, WhatsApp, YouTube, Story)'],
  ['WS-25', 'Sunday', 'Community posts - LinkedIn, WhatsApp community, Reddit community'],
];

function marketingContentCadence(db) {
  if (!hasTable(db, 'scheduled_task')) return null;
  // An empty scheduled_task is a database that has no weekly cadence at all
  // (a fresh `npm run db:init`), not one missing its marketing rows — seeding
  // half a schedule into it would be worse than leaving it empty.
  if (!db.prepare('SELECT 1 FROM scheduled_task LIMIT 1').get()) return null;

  const seen = db.prepare('SELECT 1 FROM scheduled_task WHERE task_id = ?');
  // No time_of_day: these go out when the content is ready, and pinning a
  // clock time nobody agreed to would show up in Daily View as a deadline.
  //
  // Landing at the end of their day rather than the start: sort_order is what
  // Daily View orders by now (see scheduledTaskOrder, which runs first), and
  // the column's default of 0 would put every seeded row above the tasks the
  // day already had.
  const add = db.prepare(
    `INSERT INTO scheduled_task (task_id, day, time_of_day, task, assigned_to, category, sort_order)
     VALUES (?, ?, NULL, ?, 'Adarsh', 'Marketing',
             (SELECT coalesce(max(sort_order), 0) + 1 FROM scheduled_task WHERE day = ?))`,
  );

  const added = MARKETING_CADENCE.filter(([taskId]) => !seen.get(taskId));
  added.forEach(([taskId, day, task]) => add.run(taskId, day, task, day));

  return added.length ? `scheduled_task: ${added.length} marketing cadence task(s) added` : null;
}

// Daily View grew an edit mode: rename a task, retire one, add one, drag it up
// the day's list or across to another day. The last of those needs somewhere to
// keep the order, and rowid — what the schedule was read in by until now — is
// fixed at insert, so a moved task would snap back on the next reload.
//
// Seeded from rowid, so the schedule that exists today keeps exactly the order
// it reads in today; only what someone actually drags moves after that.
function scheduledTaskOrder(db) {
  if (!hasTable(db, 'scheduled_task')) return null;
  if (hasColumn(db, 'scheduled_task', 'sort_order')) return null;
  db.exec(
    'ALTER TABLE scheduled_task ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
  );
  db.exec('UPDATE scheduled_task SET sort_order = rowid');
  return 'scheduled_task: sort_order added, seeded from the existing row order';
}

// The Customer Map screen: where a looked-up address sits on the map.
//
// A cache table and nothing else — no existing row has to change, and the
// first lookup fills it. See the note on the table in schema.sql for why a
// failed lookup is stored as a row rather than as an absence.
function geocodeCache(db) {
  if (hasTable(db, 'geocode_cache')) return null;
  db.exec(`
    CREATE TABLE geocode_cache (
        address_key  TEXT PRIMARY KEY,
        address      TEXT NOT NULL,
        latitude     REAL,
        longitude    REAL,
        precision    TEXT CHECK (precision IS NULL OR precision IN ('address','locality','postcode')),
        locality     TEXT,
        postcode     TEXT,
        display_name TEXT,
        provider     TEXT NOT NULL DEFAULT 'nominatim',
        status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','not_found')),
        looked_up_at TEXT NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT geocode_located_has_a_point CHECK (status <> 'ok' OR (latitude IS NOT NULL AND longitude IS NOT NULL))
    )
  `);
  return 'geocode_cache: created';
}

// Push notification plumbing: who to notify, and what has already been sent.
//
// Two new tables and nothing else — no existing row changes, and a database
// that has never notified anyone simply starts with both empty. See the notes
// on them in schema.sql for why the endpoint is the key and why the delivery
// key carries the date.
function pushNotifications(db) {
  const made = [];
  if (!hasTable(db, 'push_subscription')) {
    db.exec(`
      CREATE TABLE push_subscription (
          endpoint      TEXT PRIMARY KEY,
          p256dh        TEXT NOT NULL,
          auth          TEXT NOT NULL,
          label         TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          last_sent_at  TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    made.push('push_subscription');
  }
  if (!hasTable(db, 'push_delivery')) {
    db.exec(`
      CREATE TABLE push_delivery (
          notify_key TEXT PRIMARY KEY,
          sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    made.push('push_delivery');
  }
  return made.length ? `${made.join(', ')}: created` : null;
}

// The shared note bubble's one table. Nothing existing is touched, and a
// database that has never had a note posted simply starts with it empty.
//
// The tick-box columns are handled here rather than as a step of their own.
// This table is days old and exists on one machine, so there is no fleet of
// databases at the earlier shape to migrate through in order — and folding
// them in keeps one step owning one table, which is the arrangement that
// stays readable. The ADD COLUMN branch is what carries the database that was
// created between the two changes.
function sharedNotes(db) {
  if (!hasTable(db, 'shared_note')) {
    db.exec(`
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
      )
    `);
    return 'shared_note: created';
  }
  // NOT NULL is addable here only because it comes with a default; every
  // existing note becomes an unticked one, which is what it was.
  const added = [];
  if (!hasColumn(db, 'shared_note', 'done')) {
    db.exec("ALTER TABLE shared_note ADD COLUMN done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))");
    added.push('done');
  }
  if (!hasColumn(db, 'shared_note', 'done_at')) {
    db.exec('ALTER TABLE shared_note ADD COLUMN done_at TEXT');
    added.push('done_at');
  }
  if (!hasColumn(db, 'shared_note', 'done_by')) {
    db.exec('ALTER TABLE shared_note ADD COLUMN done_by TEXT');
    added.push('done_by');
  }
  if (!hasColumn(db, 'shared_note', 'assigned_to')) {
    db.exec('ALTER TABLE shared_note ADD COLUMN assigned_to TEXT');
    added.push('assigned_to');
  }
  if (!hasColumn(db, 'shared_note', 'github_issue')) {
    db.exec('ALTER TABLE shared_note ADD COLUMN github_issue INTEGER');
    added.push('github_issue');
  }
  if (!hasColumn(db, 'shared_note', 'github_category')) {
    db.exec('ALTER TABLE shared_note ADD COLUMN github_category INTEGER');
    added.push('github_category');
  }
  return added.length ? `shared_note: ${added.join(', ')} added` : null;
}

// Labour and miscellaneous spend had a table of its own for two days
// (weekly_expense, filed per Monday). It now lives in `purchase` with
// everything else: a service line, quantity 1, under a vendor called "Labour"
// or "Miscellaneous" — see recordExpense in server/ops/shared/purchasing.js.
//
// Each entry is moved to one purchase row dated the day it was entered
// (created_at, in IST), held inside the week it was filed against so no week's
// total changes. Then the table goes. One transaction, so a failure leaves the
// old table exactly as it was.
//
// Also renames the "Other" expense category to "Miscellaneous" — the list in
// server/core/expenseCategories.js did the same — so the two are one bucket.
function weeklyExpensesIntoPurchases(db) {
  const changes = [];
  const renamed = db
    .prepare("UPDATE purchase SET expense_category = 'Miscellaneous' WHERE expense_category = 'Other'")
    .run().changes;
  if (renamed) changes.push(`purchase: ${renamed} "Other" line(s) recategorised as Miscellaneous`);
  if (!hasTable(db, 'weekly_expense')) return changes.length ? changes.join('; ') : null;

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (iso, days) => {
    const [y, m, d] = iso.split('-').map(Number);
    return isoOf(new Date(y, m - 1, d + days));
  };
  // created_at is a UTC ISO stamp; the kitchen's calendar is IST.
  const istDay = (stamp) => {
    const t = Date.parse(stamp);
    return Number.isFinite(t) ? new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : null;
  };
  const nextNumber = (table, column, prefix) => {
    const row = db
      .prepare(
        `SELECT MAX(CAST(substr(${column}, ${prefix.length + 2}) AS INTEGER)) AS n FROM ${table} WHERE ${column} LIKE ?`,
      )
      .get(`${prefix}-%`);
    return (row?.n || 0) + 1;
  };

  const rows = db.prepare('SELECT * FROM weekly_expense ORDER BY created_at, expense_id').all();

  db.exec('BEGIN');
  try {
    const vendorIds = {};
    let vendorNumber = nextNumber('vendor', 'vendor_id', 'VEN');
    const vendorFor = (kind) => {
      if (vendorIds[kind]) return vendorIds[kind];
      const found = db.prepare('SELECT vendor_id FROM vendor WHERE lower(trim(vendor_name)) = lower(?)').get(kind);
      if (found) return (vendorIds[kind] = found.vendor_id);
      const id = `VEN-${String(vendorNumber++).padStart(3, '0')}`;
      db.prepare(
        "INSERT INTO vendor (vendor_id, vendor_name, vendor_type, notes) VALUES (?, ?, 'Expense', 'Weekly Purchasing labour / misc spend.')",
      ).run(id, kind);
      return (vendorIds[kind] = id);
    };

    let purchaseNumber = nextNumber('purchase', 'purchase_id', 'PUR');
    const insertPurchase = db.prepare(`
      INSERT INTO purchase (purchase_id, purchase_date, channel, vendor_id, item_type, item_name,
                            quantity_purchased, unit_price, total_cost, currency, expense_category, notes)
      VALUES (?, ?, ?, ?, 'service', ?, 1, ?, ?, 'INR', ?, ?)`);
    rows.forEach((row) => {
      const weekEnd = addDays(row.week_start, 6);
      const entered = istDay(row.created_at);
      const date = entered && entered >= row.week_start && entered <= weekEnd ? entered : row.week_start;
      const trail = `Moved from weekly expense ${row.expense_id}.`;
      insertPurchase.run(
        `PUR-${String(purchaseNumber++).padStart(4, '0')}`,
        date,
        row.channel,
        vendorFor(row.kind),
        row.description || row.kind,
        row.amount_inr,
        row.amount_inr,
        row.kind,
        [row.notes, trail].filter(Boolean).join(' '),
      );
    });
    db.exec('DROP TABLE weekly_expense');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  changes.push(`weekly_expense: ${rows.length} row(s) moved into purchase, table dropped`);
  return changes.join('; ');
}

const STEPS = [
  purchaseAttribution,
  smokingSessionFields,
  sidePrepSideKey,
  appendOnlyLogs,
  purchasePieceWeight,
  dropAiSeoTracker,
  dropUnitsOfMeasure,
  b2bSalesBook,
  b2bInvoiceLines,
  marketingBudget,
  marketingLinks,
  scheduledTaskOrder,
  marketingContentCadence,
  geocodeCache,
  pushNotifications,
  sharedNotes,
  weeklyExpensesIntoPurchases,
  purchasePurpose,
  salesOrderTrackingUrl,
  deliveryWatchQueue,
];

// Returns only what it actually changed, so the caller can say so once on
// startup rather than have every step announce itself into a silent log.
function migrate(db) {
  return STEPS.map((step) => step(db)).filter(Boolean);
}

export { migrate };
