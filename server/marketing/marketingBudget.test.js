// The marketing spend ledger, and the two bits of arithmetic the ROI screen
// is built on top of it.
//
// Almost everything worth testing here is the pro-rating. A spend row covers
// a period and a question covers a different period, and the share of one
// that falls in the other is the number every "invested" column on that
// screen is made of. Get it wrong in one direction and a monthly budget
// counts in full against a single weekend, making a good weekend look like a
// disaster; wrong in the other and the row vanishes and the weekend looks
// free. Both are confident, wrong answers, which is the kind this screen
// exists to stop producing.
//
// The second describe block covers the ratios: what a return of null means
// as against a return of zero, and why unattributed revenue is never allowed
// to flatter a channel. Nothing here talks to Odoo or Google — every function
// tested is pure, or reads only the local table.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb();

const { listBudgets, addBudget, updateBudget, deleteBudget, shareInRange, dayCount } = await import('./marketingBudget.js');
const { derive, byNet } = await import('./marketingRoi.js');
const { run } = await import('../core/db.js');

beforeEach(() => {
  run('DELETE FROM marketing_budget');
});

afterAll(() => removeTestDb(dir));

const spend = (over) =>
  addBudget({
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    channel: 'Instagram',
    category: 'ads',
    amount: 3000,
    ...over,
  });

describe('dayCount', () => {
  it('counts a single-day period as one day, not zero', () => {
    // A stall fee or one day's boosted post has period_start ===
    // period_end. Zero here would divide by itself inside shareInRange.
    expect(dayCount('2026-09-05', '2026-09-05')).toBe(1);
  });

  it('counts both ends of a range', () => {
    expect(dayCount('2026-09-01', '2026-09-30')).toBe(30);
    expect(dayCount('2026-09-04', '2026-09-06')).toBe(3);
  });
});

describe('shareInRange', () => {
  const row = { period_start: '2026-09-01', period_end: '2026-09-30' };

  it('gives a row wholly inside the window all of itself', () => {
    expect(shareInRange(row, '2026-08-01', '2026-10-31')).toBe(1);
  });

  it('gives a window wholly inside the row its day share', () => {
    // Fri-Sun of a 30-day month: three thirtieths, not all of it and not
    // none of it.
    expect(shareInRange(row, '2026-09-04', '2026-09-06')).toBeCloseTo(3 / 30, 6);
  });

  it('counts only the overlapping days when the two partly overlap', () => {
    // The last five days of September, asked about from a window that starts
    // mid-month and runs into October.
    expect(shareInRange(row, '2026-09-26', '2026-10-10')).toBeCloseTo(5 / 30, 6);
  });

  it('is zero for a row that does not overlap at all', () => {
    expect(shareInRange(row, '2026-10-01', '2026-10-31')).toBe(0);
    expect(shareInRange(row, '2026-07-01', '2026-08-31')).toBe(0);
  });

  it('counts a period that touches the window by one day', () => {
    // The boundary case that an exclusive comparison gets wrong: the row's
    // last day is the window's first.
    expect(shareInRange(row, '2026-09-30', '2026-10-05')).toBeCloseTo(1 / 30, 6);
  });

  it('never exceeds all of itself', () => {
    const oneDay = { period_start: '2026-09-05', period_end: '2026-09-05' };
    expect(shareInRange(oneDay, '2026-09-01', '2026-09-30')).toBe(1);
  });
});

