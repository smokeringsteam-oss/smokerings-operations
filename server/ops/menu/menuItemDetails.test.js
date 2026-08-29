// Covers the product-detail editor in server/ops/menu/menuItems.js: which fields it
// offers, and — the part that matters — what it lets through to an Odoo
// write. This is the only thing between a typed form and a live product
// record, so the coercions and every refusal are pinned down here rather
// than trusted to Odoo to catch.
//
// Odoo itself is mocked: these are decisions this module makes before any
// RPC goes out, and the assertions are about the payload it would send.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// menuItems.js -> menuCsvMirror.js -> knowledgeBase.js, which wants a data
// directory even though nothing here touches the CSV mirror.
process.env.KNOWLEDGE_BASE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-item-details-'));

const MENU_CATEGORY_ID = 10;
const B2B_CATEGORY_ID = 21;
const ITEM_ID = 137;

// A cut-down product.template schema with one of everything the editor has
// to reason about: a plain char, a computed read-only field, a Studio field,
// a selection, both relation kinds, and two of the fields another control on
// the screen owns.
const FIELDS = {
  name: { type: 'char', string: 'Name', readonly: false, required: true },
  list_price: { type: 'float', string: 'Sales Price', readonly: false },
  description_sale: { type: 'text', string: 'Sales Description', readonly: false },
  active: { type: 'boolean', string: 'Active', readonly: false },
  default_code: { type: 'char', string: 'Internal Reference', readonly: false },
  standard_price: { type: 'float', string: 'Cost', readonly: false, store: false },
  weight: { type: 'float', string: 'Weight', readonly: false },
  sale_delay: { type: 'integer', string: 'Lead Time', readonly: false },
  sale_ok: { type: 'boolean', string: 'Can be Sold', readonly: false },
  categ_id: { type: 'many2one', string: 'Product Category', readonly: false, relation: 'product.category', required: true },
  uom_id: { type: 'many2one', string: 'Unit', readonly: false, relation: 'uom.uom', required: true },
  taxes_id: { type: 'many2many', string: 'Sales Taxes', readonly: false, relation: 'account.tax' },
  invoice_policy: {
    type: 'selection',
    string: 'Invoicing Policy',
    readonly: false,
    selection: [
      ['order', 'Ordered quantities'],
      ['delivery', 'Delivered quantities'],
    ],
  },
  x_packaging_type: {
    type: 'selection',
    string: 'Packaging',
    readonly: false,
    selection: [['kraft_tub', 'Kraft tub']],
  },
  x_meat_qty_g: { type: 'integer', string: 'Meat per portion (g)', readonly: false },
  // Excluded for their own reasons: computed, a binary, mail plumbing, a
  // stock helper, and a type this editor can't render.
  qty_available: { type: 'float', string: 'Quantity On Hand', readonly: false },
  lst_price: { type: 'float', string: 'Public Price', readonly: true },
  image_1920: { type: 'binary', string: 'Image', readonly: false },
  message_ids: { type: 'one2many', string: 'Messages', readonly: false, relation: 'mail.message' },
  seller_ids: { type: 'one2many', string: 'Vendors', readonly: false, relation: 'product.supplierinfo' },
};

// The record the fake Odoo hands back, and the writes it received.
let record;
let writes;

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../integrations/odoo.js', () => ({ execute }));

const { fetchMenuItemDetails, updateMenuItemDetails, fetchMenuItemFieldOptions } = await import('./menuItems.js');

function fakeOdoo(model, method, args = [], kwargs = {}) {
  if (model === 'product.category' && method === 'search_read') {
    return [{ id: MENU_CATEGORY_ID, complete_name: 'Food / Finished Products' }];
  }
  // The category fence on a categ_id write: only the menu subtree counts.
  if (model === 'product.category' && method === 'search_count') {
    const id = args[0].find((term) => term[0] === 'id' && term[1] === '=')[2];
    return [MENU_CATEGORY_ID, B2B_CATEGORY_ID].includes(id) ? 1 : 0;
  }
  if (model === 'product.template' && method === 'fields_get') return FIELDS;
  // assertMenuItem's fence.
  if (model === 'product.template' && method === 'search_read') {
    const id = args[0].find((term) => term[0] === 'id')[2];
    return id === ITEM_ID ? [{ id }] : [];
  }
  if (model === 'product.template' && method === 'read') return [{ id: ITEM_ID, ...record }];
  if (model === 'product.template' && method === 'write') {
    writes.push(args[1]);
    return true;
  }
  // Display names for the many2many values.
  if (model === 'account.tax' && method === 'read') {
    return args[0].map((id) => ({ id, display_name: `Tax ${id}` }));
  }
  if (method === 'name_search') return [[16, 'kg'], [1, 'Units']];
  throw new Error(`Unexpected call: ${model}.${method} ${JSON.stringify(args)} ${JSON.stringify(kwargs)}`);
}

beforeEach(() => {
  writes = [];
  record = {
    name: 'Pulled Chicken (Bulk 1kg)',
    default_code: 'B2B-003',
    standard_price: 0,
    weight: 0,
    sale_delay: 0,
    sale_ok: true,
    categ_id: [B2B_CATEGORY_ID, 'Food / Finished Products / B2B Wholesale'],
    uom_id: [16, 'kg'],
    taxes_id: [7],
    invoice_policy: 'order',
    x_packaging_type: false,
    x_meat_qty_g: 0,
  };
  execute.mockReset();
  execute.mockImplementation(fakeOdoo);
});

const detailField = (details, name) => details.fields.find((field) => field.name === name);

