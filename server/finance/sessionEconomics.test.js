// Cost to Make's per-session lens. Everything is handed in, so these pin the
// three rules a wrong number would come from: which rate a cook's meat is
// priced at, which yield its per-kilo figures use, and which order lines it
// is credited with — once, and only once.
import { describe, it, expect } from 'vitest';
import { costSessions } from './sessionEconomics.js';

// Pork shoulder, bought by the kilo and counted in grams. meatConfig puts it
// in pulledPork: product IP-003, 40% loss, so a 60% planned yield.
const materialCosts = new Map([
  [
    'RM-051',
    {
      materialId: 'RM-051',
      basis: { bomUnits: 1000, unit: 'g' },
      perBomUnit: 0.5, // ₹500/kg, the latest purchase
      price: { source: 'purchase', ref: 'PUR-LATEST', asOf: '2026-08-20' },
      gap: null,
    },
  ],
  [
    'RM-053',
    {
      materialId: 'RM-053',
      basis: null,
      perBomUnit: null,
      price: null,
      gap: 'no price or pack size on file',
    },
  ],
]);

const purchases = [
  {
    purchase_id: 'PUR-OWN',
    material_id: 'RM-051',
    unit_price: 520,
    quantity_purchased: 5,
    total_cost: 2600,
    smoking_session_id: 'SMK-1',
  },
  {
    purchase_id: 'PUR-WOOD',
    material_id: 'RM-900',
    item_name: 'Oak chunks',
    unit_price: 300,
    quantity_purchased: 1,
    total_cost: 300,
    smoking_session_id: 'SMK-1',
  },
];

const session = (over = {}) => ({
  session_id: 'SMK-1',
  session_date: '2026-09-04',
  channel: 'B2C',
  session_purpose: 'Order',
  source_material_id: 'RM-051',
  source_material_name: 'Pork shoulder',
  source_purchase_id: 'PUR-OWN',
  output_product_id: '',
  output_type: 'Pulled',
  raw_weight_kg: 4,
  finished_weight_with_bone_kg: '',
  finished_weight_without_bone_kg: '',
  yield_pct: '',
  fed_order_refs: '',
  stage: 'smoking',
  ...over,
});

const dishes = new Map([
  ['pork-burger', { itemId: 'pork-burger', name: 'Pork burger', price: 449 }],
  ['chicken-burger', { itemId: 'chicken-burger', name: 'Chicken burger', price: 299 }],
]);
const productGrams = new Map([
  ['pork-burger', new Map([['IP-003', 110]])],
  ['chicken-burger', new Map([['IP-001', 110]])],
]);

const line = (over = {}) => ({
  orderId: 10,
  day: '2026-09-02',
  promisedDay: '2026-09-05',
  itemId: 'pork-burger',
  productName: 'Pork burger',
  quantity: 2,
  revenue: 898,
  ...over,
});

const run = (sessions, orderLines = []) =>
  costSessions({
    sessions,
    purchases,
    materialCosts,
    orderLines,
    dishes,
    productGrams,
  });

describe('costSessions — cost', () => {
  it("prices the meat at the cook's own purchase before the latest one", () => {
    const [cook] = run([session()]).sessions;
    expect(cook.rate).toMatchObject({
      perKg: 520,
      source: "this cook's purchase",
      ref: 'PUR-OWN',
    });
    expect(cook.meatCost).toBe(2080);
  });

  it('falls back to the latest purchase when the session names none', () => {
    const [cook] = run([session({ source_purchase_id: '' })]).sessions;
    expect(cook.rate).toMatchObject({ perKg: 500, source: 'latest purchase' });
  });

  it('adds other spend tagged to the cook, but never the meat line twice', () => {
    const [cook] = run([session()]).sessions;
    expect(cook.otherSpend).toEqual([{ purchaseId: 'PUR-WOOD', name: 'Oak chunks', cost: 300 }]);
    expect(cook.knownCost).toBe(2380);
  });

  it('names the gap for a cut with no price rather than costing it at zero', () => {
    const [cook] = run([session({ source_material_id: 'RM-053', source_purchase_id: '' })]).sessions;
    expect(cook.meatCost).toBeNull();
    expect(cook.knownCost).toBeNull();
    expect(cook.rateGap).toBe('no price or pack size on file');
  });
});

