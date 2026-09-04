// The ad hoc purchase line, and the gap it used to leave.
//
// A buy can name an item the catalogue has never heard of — the coriander
// bunch, the tub of diced cheese, whatever was on the counter. That is
// allowed on purpose: refusing it would mean the money couldn't be recorded
// at all. What it costs is that the line has no material row to move, so the
// purchase lands in one table and the stock count doesn't move in the other,
// and from the screen that looked exactly like a clean success.
//
// So the two halves are pinned here: recordPurchases has to say out loud
// which lines moved no stock, and catalogPurchaseItem has to be able to
// finish one — create the material, link the buy to it, and apply the
// quantity, dated to the buy rather than to today.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const VENDORS = [
  { vendor_id: 'VEN-001', vendor_name: 'Pork Shop', vendor_type: 'Meat Vendor', supplies_category: 'Pork' },
];

const MATERIALS = [
  { item_id: 'RM-001', item_name: 'Pork shoulder', category: 'Meat', quantity_on_hand: 0 },
  // The catalogue row an ad hoc "Coriander Bunch 100 g" should be mapped to
  // rather than duplicated — see the last describe block.
  { item_id: 'RM-002', item_name: 'Coriander', category: 'Produce', quantity_on_hand: 5 },
];

const { dir } = createTestDb({ vendors: VENDORS, materials: MATERIALS });
const purchasing = await import('./purchasing.js');
const { selectOne } = await import('../../core/repo.js');
const { run } = await import('../../core/db.js');

beforeEach(() => {
  run('DELETE FROM purchase');
  // Everything the tests below create, back out. The seeded rows have to
  // survive; the item rows go with their materials, since the two are created
  // together and an orphan of either is not a state the app can make.
  run("DELETE FROM material WHERE item_id NOT IN ('RM-001', 'RM-002')");
  run("DELETE FROM item WHERE item_id NOT IN ('RM-001', 'RM-002')");
  run("UPDATE material SET quantity_on_hand = 0, last_updated = NULL WHERE item_id = 'RM-001'");
  run("UPDATE material SET quantity_on_hand = 5, last_updated = NULL WHERE item_id = 'RM-002'");
});

afterAll(() => removeTestDb(dir));

const onHand = (id) => selectOne('material', { item_id: id })?.quantity_on_hand;

// One catalogue line and one typed-in line in the same cart — the mixed cart
// is the normal case, not the edge one.
const logMixedCart = (channel = 'B2C') =>
  purchasing.recordPurchases({
    vendorName: 'Pork Shop',
    purchaseDate: '2026-09-04',
    channel,
    lines: [
      { materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 2, unitPrice: 500 },
      { materialId: '', itemName: 'Coriander Bunch 100 g', quantity: 3, unitPrice: 12 },
    ],
  });

describe('logging a purchase for something not in the catalogue', () => {
  it('records the spend and moves the stock it can', () => {
    const { purchases } = logMixedCart();

    expect(purchases).toHaveLength(2);
    expect(onHand('RM-001')).toBe(2);
  });

  it('reports the line whose stock did not move instead of leaving it silent', () => {
    const { inventorySkipped } = logMixedCart();

    expect(inventorySkipped).toHaveLength(1);
    expect(inventorySkipped[0]).toMatchObject({
      item_name: 'Coriander Bunch 100 g',
      quantity: 3,
      reason: 'not in the materials catalogue',
    });
    // The purchase_id is what the screen's "Add to catalogue" button acts on,
    // so a report without it would be a warning with nothing to click.
    expect(inventorySkipped[0].purchase_id).toMatch(/^PUR-/);
  });

  // The whole point of the shared module: B2B and B2C are the same code path
  // with a different channel column, and the gap has to be reported on both.
  it.each(['B2C', 'B2B'])('reports it on the %s side too', (channel) => {
    const { purchases, inventorySkipped } = logMixedCart(channel);

    expect(purchases.every((p) => p.channel === channel)).toBe(true);
    expect(inventorySkipped.map((l) => l.item_name)).toEqual(['Coriander Bunch 100 g']);
  });

  it('says nothing when every line found its material', () => {
    const { inventorySkipped } = purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-09-04',
      lines: [{ materialId: 'RM-001', itemName: 'Pork shoulder', quantity: 2, unitPrice: 500 }],
    });

    expect(inventorySkipped).toEqual([]);
  });
});

