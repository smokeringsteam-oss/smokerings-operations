// The cost walk — the arithmetic behind "what does a burger cost us".
//
// buildCostBook reads the live catalogue and buildUnitEconomicsReport needs a
// live Odoo; neither is something a test can stand up honestly. costMenuItems
// takes its five tables as arguments for exactly that reason, so everything
// that can quietly go wrong is testable here:
//
//   * the yield gross-up, which is the single largest number in the report
//     and the easiest to leave out — costing 110 g of pulled pork as 110 g of
//     raw shoulder understates every meat dish by more than half;
//   * the batch division, where a 30 g portion of a 900 g sauce has to become
//     a thirtieth of it and not the whole thing;
//   * the gap accounting, which is the only thing standing between a partial
//     cost and a confident-looking wrong one.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// unitCost.js pulls in kbViews, which reaches the database at import time.
const { dir } = createTestDb();

const { costMenuItems, priceMaterials } = await import('./unitCost.js');

afterAll(() => removeTestDb(dir));

// Fixtures in the shape kbViews hands back: flat, CSV-named, '' for a blank.
const material = (id, name, extra = {}) => ({
  item_id: id,
  item_name: name,
  category: '',
  standard_cost_inr: '',
  cost_basis: '',
  ...extra,
});

const menuItem = (id, name, extra = {}) => ({
  menu_id: id,
  item_name: name,
  category: '',
  price_inr: '',
  is_active: 'yes',
  ...extra,
});

const bom = (parent, child, quantity, extra = {}) => ({
  line_id: `${parent}~${child}`,
  parent_id: parent,
  parent_name: parent,
  child_id: child,
  child_name: child,
  quantity,
  base_quantity: quantity,
  is_to_taste: 'no',
  status: 'ok',
  notes: '',
  ...extra,
});

const purchase = (materialId, quantity, unitPrice, date = '2026-09-01') => ({
  purchase_id: `PUR-${materialId}-${date}`,
  purchase_date: date,
  material_id: materialId,
  quantity_purchased: quantity,
  unit_price: unitPrice,
  total_cost: quantity * unitPrice,
});

// RM-051 pork shoulder and RM-048 chicken legs are the two ids meatConfig.js
// names as the cuts behind IP-003 and IP-001. The test leans on that on
// purpose: the loss percentages under a cost are the same ones the Weekend
// Prep Planner buys against, and a test that invented its own would stop
// noticing if the two ever came apart.
const PORK = 'RM-051';
const CHICKEN_LEGS = 'RM-048';

describe('priceMaterials', () => {
  it('prices off the newest purchase, ahead of the standard cost', () => {
    const costs = priceMaterials({
      materials: [material(PORK, 'Pork shoulder', { standard_cost_inr: 520, cost_basis: 'per kg' })],
      // readPurchases hands back newest first; the first line seen wins.
      purchases: [purchase(PORK, 2, 610, '2026-09-05'), purchase(PORK, 3, 520, '2026-08-10')],
    });
    const pork = costs.get(PORK);
    expect(pork.price.source).toBe('purchase');
    expect(pork.price.asOf).toBe('2026-09-05');
    // 610 a kilo is 0.61 a gram, which is the unit the bill of materials counts in.
    expect(pork.perBomUnit).toBeCloseTo(0.61, 6);
  });

  it('falls back to the standard cost when nothing has been bought', () => {
    const costs = priceMaterials({
      materials: [material('RM-036', 'Bun', { standard_cost_inr: 25, cost_basis: 'per pcs' })],
      purchases: [],
    });
    expect(costs.get('RM-036').price.source).toBe('standard');
    expect(costs.get('RM-036').perBomUnit).toBe(25);
  });

  it('reads a price out of a line that only carries a total', () => {
    const costs = priceMaterials({
      materials: [material(PORK, 'Pork shoulder', { cost_basis: 'per kg' })],
      purchases: [{ purchase_id: 'PUR-1', purchase_date: '2026-09-01', material_id: PORK, quantity_purchased: 4, unit_price: '', total_cost: 2000 }],
    });
    expect(costs.get(PORK).perBomUnit).toBeCloseTo(0.5, 6);
  });

  // The two halves fail independently and are closed by different actions, so
  // they have to be reported apart rather than as one "not priced".
  it('keeps a missing price and a missing pack size as separate gaps', () => {
    const costs = priceMaterials({
      materials: [
        material('RM-022', 'Amul cream'),
        material('RM-034', 'Apple cider vinegar'),
        material('RM-090', 'Something with a basis but no price', { cost_basis: 'per kg' }),
      ],
      // A price, but nothing says what one of them buys.
      purchases: [purchase('RM-034', 1, 181)],
    });
    expect(costs.get('RM-034').gap).toBe('no pack size on file');
    expect(costs.get('RM-090').gap).toBe('no price on file');
    expect(costs.get('RM-022').gap).toBe('no price or pack size on file');
    expect(costs.get('RM-034').perBomUnit).toBeNull();
  });
});

