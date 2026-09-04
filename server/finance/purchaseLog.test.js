// What the Purchase Logger has to get right.
//
// The reason this screen exists is a distinction, not a feature: money spent
// on practice, on posters and on meat all looked identical in the ledger, and
// all of it looked like B2C or B2B and nothing else. So the tests here are
// mostly about that distinction surviving the round trip — written on the way
// in, kept apart from the channel on the way out, and fixable afterwards for
// the two years of rows that were logged before the column had a writer.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const VENDORS = [
  { vendor_id: 'VEN-001', vendor_name: 'Pork Shop', vendor_type: 'Meat Vendor' },
  { vendor_id: 'VEN-002', vendor_name: 'Sign Works', vendor_type: 'Printer' },
];

const MATERIALS = [{ item_id: 'RM-001', item_name: 'Pork shoulder', category: 'Meat', quantity_on_hand: 0 }];

const { dir } = createTestDb({ vendors: VENDORS, materials: MATERIALS });
const log = await import('./purchaseLog.js');
const purchasing = await import('../ops/shared/purchasing.js');
const { run } = await import('../core/db.js');
const { selectOne } = await import('../core/repo.js');

beforeEach(() => {
  run('DELETE FROM purchase');
  run("UPDATE material SET quantity_on_hand = 0, last_updated = NULL WHERE item_id = 'RM-001'");
});

afterAll(() => removeTestDb(dir));

const DAY = '2026-09-04';

const logPosters = (overrides = {}) =>
  log.logSpend({
    vendorName: 'Sign Works',
    purchaseDate: DAY,
    channel: 'B2C',
    expenseCategory: 'Marketing collateral',
    lines: [{ itemName: 'A3 posters, Diwali menu', quantity: 50, unitPrice: 24 }],
    ...overrides,
  });

describe('logging spend that is not a raw material', () => {
  it('records the category alongside the channel rather than instead of it', () => {
    const { purchases } = logPosters();

    const row = selectOne('purchase', { purchase_id: purchases[0].purchase_id });
    expect(row.expense_category).toBe('Marketing collateral');
    // The whole point: a poster buy is still B2C spend. If the category had
    // replaced the channel, the per-side margin would lose it.
    expect(row.channel).toBe('B2C');
  });

  it('costs the line the same way a material buy is costed', () => {
    const { purchases } = logPosters();

    expect(purchases[0].total_cost).toBe(1200);
  });

  it('defaults a quantity of one, because most of this is bought as a thing', () => {
    const { purchases } = log.logSpend({
      vendorName: 'Sign Works',
      purchaseDate: DAY,
      channel: 'B2B',
      expenseCategory: 'Equipment & tools',
      lines: [{ itemName: 'Instant-read thermometer', unitPrice: 2400 }],
    });

    expect(purchases[0].quantity_purchased).toBe(1);
    expect(purchases[0].total_cost).toBe(2400);
  });

  it('reports the line as one that moved no stock, so it is not silently missing from inventory', () => {
    const { inventorySkipped } = logPosters();

    expect(inventorySkipped).toHaveLength(1);
    expect(inventorySkipped[0].reason).toBe('not in the materials catalogue');
  });

  it('still moves stock when the line names a catalogue material', () => {
    // The practice cook is the case that needs both halves: it is real meat
    // off the shelf AND it is not raw-material spend against an order.
    log.logSpend({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      expenseCategory: 'Practice / R&D',
      lines: [{ materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 3, unitPrice: 500 }],
    });

    expect(selectOne('material', { item_id: 'RM-001' }).quantity_on_hand).toBe(3);
    // And the category is the one that was asked for, not the material
    // fallback — a practice buy filed as Raw materials is the exact mistake
    // this screen was built to stop.
    const row = selectOne('purchase', { purchase_id: 'PUR-0001' });
    expect(row.expense_category).toBe('Practice / R&D');
  });

  it('keeps the note, which is the only record of why this buy happened', () => {
    const { purchases } = logPosters({ notes: 'Diwali counter run' });

    expect(selectOne('purchase', { purchase_id: purchases[0].purchase_id }).notes).toBe('Diwali counter run');
  });
});