describe('finishing an ad hoc line', () => {
  const uncataloguedId = () => logMixedCart().inventorySkipped[0].purchase_id;

  it('creates the material, links the buy to it and applies the quantity', () => {
    const purchaseId = uncataloguedId();

    const { material, purchase, inventoryUpdated } = purchasing.catalogPurchaseItem({
      purchaseId,
      category: 'Produce',
    });

    expect(material).toMatchObject({ item_name: 'Coriander Bunch 100 g', category: 'Produce' });
    expect(material.material_id).toMatch(/^RM-/);
    // Linked, so the row stops reading as ad hoc — and so a later delete
    // reverses this stock the same way it reverses any other line's.
    expect(purchase.material_id).toBe(material.material_id);
    expect(purchase.item_type).toBe('material');
    expect(inventoryUpdated.newQuantity).toBe(3);
    expect(onHand(material.material_id)).toBe(3);
  });

  it('starts the row at zero, so the count is explained by the buy rather than by its own creation', () => {
    const purchaseId = uncataloguedId();
    const { material } = purchasing.catalogPurchaseItem({ purchaseId, category: 'Produce' });

    // 3 on hand and a purchase of 3 — not 6, which is what a row created at
    // the purchased quantity and then adjusted would read.
    expect(onHand(material.material_id)).toBe(3);
  });

  it('dates the movement to the buy, not to today', () => {
    const purchaseId = uncataloguedId();
    const { material } = purchasing.catalogPurchaseItem({ purchaseId, category: 'Produce' });

    expect(selectOne('material', { item_id: material.material_id }).last_updated).toBe('2026-09-04');
  });

  it('takes the price paid as the standing cost and the vendor as the default supplier', () => {
    const purchaseId = uncataloguedId();
    const { material } = purchasing.catalogPurchaseItem({ purchaseId, category: 'Produce' });

    expect(material.standard_cost_inr).toBe(12);
    expect(material.default_vendor_id).toBe('VEN-001');
  });

  it('refuses a line that already has a material, rather than stocking it twice', () => {
    const { purchases } = logMixedCart();
    const alreadyLinked = purchases.find((p) => p.material_id === 'RM-001');

    expect(() => purchasing.catalogPurchaseItem({ purchaseId: alreadyLinked.purchase_id })).toThrow(
      /already linked/i,
    );
    expect(onHand('RM-001')).toBe(2);
  });

  it('refuses a second material under a name already in the catalogue', () => {
    // Two carts, same typed-in name. The first gets the material; the second
    // must not create a duplicate row that would split the item's stock.
    const first = uncataloguedId();
    purchasing.catalogPurchaseItem({ purchaseId: first, category: 'Produce' });

    const { inventorySkipped } = purchasing.recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-09-05',
      lines: [{ materialId: '', itemName: 'coriander bunch 100 G', quantity: 1, unitPrice: 12 }],
    });

    expect(() =>
      purchasing.catalogPurchaseItem({ purchaseId: inventorySkipped[0].purchase_id, category: 'Produce' }),
    ).toThrow(/already in the catalogue/i);
  });

  it('rejects a purchase id that is not there', () => {
    expect(() => purchasing.catalogPurchaseItem({ purchaseId: 'PUR-9999' })).toThrow(/No purchase found/);
  });
});

