// Per-side prep state for the Weekend Prep Planner's "Sides needed — batch
// detail" table: not started → making → done, one row per side per weekend.
//
// Shared through a knowledge-base CSV rather than localStorage for the same
// reason server/ops/b2c/weekendStatus.js is (whoever opens the board next sees where
// the kitchen actually got to, not just the browser that clicked), and keyed
// the same way: the weekend_start/weekend_end pair from Step 1's Odoo
// date-range picker, plus the side key computeSwiggyPlan groups by
// (sub-recipe id where there is one, else material id, else name).
//
// side_name rides along denormalised so the CSV reads on its own — "SR-015"
// means nothing to someone opening the file in Excel.
import { readCsvFile, writeCsvFile, appendCsvRows } from '../../core/csvStore.js';
import { getDataDir } from '../../core/knowledgeBase.js';
import fs from 'fs';
import path from 'path';

// Deliberately not in knowledgeBase.js's FILES registry: it's created on
// first use rather than shipped, and listing it there would make getConfig()
// report the whole knowledge base as unconfigured until someone happens to
// click "Start making". Same reasoning as server/marketing/aiSeo.js's two files.
const STATUS_FILE = 'Kitchen/side_prep_status.csv';

const HEADER = ['weekend_start', 'weekend_end', 'side_key', 'side_name', 'status', 'started_at', 'done_at'];
const STATUSES = new Set(['pending', 'making', 'done']);

// Created on first use — nothing ships this file, same "don't hard-fail on a
// missing optional file" spirit as weekendStatus.js.
function ensureFile() {
  const p = path.join(getDataDir(), STATUS_FILE);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${HEADER.join(',')}\r\n`, 'utf8');
  }
  return p;
}

function loadRows() {
  const statusPath = ensureFile();
  return { path: statusPath, ...readCsvFile(statusPath) };
}

// ---- Append-only history: Kitchen/packing_log.csv -----------------------
// Every start/finish is also written as a history row, following the
// knowledge-base v2 rule that "*_log.csv is append-only history, everything
// else is current truth" — Kitchen/side_prep_status.csv above is the current
// truth, this is the trail behind it.
//
// It reuses packing_log.csv rather than a new file at the pitmaster's call
// (2026-08-19): the file was left header-only and unwritten by the v2
// restructure, still carrying an order/invoice-shaped header nothing reads.
// The `channel` column tags rows B2C so the B2B kitchen can share the same
// log later rather than getting a file of its own — same convention as
// order_lifecycle_log.csv and smoking_stage_log.csv.
const LOG_FILE = 'Kitchen/packing_log.csv';
const LOG_HEADER = [
  'changed_at',
  'channel',
  'side_key',
  'side_name',
  'from_status',
  'to_status',
  'weekend_start',
  'weekend_end',
  'source',
];

// The legacy order-shaped header is replaced outright while the file holds no
// data rows (the state it shipped in). If anything has since been written
// under that header, the two headers are unioned instead — a stale column
// layout is worth keeping over silently orphaning somebody's rows.
function ensureLogFile() {
  const p = path.join(getDataDir(), LOG_FILE);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${LOG_HEADER.join(',')}
`, 'utf8');
    return { path: p, header: LOG_HEADER };
  }
  const { header, rows } = readCsvFile(p);
  if (LOG_HEADER.every((column) => header.includes(column))) return { path: p, header };
  if (!rows.length) {
    fs.writeFileSync(p, `${LOG_HEADER.join(',')}
`, 'utf8');
    return { path: p, header: LOG_HEADER };
  }
  const merged = [...header, ...LOG_HEADER.filter((column) => !header.includes(column))];
  writeCsvFile(p, merged, rows);
  return { path: p, header: merged };
}

// Best-effort: losing an
// audit row is bad, but failing the status change itself — and leaving the
// board showing a batch the kitchen has already started — is worse.
function logSidePrepChange(row) {
  try {
    const { path: p, header } = ensureLogFile();
    appendCsvRows(p, header, [{ channel: 'B2C', source: 'weekend-prep', ...row }]);
  } catch (err) {
    console.error('Failed to append to Kitchen/packing_log.csv:', err);
  }
}

function requireWeekend(weekendStart, weekendEnd) {
  if (!weekendStart || !weekendEnd) {
    const err = new Error('weekendStart and weekendEnd are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
}

// Shaped as a map keyed by side key so the board can look a row up directly
// rather than scanning a list per render.
function toMap(rows) {
  const statuses = {};
  rows.forEach((r) => {
    statuses[r.side_key] = {
      status: r.status || 'pending',
      startedAt: r.started_at || null,
      doneAt: r.done_at || null,
    };
  });
  return { statuses };
}

function getSidePrepStatuses({ weekendStart, weekendEnd }) {
  requireWeekend(weekendStart, weekendEnd);
  const { rows } = loadRows();
  return toMap(rows.filter((r) => r.weekend_start === weekendStart && r.weekend_end === weekendEnd));
}

function setSidePrepStatus({ weekendStart, weekendEnd, sideKey, sideName, status }) {
  requireWeekend(weekendStart, weekendEnd);
  if (!sideKey) {
    const err = new Error('sideKey is required.');
    err.status = 400;
    throw err;
  }
  if (!STATUSES.has(status)) {
    const err = new Error(`status must be one of ${[...STATUSES].join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const { path: statusPath, header, rows } = loadRows();
  const existing = rows.find(
    (r) => r.weekend_start === weekendStart && r.weekend_end === weekendEnd && r.side_key === sideKey,
  );
  const now = new Date().toISOString();
  // Read off before the row below is mutated in place — otherwise the history
  // row's from_status would just echo to_status.
  const fromStatus = existing?.status || 'pending';
  // started_at is kept once set: going back to "making" from done shouldn't
  // rewrite when the batch was actually started. Dropping to pending is the
  // explicit "I mis-clicked" path, so that one does clear both stamps.
  const startedAt = status === 'pending' ? '' : existing?.started_at || now;
  const doneAt = status === 'done' ? now : '';

  if (existing) {
    existing.side_name = sideName || existing.side_name;
    existing.status = status;
    existing.started_at = startedAt;
    existing.done_at = doneAt;
  } else {
    rows.push({
      weekend_start: weekendStart,
      weekend_end: weekendEnd,
      side_key: sideKey,
      side_name: sideName || sideKey,
      status,
      started_at: startedAt,
      done_at: doneAt,
    });
  }

  writeCsvFile(statusPath, header.length ? header : HEADER, rows);
  logSidePrepChange({
    // The instant of this transition, not the batch's started_at — undoing a
    // "done" keeps the original start stamp, so those two diverge.
    changed_at: now,
    side_key: sideKey,
    side_name: sideName || existing?.side_name || sideKey,
    from_status: fromStatus,
    to_status: status,
    weekend_start: weekendStart,
    weekend_end: weekendEnd,
  });
  return getSidePrepStatuses({ weekendStart, weekendEnd });
}

export { getSidePrepStatuses, setSidePrepStatus };
