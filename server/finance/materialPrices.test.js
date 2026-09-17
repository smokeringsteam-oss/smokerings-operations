// The price sheet — what it asks for, what it pre-fills from the purchase
// log, and that a save actually moves a dish's cost.
//
// buildPriceSheet is pure and is tested on fixtures; saveMaterialPrice writes
// the catalogue and is tested against a throwaway database, read back through
// the same cost walk the report uses.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb({
  materials: [
    { item_id: 'RM-022', item_name: 'Amul cream', category: 'Dairy & Eggs' },
    { item_id: 'RM-024', item_name: 'Black pepper', category: 'Spices & Seasonings' },
  ],
});

const { buildPriceSheet, saveMaterialPrice, suggestPack } = await import('./materialPrices.js');
const { selectOne } = await import('../core/repo.js');

afterAll(() => removeTestDb(dir));

const material = (id, name, extra = {}) => ({
  item_id: id,
  item_name: name,
  item_type: 'raw_material',
  category: '',
  standard_cost_inr: '',
  cost_basis: '',
  ...extra,
});

const purchase = (id, materialId, extra = {}) => ({
  purchase_id: id,
  purchase_date: '2026-09-06',
  material_id: materialId,
  item_name: '',
  item_type: 'material',
  quantity_purchased: 1,
  unit_price: '',
  total_cost: '',
  weight_per_unit_kg: '',
  vendor_id: 'VEN-002',
  vendor_name: 'Instamart',
  notes: '',
  ...extra,
});

// Sour cream is 250 of cream in a 300 batch; a burger carries 30 of it.
const TABLES = {
  materials: [
    material('RM-022', 'Amul cream', { category: 'Dairy & Eggs' }),
    material('RM-024', 'Black pepper', { category: 'Spices & Seasonings' }),
    material('RM-036', 'Bun', { category: 'Bakery', standard_cost_inr: 25, cost_basis: 'per pcs' }),
    material('RM-038', 'Wood', { category: 'Fuel / Smoking' }),
    material('IP-001', 'Pulled chicken', { item_type: 'intermediate_product' }),
  ],
  menu: [{ menu_id: 'burger', item_name: 'Burger', price_inr: 299, is_active: 'yes' }],
  recipes: [{ recipe_id: 'SR-013', recipe_name: 'Sour cream', output_quantity: 300 }],
  recipeLines: [
    { parent_id: 'burger', parent_name: 'Burger', child_id: 'RM-036', child_name: 'Bun', base_quantity: 1 },
    { parent_id: 'burger', parent_name: 'Burger', child_id: 'SR-013', child_name: 'Sour cream', base_quantity: 30 },
    { parent_id: 'SR-013', parent_name: 'Sour cream', child_id: 'RM-022', child_name: 'Amul cream', base_quantity: 250 },
    { parent_id: 'SR-013', parent_name: 'Sour cream', child_id: 'RM-024', child_name: 'Black pepper', base_quantity: 2 },
  ],
  purchases: [
    purchase('PUR-0032', 'RM-022', { item_name: 'Amul cream', unit_price: 100, total_cost: 100 }),
    purchase('PUR-0010', '', {
      item_type: null,
      item_name: 'Amul Blend Diced Cheese 200 g',
      unit_price: 125,
      total_cost: 125,
    }),
    purchase('PUR-0002', '', { item_type: 'service', item_name: 'Odoo subscription', unit_price: 1345 }),
  ],
};

const rowOf = (sheet, id) => sheet.rows.find((row) => row.materialId === id);

