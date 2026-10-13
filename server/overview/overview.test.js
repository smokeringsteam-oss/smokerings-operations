// The Overview's own arithmetic: the period it reads, the meat rollup, the
// source grouping and the per-person task split. The sections it composes
// (Sales by Item, the ledger, GA) are tested where they live.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

let dir;
let repo;
let overview;

beforeAll(async () => {
  ({ dir } = createTestDb());
  repo = await import('../core/repo.js');
  overview = await import('./overview.js');
});

afterAll(() => removeTestDb(dir));

describe('periodFor', () => {
  it('reads a week Monday to Sunday, with the week before for comparison', () => {
    const period = overview.periodFor({ view: 'week', date: '2026-10-04' }); // a Sunday
    expect(period).toMatchObject({ from: '2026-09-28', to: '2026-10-04', prevFrom: '2026-09-21', prevTo: '2026-09-27' });
  });

  it('reads a calendar month, with the month before for comparison', () => {
    const period = overview.periodFor({ view: 'month', date: '2026-03-15' });
    expect(period).toMatchObject({ from: '2026-03-01', to: '2026-03-31', prevFrom: '2026-02-01', prevTo: '2026-02-28' });
  });

  it('refuses a view or a day that is not one', () => {
    expect(() => overview.periodFor({ view: 'year' })).toThrow(/week or month/);
    expect(() => overview.periodFor({ view: 'week', date: '2026-02-30' })).toThrow(/real day/);
  });
});

describe('rollUpMeat', () => {
  const meatByItem = {
    'chicken-burger': [{ category: 'chicken', label: 'Shredded Chicken' }],
    combo: [
      { category: 'pulledPork', label: 'Pulled Pork' },
      { category: 'ribs', label: 'Pork Ribs' },
      { category: 'chicken', label: 'Shredded Chicken' },
    ],
  };

  it('counts portions per animal from the recipe, a two-meat dish once under each animal', () => {
    const { meats } = overview.rollUpMeat(
      [
        { itemId: 'chicken-burger', name: 'Chicken Burger', channel: 'B2C', units: 5, unitLabel: '' },
        { itemId: 'combo', name: 'Combo', channel: 'B2C', units: 2, unitLabel: '' },
      ],
      meatByItem,
    );
    const chicken = meats.find((m) => m.animal === 'Chicken');
    const pork = meats.find((m) => m.animal === 'Pork');
    expect(chicken.portions).toBe(7);
    // Pulled pork and ribs are both pork, but the combo is one dish.
    expect(pork.portions).toBe(2);
    expect(pork.cuts.map((c) => [c.cut, c.portions])).toEqual([
      ['Pulled Pork', 2],
      ['Pork Ribs', 2],
    ]);
  });

  it('keeps wholesale in its billed unit and classifies it by name when no recipe knows it', () => {
    const { meats, meatlessItems } = overview.rollUpMeat(
      [
        { itemId: null, name: 'Smoked Pork Belly (Bulk 1kg)', channel: 'B2B', units: 1.7, unitLabel: 'kg' },
        { itemId: null, name: 'Packaging (25 packs)', channel: 'B2B', units: 25, unitLabel: '' },
      ],
      meatByItem,
    );
    expect(meats).toHaveLength(1);
    expect(meats[0]).toMatchObject({ animal: 'Pork', portions: 0, wholesale: { kg: 1.7 } });
    expect(meats[0].cuts[0]).toMatchObject({ cut: 'Pork Belly', wholesale: { kg: 1.7 } });
    expect(meatlessItems).toBe(1);
  });
});

describe('groupSources', () => {
  it('folds aliases of one channel together but keeps direct and Google apart', () => {
    const rows = overview.groupSources([
      { source: '(direct)', sessions: 40 },
      { source: 'google', sessions: 13 },
      { source: 'ig', sessions: 9 },
      { source: 'l.instagram.com', sessions: 1 },
      { source: '(not set)', sessions: 5 },
    ]);
    expect(rows.map((r) => [r.label, r.sessions])).toEqual([
      ['Direct (typed or bookmarked)', 40],
      ['Google', 13],
      ['Instagram', 10],
      ['Unknown', 5],
    ]);
  });
});

describe('buildTasks', () => {
  const TUESDAY = new Date('2026-09-08T09:00:00');

  beforeEach(() => {
    repo.select('task_completion').forEach((row) =>
      repo.remove('task_completion', { week_key: row.week_key, task_id: row.task_id }),
    );
    repo.select('scheduled_task').forEach((row) => repo.remove('scheduled_task', { task_id: row.task_id }));
    [
      { task_id: 'WS-01', day: 'Tuesday', time_of_day: '07:30:00', task: 'Vendor run', assigned_to: 'Adarsh' },
      { task_id: 'WS-02', day: 'Tuesday', time_of_day: '15:00:00', task: 'Brine pork', assigned_to: 'Sowmya' },
      { task_id: 'WS-03', day: 'Monday', time_of_day: '09:00:00', task: 'Order packaging', assigned_to: 'adarsh' },
    ].forEach((row, i) => repo.insert('scheduled_task', { ...row, sort_order: i }));
  });

  it("splits today's cadence and the week's tally per person, names matched without case", () => {
    const { weekday, people } = overview.buildTasks(TUESDAY);
    expect(weekday).toBe('Tuesday');
    const [adarsh, sowmya] = people;
    expect(adarsh.today.map((t) => t.id)).toEqual(['WS-01']);
    expect(adarsh.week).toEqual({ done: 0, total: 2 });
    expect(sowmya.today.map((t) => t.id)).toEqual(['WS-02']);
  });

  it('follows a handover made in Daily View this week', () => {
    repo.insert('task_completion', { week_key: '2026-W37', task_id: 'WS-01', done: 1, assigned_to: 'Sowmya' });
    const [adarsh, sowmya] = overview.buildTasks(TUESDAY).people;
    expect(adarsh.today).toEqual([]);
    expect(sowmya.today.map((t) => [t.id, t.done])).toEqual([
      ['WS-01', true],
      ['WS-02', false],
    ]);
    expect(sowmya.todayDone).toBe(1);
  });
});
