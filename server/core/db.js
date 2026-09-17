// The one SQLite connection this server uses.
//
// The database is the source of truth for everything the server reads and
// writes. Nothing under server/ opens a CSV any more: the knowledge-base
// repo's Data/*.csv files seeded this database once and are now history, and
// the schema they were loaded into lives here too, in server/core/schema.sql.
// `npm run db:init` builds an empty database from it; migrations.js brings an
// existing one up to it on every open.
//
// node:sqlite rather than better-sqlite3: it ships with Node 24, so there is
// no native build step on Windows, and its API is synchronous — which is what
// lets the eighteen modules that call this keep their existing synchronous
// shape instead of every route turning async.
//
// No caching, deliberately. Every call goes to the database, so a row written
// by one request is visible to the next. At these row counts (472 across 22
// tables) an indexed read is microseconds — far cheaper than the readFileSync
// plus full RFC4180 parse it replaces.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import { migrate } from './migrations.js';

// `import { DatabaseSync } from 'node:sqlite'` is what this wants to be, and
// is what Node runs happily. Vite is the problem: it rewrites the specifier
// to a bare 'sqlite' before checking it against module.builtinModules, which
// lists 'node:sqlite' but no bare 'sqlite' — so it decides this is an npm
// package, finds none, and every server test that reaches the database dies
// at import with "Failed to load url sqlite". Neither test.server.deps.external
// nor a resolveId plugin gets in front of that rewrite.
//
// A require() call is not statically analysed, so it goes straight to Node's
// own resolver. Same module, same cost, no build-tool opinion in the way.
// Worth collapsing back to a plain import once Vite knows about node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inside this project, beside server/logs and server/uploads — deliberately
// not in the knowledge-base repo. That repo is the data and documentation
// source the CSVs were seeded from; the database is this app's own
// operational state, so it lives with the app that owns it and is gitignored
// like the other runtime directories. Override with KB_SQLITE_PATH.
function getDbPath() {
  return process.env.KB_SQLITE_PATH
    ? path.resolve(process.env.KB_SQLITE_PATH)
    : path.resolve(__dirname, '../data/smokerings.db');
}

// The schema every database here is built to. Read by `npm run db:init` and by
// the test that checks migrations.js arrives at the same shape.
function getSchemaPath() {
  return path.resolve(__dirname, 'schema.sql');
}

let db = null;

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    // 503 rather than 500: a missing database is a setup problem on this
    // machine, not a bad request.
    const err = new Error(
      `No database at ${dbPath}. Build it with \`npm run db:init\`, or set ` +
        `KB_SQLITE_PATH in the server's .env if it lives somewhere else.`,
    );
    err.status = 503;
    throw err;
  }
  db = new DatabaseSync(dbPath);
  // WAL lets a second process (a backup, a query from `npm run db`) read while
  // the server writes. Its side files (-wal, -shm) sit in the same gitignored
  // directory.
  db.exec('PRAGMA journal_mode = WAL');
  // A write held by another connection shouldn't fail a request outright.
  db.exec('PRAGMA busy_timeout = 5000');
  // Before foreign keys go on, not after: a migration that rebuilds a table
  // other tables point at has to drop it, which enforcement would refuse.
  const applied = migrate(db);
  if (applied.length) console.log(`Database migrated: ${applied.join('; ')}`);
  // ON is not the SQLite default — without it every REFERENCES clause in the
  // schema is decoration.
  db.exec('PRAGMA foreign_keys = ON');
  startCheckpointing(db);
  return db;
}

// Folds the WAL back into smokerings.db itself, every 30 seconds.
//
// SQLite only does this on its own once the WAL reaches 1,000 pages (~4 MB),
// or when the last connection closes — and the server's connection never
// closes. This app writes a few kilobytes a day, so on its own the main file
// went a week (9 Sep to 13 Sep) without a single write reaching it: the app
// read every purchase through the WAL, while anything that opens only the .db
// file — a SQLite viewer, a copied backup — saw the database as it was a week
// earlier. PASSIVE never blocks a reader or a writer; a busy result simply
// means it tries again next time. unref'd so it never keeps a test or a
// script alive.
let checkpointTimer = null;

function startCheckpointing(handle) {
  clearInterval(checkpointTimer);
  checkpointTimer = setInterval(() => {
    try {
      handle.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // Busy — nothing to do until the next tick.
    }
  }, 30_000);
  checkpointTimer.unref?.();
}

// node:sqlite hands back null-prototype objects. The modules migrating off
// csvStore.js were written against plain object literals, so these are copied
// into real objects — `{...row}`, `Object.keys` and JSON serialization all
// behave, and an accidental `row.hasOwnProperty(...)` doesn't throw.
function plain(row) {
  return row === undefined ? undefined : { ...row };
}

function all(sql, ...params) {
  return getDb().prepare(sql).all(...params).map(plain);
}

function get(sql, ...params) {
  return plain(getDb().prepare(sql).get(...params));
}

function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

// Wraps a unit of work so a multi-table change lands whole or not at all —
// the thing the CSV store could never offer. A purchase writes a purchase row
// and decrements the material's stock; as two file rewrites either could
// succeed alone, leaving the count wrong with no way to tell.
//
// Not reentrant: SQLite has no nested BEGIN, so tx() calls must not nest.
function tx(fn) {
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// What the dashboard's setup check reports: where the database is, and enough
// of a summary to tell an empty one from a loaded one at a glance.
function getDbConfig() {
  const dbPath = getDbPath();
  const exists = fs.existsSync(dbPath);
  if (!exists) return { dbPath, exists, tables: 0, rows: 0 };
  const tables = all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
  const rows = tables.reduce((sum, t) => sum + get(`SELECT count(*) AS n FROM "${t}"`).n, 0);
  return { dbPath, exists, tables: tables.length, rows, tableNames: tables };
}

// Tests build a database per case; the server never calls this.
function closeDb() {
  clearInterval(checkpointTimer);
  checkpointTimer = null;
  if (db) {
    db.close();
    db = null;
  }
}

export { getDb, getDbPath, getSchemaPath, all, get, run, tx, getDbConfig, closeDb, DatabaseSync };
