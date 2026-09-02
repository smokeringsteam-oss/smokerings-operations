// Ad-hoc read access to the SQLite knowledge base, for when you just want to
// look. No install: node:sqlite ships with Node 24, same as core/db.js.
//
//   npm run db -- .tables              list tables with row counts
//   npm run db -- .schema material     CREATE statement for one table
//   npm run db -- "select * from material limit 5"
//
// Read-only by design — it opens the file with readOnly and refuses anything
// that isn't a SELECT/PRAGMA, so a typo at the terminal can't write over
// operational data. Writes go through the app.
import { createRequire } from 'node:module';
import path from 'path';
import { fileURLToPath } from 'url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.KB_SQLITE_PATH
  ? path.resolve(process.env.KB_SQLITE_PATH)
  : path.resolve(__dirname, '../data/smokerings.db');

const arg = process.argv.slice(2).join(' ').trim();
const db = new DatabaseSync(dbPath, { readOnly: true });

function tables() {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

// console.table renders null-prototype rows as empty, so copy them out first.
function show(rows) {
  if (!rows.length) return console.log('(no rows)');
  console.table(rows.map((r) => ({ ...r })));
}

if (!arg || arg === '.tables') {
  show(tables().map((name) => ({ table: name, rows: db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n })));
} else if (arg.startsWith('.schema')) {
  const which = arg.slice('.schema'.length).trim();
  const rows = which
    ? db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").all(which)
    : db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  if (!rows.length) console.log(`No such table: ${which}`);
  rows.forEach((r) => console.log(`${r.sql};\n`));
} else if (/^\s*(select|pragma|with)\b/i.test(arg)) {
  show(db.prepare(arg).all());
} else {
  console.error('Read-only: pass a SELECT/PRAGMA/WITH query, .tables, or .schema [table]');
  process.exitCode = 1;
}

db.close();
