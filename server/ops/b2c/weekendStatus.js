// Weekend Prep Planner's "mark this weekend as done" state — a small, shared
// (knowledge-base CSV, not localStorage) status so the flag is visible to
// whoever opens the dashboard next, not just the browser that clicked it.
// One row per weekend, keyed by the same weekend_start/weekend_end date pair
// Step 1's Odoo date-range picker already uses ("this weekend" = whatever
// range was fetched), not a separate id scheme.
import { readCsvFile, writeCsvFile } from '../../core/csvStore.js';
import { filePath } from '../../core/knowledgeBase.js';
import fs from 'fs';

const HEADER = ['weekend_start', 'weekend_end', 'status', 'marked_at'];

// The file ships with just a header row (created 2026-08-15) — created here
// on first use too, in case a fresh knowledge-base checkout doesn't have it
// yet, same "don't hard-fail on a missing optional file" spirit as the rest
// of this module.
function ensureFile() {
  const p = filePath('weekendPrepStatus');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `${HEADER.join(',')}\r\n`, 'utf8');
  }
  return p;
}

function loadRows() {
  const path = ensureFile();
  return { path, ...readCsvFile(path) };
}

function getWeekendStatus({ weekendStart, weekendEnd }) {
  if (!weekendStart || !weekendEnd) {
    const err = new Error('weekendStart and weekendEnd are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
  const { rows } = loadRows();
  const row = rows.find((r) => r.weekend_start === weekendStart && r.weekend_end === weekendEnd);
  return row ? { status: row.status, markedAt: row.marked_at || null } : { status: 'planned', markedAt: null };
}

function setWeekendStatus({ weekendStart, weekendEnd, status }) {
  if (!weekendStart || !weekendEnd) {
    const err = new Error('weekendStart and weekendEnd are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
  const { path, header, rows } = loadRows();
  const existing = rows.find((r) => r.weekend_start === weekendStart && r.weekend_end === weekendEnd);
  const markedAt = status === 'done' ? new Date().toISOString() : '';

  if (existing) {
    existing.status = status;
    existing.marked_at = markedAt;
  } else {
    rows.push({ weekend_start: weekendStart, weekend_end: weekendEnd, status, marked_at: markedAt });
  }

  writeCsvFile(path, header.length ? header : HEADER, rows);
  return { status, markedAt: markedAt || null };
}

export { getWeekendStatus, setWeekendStatus };
