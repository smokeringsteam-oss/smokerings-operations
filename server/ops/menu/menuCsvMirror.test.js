// Covers the Odoo -> knowledge-base mirror: which menu row an edited Odoo
// product lands on, what it is allowed to overwrite, and that a row it can't
// match degrades to a note rather than an exception — the Odoo write has
// already happened by the time this runs.
//
// Moved onto the database with the module (phase 1). The behavioural
// assertions are the ones this made against menu.csv; what changed is that a
// row is read back from two joined tables, and that its values come back as
// numbers and an integer flag rather than the strings a CSV cell always was.
// The test that did not survive was "touches only the edited line — same line
// endings, same quoting elsewhere", which was about not churning a text
// file's diff. What it protected is still checked, as "leaves the other menu
// items alone".
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

// The same three dishes the CSV fixture had, with the columns the mirror
// touches. jackfruit-tacos is here because one test matches it by Odoo's
// internal reference rather than by name.
const MENU_ITEMS = [
  {
    item_id: 'pork-tacos',
    item_name: 'Smoked Pork Tacos',
    price_inr: 499,
    description: '12-hour pulled pork, salsa verde.',
  },
  {
    item_id: 'chicken-quesadilla',
    item_name: 'Smoked Chicken Quesadilla',
    price_inr: 399,
    description: 'Smoke. Spice. Cheese.',
  },
  {
    item_id: 'jackfruit-tacos',
    item_name: 'Smoked Jackfruit Tacos',
    price_inr: 399,
    description: 'Pulled jackfruit and salsa verde.',
  },
];

const { dir } = createTestDb({ menuItems: MENU_ITEMS });

const { mirrorMenuItemToCsv } = await import('./menuCsvMirror.js');
const { readMenu } = await import('../../core/kbViews.js');
const { update } = await import('../../core/repo.js');

const rowFor = (menuId) => readMenu().find((r) => r.menu_id === menuId);
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
  // Back to an unpinned, fully-active menu: several tests below depend on a
  // row being free to match by name, which a pin left by the previous test
  // would prevent.
  MENU_ITEMS.forEach((m) => {
    update('item', { item_id: m.item_id }, { name: m.item_name, is_active: 1 });
    update('menu_item', { item_id: m.item_id }, { price_inr: m.price_inr, description: m.description, odoo_product_id: null });
  });
});

afterAll(() => removeTestDb(dir));

describe('mirrorMenuItemToCsv', () => {
  it('writes an edited price onto the row matched by name, and pins the row', () => {
    const result = mirrorMenuItemToCsv(item({ price: 549 }), ['price']);
    expect(result).toMatchObject({ mirrored: true, menuId: 'pork-tacos', matchedBy: 'name' });
    expect(rowFor('pork-tacos').price_inr).toBe(549);
    expect(rowFor('pork-tacos').odoo_product_id).toBe(41);
  });

  it('leaves fields this edit did not touch alone', () => {
    mirrorMenuItemToCsv(item({ price: 549, description: 'whatever Odoo holds' }), ['price']);
    expect(rowFor('pork-tacos').description).toBe('12-hour pulled pork, salsa verde.');
  });

  it('never mirrors the description, even when asked to', () => {
    // Odoo's description_sale is the single source of truth for a dish's
    // blurb. A second copy here would be write-only and could only drift, so
    // 'description' is not a mirrorable field at all — passing it is a no-op
    // rather than a write.
    const result = mirrorMenuItemToCsv(item({ description: 'whatever Odoo holds' }), ['description']);
    expect(result.changed).toEqual(['odoo_product_id']);
    expect(rowFor('pork-tacos').description).toBe('12-hour pulled pork, salsa verde.');
  });

  it('reports no change when the price saved is the one already on file', () => {
    // The row now reads back as the number 499 while the mirror is handed the
    // string "499". Compared naively those differ, and every save would claim
    // to have changed a price it did not touch.
    const result = mirrorMenuItemToCsv(item({ price: 499 }), ['price']);
    expect(result.changed).toEqual(['odoo_product_id']);
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
    expect(rowFor('pork-tacos').price_inr).toBe(499);
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
    const before = readMenu();
    const result = mirrorMenuItemToCsv(item({ id: 500, name: 'Smoked Turkey Sandwich' }), ['price']);
    expect(result.mirrored).toBe(false);
    expect(result.reason).toMatch(/no menu item matches/i);
    expect(readMenu()).toEqual(before);
  });

  it('leaves the other menu items alone', () => {
    mirrorMenuItemToCsv(item({ id: 77, name: 'Smoked Chicken Quesadilla', price: 429 }), ['price']);
    expect(rowFor('chicken-quesadilla').price_inr).toBe(429);
    expect(rowFor('pork-tacos')).toMatchObject({
      price_inr: 499,
      item_name: 'Smoked Pork Tacos',
      description: '12-hour pulled pork, salsa verde.',
    });
    expect(rowFor('jackfruit-tacos')).toMatchObject({ price_inr: 399, item_name: 'Smoked Jackfruit Tacos' });
  });
});
