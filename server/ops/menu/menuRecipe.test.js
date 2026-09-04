// Covers the Edit Menu screen's recipe editor: that a save writes the column
// the planners actually read, that a unit-converting line is left to state
// both halves itself, and that a bad number rejects the whole save instead of
// leaving half a recipe written.
//
// Moved onto the database with the module (phase 1). Every behavioural
// assertion below is the one it made against recipe_lines.csv; what changed
// is where the row is read back from, and that quantities come back as
// numbers rather than the strings a CSV cell always was. The one test that
// did not survive was "leaves the file CRLF and every untouched row
// byte-identical" — it was about not churning a text file's diff, which a
// table has no equivalent of. What it was really protecting is still checked,
// as "leaves every untouched line alone".
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const MENU_ITEMS = [
  {
    item_id: 'chicken-bbq-burger',
    item_name: 'Signature Pulled Chicken BBQ Burger',
    portion_size: 120,
    price_inr: 349,
  },
  { item_id: 'chicken-tacos', item_name: 'Smoked Chicken Tacos', portion_size: 150, price_inr: 399 },
];

const RECIPES = [
  { item_id: 'IP-001', kind: 'intermediate', recipe_name: 'Pulled chicken' },
  { item_id: 'SR-015', recipe_name: 'BBQ sauce' },
];

const MATERIALS = [{ item_id: 'RM-043', item_name: 'Aluminium foil' }];

// Trimmed to the lines the editor touches. MRI-009 is the awkward one on
// purpose: its two quantity columns are separate figures (base_is_separate),
// so neither can be derived from the other. MRI-001 is the other awkward one
// — two numbers that are NOT separate, just out of step, which is exactly the
// drift the editor exists to re-link.
const BOM_LINES = [
  { line_id: 'MRI-001', parent_id: 'chicken-bbq-burger', child_id: 'IP-001', quantity: 110, base_quantity: 120 },
  { line_id: 'MRI-002', parent_id: 'chicken-bbq-burger', child_id: 'SR-015', quantity: 30, base_quantity: 30 },
  { line_id: 'MRI-009', parent_id: 'chicken-bbq-burger', child_id: 'RM-043', quantity: 2, base_quantity: 0.0667, base_is_separate: 1, notes: 'Two figures, kept apart' },
  { line_id: 'MRI-021', parent_id: 'chicken-tacos', child_id: 'IP-001', quantity: 100, base_quantity: 150 },
];

const { dir } = createTestDb({
  materials: MATERIALS,
  menuItems: MENU_ITEMS,
  recipes: RECIPES,
  bomLines: BOM_LINES,
});

const { getMenuItemRecipe, updateMenuItemRecipe } = await import('./menuRecipe.js');
const { selectOne, update } = await import('../../core/repo.js');

const lineFor = (lineId) => selectOne('bom_line', { line_id: lineId });
const menuRowFor = (menuId) => selectOne('menu_item', { item_id: menuId });

beforeEach(() => {
  BOM_LINES.forEach((b) =>
    update('bom_line', { line_id: b.line_id }, { quantity: b.quantity, base_quantity: b.base_quantity }),
  );
  MENU_ITEMS.forEach((m) => update('menu_item', { item_id: m.item_id }, { portion_size: m.portion_size }));
});

afterAll(() => removeTestDb(dir));

describe('getMenuItemRecipe', () => {
  it('returns only that dish, grouped meat first, with the number the planner uses', () => {
    const { lines } = getMenuItemRecipe({ menuId: 'chicken-bbq-burger' });
    expect(lines.map((l) => l.lineId)).toEqual(['MRI-001', 'MRI-002', 'MRI-009']);
    expect(lines.map((l) => l.group)).toEqual(['meat', 'side', 'material']);
    // base_quantity wins, which is exactly the trap the editor exists to fix.
    expect(lines[0]).toMatchObject({ quantity: 110, plannerQuantity: 120, amountsLinked: true });
    expect(lines[2]).toMatchObject({ quantity: 2, plannerQuantity: 0.0667, amountsLinked: false });
  });

  it('derives child_type from what the child actually is', () => {
    const { lines } = getMenuItemRecipe({ menuId: 'chicken-bbq-burger' });
    // The CSV carried this as its own column; it is derived from item.kind
    // now, and a raw material must still read as 'material' rather than
    // 'recipe' — computePrepPlan filters on exactly this.
    expect(lines.find((l) => l.lineId === 'MRI-009').childType).toBe('material');
    expect(lines.find((l) => l.lineId === 'MRI-002').childType).toBe('recipe');
  });

  it('rejects a blank menu id rather than returning every dish', () => {
    expect(() => getMenuItemRecipe({ menuId: '' })).toThrow(/menu id is required/i);
  });
});

describe('updateMenuItemRecipe', () => {
  it('writes both quantity columns on a linked line', () => {
    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-001', quantity: 110 }],
    });
    expect(result.changed).toEqual(['MRI-001']);
    expect(lineFor('MRI-001')).toMatchObject({ quantity: 110, base_quantity: 110 });
  });

  it("carries a meat change onto the menu's stated portion", () => {
    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-001', quantity: 110 }],
    });
    expect(menuRowFor('chicken-bbq-burger').portion_size).toBe(110);
    expect(result.notes.join(' ')).toMatch(/portion size updated 120 → 110/i);
    // A side is not a portion claim, so it leaves the menu row alone.
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-002', quantity: 40 }] });
    expect(menuRowFor('chicken-bbq-burger').portion_size).toBe(110);
  });

  it('keeps a separate-figure line unless the planner number is given too', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-009', quantity: 3 }] });
    expect(lineFor('MRI-009')).toMatchObject({ quantity: 3, base_quantity: 0.0667 });

    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-009', quantity: 3, baseQuantity: 0.1 }],
    });
    expect(lineFor('MRI-009')).toMatchObject({ quantity: 3, base_quantity: 0.1 });
    expect(result.notes.join(' ')).toMatch(/separate planner figure/);
  });

  it('clears both columns when a quantity is blanked (to taste)', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-002', quantity: '' }] });
    expect(lineFor('MRI-002')).toMatchObject({ quantity: null, base_quantity: null });
  });

  it('refuses a line belonging to another dish', () => {
    expect(() =>
      updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-021', quantity: 999 }] }),
    ).toThrow(/belongs to chicken-tacos/);
    expect(lineFor('MRI-021').quantity).toBe(100);
  });

  it('writes nothing at all when one edit in the batch is invalid', () => {
    expect(() =>
      updateMenuItemRecipe({
        menuId: 'chicken-bbq-burger',
        edits: [
          { lineId: 'MRI-001', quantity: 130 },
          { lineId: 'MRI-002', quantity: -5 },
        ],
      }),
    ).toThrow(/can't be negative/);
    expect(lineFor('MRI-001')).toMatchObject({ quantity: 110, base_quantity: 120 });
  });

  it('leaves every untouched line alone', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-001', quantity: 110 }] });
    // The CSV version of this checked the file was still CRLF and the foil
    // row byte-identical. The point was that a one-line save must not disturb
    // anything else, which is what is asserted here directly.
    expect(lineFor('MRI-009')).toMatchObject({ quantity: 2, base_quantity: 0.0667, notes: 'Two figures, kept apart' });
    expect(lineFor('MRI-002')).toMatchObject({ quantity: 30, base_quantity: 30 });
    expect(lineFor('MRI-021')).toMatchObject({ quantity: 100, base_quantity: 150 });
  });

  it('reports no change when the saved numbers are the ones already there', () => {
    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-002', quantity: 30 }],
    });
    expect(result.changed).toEqual([]);
  });
});
