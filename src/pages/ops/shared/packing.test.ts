import { describe, expect, it } from 'vitest';
import {
  SMOKER_LOADS,
  buildOrderSideGroups,
  containersNeeded,
  describeBoxes,
  describePacking,
  describeTotalPacking,
  portionSplit,
  orderMeatCategories,
  orderNeedsLoad,
  sideBoxTotals,
  smokerDays,
  sideBoxTotalsFromCounts,
  type MeatByItem,
  type PackGroup,
  type PackOrder,
  type SidesByItem,
} from './packing';

// Same containers server/core/packagingConfig.js hands down, shaped the way
// GET /api/recipes/sides-by-item delivers them.
const CUP = { materialId: 'RM-059', name: '30 ml portion cup', capacity: 30 };
const TRAY = { materialId: 'RM-039', name: '30 oz packaging', capacity: 887 };
// Sized in portions rather than millilitres — one onion to a tub, six chip
// portions to a foil sheet (server/core/packagingConfig.js, 2026-08-19).
const TUB = { materialId: 'RM-064', name: '2 oz container', capacity: 59, portionCapacity: 1 };
const FOIL = { materialId: 'RM-043', name: 'aluminium foil sheet', capacity: null, portionCapacity: 6 };

const SIDES: SidesByItem = {
  'chicken-bbq-burger': [
    { key: 'SR-015', name: 'BBQ sauce', qty: 30, baseQty: 30, container: CUP },
    { key: 'SR-017', name: 'Salad mix', qty: 100, baseQty: 100, container: TRAY },
    { key: 'SR-018', name: 'Salad dressing', qty: 15, baseQty: 15, container: CUP },
    // Counted in portions, not millilitres — one tub each.
    { key: 'SR-019', name: 'Chopped onion', qty: 1, baseQty: 1, container: TUB },
    { key: 'RM-037', name: 'Chips', qty: 20, baseQty: 20, container: FOIL },
  ],
  'bbq-ribs-250g': [
    { key: 'SR-015', name: 'BBQ sauce', qty: 30, baseQty: 30, container: CUP },
    { key: 'SR-017', name: 'Salad mix', qty: 100, baseQty: 100, container: TRAY },
  ],
};

const order = (orderId: number, items: { itemId: string; qty: number }[]): PackOrder => ({
  orderId,
  orderName: `S000${orderId}`,
  customer: 'Test',
  packBy: null,
  odooFulfilment: null,
  note: null,
  phone: '',
  address: '',
  addressName: '',
  itemCount: items.reduce((sum, i) => sum + i.qty, 0),
  items: items.map((i) => ({ ...i, name: i.itemId })),
});

describe('containersNeeded', () => {
  it('divides the quantity into the container capacity', () => {
    expect(containersNeeded(60, CUP)).toBe(2);
    expect(containersNeeded(45, CUP)).toBe(2); // part-full cup is still a cup
    expect(containersNeeded(400, TRAY)).toBe(1);
  });

  it('falls back to one box where there is no capacity to divide into', () => {
    expect(containersNeeded(4, null)).toBe(1);
    expect(containersNeeded(null, CUP)).toBe(1);
  });

  it('counts portions, not millilitres, where the container is sized that way', () => {
    // 8 chip portions at 6 to a sheet — the 160 g they weigh is irrelevant.
    expect(containersNeeded(160, FOIL, 8)).toBe(2);
    expect(containersNeeded(120, FOIL, 6)).toBe(1);
    // One caramelised onion per tub: 4 glaze burgers need 4 tubs.
    expect(containersNeeded(4, TUB, 4)).toBe(4);
  });
});

describe('portionSplit', () => {
  it('fills a sheet before starting the next', () => {
    expect(portionSplit(8, FOIL)).toEqual([6, 2]);
    expect(portionSplit(13, FOIL)).toEqual([6, 6, 1]);
  });

  it('says nothing where the portions all fit one box, or the box is sized by volume', () => {
    expect(portionSplit(4, FOIL)).toEqual([]);
    expect(portionSplit(6, FOIL)).toEqual([]);
    expect(portionSplit(4, TRAY)).toEqual([]);
  });
});

