import fs from 'fs';
import { requireFile } from './knowledgeBase.js';

// The Mon–Fri recurring cadence's source of truth is daily_view.csv (day,task,time,assigned_to)
// in the knowledge-base repo's Data folder — edit it there (Excel, Sheets, whatever) and Daily
// View picks it up next time it loads. Same KNOWLEDGE_BASE_DATA_DIR override as the other
// knowledge-base-backed files (purchasing, inventory, smoking sessions).
const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'task';

// Minimal CSV parser (handles quoted fields with embedded commas/quotes/newlines) —
// no external dependency needed for a file this small and this shape.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

// Reads + parses the CSV into the same RecurringDay[] shape the frontend already understands.
// Always includes Monday–Friday (even with zero tasks) so "Open — no mandatory tasks" still renders.
function getRecurringScheduleFromCsv() {
  const csvPath = requireFile('dailyView');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return WEEKDAY_ORDER.map((day) => ({ day, tasks: [] }));

  const [header, ...dataRows] = rows;
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const dayCol = col('day');
  const taskCol = col('task');
  const timeCol = col('time');
  const assigneeCol = col('assigned_to');

  // id is derived from day+task text (not row position) so it stays stable across CSV edits
  // that reorder or add/remove other rows — that's what keeps a week's "done" checkbox pinned
  // to the right task after someone edits the sheet mid-week.
  const byDay = new Map(WEEKDAY_ORDER.map((day) => [day, []]));
  dataRows.forEach((cells) => {
    const day = (cells[dayCol] || '').trim();
    const label = (cells[taskCol] || '').trim();
    if (!day || !label) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id: `${slugify(day)}-${slugify(label)}`,
      label,
      defaultTime: (cells[timeCol] || '').trim(),
      defaultAssignee: (cells[assigneeCol] || '').trim(),
    });
  });

  return Array.from(byDay.entries()).map(([day, tasks]) => ({ day, tasks }));
}

export { getRecurringScheduleFromCsv };