describe('fetchMenuItemDetails', () => {
  it('offers the writable product fields and leaves out the ones it must not', async () => {
    const details = await fetchMenuItemDetails({ id: ITEM_ID });
    const names = details.fields.map((field) => field.name);

    expect(names).toContain('default_code');
    expect(names).toContain('standard_price'); // non-stored but writable
    expect(names).toContain('taxes_id');

    // Owned by the editor above the panel.
    expect(names).not.toContain('name');
    expect(names).not.toContain('list_price');
    expect(names).not.toContain('description_sale');
    expect(names).not.toContain('active');
    // Odoo says read-only, isn't product data, or isn't a type this renders.
    expect(names).not.toContain('lst_price');
    expect(names).not.toContain('qty_available');
    expect(names).not.toContain('image_1920');
    expect(names).not.toContain('message_ids');
    expect(names).not.toContain('seller_ids');
  });

  it('groups fields the way the product form pages them, with Studio fields of their own', async () => {
    const details = await fetchMenuItemDetails({ id: ITEM_ID });

    expect(detailField(details, 'default_code').group).toBe('General');
    expect(detailField(details, 'taxes_id').group).toBe('Sales');
    expect(detailField(details, 'standard_price').group).toBe('Accounting');
    expect(detailField(details, 'x_meat_qty_g').group).toBe('Smoke Rings custom');
    expect(details.groups).toEqual([...new Set(details.fields.map((field) => field.group))]);
  });

  it('turns Odoo’s empty-as-false values into something an input can bind to', async () => {
    const details = await fetchMenuItemDetails({ id: ITEM_ID });

    expect(detailField(details, 'x_packaging_type').value).toBe(''); // false -> ''
    expect(detailField(details, 'uom_id').value).toEqual({ id: 16, name: 'kg' });
    expect(detailField(details, 'taxes_id').value).toEqual([{ id: 7, name: 'Tax 7' }]);
    expect(detailField(details, 'sale_ok').value).toBe(true);
    expect(detailField(details, 'weight').value).toBe(0);
  });

  it('refuses an id that is not a menu item, so a raw material cannot be read through it', async () => {
    await expect(fetchMenuItemDetails({ id: 999999 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateMenuItemDetails', () => {
  it('writes only the fields it was given, coerced to what Odoo expects', async () => {
    await updateMenuItemDetails({
      id: ITEM_ID,
      values: { weight: '1.5', x_meat_qty_g: '250.7', sale_ok: false, taxes_id: [7, 23], uom_id: 16 },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      weight: 1.5,
      x_meat_qty_g: 250, // integer field, so the typed decimal is truncated
      sale_ok: false,
      taxes_id: [[6, 0, [7, 23]]], // 6 = replace the set, which is what a form submit means
      uom_id: 16,
    });
  });

  it('clears an optional field rather than writing an empty string', async () => {
    await updateMenuItemDetails({ id: ITEM_ID, values: { default_code: '', x_packaging_type: '' } });
    expect(writes[0]).toEqual({ default_code: false, x_packaging_type: false });
  });

  it('refuses a field the panel does not own, naming it instead of dropping it', async () => {
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { list_price: 1 } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { lst_price: 1 } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { nonsense: 1 } })).rejects.toMatchObject({
      status: 400,
    });
    expect(writes).toHaveLength(0);
  });

  it('refuses values Odoo would not accept', async () => {
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { weight: 'heavy' } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      updateMenuItemDetails({ id: ITEM_ID, values: { invoice_policy: 'whenever' } }),
    ).rejects.toMatchObject({ status: 400 });
    // uom_id is required, so blanking it would fail at the database instead.
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { uom_id: null } })).rejects.toMatchObject({
      status: 400,
    });
    expect(writes).toHaveLength(0);
  });

  it('keeps the item inside Finished Products', async () => {
    // Between menu subcategories is fine...
    await updateMenuItemDetails({ id: ITEM_ID, values: { categ_id: MENU_CATEGORY_ID } });
    expect(writes[0]).toEqual({ categ_id: MENU_CATEGORY_ID });

    // ...out of the subtree is not: the item would vanish off this screen.
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: { categ_id: 4 } })).rejects.toMatchObject({
      status: 400,
    });
    expect(writes).toHaveLength(1);
  });

  it('refuses an id outside the menu category, and writes nothing', async () => {
    await expect(updateMenuItemDetails({ id: 999999, values: { weight: 1 } })).rejects.toMatchObject({ status: 404 });
    expect(writes).toHaveLength(0);
  });

  it('has nothing to say to an empty submission', async () => {
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: {} })).rejects.toMatchObject({ status: 400 });
    await expect(updateMenuItemDetails({ id: ITEM_ID, values: null })).rejects.toMatchObject({ status: 400 });
  });
});

describe('fetchMenuItemFieldOptions', () => {
  it('searches the relation the field itself points at', async () => {
    const result = await fetchMenuItemFieldOptions({ field: 'uom_id', query: 'k' });
    expect(result.relation).toBe('uom.uom');
    expect(result.options).toEqual([
      { id: 16, name: 'kg' },
      { id: 1, name: 'Units' },
    ]);
  });

  it('will not read a model the product record does not link to', async () => {
    await expect(fetchMenuItemFieldOptions({ field: 'default_code' })).rejects.toMatchObject({ status: 400 });
    await expect(fetchMenuItemFieldOptions({ field: 'name' })).rejects.toMatchObject({ status: 400 });
    await expect(fetchMenuItemFieldOptions({ field: 'res.users' })).rejects.toMatchObject({ status: 400 });
  });
});