describe('buildOrderSideGroups', () => {
  const groups = buildOrderSideGroups(order(1, [{ itemId: 'chicken-bbq-burger', qty: 4 }]), SIDES);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

  it('packs four 100 g salads into one 30 oz box', () => {
    expect(byKey['SR-017'].baseQty).toBe(400);
    expect(byKey['SR-017'].boxes).toBe(1);
  });

  it('packs four 15 g dressings into two 30 ml cups', () => {
    expect(byKey['SR-018'].baseQty).toBe(60);
    expect(byKey['SR-018'].boxes).toBe(2);
  });

  it('will not pretend four 30 ml sauces share a 30 ml cup', () => {
    expect(byKey['SR-015'].boxes).toBe(4);
  });

  it('gives a portion-counted side one tub per portion', () => {
    expect(byKey['SR-019'].portions).toBe(4);
    expect(byKey['SR-019'].boxes).toBe(4);
  });

  it('wraps four chip portions into a single foil sheet', () => {
    expect(byKey['RM-037'].portions).toBe(4);
    expect(byKey['RM-037'].boxes).toBe(1);
  });

  it('spills the seventh chip portion onto a second sheet', () => {
    const big = buildOrderSideGroups(order(3, [{ itemId: 'chicken-bbq-burger', qty: 8 }]), SIDES);
    const chips = big.find((g) => g.key === 'RM-037')!;
    expect(chips.portions).toBe(8);
    expect(chips.boxes).toBe(2);
    expect(describePacking(chips.portions, chips.boxes, chips.container)).toBe(
      '2 × aluminium foil sheet — 6 + 2 portions',
    );
  });

  it('combines the same side across different dishes in one order', () => {
    const mixed = buildOrderSideGroups(
      order(2, [
        { itemId: 'chicken-bbq-burger', qty: 2 },
        { itemId: 'bbq-ribs-250g', qty: 2 },
      ]),
      SIDES,
    );
    const salad = mixed.find((g) => g.key === 'SR-017')!;
    expect(salad.portions).toBe(4);
    expect(salad.baseQty).toBe(400);
    expect(salad.boxes).toBe(1);
  });
});

describe('describeBoxes', () => {
  it('names the container', () => {
    expect(describeBoxes(2, CUP)).toBe('2 × 30 ml portion cup');
    expect(describeBoxes(1, null)).toBe('1 container');
    expect(describeBoxes(3, null)).toBe('3 containers');
  });
});

describe('describePacking', () => {
  it('spells out how the portions land in the boxes', () => {
    expect(describePacking(8, 2, FOIL)).toBe('2 × aluminium foil sheet — 6 + 2 portions');
    expect(describePacking(4, 4, TUB)).toBe('4 × 2 oz container — one portion each');
  });

  it('just names the box where there is no split worth spelling out', () => {
    expect(describePacking(4, 1, TRAY)).toBe('1 × 30 oz packaging');
    expect(describePacking(4, 1, FOIL)).toBe('1 × aluminium foil sheet');
    expect(describePacking(1, 1, TUB)).toBe('1 × 2 oz container');
  });
});

describe('describeTotalPacking', () => {
  it('never splits pooled portions the per-order box count contradicts', () => {
    // 12 chip portions across 8 orders is 8 sheets — not "6 + 6".
    expect(describeTotalPacking(12, 8, FOIL)).toBe('8 × aluminium foil sheet — up to 6 portions each');
    expect(describeTotalPacking(12, 2, FOIL)).toBe('2 × aluminium foil sheet — up to 6 portions each');
  });

  it('keeps the plain label where every portion has its own box', () => {
    expect(describeTotalPacking(4, 4, FOIL)).toBe('4 × aluminium foil sheet');
    expect(describeTotalPacking(4, 4, TUB)).toBe('4 × 2 oz container — one portion each');
    expect(describeTotalPacking(4, 2, TRAY)).toBe('2 × 30 oz packaging');
  });
});

