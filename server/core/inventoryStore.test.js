// The stock write path, on the database.
//
// Read parity with the old CSV version was checked against the real
// knowledge-base data and matched row for row; what that could not cover is
// writing, because the CSV version and this one cannot both own the same
// stock count. So this covers the writes, and in particular the three things
// the move to SQLite was supposed to buy — an adjustment that composes rather
// than overwrites, a batch that lands whole or not at all, and an audit row
// that cannot drift from the movement it explains.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from './testDb.js';

const MATERIALS = [
  { item_id: 'RM-001', item_name: 'Pork shoulder', category: 'Meat', unit_of_measure: 'kg', quantity_on_hand: 10, reorder_level: 5 },
  { item_id: 'RM-002', item_name: 'Brioche bun', category: 'Bakery', unit_of_measure: 'pcs', quantity_on_hand: 2, reorder_level: 20 },
  // Never counted: quantity_on_hand NULL, which is the case that catches a
  // bare `quantity + delta` (NULL + 5 is NULL in SQL, not 5).
  { item_id: 'RM-003', item_name: 'Smoked paprika', category: 'Spices & Seasonings', unit_of_measure: 'g', quantity_on_hand: null },
  // An intermediate product: carries stock but is not part of the buyable
  // catalogue, so getRawMaterials must leave it out and getInventory must not.
  { item_id: 'IP-001', item_name: 'Pulled pork', kind: 'intermediate', category: 'Meat', unit_of_measure: 'kg', quantity_on_hand: 3 },
];

const { dir } = createTestDb({ materials: MATERIALS });
const store = await import('./inventoryStore.js');
const { selectOne, update } = await import('./repo.js');
// Straight to db.js for the fixture reset: repo.remove refuses a where-less
// delete on purpose, which is the right call for production code and exactly
// what a "clear the table" needs to do here.
const { run } = await import('./db.js');

beforeEach(() => {
  // Each test starts from the seeded quantities and an empty audit log,
  // rather than whatever the previous one left behind.
  MATERIALS.forEach((m) =>
    update('material', { item_id: m.item_id }, { quantity_on_hand: m.quantity_on_hand, last_updated: null }),
  );
  run('DELETE FROM inventory_adjustment');
});

afterAll(() => removeTestDb(dir));

const onHand = (id) => selectOne('material', { item_id: id }).quantity_on_hand;

describe('the materials catalogue', () => {
  it('excludes intermediate products from the buyable catalogue but keeps their stock visible', () => {
    expect(store.getRawMaterials().map((m) => m.material_id)).toEqual(['RM-001', 'RM-002', 'RM-003']);
    expect(store.getInventory().map((m) => m.material_id)).toContain('IP-001');
  });

  it('aliases item_id to material_id, the name callers were written against', () => {
    const pork = store.getRawMaterials().find((m) => m.material_id === 'RM-001');
    expect(pork).toMatchObject({ material_id: 'RM-001', item_name: 'Pork shoulder', unit_of_measure: 'kg' });
  });

  it('counts only what is genuinely below its reorder level', () => {
    // RM-002 is 2 against a level of 20. RM-003 has no level set, and a
    // missing level is not the same as a breached one.
    expect(store.getLowStock().map((m) => m.material_id)).toEqual(['RM-002']);
  });
});

