// The Priority sort: a customer who asked for a time goes ahead, ordered by
// when the rider has to leave, and distance decides everything else.
import { describe, expect, it } from 'vitest';
import {
  formatClockMinutes,
  hasDeadline,
  leaveByMinutes,
  prioritiseOrders,
  type OrderTimePreference,
  type PackOrder,
} from './packing';

const order = (id: number, distanceKm: number | null = null): PackOrder => ({
  orderId: id,
  orderName: `S${id}`,
  customer: '',
  packBy: null,
  odooFulfilment: null,
  note: null,
  phone: '',
  address: '',
  addressName: '',
  distanceKm,
  distanceStatus: distanceKm == null ? 'no_address' : 'ok',
  itemCount: 1,
  items: [],
});

const ask = (over: Partial<OrderTimePreference>): OrderTimePreference => ({
  hasPreference: true,
  label: 'Deliver by',
  preferredTime: '',
  quote: 'by 1pm',
  confidence: 'high',
  kind: 'by',
  ...over,
});

const ids = (orders: PackOrder[]) => orders.map((o) => o.orderId);

describe('prioritiseOrders', () => {
  it('is plain farthest-first when nobody asked for a time', () => {
    expect(ids(prioritiseOrders([order(1, 2), order(2, null), order(3, 9)], {}))).toEqual([3, 1, 2]);
  });

  it('puts a timed ask ahead of a farther order that asked for nothing', () => {
    const orders = [order(1, 20), order(2, 1)];
    expect(ids(prioritiseOrders(orders, { 2: ask({ preferredTime: '13:00' }) }))).toEqual([2, 1]);
  });

  it('orders timed asks by when the rider must leave, not the time asked for', () => {
    // 13:00 at 15 km leaves at 12:00; 12:45 at 1 km leaves at 12:41.
    const orders = [order(1, 1), order(2, 15)];
    const prefs = { 1: ask({ preferredTime: '12:45' }), 2: ask({ preferredTime: '13:00' }) };
    expect(ids(prioritiseOrders(orders, prefs))).toEqual([2, 1]);
    expect(formatClockMinutes(leaveByMinutes(orders[1], prefs[2])!)).toBe('12:00 PM');
  });

  it('ASAP first, untimed asks after timed ones, farthest breaking ties', () => {
    const orders = [order(1, 3), order(2, 8), order(3, 2), order(4, 30), order(5, 5)];
    const prefs = {
      1: ask({ kind: 'around', preferredTime: '' }),
      2: ask({ kind: 'around', preferredTime: '' }),
      3: ask({ preferredTime: '14:00' }),
      5: ask({ kind: 'asap', preferredTime: '' }),
    };
    expect(ids(prioritiseOrders(orders, prefs))).toEqual([5, 3, 2, 1, 4]);
  });

  it('does not pull up "after 8pm" or a low-confidence read', () => {
    const orders = [order(1, 10), order(2, 1), order(3, 2)];
    const prefs = {
      2: ask({ kind: 'after', preferredTime: '20:00' }),
      3: ask({ confidence: 'low', preferredTime: '12:00' }),
    };
    expect(hasDeadline(prefs[2])).toBe(false);
    expect(hasDeadline(prefs[3])).toBe(false);
    expect(ids(prioritiseOrders(orders, prefs))).toEqual([1, 3, 2]);
  });

  it('ignores a read cached before kind existed', () => {
    const legacy = ask({ preferredTime: '12:00' });
    delete legacy.kind;
    expect(ids(prioritiseOrders([order(1, 5), order(2, 1)], { 2: legacy }))).toEqual([1, 2]);
  });
});
