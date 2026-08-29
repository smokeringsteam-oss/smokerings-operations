// Daily View / "This Week's Tasks" per-task completion — a small, shared
// (knowledge-base CSV, not localStorage) log, same spirit as
// server/ops/b2c/weekendStatus.js, so the checklist is visible to whoever opens the
// dashboard next, not just the browser that clicked it.
//
// One row per (week_key, task_id). week_key is the ISO week (e.g. "2026-W33")
// computed by the frontend's getIsoWeekKey(). A task is only written here the
// first time someone touches it in a given week — untouched tasks fall back
// to the schedule's defaults (see getTaskDefaultState in recurringSchedule.ts).
// That's what gives every new week a fresh start automatically: there's
// nothing to reset, last week's rows just stay behind as a log and a new
// week's tasks get their own new rows the first time they're touched.
import { readCsvFile, writeCsvFile } from '../core/csvStore.js';
import { filePath } from '../core/knowledgeBase.js';
import fs from 'fs';

const HEADER = ['week_key', 'task_id', 'done', 'assigned_to', 'time', 'updated_at'];

function ensureFile() {
  const p = filePath('weeklyScheduleStatusLog');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `${HEADER.join(',')}\r\n`, 'utf8');
  }
  return p;
}

function loadRows() {
  const path = ensureFile();
  return { path, ...readCsvFile(path) };
}

// Returns every logged task state for one week, keyed by task_id — the shape
// DailyView's RecurringWeekState already expects.
function getWeekStatus({ weekKey }) {
  if (!weekKey) {
    const err = new Error('weekKey is required.');
    err.status = 400;
    throw err;
  }
  const { rows } = loadRows();
  const weekState = {};
  rows
    .filter((r) => r.week_key === weekKey)
    .forEach((r) => {
      weekState[r.task_id] = {
        done: r.done === 'true',
        assignedTo: r.assigned_to || '',
        time: r.time || '',
      };
    });
  return { weekState };
}

// Upserts one task's state for one week. A week/task pair that hasn't been
// saved before creates a new row — that's the "new week starts fresh, but
// still gets logged" behavior; nothing is ever deleted.
function setTaskStatus({ weekKey, taskId, done, assignedTo, time }) {
  if (!weekKey || !taskId) {
    const err = new Error('weekKey and taskId are required.');
    err.status = 400;
    throw err;
  }
  const { path, header, rows } = loadRows();
  const existing = rows.find((r) => r.week_key === weekKey && r.task_id === taskId);
  const updatedAt = new Date().toISOString();
  const record = {
    week_key: weekKey,
    task_id: taskId,
    done: done ? 'true' : 'false',
    assigned_to: assignedTo || '',
    time: time || '',
    updated_at: updatedAt,
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    rows.push(record);
  }

  writeCsvFile(path, header.length ? header : HEADER, rows);
  return { weekKey, taskId, done: record.done === 'true', assignedTo: record.assigned_to, time: record.time, updatedAt };
}

export { getWeekStatus, setTaskStatus };
