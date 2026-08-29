// Minimal RFC4180 CSV read/write for the knowledge-base data files (vendors,
// raw materials, inventory, purchases — see server/ops/shared/purchasing.js). No
// external CSV dependency; these files are small (dozens to low hundreds of
// rows) so whole-file read/rewrite is simple and plenty fast.
//
// Preserves the existing \r\n line endings the knowledge-base CSVs already
// use, so diffs against files edited by hand/Excel stay clean.
import fs from 'fs';

// Not every knowledge-base CSV uses the same line ending — most are CRLF,
// but menu.csv is LF — so a rewrite echoes back whatever the file already
// had rather than flipping every line and burying a one-cell edit in a
// whole-file diff. CRLF stays the default for callers that don't pass one.
function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : /\n/.test(text) ? '\n' : '\r\n';
}

function parseCsv(text) {
  const rows = [];
  // Source text of each row, kept so writeCsvFile can hand untouched rows
  // back verbatim — see SOURCE below.
  const raws = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let rowStart = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = (endIndex) => {
    pushField();
    rows.push(row);
    raws.push(text.slice(rowStart, endIndex).replace(/\r$/, ''));
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\r') {
      // swallow — paired \n (or lone \r) handled below
    } else if (c === '\n') {
      pushRow(i);
      rowStart = i + 1;
    } else {
      field += c;
    }
  }
  // Trailing field/row if the file doesn't end on a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow(text.length);
  }

  const nonEmpty = rows
    .map((cells, i) => ({ cells, raw: raws[i] }))
    .filter(({ cells }) => !(cells.length === 1 && cells[0] === ''));
  if (!nonEmpty.length) return { header: [], rows: [], eol: detectEol(text) };

  const [headerRow, ...dataRows] = nonEmpty;
  const header = headerRow.cells;
  const objects = dataRows.map(({ cells, raw }) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? '';
    });
    Object.defineProperty(obj, SOURCE, { value: { text: raw, values: { ...obj } }, enumerable: false });
    return obj;
  });
  return { header, rows: objects, eol: detectEol(text) };
}

// A row's original source text and the values parsed out of it, hung off the
// row object under a non-enumerable symbol so it never reaches a caller (or a
// CSV column) by accident. Rows a caller builds from scratch simply don't
// have it and are encoded normally.
const SOURCE = Symbol('csvSource');

function needsQuoting(value) {
  return /[",\r\n]/.test(value);
}

function encodeField(value) {
  const str = value == null ? '' : String(value);
  if (!needsQuoting(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function encodeRow(header, obj) {
  // Untouched rows go back byte-for-byte. Without this, rewriting a file to
  // change one cell also drops the quotes off every hand-quoted field that
  // doesn't strictly need them — turning a one-cell edit into a whole-file
  // diff in the knowledge-base repo.
  const source = obj[SOURCE];
  if (source && header.every((key) => key in source.values && source.values[key] === obj[key])) {
    return source.text;
  }
  return header.map((key) => encodeField(obj[key])).join(',');
}

function readCsvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCsv(text);
}

// Whatever line ending the file on disk already uses, so a rewrite doesn't
// flip every line. Callers may pass one explicitly; otherwise it's read back
// off the file, and CRLF is the default only for a file that doesn't exist
// yet. This matters more since the knowledge-base repo's v2 restructure:
// every one of its files is LF, so defaulting to CRLF turned a one-cell edit
// into a whole-file diff.
function eolFor(filePath, eol) {
  if (eol) return eol;
  if (!fs.existsSync(filePath)) return '\r\n';
  return detectEol(fs.readFileSync(filePath, 'utf8'));
}

// Overwrites the whole file — used when existing rows change (e.g.
// inventory quantity updates).
function writeCsvFile(filePath, header, rows, eol) {
  const lineEnding = eolFor(filePath, eol);
  const lines = [header.join(','), ...rows.map((row) => encodeRow(header, row))];
  fs.writeFileSync(filePath, `${lines.join(lineEnding)}${lineEnding}`, 'utf8');
}

// Appends without re-reading/re-encoding existing rows — used for
// append-only logs (purchase_log.csv). Assumes the file already ends on a
// newline, which is how everything here writes it.
function appendCsvRows(filePath, header, newRows, eol) {
  const lineEnding = eolFor(filePath, eol);
  const lines = newRows.map((row) => encodeRow(header, row));
  fs.appendFileSync(filePath, `${lines.join(lineEnding)}${lineEnding}`, 'utf8');
}

// Finds the next sequential id for a prefix (e.g. "PUR", "SMK") by scanning
// existing "<prefix>-<digits>" ids in `rows[idField]` and incrementing the
// highest one found, preserving its zero-padding width. Starts at 1, padded
// to 4 digits, if none exist yet. Shared by purchasing.js (PUR-####) and
// smoking.js (SMK-####).
function nextSequentialId(rows, idField, prefix) {
  let maxNum = 0;
  let width = 4;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  rows.forEach((row) => {
    const match = re.exec(row[idField] || '');
    if (!match) return;
    const num = Number(match[1]);
    if (num > maxNum) {
      maxNum = num;
      width = match[1].length;
    }
  });
  return `${prefix}-${String(maxNum + 1).padStart(width, '0')}`;
}

export { parseCsv, readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId };
