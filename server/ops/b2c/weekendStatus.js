// Weekend Prep Planner's "mark this weekend as done" state — one row per
// weekend in the `weekend` table, shared (not localStorage) so the flag is
// visible to whoever opens the dashboard next, not just the browser that
// clicked it.
//
// Migrated off Tasks/weekend_prep_status.csv. Two things changed with the
// move, both of them the reason this module owns the table:
//
//   * A weekend is identified by the day it starts. The CSV matched on the
//     weekend_start/weekend_end pair from Step 1's Odoo date-range picker,
//     which meant stretching the range by a day made the same weekend look
//     like a new one with no status. weekend_start is the primary key here,
//     and the end date is data on the row.
//   * server/ops/b2c/sidePrepStatus.js hangs its per-side rows off this table
//     by foreign key, so every weekend it touches has to exist here first —
//     hence ensureWeekend below, which is the only other way a row is made.
import { selectOne, upsert } from '../../core/repo.js';

function requireWeekend(weekendStart, weekendEnd) {
  if (!weekendStart || !weekendEnd) {
    const err = new Error('weekendStart and weekendEnd are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
}

// Makes sure the weekend exists, without touching a prep status that is
// already recorded. Used by the side-prep board, which has to be able to say
// "started making the sauce" for a weekend nobody has marked anything on yet.
//
// The end date is refreshed on every call: it comes from whatever range the
// planner is currently looking at, and the latest answer is the better one.
function ensureWeekend(weekendStart, weekendEnd) {
  requireWeekend(weekendStart, weekendEnd);
  upsert('weekend', ['weekend_start'], { weekend_start: weekendStart, weekend_end: weekendEnd });
}

function getWeekendStatus({ weekendStart, weekendEnd }) {
  requireWeekend(weekendStart, weekendEnd);
  const row = selectOne('weekend', { weekend_start: weekendStart });
  // 'planned' for a weekend nobody has said anything about yet, which is what
  // the board shows before the first click.
  return row?.prep_status
    ? { status: row.prep_status, markedAt: row.marked_at || null }
    : { status: 'planned', markedAt: null };
}

function setWeekendStatus({ weekendStart, weekendEnd, status }) {
  requireWeekend(weekendStart, weekendEnd);
  const markedAt = status === 'done' ? new Date().toISOString() : null;
  upsert('weekend', ['weekend_start'], {
    weekend_start: weekendStart,
    weekend_end: weekendEnd,
    prep_status: status,
    marked_at: markedAt,
  });
  return { status, markedAt };
}

export { getWeekendStatus, setWeekendStatus, ensureWeekend };
