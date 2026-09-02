// Append-only audit trail of every smoking session stage change — one row per
// transition (rub -> ready_to_smoke -> smoking -> resting -> shredding ->
// completed), with the timestamp, the session it happened to, and which side
// of the business it was for.
//
// Same split as the sessions themselves: smoking_session holds current truth
// (one row per cook, updated in place), this holds the history that updating
// would otherwise erase.
//
// B2C and B2B sessions land in this one table rather than a log each — the
// channel and purpose columns are what tell them apart, so "how many practice
// cooks did we do this month" and "how long do B2B sample smokes take vs the
// weekend ones" are both a filter on the same table.
//
// Migrated off Smoker/smoking_stage_log.csv. The table deliberately has no
// foreign key back to smoking_session: a deleted session still leaves its
// "to_stage = deleted" row behind, which is the whole point of keeping a
// trail. See the note above it in server/core/schema.sql.
import { all } from '../../core/db.js';
import { insert } from '../../core/repo.js';

// Records one stage move. Best-effort on purpose: the stage change itself has
// already been written to smoking_session by the time this runs, and losing
// an audit row is a far smaller problem than failing a step the pitmaster has
// physically already done.
//
// from_stage is blank on the row that creates the session (nothing to come
// from); to_stage is 'deleted' when a session is removed, so a session that
// disappears from the table still has a reason on file.
function logStageChange({
  sessionId,
  sessionDate,
  channel,
  purpose,
  fromStage,
  toStage,
  materialName,
  outputType,
  pitmaster,
  detail,
}) {
  try {
    insert('smoking_stage_log', {
      changed_at: new Date().toISOString(),
      session_id: sessionId || '',
      session_date: sessionDate || null,
      channel: channel || null,
      purpose: purpose || null,
      from_stage: fromStage || null,
      to_stage: toStage || null,
      source_material_name: materialName || null,
      output_type: outputType || null,
      pitmaster: pitmaster || null,
      detail: detail || null,
    });
  } catch (err) {
    console.error(`Failed to log smoking stage change for ${sessionId}:`, err.message || err);
  }
}

// History, newest first. sessionId / channel / purpose narrow it — channel
// being the "just the B2B cooks" case; limit caps how many come back.
//
// log_id breaks ties on changed_at because two transitions logged inside the
// same millisecond (a batch of sessions created together does exactly that)
// would otherwise come back in whatever order the query planner found them,
// and the screen reads the newest row as the current one.
function getStageLog({ sessionId, channel, purpose, limit } = {}) {
  const where = [];
  const params = [];
  if (sessionId) {
    where.push('session_id = ?');
    params.push(sessionId);
  }
  if (channel) {
    where.push('channel = ?');
    params.push(channel);
  }
  if (purpose) {
    where.push('purpose = ?');
    params.push(purpose);
  }

  const rows = all(
    `SELECT * FROM smoking_stage_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY changed_at DESC, log_id DESC
      ${limit ? 'LIMIT ?' : ''}`,
    ...params,
    ...(limit ? [limit] : []),
  );

  return {
    entries: rows.map((row) => ({
      changedAt: row.changed_at,
      sessionId: row.session_id,
      sessionDate: row.session_date || null,
      channel: row.channel || null,
      purpose: row.purpose || null,
      fromStage: row.from_stage || null,
      toStage: row.to_stage || null,
      materialName: row.source_material_name || null,
      outputType: row.output_type || null,
      pitmaster: row.pitmaster || null,
      detail: row.detail || null,
    })),
  };
}

export { logStageChange, getStageLog };