describe('buildPriceSheet', () => {
  const sheet = buildPriceSheet(TABLES);

  it('lists raw materials only — a smoked product is not something anyone prices', () => {
    expect(sheet.rows.map((row) => row.materialId)).not.toContain('IP-001');
  });

  it('puts what blocks a dish first, then what is costed, then what no dish uses', () => {
    expect(sheet.rows.map((row) => row.materialId)).toEqual(['RM-022', 'RM-024', 'RM-036', 'RM-038']);
  });

  it('counts a material against every dish it reaches through a sub-recipe', () => {
    expect(rowOf(sheet, 'RM-024')).toMatchObject({ dishCount: 1, dishes: ['Burger'] });
  });

  it('takes the price from the purchase log and asks only for the pack size', () => {
    const cream = rowOf(sheet, 'RM-022');
    expect(cream.gap).toBe('no pack size on file');
    expect(cream.price).toMatchObject({ perUnit: 100, source: 'purchase', ref: 'PUR-0032' });
    expect(cream.purchases[0]).toMatchObject({ purchaseId: 'PUR-0032', vendor: 'Instamart', unitPrice: 100 });
  });

  it('shows what the recipes use of it, and of what', () => {
    expect(rowOf(sheet, 'RM-022').usage).toEqual([
      { parentId: 'SR-013', parentName: 'Sour cream', quantity: 250, per: 'batch', batchOutput: 300 },
    ]);
    expect(rowOf(sheet, 'RM-036').usage[0]).toMatchObject({ per: 'plate', quantity: 1 });
  });

  it('offers unlinked purchases with the pack in their wording, and leaves services out', () => {
    expect(sheet.unlinked.map((row) => row.purchaseId)).toEqual(['PUR-0010']);
    expect(sheet.unlinked[0].pack).toEqual({ packSize: 200, packUnit: 'g' });
  });

  it('counts what is left to do over the materials a dish uses', () => {
    expect(sheet.totals).toEqual({ used: 3, usedPriced: 1, missing: 2, needPackOnly: 1 });
  });
});

describe('suggestPack', () => {
  it('reads the counter wording a link leaves in the notes', () => {
    const bought = [purchase('PUR-0040', 'RM-058', { notes: 'Mapped to RM-058; logged at the counter as "Mozzarella 200 g".' })];
    expect(suggestPack(bought)).toMatchObject({ packSize: 200, packUnit: 'g', from: 'PUR-0040' });
  });

  it('turns a recorded piece weight into a pack', () => {
    expect(suggestPack([purchase('PUR-0041', 'RM-017', { weight_per_unit_kg: 0.4 })])).toMatchObject({
      packSize: 400,
      packUnit: 'g',
    });
  });

  it('has nothing to say about a plain "1 at ₹100"', () => {
    expect(suggestPack([purchase('PUR-0042', 'RM-022', { unit_price: 100 })])).toBeNull();
  });
});

describe('saveMaterialPrice', () => {
  it('writes the pack size in the spelling the cost walk reads', () => {
    saveMaterialPrice({ materialId: 'RM-022', packSize: 250, packUnit: 'ml' });
    expect(selectOne('material', { item_id: 'RM-022' }).cost_basis).toBe('per 250 ml');
  });

  it('saves a typed price as the standard cost, and the material then costs', () => {
    const sheet = saveMaterialPrice({ materialId: 'RM-024', priceInr: 60, packSize: 100, packUnit: 'g' });
    const pepper = rowOf(sheet, 'RM-024');
    expect(pepper.gap).toBeNull();
    expect(pepper.perBomUnit).toBeCloseTo(0.6);
    expect(selectOne('material', { item_id: 'RM-024' }).standard_cost_inr).toBe(60);
  });

  it('leaves the standard cost alone when only a pack size is sent', () => {
    saveMaterialPrice({ materialId: 'RM-024', packSize: 200, packUnit: 'g' });
    expect(selectOne('material', { item_id: 'RM-024' })).toMatchObject({ standard_cost_inr: 60, cost_basis: 'per 200 g' });
  });

  it('refuses a pack it cannot parse back, a zero price, and an unknown material', () => {
    expect(() => saveMaterialPrice({ materialId: 'RM-024', packSize: 1, packUnit: 'tub' })).toThrow(/Pack size/);
    expect(() => saveMaterialPrice({ materialId: 'RM-024', packSize: 0, packUnit: 'g' })).toThrow(/Pack size/);
    expect(() => saveMaterialPrice({ materialId: 'RM-024', priceInr: 0, packSize: 1, packUnit: 'kg' })).toThrow(/Price/);
    expect(() => saveMaterialPrice({ materialId: 'RM-999', packSize: 1, packUnit: 'kg' })).toThrow(/No raw material/);
  });
});
