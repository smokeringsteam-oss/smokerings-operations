// Which service the board opens on.
//
// Before this existed the board opened on the first slot that had orders in
// it, which on a Sunday evening meant Saturday Lunch — a service two days
// finished — and every packer's first action was to click three slots along.
//
// The clock is a parameter throughout, because a rule about "now" that can
// only be checked by waiting until Sunday evening is a rule nobody checks.
import { describe, expect, it } from 'vitest';
import { dayGroupForNow, slotForNow, suggestedGroupId, type PackGroup } from './packing';

// A local IST-ish clock: these functions read getDay()/getHours(), which are
// the browser's local time, and the browser in question is in the kitchen.
const at = (iso: string) => new Date(iso);

describe('slotForNow', () => {
  it('reads Saturday either side of the 4pm lunch/dinner line', () => {
    // 2026-09-05 is a Saturday. The cutoff is the server's own — before 16:00
    // an order is filed under Lunch, from 16:00 under Dinner — so the board
    // and the orders on it agree by construction.
    expect(slotForNow(at('2026-09-05T09:00:00'))).toBe('satLunch');
    expect(slotForNow(at('2026-09-05T15:59:00'))).toBe('satLunch');
    expect(slotForNow(at('2026-09-05T16:00:00'))).toBe('satEvening');
    expect(slotForNow(at('2026-09-05T21:30:00'))).toBe('satEvening');
  });

  it('reads Sunday the same way', () => {
    expect(slotForNow(at('2026-09-06T11:00:00'))).toBe('sunLunch');
    expect(slotForNow(at('2026-09-06T18:00:00'))).toBe('sunEvening');
  });

  it('points a weekday at the weekend it is prep for', () => {
    // Not "the nearest slot": on a Wednesday there is no service in progress
    // to be nearest to, and the first one coming is what anyone opening the
    // board is working towards. Late on Friday night included — the next
    // service is still Saturday lunch.
    expect(slotForNow(at('2026-09-02T14:00:00'))).toBe('satLunch');
    expect(slotForNow(at('2026-09-04T23:00:00'))).toBe('satLunch');
    expect(slotForNow(at('2026-09-07T08:00:00'))).toBe('satLunch');
  });
});

describe('dayGroupForNow', () => {
  const days = ['2026-09-04', '2026-09-07', '2026-09-09'];

  it('opens on today when today has a delivery', () => {
    expect(dayGroupForNow(days, at('2026-09-07T10:00:00'))).toBe('2026-09-07');
  });

  it('opens on the next delivery day otherwise', () => {
    expect(dayGroupForNow(days, at('2026-09-05T10:00:00'))).toBe('2026-09-07');
  });

  it('falls back to the last day once the week is done', () => {
    // Rather than the oldest day in range: a board opened after the final
    // drop should land on something with orders on it.
    expect(dayGroupForNow(days, at('2026-09-20T10:00:00'))).toBe('2026-09-09');
  });

  it('has no answer when the groups are not days', () => {
    expect(dayGroupForNow(['satLunch', 'sunEvening'], at('2026-09-05T10:00:00'))).toBeNull();
    expect(dayGroupForNow([], at('2026-09-05T10:00:00'))).toBeNull();
  });
});

const group = (id: string, orderCount = 0): PackGroup => ({
  id,
  label: id,
  sublabel: '',
  emoji: '',
  orders: Array.from({ length: orderCount }, (_, i) => ({ orderId: i }) as PackGroup['orders'][number]),
});

describe('suggestedGroupId', () => {
  const weekend = [group('satLunch', 3), group('satEvening'), group('sunLunch', 2), group('sunEvening', 1)];

  it('picks the service the clock is in, empty or not', () => {
    // Saturday Dinner having no orders is not a reason to open somewhere else
    // at 6pm on Saturday — "Saturday Dinner is empty" is the answer the
    // packer came to the board for.
    expect(suggestedGroupId(weekend, 'B2C', at('2026-09-05T18:00:00'))).toBe('satEvening');
    expect(suggestedGroupId(weekend, 'B2C', at('2026-09-06T12:00:00'))).toBe('sunLunch');
  });

  it('falls back to a group with orders when the range has no such slot', () => {
    // A range that only turned up Sunday cannot open on Saturday Lunch.
    const sundayOnly = [group('sunLunch'), group('sunEvening', 4)];
    expect(suggestedGroupId(sundayOnly, 'B2C', at('2026-09-02T10:00:00'))).toBe('sunEvening');
  });

  it('picks the delivery day on the B2B board', () => {
    const b2b = [group('2026-09-04', 1), group('2026-09-07', 2)];
    expect(suggestedGroupId(b2b, 'B2B', at('2026-09-07T09:00:00'))).toBe('2026-09-07');
  });

  it('is empty when there are no groups at all', () => {
    expect(suggestedGroupId([], 'B2C', at('2026-09-05T10:00:00'))).toBe('');
  });
});
