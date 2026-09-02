// The database migration, run against the shape it actually has to migrate.
//
// migrations.js exists to turn the database the knowledge-base loader seeded
// into the one server/core/schema.sql describes, in place, without losing a
// row. Two things can go wrong with that and both are silent: it can arrive
// at a shape that isn't quite what schema.sql says (so a fresh install and an
// upgraded one behave differently), and a table rebuild can drop data on the
// way across. So this builds a database in the old shape, migrates it, and
// checks both.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from './db.js';
import { migrate } from './migrations.js';

// The three tables as the loader created them, plus the parents they point
// at. Inlined rather than derived from schema.sql: this is the *old* shape,
// and the whole point is that it no longer exists anywhere else.
const LEGACY_SQL = `
CREATE TABLE item (
  item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  uom_code TEXT, is_active INTEGER, notes TEXT
);
CREATE TABLE vendor (vendor_id TEXT PRIMARY KEY, vendor_name TEXT NOT NULL);
CREATE TABLE b2b_client (client_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE recipe (item_id TEXT PRIMARY KEY REFERENCES item(item_id), kind TEXT NOT NULL);
CREATE TABLE weekend (
  weekend_start TEXT PRIMARY KEY, weekend_end TEXT NOT NULL, kitchen_status TEXT,
  decision_reason TEXT, decided_by TEXT, decided_at TEXT, prep_status TEXT,
  marked_at TEXT, notes TEXT
);

CREATE TABLE purchase (
  purchase_id        TEXT PRIMARY KEY,
  purchase_date      TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
  vendor_id          TEXT NOT NULL REFERENCES vendor(vendor_id),
  item_type          TEXT NOT NULL CHECK (item_type IN ('material','service')),
  material_id        TEXT REFERENCES item(item_id),
  item_name          TEXT NOT NULL,
  quantity_purchased REAL NOT NULL CHECK (quantity_purchased > 0),
  unit_of_measure    TEXT NOT NULL,
  unit_price         REAL NOT NULL CHECK (unit_price >= 0),
  total_cost         REAL NOT NULL CHECK (total_cost >= 0),
  currency           TEXT NOT NULL DEFAULT 'INR',
  expense_category   TEXT,
  odoo_po_id         INTEGER,
  odoo_po_line_id    INTEGER,
  notes              TEXT
);

CREATE TABLE smoking_session (
  session_id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('B2C','B2B')),
  client_id TEXT REFERENCES b2b_client(client_id),
  session_purpose TEXT,
  source_material_id TEXT REFERENCES item(item_id),
  source_purchase_id TEXT REFERENCES purchase(purchase_id),
  output_product_id TEXT REFERENCES item(item_id),
  output_type TEXT, pitmaster TEXT,
  brine_recipe_id TEXT REFERENCES recipe(item_id), brine_start TEXT, brine_end TEXT,
  rub_recipe_id TEXT REFERENCES recipe(item_id), rub_start TEXT, rub_end TEXT,
  raw_weight_kg REAL, smoking_start TEXT, smoking_end TEXT,
  finished_weight_with_bone_kg REAL, finished_weight_without_bone_kg REAL, yield_pct REAL,
  rest_start TEXT, rest_end TEXT, shred_start TEXT, shred_end TEXT,
  tenderness_notes TEXT,
  smoke_rings_formed INTEGER CHECK (smoke_rings_formed IN (0,1)),
  bark_notes TEXT, juiciness TEXT,
  stage TEXT NOT NULL DEFAULT 'planned', data_quality_notes TEXT
);

CREATE TABLE side_prep_status (
  weekend_start TEXT NOT NULL REFERENCES weekend(weekend_start) ON DELETE CASCADE,
  recipe_id     TEXT NOT NULL REFERENCES recipe(item_id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','making','done')),
  started_at    TEXT,
  done_at       TEXT,
  PRIMARY KEY (weekend_start, recipe_id)
);

INSERT INTO item VALUES ('RM-001','raw_material','Pork shoulder','kg',1,NULL);
INSERT INTO item VALUES ('SR-015','sub_recipe','BBQ sauce',NULL,1,NULL);
INSERT INTO recipe VALUES ('SR-015','Sauce');
INSERT INTO vendor VALUES ('VEN-001','Pork Shop');
INSERT INTO weekend VALUES ('2026-08-07','2026-08-10',NULL,NULL,NULL,NULL,'planned',NULL,NULL);
INSERT INTO purchase (purchase_id, purchase_date, channel, vendor_id, item_type, material_id,
                      item_name, quantity_purchased, unit_of_measure, unit_price, total_cost)
  VALUES ('PUR-0001','2026-08-10','B2C','VEN-001','material','RM-001','Pork shoulder',5,'kg',520,2600);
INSERT INTO smoking_session (session_id, session_date, channel, stage, smoke_rings_formed, raw_weight_kg)
  VALUES ('SMK-0001','2026-08-11','B2C','completed',1,1.6);
INSERT INTO side_prep_status VALUES ('2026-08-07','SR-015','done','2026-08-19T15:28:04','2026-08-19T15:46:14');
`;

