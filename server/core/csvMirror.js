// Writes a knowledge-base CSV back out from the database.
//
// The SQLite cutover made the database the source of truth and stopped
// anything under server/ from reading a CSV. That was the right call for
// reads, but it also took away the thing the CSVs were quietly good at:
// opening a file and seeing the whole table at a glance, in a spreadsheet or
// in a diff, without a query. This puts that half back — a table is written
// out to its old CSV *after* the database write has succeeded, so the file is
// a mirror and never an input.
//
// Nothing reads these files back, here or anywhere under server/. Editing one
// changes nothing and is silently undone by the next mirror; the app is the
// way to change the data.
//
// Nothing here can fail a request. The database write has already happened
// and can't be honestly rolled back, and the knowledge-base repo may not be
// checked out on a given machine (the .env note says as much) — so every path
// returns { mirrored, reason } and the caller passes it up as a note.
//
// Whole-file rewrite rather than an append: a mirrored table is small (the
// task log is one row per week per task someone has touched) and rows change
// after they're written — a task ticked and then unticked is the same row
// twice, which an append-only file would show as two contradicting rows.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The knowledge-base repo lives as a sibling to this project by default:
//   D:\Personal GIT\knowledge-base\Data\...
// KNOWLEDGE_BASE_DATA_DIR overrides it, and is the same variable the CSV era
// used, so a machine that already had it set keeps working.
function getDataDir() {
  return process.env.KNOWLEDGE_BASE_DATA_DIR
    ? path.resolve(process.env.KNOWLEDGE_BASE_DATA_DIR)
    : path.resolve(__dirname, '../../../knowledge-base/Data');
}

function needsQuoting(value) {
  return /[",\r\n]/.test(value);
}

function encodeField(value) {
  const str = value == null ? '' : String(value);
  return needsQuoting(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Echo back whatever line ending the file already has, so a mirror doesn't
// flip every line and bury one changed row in a whole-file diff. The
// knowledge-base Tasks files are CRLF, which is the default for one that
// doesn't exist yet.
function eolFor(filePath) {
  if (!fs.existsSync(filePath)) return '\r\n';
  const text = fs.readFileSync(filePath, 'utf8');
  return /\r\n/.test(text) ? '\r\n' : /\n/.test(text) ? '\n' : '\r\n';
}

// Logged as well as returned. A mirror is a background nicety and its result
// reaches the page as a note nobody has to read, so a repo that has quietly
// stopped being written to would otherwise only be noticed by opening the
// file — which is exactly the thing this exists to save someone doing.
function skipped(relativePath, reason) {
  console.warn(`CSV mirror (${relativePath}): ${reason}`);
  return { mirrored: false, reason };
}

// `relativePath` is relative to Data, matching how the CSV era addressed
// these files ('Tasks/weekly_schedule_status_log.csv').
//
// A missing Data directory is a skip, not an error: it means the sibling repo
// isn't checked out here, which is a supported way to run the app. A missing
// file *inside* it is created — that's a mirror that hasn't run yet.
function mirrorCsv(relativePath, header, rows) {
  try {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) {
      return skipped(
        relativePath,
        `Saved. The CSV mirror was skipped: no knowledge-base Data directory at ${dataDir}. Set KNOWLEDGE_BASE_DATA_DIR in .env if that repo lives elsewhere.`,
      );
    }

    const filePath = path.join(dataDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const eol = eolFor(filePath);
    const lines = [header.join(','), ...rows.map((row) => header.map((key) => encodeField(row[key])).join(','))];
    const text = `${lines.join(eol)}${eol}`;

    // Written beside the target and renamed over it, so a mirror that dies
    // halfway (or a file Excel has open) leaves the previous CSV intact
    // rather than a truncated one. Same directory, because a rename across
    // volumes isn't atomic.
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, text, 'utf8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }

    return { mirrored: true, path: filePath, rows: rows.length };
  } catch (err) {
    return skipped(
      relativePath,
      `Saved, but the ${relativePath} mirror couldn't be written: ${err.message || String(err)}`,
    );
  }
}

export { getDataDir, mirrorCsv };
