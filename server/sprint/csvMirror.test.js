// Covers the knowledge-base CSV mirrors — Daily View's schedule and status
// log, and the smoking log: that an edit which reaches the table also reaches
// the file, that the file is the table (not an append trail of every edit ever
// made), and — the point of the whole design — that a CSV which can't be
// written still lets the save through.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb({
  materials: [
    { item_id: 'RM-051', item_name: 'Pork shoulder', category: 'Meat', quantity_on_hand: 20 },
    { item_id: 'RM-052', item_name: 'Pork ribs', category: 'Meat', quantity_on_hand: 20 },
  ],
});

// Points the mirror at a throwaway Data directory, the same way KB_SQLITE_PATH
// points the stores at a throwaway database — without this the suite would
// rewrite the real knowledge-base repo's CSVs.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mirror-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;

const { createTask, updateTask, deleteTask, moveTask } = await import('./recurringSchedule.js');
const { startBrining, completeRub, deleteSession, mirrorSessionsCsv } = await import('../ops/shared/smoking.js');
const { setTaskStatus } = await import('./weeklyScheduleStatusLog.js');
const { run } = await import('../core/db.js');

const schedulePath = path.join(dataDir, 'Tasks', 'schedule.csv');
const smokingPath = path.join(dataDir, 'Smoker', 'smoking_log.csv');
const statusPath = path.join(dataDir, 'Tasks', 'weekly_schedule_status_log.csv');

const lines = (file) => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);

