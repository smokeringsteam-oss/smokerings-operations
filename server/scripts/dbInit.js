// Creates an empty database from server/core/schema.sql — `npm run db:init`.
//
// This replaces `npm run kb:import`, which shelled out to a loader in the
// knowledge-base repo to seed the CSVs into SQLite. That made sense while the
// CSVs were the source of truth; they aren't any more, and re-running it today
// would push a stale snapshot over live rows. The schema moved into this repo
// with the data (see the note at the top of schema.sql), so a fresh clone can
// build a database without that repo being checked out at all.
//
// What it makes is empty. A brand new database has no catalogue in it — no
// materials, no menu, no recipes — so the screens come up with nothing to
// show until something is entered or a copy of a real database is dropped in.
// That is the honest state of a fresh install; the alternative would be
// shipping somebody else's stock counts as fixtures.
//
// It refuses to touch an existing file: the database is the source of truth,
// and there is no backup of it inside this repo (server/data is gitignored),
// so an accidental `db:init` over a live database is unrecoverable. Move the
// old file aside yourself if that is really what you meant.
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { DatabaseSync, getDbPath, getSchemaPath } from '../core/db.js';

const dbPath = getDbPath();
const schemaPath = getSchemaPath();

if (fs.existsSync(dbPath)) {
  console.error(
    `${dbPath} already exists.\n` +
      `The database is the source of truth, so this won't overwrite it. Move or\n` +
      `delete that file yourself if you really mean to start over — and take a\n` +
      `copy first, because server/data isn't in git.`,
  );
  process.exit(1);
}

if (!fs.existsSync(schemaPath)) {
  console.error(`No schema at ${schemaPath}.`);
  process.exit(1);
}

// server/data is gitignored, so it won't exist on a fresh clone.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
try {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
} catch (err) {
  db.close();
  // A half-applied schema is worse than none: it would satisfy the "already
  // exists" guard above and never be built properly.
  fs.rmSync(dbPath, { force: true });
  console.error(`Couldn't apply the schema: ${err.message}`);
  process.exit(1);
}

const tables = db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .get().n;
db.close();

console.log(`Created ${dbPath} — ${tables} tables, no rows.`);
