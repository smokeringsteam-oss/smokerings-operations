import React, { useEffect, useMemo, useState } from 'react';

const LOCAL_STORAGE_KEY = 'kitchen-prep-orders-v1';

// Real Smoke Rings BBQ menu (smokerings.in), grouped the way the menu card is.
const COLLECTIONS: { id: string; label: string }[] = [
  { id: 'smoked-chicken', label: 'The Smoked Chicken Collection' },
  { id: 'smoked-pork', label: 'The Smoked Pork Collection' },
  { id: 'pitmasters-favourite', label: "Pitmaster's Favourite" },
];

const MENU_ITEMS: { id: string; name: string; collection: string }[] = [
  { id: 'chicken-bbq-burger', name: 'Signature Pulled Chicken BBQ Burger', collection: 'smoked-chicken' },
  { id: 'chicken-glaze-burger', name: 'Smoke and Glaze Pulled Chicken Burger', collection: 'smoked-chicken' },
  { id: 'chicken-tacos', name: 'Smoked Chicken Tacos', collection: 'smoked-chicken' },
  { id: 'chicken-quesadilla', name: 'Smoked Chicken Quesadilla', collection: 'smoked-chicken' },
  { id: 'pork-bbq-burger', name: 'Signature Pulled Pork BBQ Burger', collection: 'smoked-pork' },
  { id: 'pork-glaze-burger', name: 'Smoke and Glaze Pulled Pork Burger', collection: 'smoked-pork' },
  { id: 'pork-tacos', name: 'Smoked Pork Tacos', collection: 'smoked-pork' },
  { id: 'pork-quesadilla', name: 'Smoked Pork Quesadilla', collection: 'smoked-pork' },
  { id: 'pork-burnt-ends', name: 'Pork Burnt Ends (150g)', collection: 'pitmasters-favourite' },
  { id: 'bbq-ribs-250g', name: 'Smokey BBQ Ribs (250g)', collection: 'pitmasters-favourite' },
  { id: 'bbq-ribs-half-rack', name: 'Smokey BBQ Ribs (1/2 rack, 6-7 ribs)', collection: 'pitmasters-favourite' },
];

const SLOTS: { id: string; day: string; part: string }[] = [
  { id: 'satLunch', day: 'Saturday', part: 'Lunch' },
  { id: 'satEvening', day: 'Saturday', part: 'Evening' },
  { id: 'sunLunch', day: 'Sunday', part: 'Lunch' },
  { id: 'sunEvening', day: 'Sunday', part: 'Evening' },
];

type OrderMap = Record<string, Record<string, number>>;

type ExtractedOrder = {
  itemId: string;
  slotId: string;
  quantity: number;
};

const ITEM_NAME_BY_ID: Record<string, string> = Object.fromEntries(MENU_ITEMS.map((item) => [item.id, item.name]));

// ---- Recipes & vendors -----------------------------------------------------
// Straight from the kitchen's own numbers. Anything marked `assumed: true`
// wasn't given a specific quantity — it's defaulted to a reasonable
// placeholder (same portion as the closest known dish, or "1 unit") so the
// shopping list still has a line for it. Check the "Assumptions" note below
// the tables and correct the recipe here once the real amounts are known.

type Vendor = 'meat' | 'swiggy' | 'breadTimeStories';
type Protein = 'chicken' | 'pork';
type DishFamily = 'bbq-burger' | 'glaze-burger' | 'tacos' | 'quesadilla';

type RecipeLine = {
  name: string;
  qtyPerOrder: number;
  unit: 'g' | 'ml' | 'unit';
  vendor: Vendor;
  isMeat?: boolean; // the protein amount — routed to the meat totals instead of a vendor list
  assumed?: boolean;
};