// The other ending for the same line. Most ad hoc names are not new
// ingredients — they are catalogue items typed the way the bill spelt them —
// and cataloguing each one as new is what splits an ingredient's stock across
// two rows. So mapping has to move the count onto the row that already exists,
// keep the wording the buy was logged under, and refuse the cases that would
// double-count.
describe('mapping an ad hoc line to an item already in the catalogue', () => {
  const uncataloguedId = () => logMixedCart().inventorySkipped[0].purchase_id;

  it('links the buy to the existing item and adds to its count', () => {
    const purchaseId = uncataloguedId();

    const { purchase, inventoryUpdated } = purchasing.linkPurchaseToMaterial({ purchaseId, materialId: 'RM-002' });

    expect(purchase.material_id).toBe('RM-002');
    expect(purchase.item_type).toBe('material');
    // 5 already on hand plus the 3 this buy brought in — one running count,
    // not a second row starting at 3.
    expect(inventoryUpdated.newQuantity).toBe(8);
    expect(onHand('RM-002')).toBe(8);
  });

  it('creates no new material', () => {
    const before = purchasing.getRawMaterials().length;
    purchasing.linkPurchaseToMaterial({ purchaseId: uncataloguedId(), materialId: 'RM-002' });

    expect(purchasing.getRawMaterials()).toHaveLength(before);
  });

  it("re-words the line to the catalogue's wording and keeps what was typed in the notes", () => {
    const { purchase, renamedFrom } = purchasing.linkPurchaseToMaterial({
      purchaseId: uncataloguedId(),
      materialId: 'RM-002',
    });

    expect(purchase.item_name).toBe('Coriander');
    expect(renamedFrom).toBe('Coriander Bunch 100 g');
    // The bill's own words are the only record of what was actually bought,
    // so the rename must not be the end of them.
    expect(purchase.notes).toContain('Coriander Bunch 100 g');
    expect(purchase.notes).toContain('RM-002');
  });

  it('dates the movement to the buy, not to today', () => {
    purchasing.linkPurchaseToMaterial({ purchaseId: uncataloguedId(), materialId: 'RM-002' });

    expect(selectOne('material', { item_id: 'RM-002' }).last_updated).toBe('2026-09-04');
  });

  it("leaves the item's own standing cost and default vendor alone", () => {
    const before = selectOne('material', { item_id: 'RM-002' });
    purchasing.linkPurchaseToMaterial({ purchaseId: uncataloguedId(), materialId: 'RM-002' });
    const after = selectOne('material', { item_id: 'RM-002' });

    expect(after.standard_cost_inr).toBe(before.standard_cost_inr);
    expect(after.default_vendor_id).toBe(before.default_vendor_id);
  });

  it('reverses onto the mapped item when the purchase is later deleted', () => {
    const purchaseId = uncataloguedId();
    purchasing.linkPurchaseToMaterial({ purchaseId, materialId: 'RM-002' });

    purchasing.deletePurchase(purchaseId);

    // Back to the 5 it started with — the link is what makes the delete
    // reversible, which is half the reason to make it at all.
    expect(onHand('RM-002')).toBe(5);
  });

  it('refuses a line that already has a material, rather than stocking it twice', () => {
    const { purchases } = logMixedCart();
    const alreadyLinked = purchases.find((p) => p.material_id === 'RM-001');

    expect(() =>
      purchasing.linkPurchaseToMaterial({ purchaseId: alreadyLinked.purchase_id, materialId: 'RM-002' }),
    ).toThrow(/already linked/i);
    expect(onHand('RM-002')).toBe(5);
  });

  it('refuses a material id that is not in the catalogue', () => {
    expect(() => purchasing.linkPurchaseToMaterial({ purchaseId: uncataloguedId(), materialId: 'RM-9999' })).toThrow(
      /No catalogue item found/,
    );
  });

  it('rejects a purchase id that is not there', () => {
    expect(() => purchasing.linkPurchaseToMaterial({ purchaseId: 'PUR-9999', materialId: 'RM-002' })).toThrow(
      /No purchase found/,
    );
  });

  it('requires a material to map to', () => {
    expect(() => purchasing.linkPurchaseToMaterial({ purchaseId: uncataloguedId() })).toThrow(/materialId is required/);
  });
});