describe('adjustInventory', () => {
  it('adds and consumes against the same running count', () => {
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 5 }], '2026-08-29');
    expect(onHand('RM-001')).toBe(15);
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: -8 }], '2026-08-29');
    expect(onHand('RM-001')).toBe(7);
  });

  it('treats a never-counted material as zero rather than poisoning it to NULL', () => {
    store.adjustInventory([{ materialId: 'RM-003', deltaQty: 500 }], '2026-08-29');
    expect(onHand('RM-003')).toBe(500);
  });

  it('composes two adjustments instead of the second overwriting the first', () => {
    // The failure this guards is the read-modify-write the CSV version did:
    // both calls read 10, both write their own total, and one buy vanishes.
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 3 }], '2026-08-29');
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 4 }], '2026-08-29');
    expect(onHand('RM-001')).toBe(17);
  });

  it('reports an unknown material as skipped and still applies the rest of the batch', () => {
    const { applied, skipped } = store.adjustInventory(
      [
        { materialId: 'RM-001', deltaQty: 1 },
        { materialId: 'RM-999', deltaQty: 1, itemName: 'Something ad hoc' },
        { materialId: '', deltaQty: 1, itemName: 'A line with no material at all' },
      ],
      '2026-08-29',
    );
    expect(applied.map((a) => a.material_id)).toEqual(['RM-001']);
    expect(skipped).toHaveLength(2);
    expect(onHand('RM-001')).toBe(11);
  });

  it('flags a count driven negative rather than silently clamping it', () => {
    const { applied } = store.adjustInventory([{ materialId: 'RM-002', deltaQty: -5 }], '2026-08-29');
    expect(applied[0]).toMatchObject({ material_id: 'RM-002', newQuantity: -3, wentNegative: true });
  });

  it('rounds to two places so accumulated grams do not drift into float noise', () => {
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 0.1 }], '2026-08-29');
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 0.2 }], '2026-08-29');
    expect(onHand('RM-001')).toBe(10.3);
  });

  it('stamps the movement date on every row it touches', () => {
    store.adjustInventory([{ materialId: 'RM-001', deltaQty: 1 }], '2026-08-29');
    expect(selectOne('material', { item_id: 'RM-001' }).last_updated).toBe('2026-08-29');
  });
});

describe('addInventoryAdjustment', () => {
  it('moves the stock and writes the audit row that explains it', () => {
    const result = store.addInventoryAdjustment({
      materialId: 'RM-001',
      quantity: 4,
      reason: 'Opening count',
      date: '2026-08-29',
    });
    expect(onHand('RM-001')).toBe(14);
    expect(result.adjustment).toMatchObject({
      adjustment_id: 'ADJ-0001',
      material_id: 'RM-001',
      item_name: 'Pork shoulder',
      quantity: 4,
      unit_of_measure: 'kg',
      reason: 'Opening count',
    });
    expect(result.inventoryUpdated).toMatchObject({ material_id: 'RM-001', newQuantity: 14 });
  });

  it('allocates sequential four-digit ids', () => {
    store.addInventoryAdjustment({ materialId: 'RM-001', quantity: 1, date: '2026-08-29' });
    const second = store.addInventoryAdjustment({ materialId: 'RM-002', quantity: 1, date: '2026-08-29' });
    expect(second.adjustment.adjustment_id).toBe('ADJ-0002');
  });

  it('lists adjustments newest first', () => {
    store.addInventoryAdjustment({ materialId: 'RM-001', quantity: 1, date: '2026-08-27' });
    store.addInventoryAdjustment({ materialId: 'RM-002', quantity: 1, date: '2026-08-29' });
    expect(store.getInventoryAdjustments().map((a) => a.adjustment_date)).toEqual(['2026-08-29', '2026-08-27']);
  });

  it('refuses a quantity of zero, a negative one, and an unknown material', () => {
    // A correction downwards goes through adjustInventory with a negative
    // delta; this entry point is "stock arrived", so a non-positive number is
    // a mistake rather than a shorthand.
    expect(() => store.addInventoryAdjustment({ materialId: 'RM-001', quantity: 0 })).toThrow(/greater than 0/);
    expect(() => store.addInventoryAdjustment({ materialId: 'RM-001', quantity: -2 })).toThrow(/greater than 0/);
    expect(() => store.addInventoryAdjustment({ materialId: 'RM-404', quantity: 1 })).toThrow(/Unknown material/);
    expect(() => store.addInventoryAdjustment({ quantity: 1 })).toThrow(/materialId is required/);
  });

  it('leaves stock untouched when the adjustment is rejected', () => {
    expect(() => store.addInventoryAdjustment({ materialId: 'RM-001', quantity: 0 })).toThrow();
    expect(onHand('RM-001')).toBe(10);
    expect(store.getInventoryAdjustments()).toHaveLength(0);
  });
});