describe('costMenuItems — the yield gross-up', () => {
  const book = () =>
    costMenuItems({
      materials: [material(PORK, 'Pork shoulder', { category: 'Meat', cost_basis: 'per kg' })],
      menu: [menuItem('pork-burger', 'Pulled Pork Burger', { price_inr: 449 })],
      recipes: [{ recipe_id: 'IP-003', recipe_name: 'Pulled pork', kind: 'Smoked', source_material_id: PORK, output_quantity: '', yield_pct: '' }],
      recipeLines: [bom('pork-burger', 'IP-003', 110)],
      purchases: [purchase(PORK, 2.37, 520)],
    });

  it('buys the raw weight behind the portion, not the portion', () => {
    const dish = book().items[0];
    // meatConfig puts pulled pork at 40% loss, so 110 g on the plate is 183 g
    // in the smoker: 110 / 0.60. At 520 a kilo that is 95.33.
    const meat = dish.leaves.find((leaf) => leaf.materialId === PORK);
    expect(meat.quantity).toBeCloseTo(183.33, 0);
    expect(meat.unit).toBe('g raw');
    expect(dish.costInr).toBeCloseTo(95.33, 1);
  });

  it('is not the same as costing the finished weight', () => {
    // The bug this guards against: 110 g at 0.52 a gram is 57.20, and every
    // meat dish would be understated by the yield.
    expect(book().items[0].costInr).not.toBeCloseTo(57.2, 1);
  });
});

describe('costMenuItems — sub-recipes', () => {
  const sauceBook = (extra = {}) =>
    costMenuItems({
      materials: [
        material('RM-002', 'Tomato paste', { standard_cost_inr: 300, cost_basis: 'per kg' }),
        material('RM-029', 'Brown sugar', { standard_cost_inr: 60, cost_basis: 'per kg' }),
        material('RM-025', 'Salt'),
      ],
      menu: [menuItem('ribs', 'Ribs', { price_inr: 449 })],
      recipes: [{ recipe_id: 'SR-015', recipe_name: 'BBQ sauce', kind: 'Sauce', output_quantity: 900, source_material_id: '' }],
      recipeLines: [
        bom('ribs', 'SR-015', 30),
        bom('SR-015', 'RM-002', 200),
        bom('SR-015', 'RM-029', 150),
        ...(extra.lines || []),
      ],
      purchases: [],
      ...extra.overrides,
    });

  it('takes a portion as its fraction of the batch', () => {
    const dish = sauceBook().items[0];
    // 30 of a 900 batch is a thirtieth. 200 g of paste becomes 6.667 g.
    const paste = dish.leaves.find((leaf) => leaf.materialId === 'RM-002');
    expect(paste.quantity).toBeCloseTo(6.6667, 3);
    // 6.667 g at 0.30 + 5 g at 0.06 = 2.30.
    expect(dish.costInr).toBeCloseTo(2.3, 2);
  });

  it('names the sauce an ingredient came from', () => {
    expect(sauceBook().items[0].leaves.every((leaf) => leaf.via === 'BBQ sauce')).toBe(true);
  });

  // The reason the walk goes all the way down to leaves. A sauce costed as
  // one line would contribute a confident partial number and count as costed;
  // as leaves it contributes the same rupees and admits what is missing.
  it('counts a half-priced sauce as half priced', () => {
    const dish = sauceBook({ lines: [bom('SR-015', 'RM-025', 18)] }).items[0];
    expect(dish.leavesPriced).toBe(2);
    expect(dish.leavesTotal).toBe(3);
    expect(dish.coveragePct).toBeCloseTo(66.7, 1);
    // The known rupees are still counted — dropping them would understate
    // further than the data requires.
    expect(dish.costInr).toBeCloseTo(2.3, 2);
    expect(dish.missing.map((entry) => entry.name)).toEqual(['Salt']);
  });

  it('cannot divide a batch with no stated output, and says so', () => {
    const dish = costMenuItems({
      materials: [material('RM-002', 'Tomato paste', { standard_cost_inr: 300, cost_basis: 'per kg' })],
      menu: [menuItem('ribs', 'Ribs')],
      recipes: [{ recipe_id: 'SR-015', recipe_name: 'BBQ sauce', kind: 'Sauce', output_quantity: '' }],
      recipeLines: [bom('ribs', 'SR-015', 30), bom('SR-015', 'RM-002', 200)],
      purchases: [],
    }).items[0];
    expect(dish.costInr).toBe(0);
    expect(dish.missing[0].gap).toBe('no batch output quantity on file');
  });

  it('does not hang on a recipe that contains itself', () => {
    const dish = costMenuItems({
      materials: [],
      menu: [menuItem('dish', 'Dish')],
      recipes: [
        { recipe_id: 'SR-A', recipe_name: 'A', output_quantity: 100 },
        { recipe_id: 'SR-B', recipe_name: 'B', output_quantity: 100 },
      ],
      recipeLines: [bom('dish', 'SR-A', 10), bom('SR-A', 'SR-B', 10), bom('SR-B', 'SR-A', 10)],
      purchases: [],
    }).items[0];
    expect(dish.missing.some((entry) => entry.gap === 'recipe contains itself')).toBe(true);
  });
});

