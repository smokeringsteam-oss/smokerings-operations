// Append-only audit trail of every smoking session stage change — one row per
// transition (rub -> ready_to_smoke -> smoking -> resting -> shredding ->
// completed), with the timestamp, the session it happened to, and which side
// of the business it was for.
//
// Same split as smoking_log.csv's own current-truth rows:
// smoking_log.csv holds current truth (one row per session, rewritten in
// place), this holds the history that rewriting would otherwise erase.
//
// B2C and B2B sessions land in this one file rather than a log each — the
// channel and purpose columns are what tell them apart, so "how many practice
// cooks did we do this month" and "how long do B2B sample smokes take vs the
// weekend ones" are both a filter on the same table. Same reasoning behind
// B2B sessions going into smoking_log.csv itself rather than a B2B copy of it.
//
// Not registered in server/core/knowledgeBase.js FILES — created here on first
// use, so listing it would make getConfig() report the knowledge base as
// unconfigured until someone runs a session. Same as the aiSeo and b2bClients
// files.
import fs from 'fs';
import path from 'path';
import { readCsvFile, appendCsvRows } from '../../core/csvStore.js';
import { getDataDir } from '../../core/knowledgeBase.js';

const FILE = 'smoking_stage_log.csv';
const HEADER = [
  'changed_at',
  'session_id',
  'session_date',
  'channel',
  'purpose',
  'from_stage',
  'to_stage',
  'source_material_name',
  'output_type',
  'pitmaster',
  'detail',
];

const EOL = '\n';

function ensureFile() {
  const p = path.join(getDataDir(), FILE);
  if (!fs.existsSync(p)) fs.writeFileSync(p, `${HEADER.join(',')}${EOL}`, 'utf8');
  return p;
}

// Records one stage move. Best-effort on purpose: the stage change itself has
// already been written to smoking_log.csv by the time this runs, and losing
// an audit row is a far smaller problem than failing a step the pitmaster has
// physically already done.
//
// from_stage is blank on the row that creates the session (nothing to come
// from); to_stage is 'deleted' when a session is removed, so a session that
// disappears from smoking_log.csv still has a reason on file.
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
    const p = ensureFile();
    appendCsvRows(p, HEADER, [
      {
        changed_at: new Date().toISOString(),
        session_id: sessionId || '',
        session_date: sessionDate || '',
        channel: channel || '',
        purpose: purpose || '',
        from_stage: fromStage || '',
        to_stage: toStage || '',
        source_material_name: materialName || '',
        output_type: outputType || '',
        pitmaster: pitmaster || '',
        detail: detail || '',
      },
    ]);
  } catch (err) {
    console.error(`Failed to log smoking stage change for ${sessionId}:`, err.message || err);
  }
}

// History, newest first. sessionId / channel / purpose narrow it — channel
// being the "just the B2B cooks" case; limit caps how many come back.
function getStageLog({ sessionId, channel, purpose, limit } = {}) {
  const p = path.join(getDataDir(), FILE);
  if (!fs.existsSync(p)) return { entries: [] };

  const { rows } = readCsvFile(p);
  const entries = rows
    .filter((row) => row.changed_at)
    .filter((row) => !sessionId || row.session_id === sessionId)
    .filter((row) => !channel || row.channel === channel)
    .filter((row) => !purpose || row.purpose === purpose)
    .map((row) => ({
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
    }))
    .reverse();

  return { entries: limit ? entries.slice(0, limit) : entries };
}

export { logStageChange, getStageLog, HEADER as SMOKING_STAGE_LOG_HEADER };