// Column name -> declared type, notnull and pk position. Enough to catch a
// column that is missing, renamed, retyped or lost its key; deliberately not
// the raw CREATE text, which differs harmlessly between a rebuilt table
// (SQLite quotes the name after a rename) and a freshly created one.
function shapeOf(db) {
  const shape = {};
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .forEach(({ name }) => {
      shape[name] = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((c) => `${c.name}:${c.type}${c.notnull ? '!' : ''}${c.pk ? `#${c.pk}` : ''}`);
    });
  return shape;
}

let dir;
let legacy;
let fresh;
let firstRun;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smokerings-migrations-'));

  legacy = new DatabaseSync(path.join(dir, 'legacy.db'));
  legacy.exec(LEGACY_SQL);
  firstRun = migrate(legacy);

  // What `npm run db:init` builds, for the two shapes to be compared against
  // each other.
  fresh = new DatabaseSync(path.join(dir, 'fresh.db'));
  fresh.exec(fs.readFileSync(path.resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
});

afterAll(() => {
  legacy?.close();
  fresh?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('migrate', () => {
  it('lands on exactly the shape schema.sql describes', () => {
    const migrated = shapeOf(legacy);
    const target = shapeOf(fresh);
    // The tables the migration is responsible for. The rest of the fixture is
    // stub parents — just enough of item/vendor/recipe for the foreign keys
    // to have something to point at — and comparing those would only be
    // comparing the fixture against itself.
    ['purchase', 'smoking_session', 'side_prep_status', 'smoking_stage_log', 'side_prep_log'].forEach(
      (table) => {
        expect(migrated[table], `${table} after migrating`).toEqual(target[table]);
      },
    );
  });

  it('creates the two tables that were still CSVs', () => {
    expect(Object.keys(shapeOf(legacy))).toEqual(
      expect.arrayContaining(['smoking_stage_log', 'side_prep_log']),
    );
  });

  it('carries every row across the table rebuilds', () => {
    // A purchase whose attribution columns simply didn't exist yet.
    expect(legacy.prepare('SELECT * FROM purchase').get()).toMatchObject({
      purchase_id: 'PUR-0001',
      total_cost: 2600,
      client_id: null,
      smoking_session_id: null,
      // A kg buy has no per-piece weight, and a row written before the column
      // existed was never weighed by the piece either — null is the answer in
      // both cases, and the ADD COLUMN gives it without touching the row.
      weight_per_unit_kg: null,
    });
    // The 0/1 flag becomes the word the pitmaster picked.
    expect(legacy.prepare('SELECT * FROM smoking_session').get()).toMatchObject({
      session_id: 'SMK-0001',
      smoke_rings_formed: 'Yes',
      raw_weight_kg: 1.6,
    });
    // The recipe id becomes the side key, and the name it had in the
    // catalogue comes with it so the row reads on its own.
    expect(legacy.prepare('SELECT * FROM side_prep_status').get()).toMatchObject({
      weekend_start: '2026-08-07',
      weekend_end: '2026-08-10',
      side_key: 'SR-015',
      side_name: 'BBQ sauce',
      status: 'done',
    });
  });

  it('says what it changed the first time and nothing the second', () => {
    expect(firstRun.length).toBe(5);
    // Idempotence is what makes it safe to run on every open: the server
    // opens the database on the first request of every restart.
    expect(migrate(legacy)).toEqual([]);
  });

  it('has nothing to do to a database built from schema.sql', () => {
    expect(migrate(fresh)).toEqual([]);
  });
});