describe('costMenuItems — what counts as a gap', () => {
  const book = () =>
    costMenuItems({
      materials: [
        material('RM-036', 'Bun', { category: 'Bakery', standard_cost_inr: 25, cost_basis: 'per pcs' }),
        material('RM-025', 'Salt'),
        material('RM-044', 'Mega cover', { category: 'Packaging & Supplies' }),
      ],
      menu: [menuItem('burger', 'Burger', { price_inr: 299 }), menuItem('taco', 'Taco', { price_inr: 299 })],
      recipes: [],
      recipeLines: [
        bom('burger', 'RM-036', 1),
        bom('burger', 'RM-025', 2, { is_to_taste: 'yes' }),
        bom('burger', 'RM-044', 1),
        bom('taco', 'RM-044', 1),
        // The rub-and-brine shape: a real ingredient with no quantity on file.
        bom('taco', 'RM-025', '', { quantity: '', base_quantity: '', status: 'needs_confirmation' }),
      ],
      purchases: [],
    });

  it('leaves a to-taste pinch out of both halves of the coverage figure', () => {
    const burger = book().items[0];
    expect(burger.leaves.some((leaf) => leaf.materialId === 'RM-025')).toBe(false);
    expect(burger.leavesTotal).toBe(2);
    expect(burger.coveragePct).toBe(50);
  });

  it('reports an ingredient with no quantity rather than skipping it', () => {
    const taco = book().items[1];
    expect(taco.missing.map((entry) => entry.gap)).toContain('no quantity recorded');
  });

  it('ranks the blockers by how many dishes each one holds up', () => {
    const gaps = book().gaps;
    expect(gaps[0].name).toBe('Mega cover');
    expect(gaps[0].dishCount).toBe(2);
    expect(gaps[0].dishes).toEqual(['burger', 'taco']);
  });

  it('groups a dish’s cost so the known half is legible', () => {
    const burger = book().items[0];
    expect(burger.groups).toEqual([
      { group: 'Bread', cost: 25, priced: 1, total: 1, missing: [] },
      { group: 'Packaging', cost: 0, priced: 0, total: 1, missing: ['Mega cover'] },
    ]);
  });

  it('reports the known cost as a share of the menu price, never as a margin', () => {
    // 25 of a 299 burger. The unpriced packaging can only push this up, which
    // is why the field is named for the known cost and not for what is left.
    expect(book().items[0].knownCostPct).toBeCloseTo(8.4, 1);
  });
});
