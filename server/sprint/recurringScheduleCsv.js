import fs from 'fs';
import { requireFile } from '../core/knowledgeBase.js';

// The weekly recurring cadence's source of truth is schedule.csv
// (task_id,day,time,task,assigned_to,category,related_vendor_id,related_recipe_id,
// related_sop,notes) in the knowledge-base repo's Data folder — edit it there
// (Excel, Sheets, whatever) and Daily View picks it up next time it loads.
// Same KNOWLEDGE_BASE_DATA_DIR override as the other knowledge-base-backed
// files (purchasing, inventory, smoking sessions). It has been renamed twice
// under this module — daily_view.csv -> weekly_schedule.csv (2026-08-14),
// then -> schedule.csv in the v2 restructure — with the columns unchanged
// throughout.
const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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
// Always includes all seven days (even with zero tasks) so "Open — no mandatory tasks" still renders.
function getRecurringScheduleFromCsv() {
  const csvPath = requireFile('weeklySchedule');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return WEEKDAY_ORDER.map((day) => ({ day, tasks: [] }));

  const [header, ...dataRows] = rows;
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col('task_id');
  const dayCol = col('day');
  const taskCol = col('task');
  const timeCol = col('time');
  const assigneeCol = col('assigned_to');

  // id comes straight from schedule.csv's task_id (WS-xx) primary key — stable
  // across CSV edits (reordered/renamed/reworded rows) since it doesn't depend on the
  // task's day or label text. That's what keeps a week's "done" status pinned to the
  // right task after someone edits the sheet mid-week.
  const byDay = new Map(WEEKDAY_ORDER.map((day) => [day, []]));
  dataRows.forEach((cells) => {
    const day = (cells[dayCol] || '').trim();
    const label = (cells[taskCol] || '').trim();
    const id = (cells[idCol] || '').trim();
    if (!day || !label || !id) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id,
      label,
      defaultTime: (cells[timeCol] || '').trim(),
      defaultAssignee: (cells[assigneeCol] || '').trim(),
    });
  });

  return Array.from(byDay.entries()).map(([day, tasks]) => ({ day, tasks }));
}

export { getRecurringScheduleFromCsv };
