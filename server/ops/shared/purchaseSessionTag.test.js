// Covers the B2B cost-attribution chain: which purchase line ends up charged
// to which cook, and to which account.
//
// Two link columns exist between purchases and sessions and it matters that
// they stay separate, so most of what's tested here is the boundary between
// them:
//   smoking_session.source_purchase_id — where a session's raw weight came
//                                        from (one lot, drives FIFO maths)
//   purchase.smoking_session_id        — which cook a line of spend was for
//                                        (many lines, and it includes the
//                                        spices and packaging that never had
//                                        a weight of their own)
// The rules worth pinning down are the ones a future edit could plausibly
// "simplify" into being wrong: a tag must never be stolen from another cook,
// a client set on the buy itself must outrank the session's, and deleting a
// session must free the spend rather than delete it.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const VENDORS = [
  { vendor_id: 'VEN-001', vendor_name: 'Pork Shop', vendor_type: 'Meat Vendor', supplies_category: 'Pork' },
  { vendor_id: 'VEN-002', vendor_name: 'Swiggy', vendor_type: 'Delivery', supplies_category: 'Groceries' },
];

// One catalogue material, so a purchase line can name a real item_id — that
// is a foreign key now, not a convention. Its quantity_on_hand moves when
// recordPurchases runs, which is deliberate: these tests exercise the real
// write path, stock move and all.
// RM-047 stands in for the piece-bought half of the catalogue: the butcher
// counts and prices whole birds, the kitchen works in kg, so a line has to be
// able to carry both. Its unit of measure is pcs on purpose — that is what
// moves stock — and the kg comes from weight_per_unit_kg beside it.
const MATERIALS = [
  { item_id: 'RM-001', item_name: 'Pork shoulder', category: 'Meat', quantity_on_hand: 0 },
  { item_id: 'RM-047', item_name: 'Whole chicken', category: 'Meat', unit_of_measure: 'pcs', quantity_on_hand: 0 },
];

const PURCHASES = [
  {
    purchase_id: 'PUR-0001',
    purchase_date: '2026-08-17',
    channel: 'B2B',
    vendor_id: 'VEN-001',
    material_id: 'RM-001',
    item_name: 'Pork shoulder',
    quantity_purchased: 10,
    unit_of_measure: 'kg',
    unit_price: 400,
    total_cost: 4000,
  },
  // No material_id: an ad hoc line that isn't in the catalogue. It matters to
  // this file because "what did this cook cost" has to be able to include it.
  {
    purchase_id: 'PUR-0002',
    purchase_date: '2026-08-17',
    channel: 'B2B',
    vendor_id: 'VEN-002',
    item_name: 'Butcher paper',
    quantity_purchased: 50,
    unit_of_measure: 'pcs',
    unit_price: 4,
    total_cost: 200,
  },
  {
    purchase_id: 'PUR-0003',
    purchase_date: '2026-08-17',
    channel: 'B2C',
    vendor_id: 'VEN-001',
    material_id: 'RM-001',
    item_name: 'Pork shoulder',
    quantity_purchased: 5,
    unit_of_measure: 'kg',
    unit_price: 400,
    total_cost: 2000,
  },
];

const { dir: dbDir } = createTestDb({ vendors: VENDORS, materials: MATERIALS, purchases: PURCHASES });

const { run } = await import('../../core/db.js');
const { insert } = await import('../../core/repo.js');
const { tagPurchasesToSession, clearSessionPurchaseTags, recordPurchases, getPurchases } = await import(
  './purchasing.js'
);

const rowFor = (id) => getPurchases().find((r) => r.purchase_id === id);

// Every test starts from the same three purchases. Rebuilt rather than
// patched back: recordPurchases adds rows of its own, and a leftover PUR-0004
// would silently change which id the next test's buy gets.
beforeEach(() => {
  run('DELETE FROM purchase');
  PURCHASES.forEach((p) =>
    insert('purchase', {
      ...p,
      item_type: p.material_id ? 'material' : null,
    }),
  );
});

afterAll(() => {
  removeTestDb(dbDir);
});

describe('tagPurchasesToSession', () => {
  it('stamps the session and inherits its client onto each line', () => {
    const result = tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    expect(result.tagged.sort()).toEqual(['PUR-0001', 'PUR-0002']);
    // The packaging line matters as much as the meat: "what did this cook
    // cost" is the whole point, and the answer isn't only the meat.
    expect(rowFor('PUR-0002')).toMatchObject({ smoking_session_id: 'SMK-0001', client_name: 'Taj Hotel' });
  });

  it('never steals a line already tagged to a different cook', () => {
    tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });

    const result = tagPurchasesToSession({
      sessionId: 'SMK-0002',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-002',
      clientName: 'Marriott',
    });

    // Re-pointing it would silently move 4000 rupees off the first cook with
    // nothing left to show it ever happened.
    expect(result.skipped).toEqual([{ purchase_id: 'PUR-0001', taggedTo: 'SMK-0001' }]);
    expect(rowFor('PUR-0001').smoking_session_id).toBe('SMK-0001');
    expect(rowFor('PUR-0001').client_name).toBe('');
    // The unclaimed line still goes through — one conflict doesn't sink the batch.
    expect(result.tagged).toEqual(['PUR-0002']);
  });

  it('leaves a client set on the buy itself alone', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 4,
          unitPrice: 400,
          clientId: 'CLI-009',
          clientName: 'Leela',
        },
      ],
    });

    tagPurchasesToSession({
      sessionId: 'SMK-0003',
      purchaseIds: [purchases[0].purchase_id],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    // Whoever logged the buy said outright who it was for; inheriting from
    // whichever cook happened to eat it is the weaker claim.
    expect(rowFor(purchases[0].purchase_id)).toMatchObject({
      client_name: 'Leela',
      smoking_session_id: 'SMK-0003',
    });
  });

  it('treats purchaseIds as the full set, so unticking untags', () => {
    tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    const result = tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });

    expect(result.untagged).toEqual(['PUR-0002']);
    expect(rowFor('PUR-0002').smoking_session_id).toBe('');
    // Which account the money was for outlives any one cook.
    expect(rowFor('PUR-0002').client_name).toBe('Taj Hotel');
  });

  it('only touches the session it was given', () => {
    tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });
    tagPurchasesToSession({ sessionId: 'SMK-0002', purchaseIds: ['PUR-0002'] });

    expect(rowFor('PUR-0001').smoking_session_id).toBe('SMK-0001');
    expect(rowFor('PUR-0002').smoking_session_id).toBe('SMK-0002');
  });

  it('rejects a missing sessionId rather than blanking every tag', () => {
    expect(() => tagPurchasesToSession({ purchaseIds: ['PUR-0001'] })).toThrow(/sessionId is required/);
  });
});

