// The strip of today's cadence pinned above the shared note board.
//
// The tests worth having here are the ones about the tick, because the tick is
// the part that writes. The panel has no field for an assignee and no field for
// a time, but the row it upserts holds all three columns — so the failure mode
// is a job ticked from the bubble quietly wiping the name someone assigned it
// to in Daily View, which nobody would notice until the wrong person didn't do
// it next week.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

let dir;
let today;
let repo;
let statusLog;

// A Tuesday, so Monday's rows are there to prove they are not picked up.
const TUESDAY = new Date('2026-09-08T09:00:00');
const WEEK = '2026-W37';

beforeAll(async () => {
  ({ dir } = createTestDb());
  // After createTestDb, which points KB_SQLITE_PATH at the temp database.
  repo = await import('../core/repo.js');
  statusLog = await import('./weeklyScheduleStatusLog.js');
  today = await import('./todayTasks.js');
});

afterAll(() => removeTestDb(dir));

beforeEach(() => {
  repo.select('task_completion').forEach((row) =>
    repo.remove('task_completion', { week_key: row.week_key, task_id: row.task_id }),
  );
  repo.select('scheduled_task').forEach((row) => repo.remove('scheduled_task', { task_id: row.task_id }));

  [
    { task_id: 'WS-01', day: 'Tuesday', time_of_day: '07:30:00', task: 'Vendor run', assigned_to: 'Adarsh' },
    { task_id: 'WS-02', day: 'Tuesday', time_of_day: '15:00:00', task: 'Brine pork', assigned_to: 'Sowmya' },
    { task_id: 'WS-03', day: 'Tuesday', time_of_day: 'after the delivery', task: 'Stock count' },
    { task_id: 'WS-04', day: 'Monday', time_of_day: '09:00:00', task: 'Order packaging' },
  ].forEach((row, i) => repo.insert('scheduled_task', { ...row, sort_order: i }));
});

describe('reading the strip', () => {
  it('returns only this weekday, in the order Daily View lists it', () => {
    const strip = today.getTodayTasks(TUESDAY);
    expect(strip.weekday).toBe('Tuesday');
    expect(strip.tasks.map((t) => t.id)).toEqual(['WS-01', 'WS-02', 'WS-03']);
  });

  it('gives the time in the form the kitchen reads, not the column format', () => {
    // "09:00:00" is what the table holds and "9:00 AM" is what Daily View
    // prints. The tick writes this value back, so getting it wrong here would
    // restamp the task in a format the page would then print verbatim.
    const strip = today.getTodayTasks(TUESDAY);
    expect(strip.tasks.map((t) => t.time)).toEqual(['7:30 AM', '3:00 PM', 'after the delivery']);
  });

  it('keeps ticked tasks in the list and counts both sides', () => {
    today.setTodayTaskDone({ taskId: 'WS-01', done: true, now: TUESDAY });
    const strip = today.getTodayTasks(TUESDAY);
    // Still three: the strip renders the open ones but the header says how
    // many are done, and a list that shrank away would end the day looking
    // like a day with nothing scheduled.
    expect(strip.tasks).toHaveLength(3);
    expect(strip).toMatchObject({ open: 2, done: 1 });
    expect(strip.tasks.find((t) => t.id === 'WS-01').done).toBe(true);
  });

  it("prefers this week's overrides over the cadence's defaults", () => {
    statusLog.setTaskStatus({
      weekKey: WEEK,
      taskId: 'WS-01',
      done: false,
      assignedTo: 'Sowmya',
      time: '8:15 AM',
    });
    const task = today.getTodayTasks(TUESDAY).tasks.find((t) => t.id === 'WS-01');
    expect(task).toMatchObject({ assignedTo: 'Sowmya', time: '8:15 AM' });
  });

  it('reads a fresh week as nothing ticked rather than as no tasks', () => {
    // Last week's completions must not carry over — that is the "every week
    // starts fresh" behaviour, and it comes from the week key alone.
    statusLog.setTaskStatus({ weekKey: '2026-W36', taskId: 'WS-01', done: true });
    expect(today.getTodayTasks(TUESDAY)).toMatchObject({ open: 3, done: 0 });
  });
});

