// The one write path to the database.
//
// Every server module that saves anything goes through this — no module
// writes its own INSERT/UPDATE/DELETE. That is the rule the file exists to
// enforce, and it buys three things the old one-CSV-writer-per-module layout
// could not:
//
//   * One place where a write can be made correct. Identifier quoting, null
//     handling, "did that UPDATE actually match a row", sequential id
//     allocation — fixed once rather than re-derived per module, slightly
//     differently each time.
//   * Writes that read like the domain. `update('material', { item_id }, {...})`
//     says what is happening; a heredoc of SQL in the middle of the smoking
//     flow does not.
//   * A single seam for anything that must apply to all writes later —
//     an audit trail, a change feed, a read-only mode.
//
// Reads are deliberately NOT funnelled through here. The interesting reads in
// this app are joins and aggregates (see server/core/kbViews.js), and a
// generic select() that only handles single-table equality filters would
// either be bypassed constantly or grow into a query builder. select() below
// exists for the simple lookups writers need; anything with a join goes to
// db.js's all()/get() with real SQL.
//
// Nothing here is reachable from the browser. The dashboard talks to the
// domain endpoints in server/index.js, which own the business rules — a
// purchase moves stock in the same transaction, a session id is allocated
// server-side — and those endpoints call this. A generic table-write endpoint
// exposed to the UI would route around exactly those rules.
import { all, get, run, tx } from './db.js';

// Table and column names cannot be bound as parameters — they are spliced
// into the SQL — so every identifier that reaches this file is checked
// against the plainest possible pattern before it gets there. Callers pass
// literals, so a rejection here is a typo in this repo rather than anything
// user-supplied, but the check is what keeps that true: the day someone
// wires a caller up to a request body, this refuses instead of concatenating.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

// SQLite binds only null, number, string, bigint and Uint8Array. Booleans and
// Dates are the two things a caller naturally reaches for that it rejects
// outright, and `undefined` — a property that simply wasn't set — should mean
// NULL rather than blowing up the whole statement.
function bindable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// `{ a: 1, b: null }` -> `WHERE "a" = ? AND "b" IS NULL`, with the params for
// the bound half. A null in a filter has to become IS NULL: `= ?` bound to
// null matches nothing in SQL, which as a silent no-op is the worst possible
// way for a delete or an update to fail.
function whereClause(where) {
  const keys = Object.keys(where || {});
  if (!keys.length) return { sql: '', params: [] };
  const params = [];
  const parts = keys.map((key) => {
    const value = bindable(where[key]);
    if (value === null) return `${ident(key)} IS NULL`;
    params.push(value);
    return `${ident(key)} = ?`;
  });
  return { sql: ` WHERE ${parts.join(' AND ')}`, params };
}

// A write that matched no rows is nearly always a bug — a stale id, a key
// spelled differently than the schema — and it is invisible unless something
// looks. Callers that legitimately expect a possible no-op pass
// { required: false } and read the count themselves.
function assertMatched(changes, { required, what }) {
  if (required !== false && changes === 0) {
    const err = new Error(`${what} matched no rows.`);
    err.status = 404;
    throw err;
  }
  return changes;
}

// ---- Create ------------------------------------------------------------

// insert('purchase', { purchase_id: 'PUR-0005', ... }). Column list comes
// from the object's own keys, so a row simply omits the columns it has
// nothing to say about and lets the schema's defaults apply.
function insert(table, row) {
  const keys = Object.keys(row);
  if (!keys.length) throw new Error(`insert into ${table} was given an empty row.`);
  const sql =
    `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) ` +
    `VALUES (${keys.map(() => '?').join(', ')})`;
  return run(sql, ...keys.map((key) => bindable(row[key])));
}

// One transaction, so a batch of purchase lines or BoM rows lands whole. The
// rows may differ in which columns they set; each is prepared on its own
// keys rather than forcing a union with nulls, which would overwrite schema
// defaults with NULL for any column a given row left out.
function insertMany(table, rows) {
  if (!rows.length) return 0;
  return tx(() => {
    rows.forEach((row) => insert(table, row));
    return rows.length;
  });
}

// The upsert behind every "status" table in this app: one row per key, set it
// if it isn't there, overwrite it if it is. Postgres-style ON CONFLICT, which
// SQLite has supported since 3.24 and node:sqlite therefore does too.
//
// `keys` must be the table's primary key (or a unique index) — that is what
// ON CONFLICT resolves against. The non-key columns are the ones updated.
function upsert(table, keys, row) {
  const columns = Object.keys(row);
  const updates = columns.filter((column) => !keys.includes(column));
  const sql =
    `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) ` +
    `VALUES (${columns.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${keys.map(ident).join(', ')}) DO UPDATE SET ` +
    (updates.length
      ? updates.map((column) => `${ident(column)} = excluded.${ident(column)}`).join(', ')
      : // A row that is nothing but its key has nothing to update; touching
        // the first key column to itself keeps this a valid statement and a
        // harmless no-op rather than a syntax error.
        `${ident(keys[0])} = excluded.${ident(keys[0])}`);
  return run(sql, ...columns.map((column) => bindable(row[column])));
}

// ---- Update ------------------------------------------------------------

