// Every push alert that asks someone to do something also leaves a to-do on
// the shared note board — so it shows up in the bubble, under today in Daily
// View, and on the Overview, rather than living only in a notification shade
// that gets swiped clear.
//
// A to-do rather than a cadence task: the cadence is the week's standing jobs,
// and "reply to this customer" happens once. The note board is already where
// one-off jobs go, and its tick is already shared by every screen.
//
// One open to-do per thing. Each alert names its source ("whatsapp:42",
// "delivery:1187"); a second alert about the same source while its to-do is
// still open adds nothing, so a customer who sends five messages is one job,
// not five. Once it is ticked, the next alert starts a fresh one.
//
// Left unassigned on purpose — nothing in an alert says whose job it is. The
// Overview lists unassigned to-dos so somebody can pick it up.
import { all, run } from './db.js';
import { insert, select } from './repo.js';

const MAX_BODY = 2000;

function localDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Files one alert as a to-do, due today. Returns the new note id, or null when
 * an open to-do for the same source is already on the board.
 *
 * Never throws: it runs alongside a push, and a failed write here must not stop
 * the push from going out.
 */
function fileAlertTask({ source, body, now = new Date() } = {}) {
  try {
    const key = String(source || '').trim();
    const text = String(body || '').trim().slice(0, MAX_BODY);
    if (!key || !text) return null;
    const open = select('shared_note', { source: key, done: 0 });
    if (open.length) return null;
    const result = insert('shared_note', {
      author: 'Alert',
      body: text,
      due_date: localDateKey(now),
      source: key,
      created_at: now.toISOString(),
    });
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.error('[alert-task] could not file to-do —', err.message || err);
    return null;
  }
}

/**
 * Ticks the open to-do for a source, when the thing it was about has been
 * dealt with somewhere else (a reply sent from the WhatsApp inbox, say).
 * Returns how many were closed. Never throws, for the same reason as above.
 */
function closeAlertTask(source, by = 'Alert', now = new Date()) {
  try {
    const key = String(source || '').trim();
    if (!key) return 0;
    const result = run(
      'UPDATE shared_note SET done = 1, done_at = ?, done_by = ? WHERE source = ? AND done = 0',
      now.toISOString(),
      by,
      key,
    );
    return Number(result.changes || 0);
  } catch (err) {
    console.error('[alert-task] could not close to-do —', err.message || err);
    return 0;
  }
}

// The sources that still have an open to-do with the given prefix — used to
// close WhatsApp to-dos once the thread has been answered.
function openAlertSources(prefix) {
  return all('SELECT DISTINCT source FROM shared_note WHERE done = 0 AND source LIKE ?', `${prefix}%`).map(
    (row) => row.source,
  );
}

export { fileAlertTask, closeAlertTask, openAlertSources };