describe('costSessions — yield', () => {
  it('uses the planned yield until the cook is weighed, and says so', () => {
    const [cook] = run([session()]).sessions;
    expect(cook.productId).toBe('IP-003');
    expect(cook.plannedYieldPct).toBe(60);
    expect(cook.finishedSource).toBe('planned');
    expect(cook.finishedKg).toBe(2.4);
    expect(cook.costPerFinishedKg).toBe(cook.plannedCostPerFinishedKg);
  });

  it('uses the weighed boneless weight for pulled meat', () => {
    const [cook] = run([
      session({
        finished_weight_without_bone_kg: 2,
        finished_weight_with_bone_kg: 2.4,
      }),
    ]).sessions;
    expect(cook.finishedSource).toBe('recorded');
    expect(cook.finishedKg).toBe(2);
    expect(cook.actualYieldPct).toBe(50);
    // ₹2,080 over 2 kg, against ₹520 / 0.60 on the plan.
    expect(cook.costPerFinishedKg).toBe(1040);
    const burger = cook.portions.find((portion) => portion.itemId === 'pork-burger');
    expect(burger.meatCostEach).toBe(114.4);
    expect(burger.plannedMeatCostEach).toBe(95.33);
    expect(burger.portionsPossible).toBe(18);
  });
});

describe('costSessions — what a cook fed', () => {
  it("credits the week's orders for its own meat only", () => {
    const { sessions } = run(
      [session()],
      [
        line(),
        line({
          itemId: 'chicken-burger',
          productName: 'Chicken burger',
          quantity: 3,
          revenue: 897,
        }),
      ],
    );
    const [cook] = sessions;
    expect(cook.attribution).toBe('week');
    expect(cook.plates).toBe(2);
    expect(cook.revenue).toBe(898);
    expect(cook.gramsSold).toBe(220);
    expect(cook.meatCostPerPlate).toBe(1040);
  });

  it('ignores orders promised in a different week', () => {
    const [cook] = run([session()], [line({ promisedDay: '2026-09-12' })]).sessions;
    expect(cook.orders).toBe(0);
  });

  it('splits a line two cooks of the same meat could claim by raw weight', () => {
    const { sessions } = run(
      [
        session(),
        session({
          session_id: 'SMK-2',
          raw_weight_kg: 1,
          source_purchase_id: '',
        }),
      ],
      [line({ quantity: 5, revenue: 2000 })],
    );
    const byId = Object.fromEntries(sessions.map((cook) => [cook.sessionId, cook]));
    expect(byId['SMK-1'].plates).toBe(4);
    expect(byId['SMK-2'].plates).toBe(1);
    expect(byId['SMK-1'].revenue + byId['SMK-2'].revenue).toBe(2000);
  });

  it('lets a cook that lists its orders win them outright', () => {
    const { sessions, sessionsByOrder } = run(
      [session({ fed_order_refs: '10:S010' }), session({ session_id: 'SMK-2', source_purchase_id: '' })],
      [line()],
    );
    const byId = Object.fromEntries(sessions.map((cook) => [cook.sessionId, cook]));
    expect(byId['SMK-1'].attribution).toBe('linked');
    expect(byId['SMK-1'].plates).toBe(2);
    expect(byId['SMK-2'].plates).toBe(0);
    expect(sessionsByOrder.get(10)).toEqual(['SMK-1']);
  });

  it('costs a sample cook but credits it nothing', () => {
    const [cook] = run([session({ session_purpose: 'Sample' })], [line()]).sessions;
    expect(cook.attribution).toBe('none');
    expect(cook.revenue).toBe(0);
    expect(cook.meatCost).toBe(2080);
  });

  it('adds cooks up per meat, weighting the rate by kilo', () => {
    const { summary } = run([
      session(),
      session({
        session_id: 'SMK-2',
        raw_weight_kg: 1,
        source_purchase_id: '',
      }),
    ]);
    expect(summary.byMeat).toHaveLength(1);
    // 4 kg at 520 and 1 kg at 500 is 2,580 over 5 kg.
    expect(summary.byMeat[0].avgRatePerKg).toBe(516);
    expect(summary.rawKg).toBe(5);
  });
});
