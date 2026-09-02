// Per-side prep state for the Weekend Prep Planner's "Sides needed — batch
// detail" table: not started → making → done, one row per side per weekend in
// `side_prep_status`, with every transition appended to `side_prep_log`.
//
// Shared through the database rather than localStorage for the same reason
// server/ops/b2c/weekendStatus.js is (whoever opens the board next sees where
// the kitchen actually got to, not just the browser that clicked), and keyed
// the same way: the weekend, plus the side key computeSwiggyPlan groups by
// (sub-recipe id where there is one, else material id, else name).
//
// side_name rides along denormalised so a row reads on its own — "SR-015"
// means nothing to someone reading a query result.
//
// Migrated off Kitchen/side_prep_status.csv (current truth) and the
// repurposed Kitchen/packing_log.csv (the trail behind it). The status table
// was seeded keyed on a recipe id with a foreign key to `recipe`, which only
// ever fitted a third of the sides this board tracks; server/core/migrations.js
// rekeys it on side_key, and the note there says why.
import { all } from '../../core/db.js';
import { insert, select, upsert } from '../../core/repo.js';
import { ensureWeekend } from './weekendStatus.js';

const STATUSES = new Set(['pending', 'making', 'done']);

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

// Matched on weekend_start alone — the weekend's identity, see the note in
// weekendStatus.js. The end date is carried on the row for readability, not
// as part of the key.
function getSidePrepStatuses({ weekendStart, weekendEnd }) {
  requireWeekend(weekendStart, weekendEnd);
  return toMap(select('side_prep_status', { weekend_start: weekendStart }));
}

// Every start/finish is also written to side_prep_log, the append-only trail
// that the current-truth row above would otherwise overwrite. Best-effort:
// losing an audit row is bad, but failing the status change itself — and
// leaving the board showing a batch the kitchen has already started — is
// worse.
//
// channel tags the row B2C so the B2B kitchen can share the same log later
// rather than getting one of its own, the same convention smoking_stage_log
// and sales_order follow.
function logSidePrepChange(row) {
  try {
    insert('side_prep_log', { channel: 'B2C', source: 'weekend-prep', ...row });
  } catch (err) {
    console.error('Failed to append to side_prep_log:', err.message || err);
  }
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

  const [existing] = all(
    'SELECT * FROM side_prep_status WHERE weekend_start = ? AND side_key = ?',
    weekendStart,
    sideKey,
  );
  const now = new Date().toISOString();
  // Read off before the row below is written — otherwise the history row's
  // from_status would just echo to_status.
  const fromStatus = existing?.status || 'pending';
  // started_at is kept once set: going back to "making" from done shouldn't
  // rewrite when the batch was actually started. Dropping to pending is the
  // explicit "I mis-clicked" path, so that one does clear both stamps.
  const startedAt = status === 'pending' ? null : existing?.started_at || now;
  const doneAt = status === 'done' ? now : null;

  // The row hangs off `weekend` by foreign key, so the weekend has to be on
  // file before the side is.
  ensureWeekend(weekendStart, weekendEnd);
  upsert('side_prep_status', ['weekend_start', 'side_key'], {
    weekend_start: weekendStart,
    weekend_end: weekendEnd,
    side_key: sideKey,
    side_name: sideName || existing?.side_name || sideKey,
    status,
    started_at: startedAt,
    done_at: doneAt,
  });

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
