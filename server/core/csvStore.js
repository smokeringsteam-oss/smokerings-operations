// Minimal RFC4180 CSV read/write for the knowledge-base data files (vendors,
// raw materials, inventory, purchases — see server/purchasing.js). No
// external CSV dependency; these files are small (dozens to low hundreds of
// rows) so whole-file read/rewrite is simple and plenty fast.
//
// Preserves the existing \r\n line endings the knowledge-base CSVs already
// use, so diffs against files edited by hand/Excel stay clean.
import fs from 'fs';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
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
      pushRow();
    } else {
      field += c;
    }
  }
  // Trailing field/row if the file doesn't end on a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!nonEmpty.length) return { header: [], rows: [] };

  const [header, ...dataRows] = nonEmpty;
  const objects = dataRows.map((cells) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? '';
    });
    return obj;
  });
  return { header, rows: objects };
}

function needsQuoting(value) {
  return /[",\r\n]/.test(value);
}

function encodeField(value) {
  const str = value == null ? '' : String(value);
  if (!needsQuoting(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function encodeRow(header, obj) {
  return header.map((key) => encodeField(obj[key])).join(',');
}

function readCsvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCsv(text);
}

// Overwrites the whole file — used when existing rows change (e.g.
// inventory quantity updates).
function writeCsvFile(filePath, header, rows) {
  const lines = [header.join(','), ...rows.map((row) => encodeRow(header, row))];
  fs.writeFileSync(filePath, `${lines.join('\r\n')}\r\n`, 'utf8');
}

// Appends without re-reading/re-encoding existing rows — used for
// append-only logs (purchases.csv).
function appendCsvRows(filePath, header, newRows) {
  const lines = newRows.map((row) => encodeRow(header, row));
  fs.appendFileSync(filePath, `${lines.join('\r\n')}\r\n`, 'utf8');
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