const DISH_RECIPES: Record<DishFamily, RecipeLine[]> = {
  'bbq-burger': [
    { name: 'Burger bun', qtyPerOrder: 1, unit: 'unit', vendor: 'breadTimeStories' },
    { name: 'Pulled meat', qtyPerOrder: 120, unit: 'g', vendor: 'meat', isMeat: true },
    { name: 'BBQ sauce', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
    { name: 'Coleslaw', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
    { name: 'Burger sauce', qtyPerOrder: 10, unit: 'ml', vendor: 'swiggy' },
    { name: 'Chips', qtyPerOrder: 20, unit: 'g', vendor: 'swiggy' },
    { name: 'Salad', qtyPerOrder: 70, unit: 'g', vendor: 'swiggy' },
  ],
  'glaze-burger': [
    { name: 'Burger bun', qtyPerOrder: 1, unit: 'unit', vendor: 'breadTimeStories' },
    { name: 'Lettuce', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy', assumed: true },
    { name: 'Umami glazed meat', qtyPerOrder: 120, unit: 'g', vendor: 'meat', isMeat: true },
    { name: 'Caramelised onions', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy', assumed: true },
    // Chips & salad quantity weren't given for this dish — defaulted to the same portion as the BBQ burger.
    { name: 'Chips', qtyPerOrder: 20, unit: 'g', vendor: 'swiggy', assumed: true },
    { name: 'Salad', qtyPerOrder: 70, unit: 'g', vendor: 'swiggy', assumed: true },
  ],
  tacos: [
    { name: 'Taco shells', qtyPerOrder: 3, unit: 'unit', vendor: 'breadTimeStories' },
    { name: 'Meat', qtyPerOrder: 150, unit: 'g', vendor: 'meat', isMeat: true },
    { name: 'Onion', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy', assumed: true },
    { name: 'Sour cream', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
    { name: 'Taco seasoning', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy', assumed: true },
    { name: 'Salsa verde', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
  ],
  quesadilla: [
    { name: 'Tortilla', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy' },
    { name: 'Cheese', qtyPerOrder: 50, unit: 'g', vendor: 'swiggy' },
    { name: 'Taco seasoning', qtyPerOrder: 1, unit: 'unit', vendor: 'swiggy', assumed: true },
    { name: 'Sour cream', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
    { name: 'Salsa verde', qtyPerOrder: 30, unit: 'ml', vendor: 'swiggy' },
    { name: 'Meat', qtyPerOrder: 120, unit: 'g', vendor: 'meat', isMeat: true },
  ],
};

// Which dish family (recipe) and protein each orderable menu item resolves to.
// Ribs & burnt ends aren't built from a recipe above — they're bought as
// pre-portioned smoked cuts, handled directly as meat-vendor line items.
const ITEM_DISH_FAMILY: Partial<Record<string, DishFamily>> = {
  'chicken-bbq-burger': 'bbq-burger',
  'pork-bbq-burger': 'bbq-burger',
  'chicken-glaze-burger': 'glaze-burger',
  'pork-glaze-burger': 'glaze-burger',
  'chicken-tacos': 'tacos',
  'pork-tacos': 'tacos',
  'chicken-quesadilla': 'quesadilla',
  'pork-quesadilla': 'quesadilla',
};

const ITEM_PROTEIN: Partial<Record<string, Protein>> = {
  'chicken-bbq-burger': 'chicken',
  'chicken-glaze-burger': 'chicken',
  'chicken-tacos': 'chicken',
  'chicken-quesadilla': 'chicken',
  'pork-bbq-burger': 'pork',
  'pork-glaze-burger': 'pork',
  'pork-tacos': 'pork',
  'pork-quesadilla': 'pork',
  'pork-burnt-ends': 'pork',
  'bbq-ribs-250g': 'pork',
  'bbq-ribs-half-rack': 'pork',
};

// Pre-portioned smoked cuts bought directly from the meat vendor — not built from a recipe.
const PORTIONED_CUTS: { itemId: string; gramsPerOrder: number | null }[] = [
  { itemId: 'pork-burnt-ends', gramsPerOrder: 150 },
  { itemId: 'bbq-ribs-250g', gramsPerOrder: 250 },
  // Weight per half-rack isn't on file — reported as a rack count only, not folded into the kg total.
  { itemId: 'bbq-ribs-half-rack', gramsPerOrder: null },
];

const BREAD_TIME_STORIES_CATALOG: Record<string, { priceInr: number; moq: number }> = {
  'Burger bun': { priceInr: 25, moq: 12 },
  'Taco shells': { priceInr: 20, moq: 10 },
};

// Garlic bread comes as a 2-foot baguette (₹60 each), cut into ~30 slices —
// you can only buy whole baguettes, not loose slices — and each side order
// uses 3 slices.
const GARLIC_BREAD_SLICES_PER_BAGUETTE = 30;
const GARLIC_BREAD_SLICES_PER_SIDE = 3;
const GARLIC_BREAD_PRICE_PER_BAGUETTE_INR = 60;

const formatWeight = (grams: number) => (grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${Math.round(grams)} g`);
const roundUpToMultiple = (qty: number, multiple: number) => (qty <= 0 ? 0 : Math.ceil(qty / multiple) * multiple);
const inrFormat = (n: number) => `₹${n.toLocaleString('en-IN')}`;

const formatDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Defaults the Odoo fetch range to "last Friday through this Monday" — the
// most recently completed Fri–Mon weekend block, whatever day it is today.
// This is local-calendar math (not UTC): find this week's Monday (today if
// today IS Monday), then step back 3 days for the Friday before it.
const getDefaultOdooRange = () => {
  const today = new Date();
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - daysSinceMonday);
  const lastFriday = new Date(thisMonday);
  lastFriday.setDate(thisMonday.getDate() - 3);
  return { from: formatDateInput(lastFriday), to: formatDateInput(thisMonday) };
};
const DEFAULT_ODOO_RANGE = getDefaultOdooRange();

type VendorLineTotal = { qty: number; unit: RecipeLine['unit']; assumed: boolean };
type MeatBreakdownLine = { label: string; count: number; gramsPerOrder: number; grams: number };

// ---- Sides needed & Swiggy order (server/recipes.js) ----------------------
// Driven by menu.csv / recipe_ingredients.csv / rub_recipes.csv /
// rub_recipe_ingredients.csv — replaces the old hardcoded Swiggy guesses in
// DISH_RECIPES above with the real per-order ingredient data and known batch
// yields. Meat needed and Bread Time Stories sections above still use the
// static DISH_RECIPES model; only the Swiggy side of Step 2 is data-driven.
type DishTypeTotal = {
  id: string;
  label: string;
  total: number;
  items: { itemId: string; name: string; count: number }[];
};
type SideRow = {
  name: string;
  portions: number;
  totalQty: number;
  unit: string;
  hasUnparsedQty: boolean;
  subRecipeId: string | null;
  batchInfo: { batches: number; batchYield: number; batchUnit: string } | null;
};
type SwiggyIngredient = { name: string; materialId: string | null; unit: string; qty: number };
type SwiggyPlan = { dishTypeTotals: DishTypeTotal[]; sides: SideRow[]; swiggyList: SwiggyIngredient[]; gaps: string[] };

// ---- Smoking-loss config ---------------------------------------------------
// Static reference numbers for converting served/output meat weight into raw
// purchase weight — this is a settled calculation, not a live-tunable
// calculator, so these are plain constants. Update them directly in code once
// better numbers are confirmed.
// Pulled pork (shoulder), ribs, and pork belly (burnt ends) each lose weight
// at their own rate — different cuts, different smoke times. Confirmed so
// far: chicken at 50% (whole bone-in legs, already netting out the bone),
// pulled pork at 56%, and ribs at 30%. Pork belly still defaults to the
// original 35-40% shoulder/ribs range (midpoint, 37.5%) as a placeholder —
// it's the only one left without its own confirmed number.
const MEAT_LOSS = {
  pulledPorkLossPct: 56,
  ribsLossPct: 30,
  porkBellyLossPct: 37.5,
  chickenLossPct: 50,
  // Half-rack raw weight, derived from the same 2.37kg / 2 racks purchase above.
  halfRackRawWeightG: 1185,
  chickenLegRawWeightG: 0,
  // Pork shoulder can only be bought in 1.2kg minimum units — round the buy
  // quantity up to the nearest multiple, same idea as the Bread Time Stories
  // MOQs below.
  pulledPorkMoqG: 1200,
};

// Static reference tile: every dish's contribution, then three plain-English
// lines — Required / Buy raw / Wastage — so the whole calculation reads like
// a checklist, not a black-box number.
const MeatCategoryTile = ({
  icon,
  title,
  colorClass,
  lossPct,
  requiredNoun,
  buyNoun,
  breakdownLines,
  outputGrams,
  buyLabel,
  wastageGrams,
  extra,
}: {
  icon: string;
  title: string;
  colorClass: 'pork' | 'chicken';
  lossPct: number;
  requiredNoun: string;
  buyNoun: string;
  breakdownLines: MeatBreakdownLine[];
  outputGrams: number;
  buyLabel: string;
  wastageGrams: number | null;
  extra?: React.ReactNode;
}) => (
  <div className={`inv-compact-tile ${colorClass}`}>
    <div className="inv-compact-head">
      <span className="inv-compact-title">
        {icon} {title}
      </span>
      <span className="inv-pct-static">{lossPct}% loss</span>
    </div>
    {breakdownLines.length > 0 && (
      <ul className="inv-compact-breakdown">
        {breakdownLines.map((line, index) => (
          <li key={index}>
            <span>{line.label}</span>
            <span>
              {line.count} × {line.gramsPerOrder}g = {formatWeight(line.grams)}
            </span>
          </li>
        ))}
      </ul>
    )}
    <div className="inv-compact-total">
      <span>Required {requiredNoun}</span>
      <span>{formatWeight(outputGrams)}</span>
    </div>
    <div className="inv-compact-buy">
      <span className="inv-compact-buy-label">Buy raw {buyNoun}</span>
      <span className="inv-compact-buy-value">{buyLabel}</span>
    </div>
    {wastageGrams != null && (
      <div className="inv-compact-waste">
        <span>Wastage</span>
        <span>{wastageGrams > 0 ? formatWeight(wastageGrams) : 'None'}</span>
      </div>
    )}
    {extra}
  </div>
);

const WeekendPrepPlanner: React.FC = () => {
  const [step, setStep] = useState(1);
  const [orders, setOrders] = useState<OrderMap>({});
  const [unmatchedLines, setUnmatchedLines] = useState<string[]>([]);
  const [odooFrom, setOdooFrom] = useState(DEFAULT_ODOO_RANGE.from);
  const [odooTo, setOdooTo] = useState(DEFAULT_ODOO_RANGE.to);
  const [isFetchingOdoo, setIsFetchingOdoo] = useState(false);
  const [odooStatus, setOdooStatus] = useState('');
  const [odooError, setOdooError] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!stored) {
      return;
    }
    try {
      const parsed: OrderMap = JSON.parse(stored);
      setOrders(parsed || {});
    } catch {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(orders));
  }, [orders]);

  const rowTotal = (itemId: string) =>
    SLOTS.reduce((sum, slot) => sum + (orders[itemId]?.[slot.id] || 0), 0);

  const colTotal = (slotId: string) =>
    MENU_ITEMS.reduce((sum, item) => sum + (orders[item.id]?.[slotId] || 0), 0);

  const grandTotal = useMemo(() => SLOTS.reduce((sum, slot) => sum + colTotal(slot.id), 0), [orders]);

  const handleClear = () => {
    window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    setOrders({});
    setStep(1);
  };

  const applyExtractedOrders = (entries: ExtractedOrder[]) => {
    setOrders((current) => {
      const next: OrderMap = { ...current };
      entries.forEach(({ itemId, slotId, quantity }) => {
        const itemSlots = { ...(next[itemId] || {}) };
        itemSlots[slotId] = Math.max(0, Math.floor((itemSlots[slotId] || 0) + quantity));
        next[itemId] = itemSlots;
      });
      return next;
    });
  };

  const handleFetchOdoo = async () => {
    if (!odooFrom || !odooTo || isFetchingOdoo) {
      return;
    }

    setIsFetchingOdoo(true);
    setOdooError('');
    setOdooStatus('');

    try {
      const resp = await fetch(`/api/odoo/orders?from=${odooFrom}&to=${odooTo}`);
      let data: { orders?: ExtractedOrder[]; unmatched?: string[]; ordersFound?: number; error?: string };
      try {
        data = await resp.json();
      } catch {
        throw new Error(
          'Got an empty response from the server. Is the backend running (npm run start-server)? Try again.',
        );
      }
      if (!resp.ok) throw new Error(data.error || 'Odoo request failed.');

      const entries: ExtractedOrder[] = Array.isArray(data.orders) ? data.orders : [];
      const unmatched: string[] = Array.isArray(data.unmatched) ? data.unmatched : [];
      const ordersFound = data.ordersFound || 0;

      if (entries.length) {
        applyExtractedOrders(entries);
        setOdooStatus(
          `Pulled ${ordersFound} order${ordersFound === 1 ? '' : 's'} from Odoo — added ${entries.length} line item${
            entries.length === 1 ? '' : 's'
          } to the dashboard.`,
        );
      } else {
        setOdooStatus(
          ordersFound > 0
            ? `Found ${ordersFound} order${ordersFound === 1 ? '' : 's'} in that range, but none matched a Sat/Sun slot or a known menu item.`
            : 'No confirmed B2C orders found in that date range.',
        );
      }
      setUnmatchedLines(unmatched);
    } catch (err) {
      setOdooError(String((err as Error).message || err));
    } finally {
      setIsFetchingOdoo(false);
    }
  };

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    }
  };

  const handleBack = () => {
    setStep((current) => Math.max(1, current - 1));
  };

  // ---- Step 2: derive the shopping list from Step 1's order counts --------
  const inventory = useMemo(() => {
    const meatGrams: Record<Protein, number> = { chicken: 0, pork: 0 };
    const meatBreakdown: Record<Protein, MeatBreakdownLine[]> = { chicken: [], pork: [] };
    const vendorTotals: Record<'swiggy' | 'breadTimeStories', Record<string, VendorLineTotal>> = {
      swiggy: {},
      breadTimeStories: {},
    };

    const addVendorLine = (vendor: 'swiggy' | 'breadTimeStories', line: RecipeLine, qty: number) => {
      const bucket = vendorTotals[vendor];
      if (!bucket[line.name]) {
        bucket[line.name] = { qty: 0, unit: line.unit, assumed: false };
      }
      bucket[line.name].qty += qty;
      if (line.assumed) bucket[line.name].assumed = true;
    };

    MENU_ITEMS.forEach((item) => {
      const count = rowTotal(item.id);
      if (!count) return;

      const family = ITEM_DISH_FAMILY[item.id];
      if (!family) return; // ribs/burnt-ends handled below
      const protein = ITEM_PROTEIN[item.id];
      if (!protein) return;

      DISH_RECIPES[family].forEach((line) => {
        const totalQty = line.qtyPerOrder * count;
        if (line.isMeat) {
          meatGrams[protein] += totalQty;
          meatBreakdown[protein].push({ label: item.name, count, gramsPerOrder: line.qtyPerOrder, grams: totalQty });
        } else if (line.vendor === 'swiggy') {
          addVendorLine('swiggy', line, totalQty);
        } else if (line.vendor === 'breadTimeStories') {
          addVendorLine('breadTimeStories', line, totalQty);
        }
      });
    });

    const portionedLines = PORTIONED_CUTS.map((cut) => {
      const count = rowTotal(cut.itemId);
      const grams = cut.gramsPerOrder != null ? count * cut.gramsPerOrder : null;
      if (grams) meatGrams.pork += grams;
      return { itemId: cut.itemId, name: ITEM_NAME_BY_ID[cut.itemId] || cut.itemId, count, grams };
    });

    return { meatGrams, meatBreakdown, vendorTotals, portionedLines };
  }, [orders]);

  // ---- Raw meat to buy, accounting for smoking loss ------------------------
  // Four independent categories, each with its own loss %: pulled pork
  // (shoulder), pork belly (burnt ends), ribs, and shredded chicken (whole
  // bone-in legs). Pulled pork & belly are bought by weight. 250g rib
  // portions are cut from whole racks, so their raw-weight need converts into
  // "how many more racks" via the half-rack's raw weight; half-rack ORDERS
  // are smoked and served as one intact rack each, so those convert 1:1 with
  // no weight math. Chicken legs convert the same way via raw weight/leg.
  const rawMeatPlan = useMemo(() => {
    const bellyLine = inventory.portionedLines.find((l) => l.itemId === 'pork-burnt-ends');
    const rib250Line = inventory.portionedLines.find((l) => l.itemId === 'bbq-ribs-250g');
    const bellyOutputGrams = bellyLine?.grams || 0;
    const bellyCount = bellyLine?.count || 0;
    const rib250Grams = rib250Line?.grams || 0;
    const rib250Count = rib250Line?.count || 0;
    const halfRackCount = inventory.portionedLines.find((l) => l.itemId === 'bbq-ribs-half-rack')?.count || 0;

    const pulledPorkOutputGrams = inventory.meatBreakdown.pork.reduce((sum, l) => sum + l.grams, 0);
    const chickenOutputGrams = inventory.meatGrams.chicken;

    const {
      pulledPorkLossPct,
      ribsLossPct,
      porkBellyLossPct,
      chickenLossPct,
      halfRackRawWeightG,
      chickenLegRawWeightG,
      pulledPorkMoqG,
    } = MEAT_LOSS;

    const pulledPorkYield = 1 - pulledPorkLossPct / 100;
    const bellyYield = 1 - porkBellyLossPct / 100;
    const ribsYield = 1 - ribsLossPct / 100;
    const chickenYield = 1 - chickenLossPct / 100;

    const toRaw = (outputGrams: number, yieldPct: number) => (yieldPct > 0 ? outputGrams / yieldPct : 0);

    const pulledPorkRawGrams = toRaw(pulledPorkOutputGrams, pulledPorkYield);
    const pulledPorkBuyGrams = pulledPorkMoqG > 0 ? roundUpToMultiple(pulledPorkRawGrams, pulledPorkMoqG) : pulledPorkRawGrams;
    const bellyRawGrams = toRaw(bellyOutputGrams, bellyYield);
    const ribPortionRawGrams = toRaw(rib250Grams, ribsYield);
    const chickenRawGrams = toRaw(chickenOutputGrams, chickenYield);

    const racksForPortions = halfRackRawWeightG > 0 ? Math.ceil(ribPortionRawGrams / halfRackRawWeightG) : null;
    const totalRacks = racksForPortions != null ? racksForPortions + halfRackCount : null;
    const legsToBuy = chickenLegRawWeightG > 0 ? Math.ceil(chickenRawGrams / chickenLegRawWeightG) : null;

    // Wastage has to be measured in COOKED terms, not raw — you can't set aside
    // "extra raw meat" unsmoked, the whole cut goes on the smoker together. So
    // it's: (what smoking the bought amount actually yields) minus (what's
    // actually needed) — the leftover cooked meat you'll really end up with.
    // Only computable where buying happens in fixed units (MOQ / racks / legs);
    // null means "not on file yet", not "zero", so the tile can stay quiet
    // instead of showing a false zero.
    const pulledPorkWastageGrams = pulledPorkBuyGrams * pulledPorkYield - pulledPorkOutputGrams;
    // Direct half-rack orders consume a whole rack each with nothing left over —
    // only the racks bought *to cut 250g portions from* can run over.
    const ribsWastageGrams =
      racksForPortions != null ? racksForPortions * halfRackRawWeightG * ribsYield - rib250Grams : null;
    const chickenWastageGrams =
      legsToBuy != null ? legsToBuy * chickenLegRawWeightG * chickenYield - chickenOutputGrams : null;
    // Pork belly has no buy-unit constraint on file — bought as exact continuous weight, so no rounding waste.
    const bellyWastageGrams = 0;

    return {
      pulledPorkOutputGrams,
      pulledPorkRawGrams,
      pulledPorkBuyGrams,
      pulledPorkWastageGrams,
      bellyOutputGrams,
      bellyCount,
      bellyRawGrams,
      bellyWastageGrams,
      rib250Grams,
      rib250Count,
      halfRackCount,
      ribPortionRawGrams,
      racksForPortions,
      totalRacks,
      ribsWastageGrams,
      chickenOutputGrams,
      chickenRawGrams,
      legsToBuy,
      chickenWastageGrams,
    };
  }, [inventory]);

  const breadTimeStoriesRows = useMemo(
    () =>
      Object.entries(BREAD_TIME_STORIES_CATALOG).map(([name, catalog]) => {
        const needed = inventory.vendorTotals.breadTimeStories[name]?.qty || 0;
        const orderQty = roundUpToMultiple(needed, catalog.moq);
        return { name, needed, orderQty, moq: catalog.moq, priceInr: catalog.priceInr, cost: orderQty * catalog.priceInr };
      }),
    [inventory],
  );
  // One side of garlic bread (3 slices) rides along with every prime-cut order
  // — ribs (either portion) and burnt ends. Slices come 30-to-a-baguette and
  // can only be bought whole — same round-up-to-a-fixed-unit idea as the
  // MOQs above, just phrased in slices.
  const primeCutOrders = rawMeatPlan.rib250Count + rawMeatPlan.halfRackCount + rawMeatPlan.bellyCount;
  const garlicBreadSlicesNeeded = primeCutOrders * GARLIC_BREAD_SLICES_PER_SIDE;
  const garlicBreadBaguettes = Math.ceil(garlicBreadSlicesNeeded / GARLIC_BREAD_SLICES_PER_BAGUETTE) || 0;
  const garlicBreadSlicesBought = garlicBreadBaguettes * GARLIC_BREAD_SLICES_PER_BAGUETTE;
  const garlicBreadWastageSlices = garlicBreadSlicesBought - garlicBreadSlicesNeeded;
  const garlicBreadCost = garlicBreadBaguettes * GARLIC_BREAD_PRICE_PER_BAGUETTE_INR;
  const breadTimeStoriesTotalCost = breadTimeStoriesRows.reduce((sum, row) => sum + row.cost, 0) + garlicBreadCost;

  const hasAnyOrders = grandTotal > 0;

  // ---- Sides needed & Swiggy order — data-driven (server/recipes.js) ------
  const orderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    MENU_ITEMS.forEach((item) => {
      const total = rowTotal(item.id);
      if (total > 0) counts[item.id] = total;
    });
    return counts;
  }, [orders]);
  const orderCountsKey = JSON.stringify(orderCounts);

  const [swiggyPlan, setSwiggyPlan] = useState<SwiggyPlan | null>(null);
  const [isLoadingSwiggyPlan, setIsLoadingSwiggyPlan] = useState(false);
  const [swiggyPlanError, setSwiggyPlanError] = useState('');

  useEffect(() => {
    if (!hasAnyOrders) {
      setSwiggyPlan(null);
      return;
    }
    let cancelled = false;
    setIsLoadingSwiggyPlan(true);
    setSwiggyPlanError('');

    fetch('/api/recipes/swiggy-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderCounts }),
    })
      .then(async (resp) => {
        let data: SwiggyPlan & { error?: string };
        try {
          data = await resp.json();
        } catch {
          throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
        }
        if (!resp.ok) throw new Error(data.error || 'Failed to work out sides needed.');
        if (!cancelled) setSwiggyPlan(data);
      })
      .catch((err) => {
        if (!cancelled) setSwiggyPlanError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSwiggyPlan(false);
      });

    return () => {
      cancelled = true;
    };
    // orderCountsKey is a stable stringified snapshot of orderCounts — re-fetches only when the actual counts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderCountsKey, hasAnyOrders]);

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Weekend Prep Planner</h1>
        <p>
          Log expected orders for Saturday and Sunday, then turn them into a meat weight and inventory
          shopping list for the kitchen.
        </p>
      </div>

      <div className="wizard-shell">
        <div className="wizard-steps">
          <div className={`wizard-step ${step === 1 ? 'active' : ''}`}>1. Weekend Orders</div>
          <div className={`wizard-step ${step === 2 ? 'active' : ''}`}>2. Inventory Estimate</div>
        </div>

        <div className="wizard-card">
          {step === 1 && (
            <div>
              <h2>Step 1: Weekend orders</h2>
              <p>
                Orders come straight from Odoo now — no manual entry. Pull confirmed weekend orders for a
                date range below. This becomes the basis for the meat weight and inventory estimate in Step 2.
              </p>

              <div className="prep-paste-panel">
                <label>
                  Fetch from Odoo — confirmed B2C orders in a date range
                  <div className="prep-odoo-dates">
                    <span>
                      From
                      <input type="date" value={odooFrom} onChange={(event) => setOdooFrom(event.target.value)} />
                    </span>
                    <span>
                      To
                      <input type="date" value={odooTo} onChange={(event) => setOdooTo(event.target.value)} />
                    </span>
                  </div>
                </label>
                <div className="prep-paste-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleFetchOdoo}
                    disabled={!odooFrom || !odooTo || isFetchingOdoo}
                  >
                    {isFetchingOdoo ? 'Fetching…' : 'Fetch from Odoo'}
                  </button>
                  <span className="prep-paste-hint">
                    Pulls confirmed, individual-customer Sales Orders — B2B/corporate orders are excluded.
                    Adds to the totals below, it never overwrites them.
                  </span>
                </div>
                {odooError && <p className="chat-error">{odooError}</p>}
                {odooStatus && !odooError && <p className="status-message">{odooStatus}</p>}
              </div>

              {unmatchedLines.length > 0 && (
                <div className="prep-unmatched">
                  <strong>Couldn't confidently match these Odoo line items — check the product names and try again:</strong>
                  <ul>
                    {unmatchedLines.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="prep-table-wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th className="prep-item-col">Menu item</th>
                      {SLOTS.map((slot) => (
                        <th key={slot.id}>
                          <span className="prep-slot-day">{slot.day}</span>
                          <span className="prep-slot-part">{slot.part}</span>
                        </th>
                      ))}
                      <th>Total</th>
                    </tr>
                  </thead>
                  {COLLECTIONS.map((collection) => (
                    <tbody key={collection.id}>
                      <tr className="prep-group-row">
                        <td colSpan={SLOTS.length + 2}>{collection.label}</td>
                      </tr>
                      {MENU_ITEMS.filter((item) => item.collection === collection.id).map((item) => (
                        <tr key={item.id}>
                          <td className="prep-item-col">{item.name}</td>
                          {SLOTS.map((slot) => (
                            <td key={slot.id} className="prep-total-cell">
                              {orders[item.id]?.[slot.id] || 0}
                            </td>
                          ))}
                          <td className="prep-total-cell">{rowTotal(item.id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                  <tfoot>
                    <tr>
                      <td className="prep-item-col">Slot total</td>
                      {SLOTS.map((slot) => (
                        <td key={slot.id} className="prep-total-cell">
                          {colTotal(slot.id)}
                        </td>
                      ))}
                      <td className="prep-total-cell prep-grand-total">{grandTotal}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="prep-summary-grid">
                {SLOTS.map((slot) => (
                  <div key={slot.id} className="prep-summary-card">
                    <div className="prep-summary-label">
                      {slot.day} · {slot.part}
                    </div>
                    <div className="prep-summary-value">{colTotal(slot.id)}</div>
                  </div>
                ))}
                <div className="prep-summary-card prep-summary-card-total">
                  <div className="prep-summary-label">Weekend total</div>
                  <div className="prep-summary-value">{grandTotal}</div>
                </div>
              </div>

              <div className="wizard-actions-bottom">
                <button type="button" className="secondary-button" onClick={handleClear}>
                  Clear orders
                </button>
              </div>
            </div>
          )}

          {step === 2 && !hasAnyOrders && (
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
              <h3>No orders logged yet</h3>
              <p>Go back to Step 1 and log some weekend orders — the shopping list builds itself from those counts.</p>
              <span className="badge-soon">Nothing to estimate</span>
            </div>
          )}

          {step === 2 && hasAnyOrders && (
            <div>
              <h2>Step 2: Inventory Estimate</h2>
              <p>
                Built from the {grandTotal} weekend orders logged in Step 1, split across your three
                vendors: the meat vendor (chicken/pork by weight), Bread Time Stories (buns, taco shells,
                garlic bread), and Swiggy (sides, sauces &amp; other groceries).
              </p>

              {swiggyPlan && swiggyPlan.dishTypeTotals.some((d) => d.total > 0) && (
                <>
                  <h3 className="inv-section-title">🍽️ Dish type summary</h3>
                  <p className="inv-section-hint">How the {grandTotal} orders break down by dish type.</p>
                  <div className="prep-summary-grid">
                    {swiggyPlan.dishTypeTotals.map((d) => (
                      <div key={d.id} className="prep-summary-card">
                        <div className="prep-summary-label">{d.label}</div>
                        <div className="prep-summary-value">{d.total}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <h3 className="inv-section-title">🥩 Meat needed</h3>
              <p className="inv-section-hint">
                Every order's line-item weight, the output subtotal per cut, and a clear "Buy" line after
                smoking loss — one static reference to come back to on prep day.
              </p>
              <div className="inv-compact-grid">
                <MeatCategoryTile
                  icon="🐔"
                  title="Shredded Chicken"
                  colorClass="chicken"
                  lossPct={MEAT_LOSS.chickenLossPct}
                  requiredNoun="shredded chicken"
                  buyNoun="chicken"
                  breakdownLines={inventory.meatBreakdown.chicken}
                  outputGrams={rawMeatPlan.chickenOutputGrams}
                  buyLabel={
                    rawMeatPlan.legsToBuy != null ? `${rawMeatPlan.legsToBuy} legs` : formatWeight(rawMeatPlan.chickenRawGrams)
                  }
                  wastageGrams={rawMeatPlan.chickenWastageGrams}
                  extra={
                    MEAT_LOSS.chickenLegRawWeightG > 0 ? (
                      <p className="inv-compact-caption">at {MEAT_LOSS.chickenLegRawWeightG}g/leg</p>
                    ) : (
                      <p className="inv-note">Set chickenLegRawWeightG in code to convert this to a leg count.</p>
                    )
                  }
                />

                <MeatCategoryTile
                  icon="🍖"
                  title="Pulled Pork"
                  colorClass="pork"
                  lossPct={MEAT_LOSS.pulledPorkLossPct}
                  requiredNoun="shredded pork"
                  buyNoun="pork"
                  breakdownLines={inventory.meatBreakdown.pork}
                  outputGrams={rawMeatPlan.pulledPorkOutputGrams}
                  buyLabel={formatWeight(rawMeatPlan.pulledPorkBuyGrams)}
                  wastageGrams={rawMeatPlan.pulledPorkWastageGrams}
                  extra={
                    <p className="inv-compact-caption">
                      Needs {formatWeight(rawMeatPlan.pulledPorkRawGrams)}, rounded up to the {formatWeight(MEAT_LOSS.pulledPorkMoqG)}{' '}
                      minimum buy unit.
                    </p>
                  }
                />

                <MeatCategoryTile
                  icon="🍗"
                  title="Pork Ribs"
                  colorClass="pork"
                  lossPct={MEAT_LOSS.ribsLossPct}
                  requiredNoun="ribs"
                  buyNoun="ribs"
                  breakdownLines={[
                    {
                      label: 'Smokey BBQ Ribs (250g)',
                      count: rawMeatPlan.rib250Count,
                      gramsPerOrder: 250,
                      grams: rawMeatPlan.rib250Grams,
                    },
                  ]}
                  outputGrams={rawMeatPlan.rib250Grams}
                  buyLabel={
                    rawMeatPlan.totalRacks != null
                      ? `${rawMeatPlan.totalRacks} half-racks`
                      : formatWeight(rawMeatPlan.ribPortionRawGrams)
                  }
                  wastageGrams={rawMeatPlan.ribsWastageGrams}
                  extra={
                    <>
                      <div className="inv-compact-total">
                        <span>Whole half-racks (served as-is)</span>
                        <span>{rawMeatPlan.halfRackCount}</span>
                      </div>
                      {MEAT_LOSS.halfRackRawWeightG > 0 ? (
                        <p className="inv-compact-caption">at {MEAT_LOSS.halfRackRawWeightG}g/rack</p>
                      ) : (
                        <p className="inv-note">
                          Set halfRackRawWeightG in code to convert the 250g-portion weight into a rack count.
                        </p>
                      )}
                    </>
                  }
                />

                <MeatCategoryTile
                  icon="🥓"
                  title="Pork Belly"
                  colorClass="pork"
                  lossPct={MEAT_LOSS.porkBellyLossPct}
                  requiredNoun="pork belly"
                  buyNoun="pork belly"
                  breakdownLines={[
                    {
                      label: 'Pork Burnt Ends (150g)',
                      count: rawMeatPlan.bellyCount,
                      gramsPerOrder: 150,
                      grams: rawMeatPlan.bellyOutputGrams,
                    },
                  ]}
                  outputGrams={rawMeatPlan.bellyOutputGrams}
                  buyLabel={formatWeight(rawMeatPlan.bellyRawGrams)}
                  wastageGrams={rawMeatPlan.bellyWastageGrams}
                />
              </div>

              <h3 className="inv-section-title">🍞 Bread Time Stories order</h3>
              <p className="inv-section-hint">Order quantities rounded up to each item's MOQ.</p>
              <div className="prep-table-wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th className="prep-item-col">Item</th>
                      <th>Needed</th>
                      <th>Order qty (MOQ)</th>
                      <th>Unit price</th>
                      <th>Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breadTimeStoriesRows.map((row) => (
                      <tr key={row.name}>
                        <td className="prep-item-col">{row.name}</td>
                        <td className="prep-total-cell">{Math.round(row.needed)}</td>
                        <td className="prep-total-cell">
                          {row.orderQty} <span className="inv-note-inline">(MOQ {row.moq})</span>
                        </td>
                        <td className="prep-total-cell">{inrFormat(row.priceInr)}</td>
                        <td className="prep-total-cell inv-cost-cell">{inrFormat(row.cost)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="prep-item-col">
                        Garlic bread
                        <div className="inv-note-inline">
                          ₹60/baguette · {GARLIC_BREAD_SLICES_PER_BAGUETTE} slices each · {GARLIC_BREAD_SLICES_PER_SIDE} slices per rib/burnt-end order
                        </div>
                      </td>
                      <td className="prep-total-cell">
                        {garlicBreadSlicesNeeded}
                        <div className="inv-note-inline">
                          {primeCutOrders} prime-cut order{primeCutOrders === 1 ? '' : 's'} × {GARLIC_BREAD_SLICES_PER_SIDE}
                        </div>
                      </td>
                      <td className="prep-total-cell">
                        {garlicBreadBaguettes} <span className="inv-note-inline">baguette{garlicBreadBaguettes === 1 ? '' : 's'}</span>
                      </td>
                      <td className="prep-total-cell">{inrFormat(GARLIC_BREAD_PRICE_PER_BAGUETTE_INR)}</td>
                      <td className="prep-total-cell inv-cost-cell">{inrFormat(garlicBreadCost)}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr className="inv-total-row">
                      <td className="prep-item-col" colSpan={4}>
                        Estimated Bread Time Stories total
                      </td>
                      <td className="prep-total-cell prep-grand-total">{inrFormat(breadTimeStoriesTotalCost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="inv-note">
                Garlic bread rides along with every ribs (250g or half-rack) and burnt ends order — 3
                slices each. Buying whole baguettes leaves {garlicBreadWastageSlices} leftover slice
                {garlicBreadWastageSlices === 1 ? '' : 's'} this week.
              </p>

              <h3 className="inv-section-title">🥗 Sides needed</h3>
              <p className="inv-section-hint">
                Every side/sauce across all dish types — portions is how many orders need it (e.g. "13
                sides of salad"), quantity is how much to actually prep or buy. Where a side is made
                in-house from a known-yield batch recipe, the batch count needed is shown too.
              </p>
              {isLoadingSwiggyPlan && <p className="status-message">Working it out…</p>}
              {swiggyPlanError && <p className="chat-error">{swiggyPlanError}</p>}
              {swiggyPlan && swiggyPlan.sides.length > 0 && (
                <div className="prep-table-wrap">
                  <table className="prep-table">
                    <thead>
                      <tr>
                        <th className="prep-item-col">Side</th>
                        <th>Portions</th>
                        <th>Quantity needed</th>
                        <th>Batches</th>
                      </tr>
                    </thead>
                    <tbody>
                      {swiggyPlan.sides.map((side) => (
                        <tr key={side.name}>
                          <td className="prep-item-col">
                            {side.name}
                            {side.hasUnparsedQty && <span className="inv-assumed">partial</span>}
                          </td>
                          <td className="prep-total-cell">{side.portions}</td>
                          <td className="prep-total-cell">
                            {side.totalQty} {side.unit}
                          </td>
                          <td className="prep-total-cell">
                            {side.batchInfo
                              ? `${side.batchInfo.batches} × ${side.batchInfo.batchYield}${side.batchInfo.batchUnit} batch`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3 className="inv-section-title">🛒 Swiggy order (raw ingredients)</h3>
              <p className="inv-section-hint">
                The raw groceries behind the sides above — in-house preps with a known batch yield are
                broken down into what goes into them, direct items (e.g. Chips) are listed as-is.
              </p>
              {swiggyPlan && swiggyPlan.swiggyList.length > 0 ? (
                <div className="prep-table-wrap">
                  <table className="prep-table">
                    <thead>
                      <tr>
                        <th className="prep-item-col">Ingredient</th>
                        <th>Quantity needed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {swiggyPlan.swiggyList.map((row) => (
                        <tr key={`${row.materialId || row.name}-${row.unit}`}>
                          <td className="prep-item-col">{row.name}</td>
                          <td className="prep-total-cell">
                            {row.qty} {row.unit}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                swiggyPlan && <p className="inv-note">Nothing to extrapolate yet — see the gaps below.</p>
              )}

              {swiggyPlan && swiggyPlan.gaps.length > 0 && (
                <div className="prep-unmatched">
                  <strong>Data gaps found while working this out:</strong>
                  <ul>
                    {swiggyPlan.gaps.map((gap, index) => (
                      <li key={index}>{gap}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="prep-unmatched">
                <strong>Assumptions to double-check:</strong>
                <ul>
                  <li>Pulled pork (50%), ribs (30%), and chicken (50%) loss %s are all confirmed. Pork belly still defaults to 37.5% (the midpoint of the original 35–40% shoulder/ribs range) — it's the only one left without its own confirmed number.</li>
                  <li>Raw weight per half-rack is set (1.185kg, from a 2.37kg/2-rack purchase), so the Ribs tile shows a real rack count. Raw weight per chicken leg still isn't on file, so that tile shows a raw kg figure instead of a leg count until chickenLegRawWeightG is set in MEAT_LOSS.</li>
                  <li>Pulled pork can only be bought in 1.2kg minimum units — the Buy figure is rounded up to the nearest 1.2kg, shown alongside the exact amount needed.</li>
                  <li>Taco shell pricing is read as ₹20 per shell (3 shells/order), not ₹20 per full taco set — confirm with Bread Time Stories if that's wrong.</li>
                  <li>Sides needed &amp; the Swiggy order above are now driven by menu.csv/recipe_ingredients.csv/rub_recipes.csv instead of guesses — see "Data gaps found" above for anything still missing from that data.</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="wizard-actions">
          {step > 1 && (
            <button type="button" className="secondary-button" onClick={handleBack}>
              Back
            </button>
          )}
          {step < 2 && (
            <button type="button" className="primary-button" onClick={handleNext}>
              Next: Estimate inventory
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default WeekendPrepPlanner;