describe('ticking from the panel', () => {
  it('writes the same completion row Daily View reads', () => {
    today.setTodayTaskDone({ taskId: 'WS-02', done: true, now: TUESDAY });
    expect(statusLog.getWeekStatus({ weekKey: WEEK }).weekState['WS-02']).toMatchObject({ done: true });
  });

  it('keeps the assignee and time it was given, having no field for either', () => {
    // The panel sends only `done`. If that were passed straight through, the
    // upsert would blank both other columns.
    statusLog.setTaskStatus({ weekKey: WEEK, taskId: 'WS-02', done: false, assignedTo: 'Naveen', time: '4:30 PM' });
    today.setTodayTaskDone({ taskId: 'WS-02', done: true, now: TUESDAY });
    expect(statusLog.getWeekStatus({ weekKey: WEEK }).weekState['WS-02']).toMatchObject({
      done: true,
      assignedTo: 'Naveen',
      time: '4:30 PM',
    });
  });

  it("falls back to the cadence's own assignee and time for an untouched task", () => {
    today.setTodayTaskDone({ taskId: 'WS-01', done: true, now: TUESDAY });
    expect(statusLog.getWeekStatus({ weekKey: WEEK }).weekState['WS-01']).toMatchObject({
      assignedTo: 'Adarsh',
      time: '7:30 AM',
    });
  });

  it('unticks as well, and hands back the whole strip', () => {
    today.setTodayTaskDone({ taskId: 'WS-01', done: true, now: TUESDAY });
    const strip = today.setTodayTaskDone({ taskId: 'WS-01', done: false, now: TUESDAY });
    expect(strip).toMatchObject({ open: 3, done: 0 });
  });

  it('refuses a task that is not in the schedule', () => {
    expect(() => today.setTodayTaskDone({ taskId: 'WS-99', done: true, now: TUESDAY })).toThrow(/no longer/);
  });

  it('refuses a missing id or a done that is not a boolean', () => {
    expect(() => today.setTodayTaskDone({ done: true, now: TUESDAY })).toThrow(/task id/);
    expect(() => today.setTodayTaskDone({ taskId: 'WS-01', now: TUESDAY })).toThrow(/true or false/);
  });
});

describe('reassigning from the panel', () => {
  it("writes this week's override and leaves the cadence alone", () => {
    const strip = today.reassignTodayTask({ taskId: 'WS-01', assignedTo: ' Sowmya ', now: TUESDAY });
    expect(strip.tasks.find((t) => t.id === 'WS-01').assignedTo).toBe('Sowmya');
    expect(statusLog.getWeekStatus({ weekKey: WEEK }).weekState['WS-01']).toMatchObject({ assignedTo: 'Sowmya' });
    expect(repo.select('scheduled_task', { task_id: 'WS-01' })[0].assigned_to).toBe('Adarsh');
  });

  it('keeps the tick and the time it already had', () => {
    statusLog.setTaskStatus({ weekKey: WEEK, taskId: 'WS-02', done: true, assignedTo: 'Sowmya', time: '4:30 PM' });
    today.reassignTodayTask({ taskId: 'WS-02', assignedTo: 'Naveen', now: TUESDAY });
    expect(statusLog.getWeekStatus({ weekKey: WEEK }).weekState['WS-02']).toMatchObject({
      done: true,
      assignedTo: 'Naveen',
      time: '4:30 PM',
    });
  });

  it('refuses a blank name or an unknown task', () => {
    expect(() => today.reassignTodayTask({ taskId: 'WS-01', assignedTo: '  ', now: TUESDAY })).toThrow(/name/);
    expect(() => today.reassignTodayTask({ taskId: 'WS-99', assignedTo: 'Naveen', now: TUESDAY })).toThrow(/no longer/);
  });
});