describe('listBudgets', () => {
  it('pro-rates a monthly budget down to the window asked about', () => {
    spend({ amount: 3000 }); // Rs 3,000 across 30 days = Rs 100/day
    const [row] = listBudgets({ fromDate: '2026-09-04', toDate: '2026-09-06' });

    expect(row.amount).toBe(3000); // what was actually paid
    expect(row.amountInRange).toBe(300); // what belongs to these three days
    expect(row.partial).toBe(true);
  });

  it('leaves a row that fits inside the window at its full amount', () => {
    spend({ periodStart: '2026-09-04', periodEnd: '2026-09-06', amount: 500 });
    const [row] = listBudgets({ fromDate: '2026-09-01', toDate: '2026-09-30' });

    expect(row.amountInRange).toBe(500);
    // Not marked partial, so the screen shows one figure rather than
    // "Rs 500 of Rs 500".
    expect(row.partial).toBe(false);
  });

  it('drops rows outside the window entirely', () => {
    spend({ periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    expect(listBudgets({ fromDate: '2026-09-01', toDate: '2026-09-30' })).toEqual([]);
  });

  it('returns every row at full amount when no window is given', () => {
    spend({ periodStart: '2026-07-01', periodEnd: '2026-07-31', amount: 1200 });
    const rows = listBudgets();
    expect(rows).toHaveLength(1);
    expect(rows[0].amountInRange).toBe(1200);
    expect(rows[0].share).toBe(1);
  });

  it('rounds a pro-rated share to the rupee so a column adds up to its total', () => {
    // Rs 1,000 over 30 days, asked about across 7 — 233.33 recurring.
    spend({ amount: 1000 });
    const [row] = listBudgets({ fromDate: '2026-09-01', toDate: '2026-09-07' });
    expect(row.amountInRange).toBe(233);
    expect(Number.isInteger(row.amountInRange)).toBe(true);
  });
});

describe('addBudget', () => {
  it('normalises an empty campaign to null so channel-only spend groups together', () => {
    // Empty string and null both mean "no campaign behind this spend", and
    // only one of them groups correctly.
    const row = spend({ campaign: '   ' });
    expect(row.campaign).toBe('');
    expect(listBudgets()[0].campaign).toBe('');
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => spend({ periodStart: '2026-09-30', periodEnd: '2026-09-01' })).toThrow(/cannot end before/i);
  });

  it('refuses a category that is not one of ours', () => {
    // A typo'd category would otherwise open its own bucket in the spend
    // breakdown and look like a real one.
    expect(() => spend({ category: 'adverts' })).toThrow(/not a spend category/i);
  });

  it('refuses a negative amount', () => {
    expect(() => spend({ amount: -500 })).toThrow(/cannot be negative/i);
  });

  it('accepts zero, which is a real answer', () => {
    // An organic channel that cost nothing still deserves a row: it is how
    // "generated revenue for free" gets onto the screen at all.
    expect(spend({ amount: 0, channel: 'Reddit', category: 'other' }).amount).toBe(0);
  });

  it('requires a channel, because it is the join key onto revenue', () => {
    expect(() => spend({ channel: '' })).toThrow(/channel is required/i);
  });

  it('refuses a date that is not a date', () => {
    expect(() => spend({ periodStart: 'September' })).toThrow(/must be a date/i);
  });
});

describe('updateBudget', () => {
  it('validates a one-field patch against the row as it will be', () => {
    // Moving only period_end has to be checked against the existing
    // period_start, or a backwards period gets past the store and is caught
    // by the CHECK instead — with a message naming neither field.
    const row = spend();
    expect(() => updateBudget({ id: row.id, periodEnd: '2026-08-01' })).toThrow(/cannot end before/i);
  });

  it('leaves untouched fields alone', () => {
    const row = spend({ campaign: 'Ganesh Weekend', vendor: 'Meta', notes: 'boosted reel' });
    const updated = updateBudget({ id: row.id, amount: 4500 });

    expect(updated.amount).toBe(4500);
    expect(updated.campaign).toBe('Ganesh Weekend');
    expect(updated.vendor).toBe('Meta');
    expect(updated.notes).toBe('boosted reel');
  });

  it('can clear a campaign by passing an empty one', () => {
    const row = spend({ campaign: 'Ganesh Weekend' });
    expect(updateBudget({ id: row.id, campaign: '' }).campaign).toBe('');
  });

  it('says so when there is no such row', () => {
    expect(() => updateBudget({ id: 'MKB-9999', amount: 1 })).toThrow(/No spend row/);
  });
});

describe('deleteBudget', () => {
  it('removes the row', () => {
    const row = spend();
    deleteBudget(row.id);
    expect(listBudgets()).toEqual([]);
  });

  it('refuses an id that is not there rather than reporting a silent success', () => {
    expect(() => deleteBudget('MKB-9999')).toThrow();
  });
});

describe('derive', () => {
  it('reports a return of null, not zero, when nothing was invested', () => {
    // The distinction the sort depends on: a channel that generated revenue
    // for free is not the same as one that burned money for nothing, and a 0
    // would sort them together at the bottom.
    const free = derive({ invested: 0, generated: 5000, orders: 10, sessions: 0 });
    expect(free.roi).toBeNull();
    expect(free.net).toBe(5000);

    const wasted = derive({ invested: 5000, generated: 0, orders: 0, sessions: 0 });
    expect(wasted.roi).toBe(0);
    expect(wasted.net).toBe(-5000);
  });

  it('computes the return as a multiple of spend', () => {
    expect(derive({ invested: 2000, generated: 7000, orders: 20, sessions: 0 }).roi).toBe(3.5);
  });

  it('keeps two decimals on a ratio, because 3.47x is not 3.4x', () => {
    expect(derive({ invested: 3000, generated: 10400, orders: 1, sessions: 0 }).roi).toBe(3.47);
  });

  it('gives cost per order and order value only where there are orders', () => {
    const row = derive({ invested: 1000, generated: 4000, orders: 8, sessions: 0 });
    expect(row.cac).toBe(125);
    expect(row.aov).toBe(500);

    const none = derive({ invested: 1000, generated: 0, orders: 0, sessions: 0 });
    expect(none.cac).toBeNull();
    expect(none.aov).toBeNull();
  });

  it('leaves conversion rate null where there is no traffic to convert', () => {
    // A WhatsApp order has no session behind it. A 0% there would read as a
    // failure rather than as a question that does not apply to the channel.
    expect(derive({ invested: 0, generated: 900, orders: 3, sessions: 0 }).conversionRate).toBeNull();
    expect(derive({ invested: 0, generated: 900, orders: 3, sessions: 60 }).conversionRate).toBe(5);
  });
});

describe('byNet', () => {
  it('ranks by rupees generated over spend, not by the multiple', () => {
    // A 4x on Rs 300 and a 3x on Rs 8,000 — it is the second one paying the
    // rent, and it belongs at the top of a table headed "what worked".
    const small = derive({ invested: 300, generated: 1200, orders: 3, sessions: 0 });
    const big = derive({ invested: 8000, generated: 24000, orders: 60, sessions: 0 });

    expect(small.roi).toBeGreaterThan(big.roi);
    expect([small, big].sort(byNet)[0]).toBe(big);
  });
});