// update('material', { item_id: 'RM-001' }, { stock_status: 'ok' })
function update(table, where, patch, options = {}) {
  const columns = Object.keys(patch);
  if (!columns.length) throw new Error(`update of ${table} was given an empty patch.`);
  const { sql: whereSql, params: whereParams } = whereClause(where);
  const sql =
    `UPDATE ${ident(table)} SET ${columns.map((column) => `${ident(column)} = ?`).join(', ')}${whereSql}`;
  const result = run(sql, ...columns.map((column) => bindable(patch[column])), ...whereParams);
  return assertMatched(result.changes, { ...options, what: `update of ${table}` });
}

// Adds `delta` to a numeric column inside the statement, so the read and the
// write are one atomic step. Doing it as select-then-update in JS means two
// callers can read the same starting value and the second silently erases the
// first — which for stock is a count that is simply wrong, with nothing in
// any log to say so.
//
// coalesce because a never-counted material has NULL on hand, and NULL + 5 is
// NULL, not 5. Rounded to `places` to stop grams and millilitres accumulating
// into float noise like 4.199999999999999 on the stock table.
function increment(table, where, column, delta, { patch = {}, places = 2, ...options } = {}) {
  const { sql: whereSql, params: whereParams } = whereClause(where);
  const extra = Object.keys(patch);
  const sql =
    `UPDATE ${ident(table)} SET ${ident(column)} = round(coalesce(${ident(column)}, 0) + ?, ${Number(places)})` +
    (extra.length ? `, ${extra.map((c) => `${ident(c)} = ?`).join(', ')}` : '') +
    whereSql;
  const result = run(sql, bindable(delta), ...extra.map((c) => bindable(patch[c])), ...whereParams);
  return assertMatched(result.changes, { ...options, what: `increment of ${table}.${column}` });
}

// ---- Delete ------------------------------------------------------------

// An empty `where` would delete the table. That is never what a caller of a
// helper named remove() meant to type, so it is refused rather than obeyed.
function remove(table, where, options = {}) {
  if (!Object.keys(where || {}).length) {
    throw new Error(`remove from ${table} needs a where clause — refusing to delete every row.`);
  }
  const { sql: whereSql, params } = whereClause(where);
  const result = run(`DELETE FROM ${ident(table)}${whereSql}`, ...params);
  return assertMatched(result.changes, { ...options, what: `delete from ${table}` });
}

// ---- Read (simple lookups only — joins go to db.js) --------------------

function select(table, where = {}, { orderBy, limit } = {}) {
  const { sql: whereSql, params } = whereClause(where);
  let sql = `SELECT * FROM ${ident(table)}${whereSql}`;
  if (orderBy) {
    // "col" or "col desc", one or more, comma separated — enough for the
    // orderings writers need without becoming an expression parser.
    const parts = String(orderBy)
      .split(',')
      .map((part) => {
        const [column, direction = 'asc'] = part.trim().split(/\s+/);
        if (!/^(asc|desc)$/i.test(direction)) throw new Error(`Unsafe sort direction: ${direction}`);
        return `${ident(column)} ${direction.toUpperCase()}`;
      });
    sql += ` ORDER BY ${parts.join(', ')}`;
  }
  if (limit != null) sql += ` LIMIT ${Number(limit)}`;
  return all(sql, ...params);
}

function selectOne(table, where) {
  const rows = select(table, where, { limit: 1 });
  return rows[0];
}

function exists(table, where) {
  return selectOne(table, where) !== undefined;
}

function count(table, where = {}) {
  const { sql: whereSql, params } = whereClause(where);
  return get(`SELECT count(*) AS n FROM ${ident(table)}${whereSql}`, ...params).n;
}

// ---- Ids ---------------------------------------------------------------

// The next "PUR-0005" / "SMK-0012" / "ADJ-0001" for a prefixed id column,
// replacing csvStore's nextSequentialId — same scheme, but as one indexed max
// rather than a scan of every row.
//
// GLOB, not LIKE: LIKE is case-insensitive by default in SQLite, so a stray
// 'pur-0009' would be counted and the next id would collide with nothing
// visible. The width comes from the widest existing id so a table that
// started at three digits keeps them.
function nextId(table, column, prefix, { width } = {}) {
  const start = prefix.length + 2; // 1-based substr, past "PREFIX-"
  const row = get(
    `SELECT max(CAST(substr(${ident(column)}, ${start}) AS INTEGER)) AS last,
            max(length(${ident(column)}) - ${start - 1}) AS digits
       FROM ${ident(table)}
      WHERE ${ident(column)} GLOB ?`,
    `${prefix}-[0-9]*`,
  );
  const pad = width || row?.digits || 4;
  return `${prefix}-${String((row?.last || 0) + 1).padStart(pad, '0')}`;
}

// Re-exported so a caller composing several writes into one unit gets it from
// the same module as the writes themselves. Not reentrant — SQLite has no
// nested BEGIN, so transaction() calls must not nest.
const transaction = tx;

export {
  insert,
  insertMany,
  upsert,
  update,
  increment,
  remove,
  select,
  selectOne,
  exists,
  count,
  nextId,
  transaction,
};
