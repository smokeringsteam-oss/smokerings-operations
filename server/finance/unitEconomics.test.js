// The volume half of Cost to Make — which sold lines become which dish.
//
// buildUnitEconomicsReport needs a live Odoo, so the part that can be tested
// honestly is soldByItem: the join between what Odoo sold and what the menu
// table knows about. Two things go quietly wrong there and neither shows up
// as an error — a wholesale kilo counted as a plate, and a renamed dish whose
// old and new Odoo products each keep half its sales.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// unitEconomics.js pulls in unitCost and itemSales, both of which reach the
// database at import time.
const { dir } = createTestDb();

const { soldByItem } = await import('./unitEconomics.js');

afterAll(() => removeTestDb(dir));

const line = (over = {}) => ({
  channel: 'B2C',
  itemId: 'pork-burger',
  name: 'Pulled Pork Burger',
  units: 4,
  revenue: 1796,
  orders: 3,
  series: [1, 3],
  ...over,
});

describe('soldByItem', () => {
  it('keeps only the weekend menu — a wholesale kilo is not a plate', () => {
    const { byItem } = soldByItem({
      items: [line(), line({ channel: 'B2B', itemId: 'pork-burger', units: 12, series: [12, 0] })],
    });
    // The B2B line is dropped rather than added: it billed kilos, and there is
    // no per-plate cost behind it.
    expect(byItem.get('pork-burger').units).toBe(4);
  });

  it('adds two Odoo products that match the same dish', () => {
    // The renamed-dish case. Whichever one won, the other half of the sales
    // would silently disappear from the cost.
    const { byItem } = soldByItem({
      items: [line(), line({ name: 'Pulled Pork Burger (old)', units: 2, revenue: 898, orders: 2, series: [2, 0] })],
    });
    const dish = byItem.get('pork-burger');
    expect(dish.units).toBe(6);
    expect(dish.revenue).toBe(2694);
    expect(dish.orders).toBe(5);
    expect(dish.series).toEqual([3, 3]);
  });

  it('reports a line the menu does not recognise rather than dropping it', () => {
    const { byItem, unmatched } = soldByItem({
      items: [line(), line({ itemId: null, name: 'Delivery credit', units: 1, revenue: -30 })],
    });
    expect(byItem.size).toBe(1);
    expect(unmatched).toEqual([{ name: 'Delivery credit', units: 1, revenue: -30 }]);
  });
});