describe('weekend totals', () => {
  // Eight burgers, but split across two customers — salad only combines
  // within an order, so that's two trays, not one.
  const orders = [
    order(1, [{ itemId: 'chicken-bbq-burger', qty: 4 }]),
    order(2, [{ itemId: 'chicken-bbq-burger', qty: 4 }]),
  ];

  it('sums boxes order by order', () => {
    const rows = Object.fromEntries(sideBoxTotals(orders, SIDES).map((r) => [r.key, r]));
    expect(rows['SR-017'].portions).toBe(8);
    expect(rows['SR-017'].boxes).toBe(2);
    expect(rows['SR-018'].boxes).toBe(4);
    expect(rows['SR-015'].boxes).toBe(8);
  });

  it('over-estimates rather than under-estimates without the individual orders', () => {
    const fromCounts = Object.fromEntries(
      sideBoxTotalsFromCounts({ 'chicken-bbq-burger': 8 }, SIDES).map((r) => [r.key, r]),
    );
    const perOrder = Object.fromEntries(sideBoxTotals(orders, SIDES).map((r) => [r.key, r]));
    Object.keys(perOrder).forEach((key) => {
      expect(fromCounts[key].boxes).toBeGreaterThanOrEqual(perOrder[key].boxes);
    });
    // One box per plate when nothing can be combined.
    expect(fromCounts['SR-017'].boxes).toBe(8);
  });
});

// Same shape GET /api/recipes/meat-by-item returns (server/ops/b2c/recipes.js
// getMeatByItem) — the dish's smoked-meat components, category keys from
// server/core/meatConfig.js.
const MEAT: MeatByItem = {
  'chicken-bbq-burger': [{ category: 'chicken', label: 'Shredded Chicken', productName: 'Pulled chicken' }],
  'pork-bbq-burger': [{ category: 'pulledPork', label: 'Pulled Pork', productName: 'Pulled pork' }],
  'bbq-ribs-250g': [{ category: 'ribs', label: 'Pork Ribs', productName: 'Smoked pork ribs' }],
  'jackfruit-burger': [{ category: 'jackfruit', label: 'Pulled Jackfruit', productName: 'Pulled jackfruit' }],
  'beef-ribs-250g': [{ category: 'beefRibs', label: 'Beef Ribs', productName: 'Smoked beef ribs' }],
  // A dish carrying both — one order of it belongs to both smoker loads.
  'combo-platter': [
    { category: 'beefRibs', label: 'Beef Ribs', productName: 'Smoked beef ribs' },
    { category: 'porkBelly', label: 'Pork Belly', productName: 'Pork belly burnt ends' },
  ],
};

const PORK = SMOKER_LOADS.find((l) => l.id === 'pork')!;
const BEEF = SMOKER_LOADS.find((l) => l.id === 'beef')!;
const CHICKEN = SMOKER_LOADS.find((l) => l.id === 'chicken')!;