beforeEach(() => {
  run('DELETE FROM task_completion');
  run('DELETE FROM scheduled_task');
  run('DELETE FROM smoking_session');
  fs.rmSync(path.join(dataDir, 'Tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(dataDir, 'Smoker'), { recursive: true, force: true });
});

afterAll(() => {
  removeTestDb(dir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('schedule.csv mirror', () => {
  it('writes the file on the first edit, creating Tasks/ if it has to', () => {
    const { taskId } = createTask({
      day: 'Monday',
      label: 'Review weekend sales',
      time: '9:00 AM',
      category: 'Review',
    });

    expect(lines(schedulePath)).toEqual([
      'task_id,day,time,task,assigned_to,category,related_vendor_id,related_recipe_id,related_sop,notes',
      `${taskId},Monday,9:00 AM,Review weekend sales,Adarsh,Review,,,,`,
    ]);
  });

  it('writes the time the way the sheet held it, not the way the column stores it', () => {
    // storeTime() normalises "2:00 PM" to 14:00:00 on the way in; a mirror
    // that echoed the column back would rewrite every row of a hand-kept file
    // into 24-hour time on the first save.
    createTask({ day: 'Thursday', label: 'Inventory check', time: '2:00 PM', assignedTo: 'Sowmya' });

    expect(lines(schedulePath)[1]).toContain(',2:00 PM,');
  });

  it('takes the shorthand a person types into the time field', () => {
    createTask({ day: 'Monday', label: 'Light the smoker', time: '9am' });

    expect(lines(schedulePath)[1]).toContain(',9:00 AM,');
  });

  it('leaves a time it cannot read alone rather than guessing at it', () => {
    // A bare hour included: "6" on this schedule is as likely to be the
    // evening as the morning, so it stays as typed.
    createTask({ day: 'Monday', label: 'Pull the pork', time: '6' });
    createTask({ day: 'Tuesday', label: 'Wrap up', time: 'after service' });

    const rows = lines(schedulePath).slice(1);
    expect(rows[0]).toContain(',6,');
    expect(rows[1]).toContain(',after service,');
  });

  it('quotes a task containing a comma so the file still parses', () => {
    createTask({ day: 'Sunday', label: 'Social posts - BTS (IG, FB, WhatsApp)' });

    expect(lines(schedulePath)[1]).toContain('"Social posts - BTS (IG, FB, WhatsApp)"');
  });

  it('is the table, not a log of edits — a rename replaces the row', () => {
    const { taskId } = createTask({ day: 'Tuesday', label: 'Reddit post' });
    updateTask({ taskId, label: 'Reddit automation post' });

    const rows = lines(schedulePath);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Reddit automation post');
    expect(rows[1]).not.toContain('Reddit post,');
  });

  it('drops a deleted task from the file', () => {
    const kept = createTask({ day: 'Friday', label: 'Order consolidation' }).taskId;
    const gone = createTask({ day: 'Friday', label: 'Retired task' }).taskId;
    deleteTask({ taskId: gone });

    const rows = lines(schedulePath);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(kept);
  });

  it('orders the file by weekday, then by the rank a drag left behind', () => {
    const monday = createTask({ day: 'Monday', label: 'Retro' }).taskId;
    const friday = createTask({ day: 'Friday', label: 'Make BBQ sauce' }).taskId;
    const second = createTask({ day: 'Friday', label: 'Place meat order' }).taskId;

    // Drag the second Friday task to the top of its day.
    moveTask({ taskId: second, day: 'Friday', index: 0 });

    expect(lines(schedulePath).slice(1).map((row) => row.split(',')[0])).toEqual([monday, second, friday]);
  });
});

describe('weekly_schedule_status_log.csv mirror', () => {
  // task_completion.task_id is a foreign key, so the task has to exist first.
  let taskId;
  beforeEach(() => {
    taskId = createTask({ day: 'Friday', label: 'Order consolidation', time: '10:00 AM' }).taskId;
  });

  it('logs a tick in the CSV era’s shape — `time`, and done as true/false', () => {
    setTaskStatus({ weekKey: '2026-W36', taskId, done: true, assignedTo: 'Adarsh', time: '10:00 AM' });

    const rows = lines(statusPath);
    expect(rows[0]).toBe('week_key,task_id,done,assigned_to,time,updated_at');
    // The timestamp is the only cell the test can't predict; the rest is the
    // whole row, in the order the CSV era wrote it.
    const [weekKey, id, done, assignedTo, time, updatedAt] = rows[1].split(',');
    expect([weekKey, id, done, assignedTo, time]).toEqual(['2026-W36', taskId, 'true', 'Adarsh', '10:00 AM']);
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  it('updates the row rather than appending a second one when a tick is undone', () => {
    setTaskStatus({ weekKey: '2026-W36', taskId, done: true });
    setTaskStatus({ weekKey: '2026-W36', taskId, done: false });

    const rows = lines(statusPath);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(',false,');
  });

  it('keeps last week’s rows when a new week starts', () => {
    setTaskStatus({ weekKey: '2026-W35', taskId, done: true });
    setTaskStatus({ weekKey: '2026-W36', taskId, done: false });

    expect(lines(statusPath)).toHaveLength(3);
  });
});

describe('smoking_log.csv mirror', () => {
  // The whole reason this mirror exists: before it, a session logged in the
  // app reached the database and the knowledge-base file kept whatever the
  // SQLite cutover had left in it — so the file quietly drifted a month behind
  // the smoker.
  const brine = (materialId = 'RM-051') =>
    startBrining({
      materialId,
      pitmaster: 'Adarsh',
      brineRecipe: '',
      brineStart: '2026-09-04T06:00',
      brineEnd: '2026-09-04T08:00',
      channel: 'B2C',
    }).session;

  it('writes a session out on the step that creates it, creating Smoker/ if it has to', () => {
    const session = brine();

    const rows = lines(smokingPath);
    expect(rows[0].split(',')).toHaveLength(37);
    expect(rows[0].split(',')[0]).toBe('session_id');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(session.session_id);
    expect(rows[1]).toContain('Pork shoulder');
  });

  it('follows the session through a later stage rather than freezing at creation', () => {
    const session = brine();
    completeRub({
      sessionId: session.session_id,
      rubRecipe: '',
      rubStart: '2026-09-04T08:10',
      rubEnd: '2026-09-04T08:30',
    });

    const rows = lines(smokingPath);
    // Still one row — the mirror is the table, not an append per stage.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('2026-09-04T08:30');
    expect(rows[1].endsWith(',ready_to_smoke,')).toBe(true);
  });

  it('drops a deleted session from the file', () => {
    const kept = brine('RM-051');
    const gone = brine('RM-052');
    deleteSession(gone.session_id);

    const rows = lines(smokingPath);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(kept.session_id);
    expect(rows[1]).not.toContain(gone.session_id);
  });

  it('writes oldest first, so the file reads as a log', () => {
    // readSessions() hands the screen newest-first; the file is the other way
    // round, the same as the weekly status log.
    const first = brine('RM-051');
    const second = brine('RM-052');

    expect(lines(smokingPath).slice(1).map((row) => row.split(',')[0])).toEqual([
      first.session_id,
      second.session_id,
    ]);
  });

  it('can be run by hand against a table nothing has touched since the cutover', () => {
    brine();
    fs.rmSync(path.join(dataDir, 'Smoker'), { recursive: true, force: true });

    // What `npm run csv:mirror` calls — no edit involved, just the table
    // written back out.
    expect(mirrorSessionsCsv().mirrored).toBe(true);
    expect(lines(smokingPath)).toHaveLength(2);
  });
});

describe('when the CSV cannot be written', () => {
  it('still saves to the database, and says why the file did not get it', () => {
    const { taskId } = createTask({ day: 'Monday', label: 'Review weekend sales' });
    const dataDirBefore = process.env.KNOWLEDGE_BASE_DATA_DIR;
    process.env.KNOWLEDGE_BASE_DATA_DIR = path.join(dataDir, 'no-such-checkout');

    try {
      const saved = setTaskStatus({ weekKey: '2026-W36', taskId, done: true });

      // The save itself went through — the tick is in the database and comes
      // back to the next person who opens the board.
      expect(saved.done).toBe(true);
      expect(saved.csv.mirrored).toBe(false);
      expect(saved.csv.reason).toMatch(/knowledge-base Data directory/);
    } finally {
      process.env.KNOWLEDGE_BASE_DATA_DIR = dataDirBefore;
    }
  });
});