describe('clearSessionPurchaseTags', () => {
  it('frees the spend but keeps the purchase', () => {
    tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    expect(clearSessionPurchaseTags('SMK-0001').untagged).toEqual(['PUR-0001']);
    // Deleting a mis-logged cook must not erase money that was actually spent.
    expect(rowFor('PUR-0001')).toMatchObject({
      smoking_session_id: '',
      client_name: 'Taj Hotel',
      total_cost: 4000,
    });
  });
});

describe('recordPurchases client tag', () => {
  it('stores a per-line client on B2B', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 6,
          unitPrice: 400,
          clientId: 'CLI-001',
          clientName: 'Taj Hotel',
        },
        { itemName: 'Butcher paper', unit: 'pcs', quantity: 20, unitPrice: 4 },
      ],
    });

    // Per line, because one butcher run routinely covers two accounts and one
    // cart routinely mixes a client's meat with packaging bought for nobody.
    expect(purchases.find((p) => p.item_name === 'Pork shoulder')).toMatchObject({
      client_id: 'CLI-001',
      client_name: 'Taj Hotel',
    });
    expect(purchases.find((p) => p.item_name === 'Butcher paper')).toMatchObject({
      client_id: '',
      client_name: '',
    });
    // Never pre-set here — the cook doesn't exist yet at buying time.
    expect(purchases.every((p) => p.smoking_session_id === '')).toBe(true);
  });

  it('drops a client tag on a B2C buy, which has no account book', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2C',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 3,
          unitPrice: 400,
          clientId: 'CLI-001',
          clientName: 'Taj Hotel',
        },
      ],
    });

    expect(purchases[0]).toMatchObject({ client_id: '', client_name: '' });
  });

  it('refuses a vendor that isn\'t in the book rather than inventing one', () => {
    // vendor_id is a foreign key now. The screen picks from a dropdown, so
    // the only way here is a name that was never added — and a purchase
    // logged against a vendor nobody can look up is worse than a refusal.
    expect(() =>
      recordPurchases({
        vendorName: 'Some Bloke At The Market',
        channel: 'B2C',
        lines: [{ itemName: 'Charcoal', unit: 'kg', quantity: 10, unitPrice: 30 }],
      }),
    ).toThrow(/No vendor called/);
  });

  it('records a piece-bought line as a count, a piece weight and a total in kg', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [
        { materialId: 'RM-047', itemName: 'Whole chicken', unit: 'pcs', quantity: 4, unitPrice: 450, weightPerUnitKg: 1.6 },
      ],
    });

    // The count stays the quantity — that is what the vendor invoices and
    // what moves stock — and the cost is per bird, so the line totals to four
    // birds' worth of money, not four kilos' worth.
    expect(purchases[0]).toMatchObject({
      quantity_purchased: 4,
      unit_of_measure: 'pcs',
      unit_price: 450,
      total_cost: 1800,
      weight_per_unit_kg: 1.6,
      // Derived on read rather than stored, so it can never disagree with the
      // two numbers it comes from.
      total_weight_kg: 6.4,
    });
  });

  it('leaves the piece weight blank when nobody weighed them', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [{ materialId: 'RM-047', itemName: 'Whole chicken', unit: 'pcs', quantity: 4, unitPrice: 450 }],
    });

    // Same reason the price below can be blank: unweighed is a real answer,
    // and a 0 would make the buy total to nothing in kg.
    expect(purchases[0]).toMatchObject({ quantity_purchased: 4, weight_per_unit_kg: '', total_weight_kg: '' });
  });

  it('refuses a piece weight of zero, which is a mis-typed box not an unknown', () => {
    expect(() =>
      recordPurchases({
        vendorName: 'Pork Shop',
        purchaseDate: '2026-08-18',
        channel: 'B2B',
        lines: [
          { materialId: 'RM-047', itemName: 'Whole chicken', unit: 'pcs', quantity: 4, unitPrice: 450, weightPerUnitKg: 0 },
        ],
      }),
    ).toThrow(/Weight of one Whole chicken/);
  });

  it('records a line with no price rather than calling it free', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2C',
      lines: [{ materialId: 'RM-001', itemName: 'Pork shoulder', unit: 'kg', quantity: 2 }],
    });

    // Blank, not 0: the meat was bought, the bill hasn't arrived, and a zero
    // would quietly total up as if it had been free.
    expect(purchases[0]).toMatchObject({ quantity_purchased: 2, unit_price: '', total_cost: '' });
  });
});
