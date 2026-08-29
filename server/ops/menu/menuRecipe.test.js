// Covers the Edit Menu screen's recipe editor: that a save writes the column
// the planners actually read, that a unit-converting line is left to state
// both halves itself, and that a bad number rejects the whole save instead of
// leaving half a recipe written.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCsvFile } from '../../core/csvStore.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-recipe-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'Menu'), { recursive: true });
const linesPath = path.join(dataDir, 'Menu', 'recipe_lines.csv');
const menuPath = path.join(dataDir, 'Menu', 'menu.csv');

const { getMenuItemRecipe, updateMenuItemRecipe } = await import('./menuRecipe.js');

// Trimmed to the columns the editor touches, and deliberately CRLF — the real
// file is, and a one-cell save must not flip every line ending.
const LINES_HEADER =
  'line_id,parent_id,parent_name,child_type,child_id,child_name,quantity,unit,base_quantity,base_unit,is_to_taste,status,notes';
const LINES_FIXTURE =
  [
    LINES_HEADER,
    'MRI-001,chicken-bbq-burger,Signature Pulled Chicken BBQ Burger,recipe,IP-001,Pulled chicken,110,g,120,g,no,ok,',
    'MRI-002,chicken-bbq-burger,Signature Pulled Chicken BBQ Burger,recipe,SR-015,BBQ sauce,30,ml,30,ml,no,ok,',
    'MRI-009,chicken-bbq-burger,Signature Pulled Chicken BBQ Burger,material,RM-043,Aluminium foil,2,sheets,0.0667,roll,no,ok,Converted with UC-022',
    'MRI-021,chicken-tacos,Smoked Chicken Tacos,recipe,IP-001,Pulled chicken,100,g,150,g,no,ok,',
  ].join('\r\n') + '\r\n';

const MENU_FIXTURE =
  [
    'menu_id,item_name,main_product_id,portion_size,portion_unit,price_inr',
    'chicken-bbq-burger,Signature Pulled Chicken BBQ Burger,IP-001,120,g,349',
    'chicken-tacos,Smoked Chicken Tacos,IP-001,150,g,399',
  ].join('\n') + '\n';

const lineFor = (lineId) => readCsvFile(linesPath).rows.find((r) => r.line_id === lineId);
const menuRowFor = (menuId) => readCsvFile(menuPath).rows.find((r) => r.menu_id === menuId);

beforeEach(() => {
  process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
  fs.writeFileSync(linesPath, LINES_FIXTURE, 'utf8');
  fs.writeFileSync(menuPath, MENU_FIXTURE, 'utf8');
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('getMenuItemRecipe', () => {
  it('returns only that dish, grouped meat first, with the number the planner uses', () => {
    const { lines } = getMenuItemRecipe({ menuId: 'chicken-bbq-burger' });
    expect(lines.map((l) => l.lineId)).toEqual(['MRI-001', 'MRI-002', 'MRI-009']);
    expect(lines.map((l) => l.group)).toEqual(['meat', 'side', 'material']);
    // base_quantity wins, which is exactly the trap the editor exists to fix.
    expect(lines[0]).toMatchObject({ quantity: 110, plannerQuantity: 120, unitsMatch: true });
    expect(lines[2]).toMatchObject({ quantity: 2, unit: 'sheets', plannerQuantity: 0.0667, unitsMatch: false });
  });

  it('rejects a blank menu id rather than returning every dish', () => {
    expect(() => getMenuItemRecipe({ menuId: '' })).toThrow(/menu id is required/i);
  });
});

describe('updateMenuItemRecipe', () => {
  it('writes both quantity columns when the units match', () => {
    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-001', quantity: 110 }],
    });
    expect(result.changed).toEqual(['MRI-001']);
    expect(lineFor('MRI-001')).toMatchObject({ quantity: '110', base_quantity: '110' });
  });

  it('carries a meat change onto menu.csv\'s stated portion', () => {
    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-001', quantity: 110 }],
    });
    expect(menuRowFor('chicken-bbq-burger').portion_size).toBe('110');
    expect(result.notes.join(' ')).toMatch(/portion_size updated 120 → 110 g/);
    // A side is not a portion claim, so it leaves menu.csv alone.
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-002', quantity: 40 }] });
    expect(menuRowFor('chicken-bbq-burger').portion_size).toBe('110');
  });

  it('keeps a unit-converting line unless the stock figure is given too', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-009', quantity: 3 }] });
    expect(lineFor('MRI-009')).toMatchObject({ quantity: '3', base_quantity: '0.0667' });

    const result = updateMenuItemRecipe({
      menuId: 'chicken-bbq-burger',
      edits: [{ lineId: 'MRI-009', quantity: 3, baseQuantity: 0.1 }],
    });
    expect(lineFor('MRI-009')).toMatchObject({ quantity: '3', base_quantity: '0.1' });
    expect(result.notes.join(' ')).toMatch(/stocked in roll/);
  });

  it('clears both columns when a quantity is blanked (to taste)', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-002', quantity: '' }] });
    expect(lineFor('MRI-002')).toMatchObject({ quantity: '', base_quantity: '' });
  });

  it('refuses a line belonging to another dish', () => {
    expect(() =>
      updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-021', quantity: 999 }] }),
    ).toThrow(/belongs to chicken-tacos/);
    expect(lineFor('MRI-021').quantity).toBe('100');
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
    expect(lineFor('MRI-001')).toMatchObject({ quantity: '110', base_quantity: '120' });
  });

  it('leaves the file CRLF and every untouched row byte-identical', () => {
    updateMenuItemRecipe({ menuId: 'chicken-bbq-burger', edits: [{ lineId: 'MRI-001', quantity: 110 }] });
    const text = fs.readFileSync(linesPath, 'utf8');
    expect(text.split('\r\n').length).toBe(LINES_FIXTURE.split('\r\n').length);
    expect(text).toContain(
      'MRI-009,chicken-bbq-burger,Signature Pulled Chicken BBQ Burger,material,RM-043,Aluminium foil,2,sheets,0.0667,roll,no,ok,Converted with UC-022',
    );
  });
});