describe('refusing what cannot be filed', () => {
  it('refuses a cart with no category — the field this screen exists for', () => {
    expect(() => logPosters({ expenseCategory: '' })).toThrow(/expense category is required/i);
  });

  it('refuses a category that is not on the list, naming the ones that are', () => {
    expect(() => logPosters({ expenseCategory: 'Posters' })).toThrow(/not an expense category/i);
  });

  it('accepts a category typed in the wrong case and stores the list spelling', () => {
    // Otherwise "practice / r&d" from a script becomes a thirteenth category
    // sitting beside the twelve, and the rollup splits in two.
    const { purchases } = logPosters({ expenseCategory: 'pRACTICE / r&d' });

    expect(selectOne('purchase', { purchase_id: purchases[0].purchase_id }).expense_category).toBe(
      'Practice / R&D',
    );
  });

  it('writes nothing when one line of a cart has a bad category', () => {
    expect(() =>
      log.logSpend({
        vendorName: 'Sign Works',
        purchaseDate: DAY,
        channel: 'B2C',
        expenseCategory: 'Marketing collateral',
        lines: [
          { itemName: 'A3 posters', quantity: 50, unitPrice: 24 },
          { itemName: 'Banner', quantity: 1, unitPrice: 900, expenseCategory: 'Billboards' },
        ],
      }),
    ).toThrow(/not an expense category/i);

    // The first line must not be sitting in the log under a category nobody
    // finished choosing.
    expect(log.getSpendLog({ from: DAY, to: DAY }).totals.lines).toBe(0);
  });
});

describe('what Weekly Purchasing writes', () => {
  it('files a catalogue buy as raw materials when nobody says otherwise', () => {
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      lines: [{ materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 5, unitPrice: 500 }],
    });

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe('Raw materials');
  });

  it('leaves an ad hoc line uncategorised rather than guessing', () => {
    // The off-catalogue lines are exactly where the posters and gas refills
    // hide, so a default of "Raw materials" here would file the interesting
    // spend under the boring category, silently.
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      lines: [{ itemName: 'Bag of ice', quantity: 2, unitPrice: 40 }],
    });

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe(null);
    expect(log.getSpendLog({ from: DAY, to: DAY }).needsFiling).toMatchObject({ lines: 1, spend: 80, blankLines: 1 });
  });

  it('takes a per-line category over the cart one, for the mixed bill', () => {
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      expenseCategory: 'Raw materials',
      lines: [
        { materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 5, unitPrice: 500 },
        { itemName: 'Charcoal 10 kg', quantity: 2, unitPrice: 300, expenseCategory: 'Fuel & gas' },
      ],
    });

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe('Raw materials');
    expect(selectOne('purchase', { purchase_id: 'PUR-0002' }).expense_category).toBe('Fuel & gas');
  });
});

