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

const STEPS = [purchaseAttribution, smokingSessionFields, sidePrepSideKey, appendOnlyLogs, purchasePieceWeight];

// Returns only what it actually changed, so the caller can say so once on
// startup rather than have every step announce itself into a silent log.
function migrate(db) {
  return STEPS.map((step) => step(db)).filter(Boolean);
}

export { migrate };