describe('smoker loads', () => {
  it('reads every meat an order carries, deduped across its line items', () => {
    const both = order(1, [
      { itemId: 'chicken-bbq-burger', qty: 2 },
      { itemId: 'bbq-ribs-250g', qty: 1 },
      { itemId: 'combo-platter', qty: 1 },
    ]);
    expect([...orderMeatCategories(both, MEAT)].sort()).toEqual(['beefRibs', 'chicken', 'porkBelly', 'ribs']);
  });

  it('puts every pork cut behind the one pork switch', () => {
    expect(orderNeedsLoad(order(1, [{ itemId: 'pork-bbq-burger', qty: 1 }]), MEAT, PORK)).toBe(true);
    expect(orderNeedsLoad(order(2, [{ itemId: 'bbq-ribs-250g', qty: 1 }]), MEAT, PORK)).toBe(true);
    expect(orderNeedsLoad(order(3, [{ itemId: 'combo-platter', qty: 1 }]), MEAT, PORK)).toBe(true);
  });

  it('counts an order in both loads when it carries both meats', () => {
    const combo = order(1, [{ itemId: 'combo-platter', qty: 1 }]);
    expect(orderNeedsLoad(combo, MEAT, PORK)).toBe(true);
    expect(orderNeedsLoad(combo, MEAT, BEEF)).toBe(true);
  });

  it('puts beef ribs behind the beef switch and nothing else', () => {
    const beefOnly = order(1, [{ itemId: 'beef-ribs-250g', qty: 2 }]);
    expect(orderNeedsLoad(beefOnly, MEAT, BEEF)).toBe(true);
    expect(orderNeedsLoad(beefOnly, MEAT, PORK)).toBe(false);
  });

  it('puts chicken behind its own switch, not pork’s', () => {
    // Chicken is a much shorter smoke than the shoulders, so it is its own
    // load — sweeping it with pork would stamp the wrong time on a
    // chicken-only order.
    const chickenOnly = order(1, [{ itemId: 'chicken-bbq-burger', qty: 3 }]);
    expect(orderNeedsLoad(chickenOnly, MEAT, CHICKEN)).toBe(true);
    expect(orderNeedsLoad(chickenOnly, MEAT, PORK)).toBe(false);
    expect(orderNeedsLoad(chickenOnly, MEAT, BEEF)).toBe(false);
    // ...and a pork order is not swept onto the chicken switch either.
    expect(orderNeedsLoad(order(2, [{ itemId: 'pork-bbq-burger', qty: 1 }]), MEAT, CHICKEN)).toBe(false);
  });

  it('leaves out orders with none of that load, and meats with no switch', () => {
    // Jackfruit has no switch — it belongs to no load, so it is driven from
    // the per-order dropdown instead of being swept into one.
    const jackfruit = order(1, [{ itemId: 'jackfruit-burger', qty: 1 }]);
    expect(SMOKER_LOADS.every((load) => !orderNeedsLoad(jackfruit, MEAT, load))).toBe(true);
  });

  it('matches nothing rather than guessing while the reference data is missing', () => {
    const pork = order(1, [{ itemId: 'pork-bbq-burger', qty: 1 }]);
    expect(orderNeedsLoad(pork, null, PORK)).toBe(false);
    // An item with no recipe line for a smoked meat isn't in the map at all.
    expect(orderNeedsLoad(order(2, [{ itemId: 'side-of-chips', qty: 1 }]), MEAT, PORK)).toBe(false);
  });
});

const group = (id: string, label: string, orders: PackOrder[]): PackGroup => ({
  id,
  label,
  sublabel: label,
  emoji: '🌤️',
  orders,
});

describe('smokerDays', () => {
  it('collapses the four B2C services into Saturday and Sunday', () => {
    const days = smokerDays([
      group('satLunch', 'Saturday Lunch', [order(1, [{ itemId: 'pork-bbq-burger', qty: 1 }])]),
      group('satEvening', 'Saturday Dinner', [order(2, [{ itemId: 'chicken-bbq-burger', qty: 1 }])]),
      group('sunLunch', 'Sunday Lunch', [order(3, [{ itemId: 'bbq-ribs-250g', qty: 1 }])]),
      group('sunEvening', 'Sunday Dinner', []),
    ]);
    expect(days.map((d) => d.id)).toEqual(['sat', 'sun']);
    expect(days.map((d) => d.label)).toEqual(['Saturday', 'Sunday']);
    // Lighting Saturday must not sweep up Sunday's order.
    expect(days[0].orders.map((o) => o.orderId)).toEqual([1, 2]);
    expect(days[1].orders.map((o) => o.orderId)).toEqual([3]);
  });

  it('keeps an empty day so it still shows as having nothing on the smoker', () => {
    const days = smokerDays([group('satLunch', 'Saturday Lunch', []), group('sunLunch', 'Sunday Lunch', [])]);
    expect(days).toHaveLength(2);
    expect(days.every((d) => d.orders.length === 0)).toBe(true);
  });

  it('leaves B2B delivery days as their own buckets, in the order the server sent them', () => {
    const days = smokerDays([
      group('2026-09-03', 'Thu 3 Sep', [order(1, [{ itemId: 'pork-bbq-burger', qty: 1 }])]),
      group('2026-09-05', 'Sat 5 Sep', [order(2, [{ itemId: 'chicken-bbq-burger', qty: 1 }])]),
    ]);
    expect(days.map((d) => d.id)).toEqual(['2026-09-03', '2026-09-05']);
    expect(days.map((d) => d.label)).toEqual(['Thu 3 Sep', 'Sat 5 Sep']);
  });
});