describe('the report', () => {
  const seed = () => {
    logPosters();
    log.logSpend({
      vendorName: 'Sign Works',
      purchaseDate: DAY,
      channel: 'B2B',
      expenseCategory: 'Marketing collateral',
      lines: [{ itemName: 'Wholesale leaflets', quantity: 200, unitPrice: 5 }],
    });
    log.logSpend({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      expenseCategory: 'Practice / R&D',
      lines: [{ materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 2, unitPrice: 500 }],
    });
  };

  it('splits every category by channel, which is the distinction being asked for', () => {
    seed();

    const { categories } = log.getSpendLog({ from: DAY, to: DAY });
    const collateral = categories.find((row) => row.category === 'Marketing collateral');

    expect(collateral).toMatchObject({ spend: 2200, b2c: 1200, b2b: 1000, lines: 2 });
  });

  it('orders categories by the vocabulary, not by size, so the list sits still', () => {
    seed();

    // Practice / R&D is second in the list and smaller than Marketing
    // collateral, which is third. Sorted by spend it would jump above it.
    expect(log.getSpendLog({ from: DAY, to: DAY }).categories.map((row) => row.category)).toEqual([
      'Practice / R&D',
      'Marketing collateral',
    ]);
  });

  it('keeps the rollups over the whole range when a filter narrows the rows', () => {
    seed();

    const report = log.getSpendLog({ from: DAY, to: DAY, category: 'Practice / R&D' });

    expect(report.rows).toHaveLength(1);
    // Still all three categories' worth of context beside the one row, or
    // there is nothing to read the figure against.
    expect(report.categories).toHaveLength(2);
    expect(report.totals.spend).toBe(3200);
    expect(report.totals.shownSpend).toBe(1000);
  });

  it('filters to the uncategorised queue on request', () => {
    seed();
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      lines: [{ itemName: 'Bag of ice', quantity: 2, unitPrice: 40 }],
    });

    const report = log.getSpendLog({ from: DAY, to: DAY, uncategorisedOnly: true });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].item_name).toBe('Bag of ice');
    expect(report.needsFiling.lines).toBe(1);
  });

  it('counts an unpriced line without letting it read as free', () => {
    log.logSpend({
      vendorName: 'Sign Works',
      purchaseDate: DAY,
      channel: 'B2C',
      expenseCategory: 'Equipment & tools',
      lines: [{ itemName: 'Smoker probe — bill to follow', quantity: 1 }],
    });

    const report = log.getSpendLog({ from: DAY, to: DAY });
    expect(report.totals.lines).toBe(1);
    expect(report.totals.uncostedLines).toBe(1);
    expect(report.totals.spend).toBe(0);
  });

  it('puts a category string that is not one of the twelve on the worklist, without losing its money', () => {
    // The live database has these: "Raw Material - Meat" and "Software &
    // Subscriptions" came across in the CSV import and are not in the
    // vocabulary anything writes today. They are real spend under a name
    // nothing else uses — so they need re-filing, and until they are re-filed
    // they still have to total somewhere.
    logPosters();
    run("UPDATE purchase SET expense_category = 'Raw Material - Meat' WHERE purchase_id = 'PUR-0001'");

    const report = log.getSpendLog({ from: DAY, to: DAY });

    expect(report.needsFiling).toMatchObject({ lines: 1, retiredLines: 1, blankLines: 0, spend: 1200 });
    expect(report.categories[0]).toMatchObject({ category: 'Raw Material - Meat', spend: 1200, retired: true });
    expect(report.totals.spend).toBe(1200);
  });

  it('keeps the worklist out of reach of the filters, because it is a chore and not a view', () => {
    seed();
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      lines: [{ itemName: 'Bag of ice', quantity: 2, unitPrice: 40 }],
    });

    // Narrowing to one category must not make the unfiled lines look dealt
    // with.
    const report = log.getSpendLog({ from: DAY, to: DAY, category: 'Practice / R&D' });

    expect(report.rows).toHaveLength(1);
    expect(report.needsFiling.rows).toHaveLength(1);
    expect(report.needsFiling.rows[0].item_name).toBe('Bag of ice');
  });

  it('refuses a filter naming a category that does not exist', () => {
    // An empty table would otherwise read as "nothing was spent on that"
    // rather than "that is not a category".
    expect(() => log.getSpendLog({ from: DAY, to: DAY, category: 'Posters' })).toThrow(
      /not an expense category/i,
    );
  });
});

describe('backfilling a category onto lines already logged', () => {
  const twoAdHocLines = () =>
    purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: DAY,
      channel: 'B2C',
      lines: [
        { itemName: 'Bag of ice', quantity: 2, unitPrice: 40 },
        { itemName: 'Butcher paper roll', quantity: 1, unitPrice: 250 },
      ],
    });

  it('categorises a list of lines in one go', () => {
    twoAdHocLines();

    const result = log.categorisePurchases({
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      expenseCategory: 'Packaging & consumables',
    });

    expect(result.updated).toBe(2);
    expect(log.getSpendLog({ from: DAY, to: DAY }).needsFiling.lines).toBe(0);
  });

  it('overwrites a category that was already set, because that is the correction', () => {
    logPosters();

    log.categorisePurchases({ purchaseIds: ['PUR-0001'], expenseCategory: 'Samples & giveaways' });

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe('Samples & giveaways');
  });

  it('clears one back to uncategorised when given a blank', () => {
    logPosters();

    log.categorisePurchases({ purchaseIds: ['PUR-0001'], expenseCategory: '' });

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe(null);
  });

  it('moves none of them when one id does not exist', () => {
    twoAdHocLines();

    expect(() =>
      log.categorisePurchases({
        purchaseIds: ['PUR-0001', 'PUR-9999'],
        expenseCategory: 'Packaging & consumables',
      }),
    ).toThrow(/PUR-9999/);

    expect(selectOne('purchase', { purchase_id: 'PUR-0001' }).expense_category).toBe(null);
  });

  it('leaves everything else on the row alone', () => {
    twoAdHocLines();

    log.categorisePurchases({ purchaseIds: ['PUR-0001'], expenseCategory: 'Fuel & gas' });

    const row = selectOne('purchase', { purchase_id: 'PUR-0001' });
    expect(row).toMatchObject({ channel: 'B2C', item_name: 'Bag of ice', total_cost: 80 });
  });
});
