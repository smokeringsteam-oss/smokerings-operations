// Covers the Odoo -> menu.csv mirror: which CSV row an edited Odoo product
// lands on, what it is allowed to overwrite, and that a file it can't match
// (or can't find) degrades to a note rather than an exception — the Odoo
// write has already happened by the time this runs.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCsvFile } from '../../core/csvStore.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-csv-mirror-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
// menu.csv lives under Data/Menu (server/core/knowledgeBase.js FILES.menu); the
// fixture below is written straight to disk, so create the folder for it.
fs.mkdirSync(path.join(dataDir, 'Menu'), { recursive: true });
const menuPath = path.join(dataDir, 'Menu', 'menu.csv');

const { mirrorMenuItemToCsv } = await import('./menuCsvMirror.js');

// A trimmed menu.csv with the columns the mirror touches, deliberately LF and
// with a hand-quoted notes field that doesn't strictly need its quotes — both
// of which the writer has to leave alone on rows it didn't edit.
const HEADER = 'menu_id,item_name,price_inr,is_active,odoo_product_id,description,notes';
const FIXTURE = [
  HEADER,
  'pork-tacos,Smoked Pork Tacos,499,yes,,"12-hour pulled pork, salsa verde.","Quoted; but comma-free"',
  'chicken-quesadilla,Smoked Chicken Quesadilla,399,yes,,Smoke. Spice. Cheese.,',
  'jackfruit-tacos,Smoked Jackfruit Tacos,399,yes,,Pulled jackfruit and salsa verde.,',
].join('\n') + '\n';

const rowFor = (menuId) => readCsvFile(menuPath).rows.find((r) => r.menu_id === menuId);
const item = (over) => ({
  id: 41,
  name: 'Smoked Pork Tacos',
  code: '',
  price: 499,
  description: '',
  isAvailable: true,
  isArchived: false,
  ...over,
});

beforeEach(() => {
  process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
  fs.writeFileSync(menuPath, FIXTURE, 'utf8');
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('mirrorMenuItemToCsv', () => {
  it('writes an edited price onto the row matched by name, and pins the row', () => {
    const result = mirrorMenuItemToCsv(item({ price: 549 }), ['price']);
    expect(result).toMatchObject({ mirrored: true, menuId: 'pork-tacos', matchedBy: 'name' });
    expect(rowFor('pork-tacos').price_inr).toBe('549');
    expect(rowFor('pork-tacos').odoo_product_id).toBe('41');
  });

  it('leaves fields this edit did not touch alone', () => {
    mirrorMenuItemToCsv(item({ price: 549, description: 'whatever Odoo holds' }), ['price']);
    expect(rowFor('pork-tacos').description).toBe('12-hour pulled pork, salsa verde.');
  });

  it('follows the pin after the product is renamed in Odoo', () => {
    mirrorMenuItemToCsv(item({}), ['price']);
    const result = mirrorMenuItemToCsv(item({ name: 'Smoky Pork Street Tacos' }), ['name']);
    expect(result).toMatchObject({ mirrored: true, menuId: 'pork-tacos', matchedBy: 'odoo_product_id' });
    expect(rowFor('pork-tacos').item_name).toBe('Smoky Pork Street Tacos');
  });

  it('falls back to keyword matching for an unpinned row whose name drifted', () => {
    const result = mirrorMenuItemToCsv(
      item({ id: 77, name: 'Smoked Chicken Quesadilla (New Recipe)', price: 429 }),
      ['price'],
    );
    expect(result).toMatchObject({ mirrored: true, menuId: 'chicken-quesadilla', matchedBy: 'name keywords' });
  });

  it('matches on the Odoo internal reference when it holds the menu_id', () => {
    const result = mirrorMenuItemToCsv(item({ id: 55, name: 'Anything', code: 'jackfruit-tacos' }), ['name']);
    expect(result).toMatchObject({ mirrored: true, menuId: 'jackfruit-tacos', matchedBy: 'internal reference' });
  });

  it('never lets a second Odoo product claim a row already pinned to another', () => {
    mirrorMenuItemToCsv(item({}), ['price']);
    const result = mirrorMenuItemToCsv(item({ id: 99, price: 1 }), ['price']);
    expect(result.mirrored).toBe(false);
    expect(rowFor('pork-tacos').price_inr).toBe('499');
  });

  it('collapses archived-or-unavailable into the single is_active flag', () => {
    mirrorMenuItemToCsv(item({ isAvailable: false }), ['available']);
    expect(rowFor('pork-tacos').is_active).toBe('no');
    mirrorMenuItemToCsv(item({ isAvailable: true, isArchived: true }), ['available']);
    expect(rowFor('pork-tacos').is_active).toBe('no');
    mirrorMenuItemToCsv(item({ isAvailable: true, isArchived: false }), ['available']);
    expect(rowFor('pork-tacos').is_active).toBe('yes');
  });

  it('reports an unmatched item instead of throwing or inventing a row', () => {
    const before = fs.readFileSync(menuPath, 'utf8');
    const result = mirrorMenuItemToCsv(item({ id: 500, name: 'Smoked Turkey Sandwich' }), ['price']);
    expect(result.mirrored).toBe(false);
    expect(result.reason).toMatch(/no row in Menu\/menu\.csv matches/i);
    expect(fs.readFileSync(menuPath, 'utf8')).toBe(before);
  });

  it('reports a missing knowledge base instead of throwing', () => {
    process.env.KNOWLEDGE_BASE_DATA_DIR = path.join(dataDir, 'not-checked-out');
    const result = mirrorMenuItemToCsv(item({}), ['price']);
    expect(result.mirrored).toBe(false);
    expect(result.reason).toMatch(/KNOWLEDGE_BASE_DATA_DIR/);
  });

  it('touches only the edited line — same line endings, same quoting elsewhere', () => {
    mirrorMenuItemToCsv(item({ id: 77, name: 'Smoked Chicken Quesadilla', price: 429 }), ['price']);
    const after = fs.readFileSync(menuPath, 'utf8');
    expect(after).not.toContain('\r\n');
    const before = FIXTURE.split('\n');
    const lines = after.split('\n');
    expect(lines).toHaveLength(before.length);
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(before[1]); // pork-tacos row, quotes and all
    expect(lines[3]).toBe(before[3]);
    expect(lines[2]).toContain('429');
  });
});
