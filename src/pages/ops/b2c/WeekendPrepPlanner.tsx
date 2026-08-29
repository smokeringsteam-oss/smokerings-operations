import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  BulkStatusBar,
  FulfilmentBadge,
  FulfilmentControl,
  ODOO_STATUS_LABELS,
  useOrderFulfilment,
  type FulfilmentOrder,
  type PackStatusValue,
} from '../shared/orderFulfilment';
import {
  boxesSaved,
  buildOrderSideGroups,
  describePacking,
  sideBoxTotals,
  sideBoxTotalsFromCounts,
  type OrderTimePreference,
  type OrderTimePreferences,
  type PackOrder,
  type PackSlotId,
  type PackingResponse,
  type SideBoxTotal,
  type SideContainer,
  type SidesByItem,
} from '../shared/packing';

const LOCAL_STORAGE_KEY = 'kitchen-prep-orders-v1';

// Real Smoke Rings BBQ menu (smokerings.in).
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
  { id: 'beef-ribs-250g', name: 'Smokey BBQ Beef Ribs (250g)', collection: 'pitmasters-favourite' },
  { id: 'jackfruit-tacos', name: 'Smoked Jackfruit Tacos', collection: 'smoked-jackfruit' },
];

// Step 1 shows the weekend's counts as tiles — one per thing the kitchen
// actually preps, not one per SKU. Tacos and quesadillas of the same protein
// share a tile: same pulled meat, same tortilla run, so the kitchen wants the
// combined number with the split underneath as the footnote.
const ORDER_TILES: { id: string; label: string; parts: { label: string; itemId: string }[] }[] = [
  { id: 'chicken-bbq-burger', label: 'Chicken BBQ Burger', parts: [{ label: 'BBQ', itemId: 'chicken-bbq-burger' }] },
  {
    id: 'chicken-glaze-burger',
    label: 'Chicken Glaze Burger',
    parts: [{ label: 'Glaze', itemId: 'chicken-glaze-burger' }],
  },
  {
    id: 'chicken-tacos-quesadilla',
    label: 'Chicken Tacos & Quesadilla',
    parts: [
      { label: 'Tacos', itemId: 'chicken-tacos' },
      { label: 'Quesadilla', itemId: 'chicken-quesadilla' },
    ],
  },
  { id: 'pork-bbq-burger', label: 'Pork BBQ Burger', parts: [{ label: 'BBQ', itemId: 'pork-bbq-burger' }] },
  { id: 'pork-glaze-burger', label: 'Pork Glaze Burger', parts: [{ label: 'Glaze', itemId: 'pork-glaze-burger' }] },
  {
    id: 'pork-tacos-quesadilla',
    label: 'Pork Tacos & Quesadilla',
    parts: [
      { label: 'Tacos', itemId: 'pork-tacos' },
      { label: 'Quesadilla', itemId: 'pork-quesadilla' },
    ],
  },
  { id: 'pork-burnt-ends', label: 'Pork Burnt Ends (150g)', parts: [{ label: '150 g', itemId: 'pork-burnt-ends' }] },
  { id: 'bbq-ribs-250g', label: 'BBQ Ribs (250g)', parts: [{ label: '250 g', itemId: 'bbq-ribs-250g' }] },
  { id: 'bbq-ribs-half-rack', label: 'BBQ Ribs (½ rack)', parts: [{ label: '6-7 ribs', itemId: 'bbq-ribs-half-rack' }] },
  { id: 'beef-ribs-250g', label: 'BBQ Beef Ribs (250g)', parts: [{ label: '250 g', itemId: 'beef-ribs-250g' }] },
  { id: 'jackfruit-tacos', label: 'Jackfruit Tacos', parts: [{ label: 'Tacos', itemId: 'jackfruit-tacos' }] },
];

// The ids stay 'satEvening'/'sunEvening' — that's what Odoo's slot tags and
// every server response key on — but the label reads "Dinner", which is what
// the kitchen calls the slot and what Order Packing already shows.
const SLOTS: { id: string; day: string; part: string }[] = [
  { id: 'satLunch', day: 'Saturday', part: 'Lunch' },
  { id: 'satEvening', day: 'Saturday', part: 'Dinner' },
  { id: 'sunLunch', day: 'Sunday', part: 'Lunch' },
  { id: 'sunEvening', day: 'Sunday', part: 'Dinner' },
];

type OrderMap = Record<string, Record<string, number>>;

type ExtractedOrder = {
  itemId: string;
  slotId: string;
  quantity: number;
};

// An unconfirmed Odoo quotation (state draft/sent) sitting in the fetched
// range. Its quantities are deliberately kept OUT of the totals below until
// it's confirmed — `entries` is the exact set of {itemId, slotId, quantity}
// rows to fold in when it is, so confirming never needs a re-fetch (which
// would re-add every confirmed order that's already been applied).
type PendingQuotation = {
  orderId: number;
  orderName: string;
  state: string;
  customer: string;
  customerPhone: string | null;
  promised: string | null;
  amountTotal: number;
  slotId: string | null;
  slotLabel: string | null;
  slotIssue: string | null;
  items: { name: string; qty: number; itemId: string | null }[];
  unmatchedItems: string[];
  entries: ExtractedOrder[];
};

// ---- Recipes & vendors -----------------------------------------------------
// Meat weights and Bread Time Stories (bun/taco-shell/garlic-bread) buy
// quantities used to be hardcoded here as DISH_RECIPES/PORTIONED_CUTS/
// MEAT_LOSS/BREAD_TIME_STORIES_CATALOG/GARLIC_BREAD_* constants. Migrated
// 2026-08-15 onto the real knowledge-base data — see server/ops/b2c/recipes.js
// computeMeatPlan (fed by recipe_lines.csv's per-order finished
// weight + server/core/meatConfig.js's loss %s and cuts) and
// computePrepPlan (fed by the same recipe_lines.csv rows for the
// Bakery category, now also carrying price/order_multiple from
// materials.csv). See that repo's README.md "What changed on
// 2026-08-15" for exactly what moved and why.

// vendors.csv VEN-001 — the bakery supplier the Bakery-category buy table was
// originally written around (buns, taco shells, garlic bread, Friday 11:00
// order deadline). Only used to sort its table first and give it the bread
// icon; every other vendor's rows render from the data, no id needed.
const BAKERY_VENDOR_ID = 'VEN-001';
// vendors.csv VEN-002 — Swiggy Instamart. Bakery-category items sourced from
// it (tortillas) are bought on the same run as the raw ingredients below, so
// they're shown with the Swiggy order rather than in the bakery table.
const SWIGGY_VENDOR_ID = 'VEN-002';
const UNASSIGNED_VENDOR_KEY = '__no_vendor__';

const formatWeight = (grams: number) => (grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${Math.round(grams)} g`);
const roundUpToMultiple = (qty: number, multiple: number) => (qty <= 0 ? 0 : Math.ceil(qty / multiple) * multiple);
const inrFormat = (n: number) => `₹${n.toLocaleString('en-IN')}`;
// Quantities are summed from CSV decimals (0.1 of a baguette, 15 g of
// dressing) — trim the float dust before they hit a card or a table cell.
const roundQty = (n: number) => Math.round(n * 100) / 100;

const formatDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Defaults the Odoo fetch range to the Mon→Sun week containing the next
// Sat/Sun (the current weekend once it's Sat or Sun) — the weekend being
// prepped for. This is local-calendar math (not UTC): find the coming Sunday
// (today if today IS Sunday), then step back 6 days for that week's Monday.
//
// It picks a SERVICE weekend, not a "when was the order typed in" block like
// the old last-Fri-through-Mon default: the Odoo fetch filters on the PROMISED
// time (commitment_date). The Monday start is load-bearing, not padding — an
// order with no promised time falls back to its date_order (server/integrations/odoo.js
// weekendOrderDomain), so the window must still cover the week it was placed
// in. Same default in Order Packing — keep the two in sync.
const getDefaultOdooRange = () => {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + ((7 - today.getDay()) % 7));
  const monday = new Date(sunday);
  monday.setDate(sunday.getDate() - 6);
  return { from: formatDateInput(monday), to: formatDateInput(sunday) };
};
const DEFAULT_ODOO_RANGE = getDefaultOdooRange();

// A quotation's promised time — Odoo's naive-UTC 'YYYY-MM-DD HH:mm:ss', so it
// needs the space-to-T fixup and an explicit 'Z'; without the Z it parses as
// local time and reads 5½ hours early, which would contradict the Lunch/Dinner
// slot the server derived from this same field. Weekday and date included
// (unlike OrderPacking's time-only version) because these cards aren't filed
// under a day column — the date is the point.
const formatPromised = (iso: string | null) => {
  if (!iso) return 'No date on file';
  const d = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
};

type MeatBreakdownLine = { label: string; count: number; gramsPerOrder: number; grams: number };
// Mirrors server/ops/b2c/recipes.js computeMeatPlan's per-category response shape.
type MeatCategoryPlan = {
  label: string;
  productId: string | null;
  productName: string;
  sourceMaterialId: string | null;
  sourceMaterialName: string | null;
  breakdown: MeatBreakdownLine[];
  outputGrams: number;
  lossPct: number;
  lossSource: 'configured' | 'default';
  preferRealizedLoss: boolean;
  orderMultipleG: number | null;
};
type MeatPlan = {
  chicken: MeatCategoryPlan;
  pulledPork: MeatCategoryPlan;
  ribs: MeatCategoryPlan;
  porkBelly: MeatCategoryPlan;
  jackfruit: MeatCategoryPlan;
  beefRibs: MeatCategoryPlan;
  gaps: string[];
};
// Mirrors server/ops/b2c/recipes.js computePrepPlan's row shape (Bakery category —
// buns, taco shells, tortillas, garlic bread), now carrying price/
// order_multiple from materials.csv alongside the quantities
// OrderPacking.tsx already reads, plus the row's default vendor: Bakery is a
// kitchen step ("warm/toast it"), not a supplier, and the rows don't all come
// from the same place — see the vendor note in server/ops/b2c/recipes.js above
// PREP_CATEGORY.
type BakeryRow = {
  name: string;
  materialId: string | null;
  unit: string;
  portions: number;
  totalQty: number;
  hasUnparsedQty: boolean;
  unitPriceInr: number | null;
  orderMultiple: number | null;
  vendorId: string | null;
  vendorName: string | null;
  orderQty: number;
  costInr: number | null;
};

// ---- Sides needed & Swiggy order (server/ops/b2c/recipes.js) ----------------------
// Driven by menu.csv / recipe_ingredients.csv / rub_recipes.csv /
// rub_recipe_ingredients.csv.
type DishTypeTotal = {
  id: string;
  label: string;
  total: number;
  items: { itemId: string; name: string; count: number }[];
};
// Burgers come in two sauces off the same patty (Chicken/Pork x BBQ/Glaze), and
// the kitchen glazes or sauces at the pass — so the dish-type card's total isn't
// enough on its own. Split the type's items by the sauce in their menu id and
// show both counts under the total. Any dish type without a sauce variant (tacos,
// quesadillas, prime cuts) returns null and renders as before.
const sauceSplit = (items: { itemId: string; count: number }[]) => {
  const bbq = items.filter((i) => /-bbq(-|$)/.test(i.itemId)).reduce((n, i) => n + i.count, 0);
  const glaze = items.filter((i) => /-glaze(-|$)/.test(i.itemId)).reduce((n, i) => n + i.count, 0);
  return bbq + glaze > 0 ? { bbq, glaze } : null;
};

// Prime Cuts lumps burnt ends and every rib plate into one number, but ribs are
// what actually goes on the smoker — and a 250 g portion and a 1/2 rack (850 g,
// 6-7 ribs) are the same cut in very different amounts. Split the card's items
// by rib menu id (pork and beef alike, both sold as -ribs-250g) so the total
// still reads as the dish-type count while the ribs line says what to smoke.
// Any dish type with no ribs in it (burgers, tacos, quesadillas) returns null
// and renders as before.
const ribsSplit = (items: { itemId: string; count: number }[]) => {
  const countOf = (re: RegExp) => items.filter((i) => re.test(i.itemId)).reduce((n, i) => n + i.count, 0);
  const portions = countOf(/ribs-250g$/);
  const halfRacks = countOf(/ribs-half-rack$/);
  return portions + halfRacks > 0 ? { total: portions + halfRacks, portions, halfRacks } : null;
};

type SideRow = {
  key: string;
  // Which prep-order band this side sits in (server/ops/b2c/recipes.js SIDE_PREP_TIER)
  // — 1 first, then 2, 3 is order-independent, 4 is bought not made.
  prepTier: number;
  name: string;
  portions: number;
  totalQty: number;
  unit: string;
  hasUnparsedQty: boolean;
  subRecipeId: string | null;
  batchInfo: { batches: number; batchYield: number; batchUnit: string } | null;
  // Which box this side is packed in and how many of them the portions need
  // (server/core/packagingConfig.js). Counted plate by plate server-side, since
  // that endpoint only ever sees slot totals — Step 2 recomputes it order by
  // order where the individual orders are on hand.
  container: SideContainer;
  boxes: number;
};
// Where a side is in the prep run for this weekend (server/ops/b2c/sidePrepStatus.js).
type SidePrepStatus = 'pending' | 'making' | 'done';
type SidePrepStatuses = Record<string, { status: SidePrepStatus; startedAt: string | null; doneAt: string | null }>;
type SwiggyIngredient = { name: string; materialId: string | null; unit: string; qty: number };
type SwiggyPlan = {
  dishTypeTotals: DishTypeTotal[];
  sides: SideRow[];
  prepTiers: { tier: number; label: string }[];
  swiggyList: SwiggyIngredient[];
  // Ingredients the recipes genuinely use but that are drawn from existing
  // pantry stock instead of reordered on the Swiggy run (e.g. Dabur honey) —
  // same shape as swiggyList, kept separate so they never inflate the buy list.
  fromInventory: SwiggyIngredient[];
  gaps: string[];
};

// ---- Step 3: Pre-packing guidelines ----------------------------------------

// What the customer asked for about timing, read out of the order's Odoo note
// by Gemini (server/integrations/geminiContent.js readOrderTimePreferences). Rendered as a
// callout rather than a chip because the customer's own words are the point —
// "by 1PM if possible" and "MUST be there by 1" are the same badge and very
// different kitchen decisions, so the quote is shown, not just a paraphrase.
// Nothing renders for the orders that asked for nothing, which is most of them.
const TimePreferenceCallout: React.FC<{ preference: OrderTimePreference | undefined }> = ({ preference }) => {
  if (!preference?.hasPreference) return null;
  return (
    <div className={`pack-time-pref pack-time-pref-${preference.confidence}`}>
      <span className="pack-time-pref-label">
        ⏰ {preference.label || 'Time preference'}
      </span>
      {preference.quote && <span className="pack-time-pref-quote">“{preference.quote}”</span>}
      {preference.confidence !== 'high' && (
        <span className="pack-time-pref-hint">Read from a vague note — worth a look before you promise it.</span>
      )}
    </div>
  );
};
// Per-order side-clubbing intelligence — e.g. 3 burgers in one order each
// wanting a salad side combine into one 300g container instead of three
// 100g ones. Needs individual orders (not just the slot totals Step 1/2
// work from), so it's its own fetch against the same endpoint and shapes
// Order Packing already uses (server/index.js GET /api/odoo/order-packing,
// GET /api/recipes/sides-by-item) — kept as a separate fetch/render here
// (not a shared component) since this page already mirrors Order Packing's
// language/shapes deliberately rather than importing from it (see the Sides
// section comments above).
// ---- Smoking-loss config ---------------------------------------------------
// Converting served/output meat weight into raw purchase weight needs a loss
// % per category. The planned number is config, not data: it comes from
// server/core/meatConfig.js via the meat-plan response (50% pulled chicken, 56%
// pulled pork, 30% for everything that doesn't name its own). That's what
// the buy figures use.
//
// Completed smoking sessions produce a second, measured number — GET
// /api/smoking/yield-stats (server/ops/shared/smoking.js getRealizedLossStats), the
// weighted raw-vs-finished loss across every session on file. It is shown
// alongside the planned % on each tile, but only replaces it where
// meatConfig marks that category preferRealizedLoss — deliberately off by
// default, so one unrepresentative cook can't move a buy figure on its own.
// Trust a measured number? Set the planned % in meatConfig.js to match.

// ---- Realized yield (feeds back from the Smoking Session module) ----------
type LossStat = { lossPct: number; sessionCount: number; rawKg: number; finishedKg: number };
type YieldStats = {
  pulledPork: LossStat | null;
  ribs: LossStat | null;
  porkBelly: LossStat | null;
  chicken: LossStat | null;
  jackfruit: LossStat | null;
  beefRibs: LossStat | null;
};
type EffectiveLoss = {
  pct: number;
  // Where the number driving the buy figure came from: this meat's own
  // configured %, meatConfig's catch-all default, or completed sessions.
  source: 'configured' | 'default' | 'measured';
  // What sessions actually measured, whether or not it's driving the buy
  // figure — null until a category has a completed session on file.
  measuredPct: number | null;
  sessionCount: number;
};
const LOSS_TILE_LABELS: Record<keyof YieldStats, string> = {
  chicken: 'Chicken',
  pulledPork: 'Pulled pork',
  ribs: 'Ribs',
  porkBelly: 'Pork belly',
  jackfruit: 'Jackfruit',
  beefRibs: 'Beef ribs',
};

// The loss % badge says two things at once: which number the buy figure
// used, and what completed sessions have actually measured — so a planned %
// that has drifted from reality is visible on the tile rather than only
// findable by opening meatConfig.js.
const sessionsLabel = (count: number) => `${count} session${count === 1 ? '' : 's'}`;

const lossBadgeSuffix = (loss: EffectiveLoss) => {
  if (loss.source === 'measured') return sessionsLabel(loss.sessionCount);
  if (loss.measuredPct != null) return `${loss.measuredPct}% measured`;
  return loss.source === 'default' ? 'default' : 'planned';
};

const lossBadgeTitle = (loss: EffectiveLoss) => {
  if (loss.source === 'measured') {
    return `Measured across ${sessionsLabel(loss.sessionCount)} — this category is set to follow realized loss`;
  }
  const planned =
    loss.source === 'default'
      ? "Planned figure — meatConfig.js's catch-all default, this meat doesn't set its own yet"
      : 'Planned figure from server/core/meatConfig.js';
  return loss.measuredPct == null
    ? `${planned}. No completed smoking sessions yet.`
    : `${planned}. ${sessionsLabel(loss.sessionCount)} on file measured ${loss.measuredPct}% — edit meatConfig.js to adopt it.`;
};

// Static reference tile: every dish's contribution, then three plain-English
// lines — Required / Buy raw / Wastage — so the whole calculation reads like
// a checklist, not a black-box number.
const MeatCategoryTile = ({
  icon,
  title,
  colorClass,
  loss,
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
  colorClass: 'pork' | 'chicken' | 'jackfruit' | 'beef';
  loss: EffectiveLoss;
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
      <span className="inv-pct-static" title={lossBadgeTitle(loss)}>
        {loss.pct}% loss · {lossBadgeSuffix(loss)}
      </span>
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

// Where a side is in the weekend's prep run, as a two-step control in the
// batch-detail table: not started → making → done. Each state shows only the
// move that goes forward, plus an undo, so there's never a choice to make
// mid-prep — the kitchen taps the one lit button.
const SidePrepControl: React.FC<{
  side: SideRow;
  state: SidePrepStatuses[string] | undefined;
  busy: boolean;
  disabled: boolean;
  onSet: (side: SideRow, status: SidePrepStatus) => void;
}> = ({ side, state, busy, disabled, onSet }) => {
  const status = state?.status || 'pending';
  const stamp = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';

  if (busy) return <span className="prep-status-hint">Saving…</span>;

  if (status === 'done') {
    return (
      <div className="prep-status-stack">
        <span className="prep-status-badge done">✅ Done{stamp(state?.doneAt) ? ` ${stamp(state?.doneAt)}` : ''}</span>
        <button type="button" className="secondary-button small" disabled={disabled} onClick={() => onSet(side, 'making')}>
          ↺ Undo
        </button>
      </div>
    );
  }

  if (status === 'making') {
    return (
      <div className="prep-status-stack">
        <span className="prep-status-badge making">
          🔥 Making{stamp(state?.startedAt) ? ` since ${stamp(state?.startedAt)}` : ''}
        </span>
        <div className="prep-status-buttons">
          <button type="button" className="primary-button small" disabled={disabled} onClick={() => onSet(side, 'done')}>
            ✅ Mark done
          </button>
          <button
            type="button"
            className="secondary-button small"
            disabled={disabled}
            onClick={() => onSet(side, 'pending')}
          >
            ↺
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="secondary-button small" disabled={disabled} onClick={() => onSet(side, 'making')}>
      ▶ Start making
    </button>
  );
};

const WeekendPrepPlanner: React.FC = () => {
  const [step, setStep] = useState(1);
  // Step 2 leads with the meat buy list; the rest of the estimate is prep-day
  // detail, opened on demand rather than scrolled past every time.
  const [showKitchenPrep, setShowKitchenPrep] = useState(false);
  // The bakery order is its own vendor run with its own lead time, so it gets its
  // own fold rather than living inside Kitchen prep.
  const [showBakeryOrder, setShowBakeryOrder] = useState(false);
  // Open by default — it's the reason Step 2 exists. The fold is for after the
  // meat is ordered, when the prep-day detail below is what's still live.
  const [showMeatToBuy, setShowMeatToBuy] = useState(true);
  const [orders, setOrders] = useState<OrderMap>({});
  const [unmatchedLines, setUnmatchedLines] = useState<string[]>([]);
  const [odooFrom, setOdooFrom] = useState(DEFAULT_ODOO_RANGE.from);
  const [odooTo, setOdooTo] = useState(DEFAULT_ODOO_RANGE.to);
  const [isFetchingOdoo, setIsFetchingOdoo] = useState(false);
  const [odooStatus, setOdooStatus] = useState('');
  const [odooError, setOdooError] = useState('');
  // Unconfirmed quotations from the last fetch, plus which one is mid-confirm
  // and what the last confirm said. Not persisted to localStorage: it's a
  // live view of Odoo, and a stale confirm button is worse than no button.
  const [quotations, setQuotations] = useState<PendingQuotation[]>([]);
  const [confirmingOrderId, setConfirmingOrderId] = useState<number | null>(null);
  const [quotationNotice, setQuotationNotice] = useState('');
  const [quotationError, setQuotationError] = useState('');
  // The quotation whose detail modal is open, if any. The list itself is only
  // order numbers — everything else (contact number, lines, Confirm) lives in
  // the modal, so a busy weekend's quotations stay one short row.
  const [openQuotationId, setOpenQuotationId] = useState<number | null>(null);
  // Orders confirmed from this screen, whose quantities are already in the
  // totals. A later fetch in the same session sees them as confirmed orders
  // and re-applies them, so they must not also reappear as a confirmable
  // quotation card.
  const confirmedQuotationIds = useRef<Set<number>>(new Set());

  // yieldStats/effectiveLoss/meatPlan/orderCounts are declared further down,
  // right after grandTotal — meatPlan (and effectiveLoss's fallback) needs
  // orderCounts, which needs rowTotal, which isn't defined until below.

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
    setQuotations([]);
    setQuotationNotice('');
    setQuotationError('');
    confirmedQuotationIds.current = new Set();
    setStep(1);
  };

  // `mode: 'replace'` rebuilds the totals from just these entries; 'add' folds
  // them into what's already there. The Odoo fetch replaces — it runs by itself
  // on load, so adding would double-count the weekend on every reload. A
  // quotation confirmed here adds, since that one order isn't in the last
  // fetch's confirmed set.
  const applyExtractedOrders = (entries: ExtractedOrder[], mode: 'add' | 'replace' = 'add') => {
    setOrders((current) => {
      const next: OrderMap = mode === 'replace' ? {} : { ...current };
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
    setQuotationNotice('');
    setQuotationError('');

    try {
      const resp = await fetch(`/api/odoo/orders?from=${odooFrom}&to=${odooTo}`);
      let data: {
        orders?: ExtractedOrder[];
        quotations?: PendingQuotation[];
        unmatched?: string[];
        ordersFound?: number;
        error?: string;
      };
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
      const pending: PendingQuotation[] = Array.isArray(data.quotations) ? data.quotations : [];
      // A quotation this fetch turned up may already have been confirmed
      // (and its quantities applied) from an earlier fetch in this session —
      // dropping it keeps the button from adding the same order twice.
      const stillPending = pending.filter((q) => !confirmedQuotationIds.current.has(q.orderId));
      const quotationTail = stillPending.length
        ? ` ${stillPending.length} unconfirmed quotation${stillPending.length === 1 ? '' : 's'} below — not counted yet.`
        : '';

      // Replace, not add: this fetch is the whole picture for the range, and it
      // runs on load. Entries empty means the range genuinely has nothing —
      // clear the tiles rather than leaving the last range's numbers up.
      applyExtractedOrders(entries, 'replace');

      if (entries.length) {
        setOdooStatus(
          `Pulled ${ordersFound} confirmed order${ordersFound === 1 ? '' : 's'} from Odoo — added ${entries.length} line item${
            entries.length === 1 ? '' : 's'
          } to the dashboard.${quotationTail}`,
        );
      } else {
        setOdooStatus(
          ordersFound > 0
            ? `Found ${ordersFound} confirmed order${ordersFound === 1 ? '' : 's'} in that range, but none matched a Sat/Sun slot or a known menu item.${quotationTail}`
            : `No confirmed B2C orders found in that date range.${quotationTail}`,
        );
      }
      setUnmatchedLines(unmatched);
      setQuotations(stillPending);
    } catch (err) {
      setOdooError(String((err as Error).message || err));
    } finally {
      setIsFetchingOdoo(false);
    }
  };

  // Nobody should have to press a button to see this weekend's orders — the
  // fetch is part of loading the page. Runs on mount and again whenever the
  // range changes; the ref keeps StrictMode's double-mount (and a re-render
  // with the same dates) from firing a second request. Safe to re-run because
  // the fetch replaces the totals rather than adding to them.
  const autoFetchedRange = useRef('');
  useEffect(() => {
    if (!odooFrom || !odooTo) return;
    const key = `${odooFrom}|${odooTo}`;
    if (autoFetchedRange.current === key) return;
    autoFetchedRange.current = key;
    void handleFetchOdoo();
  }, [odooFrom, odooTo]);

  // Confirms one quotation in Odoo, then folds exactly that order's line
  // items into the totals — the fetch already handed us its entries, so
  // there's no re-fetch and therefore no chance of double-counting the
  // confirmed orders already applied.
  const handleConfirmQuotation = async (quotation: PendingQuotation) => {
    if (confirmingOrderId !== null) return;

    setConfirmingOrderId(quotation.orderId);
    setQuotationError('');
    setQuotationNotice('');

    try {
      const resp = await fetch(`/api/odoo/orders/${quotation.orderId}/confirm`, { method: 'POST' });
      let data: {
        confirmed?: boolean;
        alreadyConfirmed?: boolean;
        state?: string;
        fulfilment?: string | null;
        fulfilmentError?: string | null;
        error?: string;
      };
      try {
        data = await resp.json();
      } catch {
        throw new Error('Got an empty response from the server. Is the backend running? Try again.');
      }
      if (!resp.ok) throw new Error(data.error || 'Odoo refused the confirmation.');
      if (!data.confirmed) {
        throw new Error(
          `${quotation.orderName} is in state "${data.state || 'unknown'}" after confirming — open it in Odoo and check.`,
        );
      }

      confirmedQuotationIds.current.add(quotation.orderId);
      setQuotations((current) => current.filter((q) => q.orderId !== quotation.orderId));

      // The confirm also starts the fulfilment pipeline on the order
      // (server/integrations/odoo.js confirmSaleOrder), so the notice says where the order
      // now sits — and says so plainly when only that half failed, since the
      // order is a sales order either way.
      const stageTail = data.fulfilmentError
        ? ` (couldn't set its fulfilment status: ${data.fulfilmentError})`
        : data.fulfilment
          ? ` (fulfilment status ${ODOO_STATUS_LABELS[data.fulfilment] || data.fulfilment})`
          : '';

      if (quotation.entries.length) {
        applyExtractedOrders(quotation.entries);
        const added = quotation.entries.reduce((sum, entry) => sum + entry.quantity, 0);
        setQuotationNotice(
          `${quotation.orderName} is a sales order now${data.alreadyConfirmed ? ' (it was already confirmed there)' : ''}${stageTail} — added ${added} item${
            added === 1 ? '' : 's'
          } to ${quotation.slotLabel}.`,
        );
      } else {
        setQuotationNotice(
          `${quotation.orderName} is a sales order now${stageTail}, but nothing could be added to the plan${
            quotation.slotId ? ' — none of its lines matched a menu item' : " — it has no Sat/Sun slot yet"
          }. Fix it in Odoo and add the quantities by hand.`,
        );
      }
    } catch (err) {
      setQuotationError(String((err as Error).message || err));
    } finally {
      setConfirmingOrderId(null);
    }
  };

  // Resolved by id rather than held as an object, so a confirm that drops the
  // quotation out of the list closes the modal on its own.
  const openQuotation = quotations.find((q) => q.orderId === openQuotationId) || null;

  useEffect(() => {
    if (!openQuotation) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && confirmingOrderId === null) setOpenQuotationId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openQuotation, confirmingOrderId]);

  const handleNext = () => {
    if (step < 3) {
      setStep((current) => current + 1);
    }
  };

  const handleBack = () => {
    setStep((current) => Math.max(1, current - 1));
  };

  // ---- Step 2 order counts — feeds every data-driven plan below (meat,
  // bakery, sides/Swiggy) ------------------------------------------------
  const orderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    MENU_ITEMS.forEach((item) => {
      const total = rowTotal(item.id);
      if (total > 0) counts[item.id] = total;
    });
    return counts;
  }, [orders]);
  const orderCountsKey = JSON.stringify(orderCounts);
  const hasAnyOrders = grandTotal > 0;

  // ---- Meat needed (server/ops/b2c/recipes.js computeMeatPlan) ----------------------
  // Per-order finished weight (recipe_lines.csv) + the planned
  // loss % and cut to buy (server/core/meatConfig.js) for every category — pulled
  // pork, pork belly (burnt ends), ribs (both the 250g portion and whole
  // half-racks, which draw from the same raw pork-ribs pool), shredded
  // chicken, jackfruit and beef ribs.
  const [meatPlan, setMeatPlan] = useState<MeatPlan | null>(null);
  const [isLoadingMeatPlan, setIsLoadingMeatPlan] = useState(false);
  const [meatPlanError, setMeatPlanError] = useState('');

  useEffect(() => {
    if (!hasAnyOrders) {
      setMeatPlan(null);
      return;
    }
    let cancelled = false;
    setIsLoadingMeatPlan(true);
    setMeatPlanError('');

    fetch('/api/recipes/meat-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderCounts }),
    })
      .then(async (resp) => {
        let data: MeatPlan & { error?: string };
        try {
          data = await resp.json();
        } catch {
          throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
        }
        if (!resp.ok) throw new Error(data.error || 'Failed to work out meat needed.');
        if (!cancelled) setMeatPlan(data);
      })
      .catch((err) => {
        if (!cancelled) setMeatPlanError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMeatPlan(false);
      });

    return () => {
      cancelled = true;
    };
    // orderCountsKey is a stable stringified snapshot of orderCounts — re-fetches only when the actual counts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderCountsKey, hasAnyOrders]);

  // Realized loss %s from completed Smoking Session sessions — see
  // GET /api/smoking/yield-stats. Fetched once on mount; a category with no
  // completed sessions yet comes back null. Displayed next to the planned %
  // on every tile; only drives the buy figure where meatConfig.js sets
  // preferRealizedLoss on that category.
  const [yieldStats, setYieldStats] = useState<YieldStats | null>(null);

  useEffect(() => {
    // Failures are non-fatal: yieldStats stays null and every tile falls back
    // to the planned % from meatConfig.js, so there is nothing to surface.
    fetch('/api/smoking/yield-stats')
      .then(async (resp) => {
        if (!resp.ok) return;
        setYieldStats(await resp.json());
      })
      .catch(() => {});
  }, []);

  // No hardcoded fallback %s here any more — the planned number always comes
  // from the meat-plan response (server/core/meatConfig.js). Until it loads there
  // is nothing to show, which is what the loading state is for.
  const effectiveLoss = useMemo(() => {
    const pick = (category: keyof YieldStats): EffectiveLoss => {
      const plan = meatPlan?.[category];
      const stat = yieldStats?.[category] ?? null;
      const measuredPct = stat ? stat.lossPct : null;
      const sessionCount = stat ? stat.sessionCount : 0;
      if (stat && plan?.preferRealizedLoss) {
        return { pct: stat.lossPct, source: 'measured', measuredPct, sessionCount };
      }
      return { pct: plan?.lossPct ?? 0, source: plan?.lossSource ?? 'default', measuredPct, sessionCount };
    };
    return {
      chicken: pick('chicken'),
      pulledPork: pick('pulledPork'),
      ribs: pick('ribs'),
      porkBelly: pick('porkBelly'),
      jackfruit: pick('jackfruit'),
      beefRibs: pick('beefRibs'),
    };
  }, [yieldStats, meatPlan]);

  // ---- Raw meat to buy, accounting for smoking loss ------------------------
  // Ribs' 250g-portion and half-rack orders both draw from the same raw
  // pork-ribs pool (meatPlan.ribs.outputGrams already sums both, per
  // computeMeatPlan) so there's one combined raw/buy figure, not a separate
  // "racks to cut portions from" count — buying happens in kg, same as every
  // other category, since that's how every meat vendor on file actually
  // prices it (₹/kg). Only pulled pork has a purchase-unit constraint today
  // (pork shoulder's 1.2 kg minimum buy unit, meatConfig.js cut.minBuyKg,
  // arriving as orderMultipleG) — the rest buy the exact raw weight needed.
  const rawMeatPlan = useMemo(() => {
    if (!meatPlan) return null;
    const buildCategory = (category: MeatCategoryPlan, lossPct: number) => {
      const yieldFraction = 1 - lossPct / 100;
      const rawGrams = yieldFraction > 0 ? category.outputGrams / yieldFraction : 0;
      const buyGrams = category.orderMultipleG ? roundUpToMultiple(rawGrams, category.orderMultipleG) : rawGrams;
      // Wastage is measured in COOKED terms — you can't set aside "extra raw
      // meat" unsmoked, the whole cut goes on the smoker together. Only
      // computable where buying rounds to a fixed unit (pulled pork's MOQ);
      // 0 elsewhere since buying the exact raw weight leaves nothing over.
      const wastageGrams = category.orderMultipleG ? buyGrams * yieldFraction - category.outputGrams : 0;
      return { ...category, rawGrams, buyGrams, wastageGrams };
    };
    return {
      chicken: buildCategory(meatPlan.chicken, effectiveLoss.chicken.pct),
      pulledPork: buildCategory(meatPlan.pulledPork, effectiveLoss.pulledPork.pct),
      ribs: buildCategory(meatPlan.ribs, effectiveLoss.ribs.pct),
      porkBelly: buildCategory(meatPlan.porkBelly, effectiveLoss.porkBelly.pct),
      jackfruit: buildCategory(meatPlan.jackfruit, effectiveLoss.jackfruit.pct),
      beefRibs: buildCategory(meatPlan.beefRibs, effectiveLoss.beefRibs.pct),
    };
  }, [meatPlan, effectiveLoss]);

  // ---- Bread Time Stories order (server/ops/b2c/recipes.js computePrepPlan) --------
  // Same Bakery-category aggregation Order Packing already uses for "what to
  // toast before packing", now also carrying price/order_multiple from
  // materials.csv — replaces the old hardcoded BREAD_TIME_STORIES_CATALOG
  // and GARLIC_BREAD_* constants. Garlic bread needs no special-casing here
  // any more: it's just another Bakery row (recipe_lines.csv
  // already has its per-order slice count, normalised to a fraction of a
  // baguette via units.csv UC-023).
  const [bakeryPlan, setBakeryPlan] = useState<BakeryRow[] | null>(null);
  const [isLoadingBakeryPlan, setIsLoadingBakeryPlan] = useState(false);
  const [bakeryPlanError, setBakeryPlanError] = useState('');

  useEffect(() => {
    if (!hasAnyOrders) {
      setBakeryPlan(null);
      return;
    }
    let cancelled = false;
    setIsLoadingBakeryPlan(true);
    setBakeryPlanError('');

    fetch('/api/recipes/prep-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderCounts }),
    })
      .then(async (resp) => {
        let data: { prep?: BakeryRow[]; error?: string };
        try {
          data = await resp.json();
        } catch {
          throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
        }
        if (!resp.ok) throw new Error(data.error || 'Failed to work out the bread & wraps order.');
        if (!cancelled) setBakeryPlan(data.prep || []);
      })
      .catch((err) => {
        if (!cancelled) setBakeryPlanError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBakeryPlan(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderCountsKey, hasAnyOrders]);

  // One buy table per vendor rather than one "Bread Time Stories" table for
  // every Bakery row: Tortilla (RM-056) is a Bakery item sourced on the
  // Swiggy run, so lumping it in overstated the bakery order by its cost and
  // left it off the Swiggy trip entirely. Bread Time Stories sorts first
  // (it's the bulk of the order and the one with a Friday 11:00 deadline),
  // then any other vendor by name, unassigned rows last.
  //
  // The Instamart group doesn't render here at all — it's filtered out below
  // and shown with the Swiggy raw-ingredient order instead, since it's one
  // trip to one vendor and splitting it across two sections meant checking
  // two lists before placing the same order.
  const allBakeryOrdersByVendor = useMemo(() => {
    const groups = new Map<string, { vendorId: string | null; vendorName: string; rows: BakeryRow[]; totalCost: number }>();
    (bakeryPlan || []).forEach((row) => {
      const key = row.vendorId || UNASSIGNED_VENDOR_KEY;
      const group = groups.get(key) || {
        vendorId: row.vendorId,
        vendorName: row.vendorName || 'No vendor on file',
        rows: [],
        totalCost: 0,
      };
      group.rows.push(row);
      group.totalCost += row.costInr || 0;
      groups.set(key, group);
    });
    const rank = (vendorId: string | null) => (vendorId === BAKERY_VENDOR_ID ? 0 : vendorId ? 1 : 2);
    return Array.from(groups.values()).sort(
      (a, b) => rank(a.vendorId) - rank(b.vendorId) || a.vendorName.localeCompare(b.vendorName),
    );
  }, [bakeryPlan]);

  const bakeryOrdersByVendor = useMemo(
    () => allBakeryOrdersByVendor.filter((group) => group.vendorId !== SWIGGY_VENDOR_ID),
    [allBakeryOrdersByVendor],
  );
  // Bakery-category rows that come off the Swiggy run (tortillas), shown with
  // the raw ingredients below instead.
  const swiggyBakeryGroup = useMemo(
    () => allBakeryOrdersByVendor.find((group) => group.vendorId === SWIGGY_VENDOR_ID) || null,
    [allBakeryOrdersByVendor],
  );

  // ---- Sides needed & Swiggy order — data-driven (server/ops/b2c/recipes.js) ------
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

  // ---- Per-side prep state for the batch-detail table (server/ops/b2c/sidePrepStatus.js)
  // Shared through a knowledge-base CSV rather than localStorage so whoever
  // opens the board next sees where the kitchen actually got to. Keyed by the
  // same weekend date range Step 1 fetched, plus the side key.
  const [sidePrepStatuses, setSidePrepStatuses] = useState<SidePrepStatuses>({});
  const [sidePrepBusyKey, setSidePrepBusyKey] = useState<string | null>(null);
  const [sidePrepError, setSidePrepError] = useState('');

  useEffect(() => {
    if (!odooFrom || !odooTo) return;
    let cancelled = false;
    fetch(`/api/side-prep-status?from=${odooFrom}&to=${odooTo}`)
      .then((resp) => resp.json())
      .then((data: { statuses?: SidePrepStatuses }) => {
        if (!cancelled) setSidePrepStatuses(data.statuses || {});
      })
      .catch(() => {
        // Non-fatal — the buttons just start from "not started" until re-fetched.
      });
    return () => {
      cancelled = true;
    };
  }, [odooFrom, odooTo]);

  const handleSetSidePrep = async (side: SideRow, status: SidePrepStatus) => {
    if (!odooFrom || !odooTo || sidePrepBusyKey) return;
    setSidePrepBusyKey(side.key);
    setSidePrepError('');
    try {
      const resp = await fetch('/api/side-prep-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: odooFrom, to: odooTo, sideKey: side.key, sideName: side.name, status }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to save prep status.');
      setSidePrepStatuses(data.statuses || {});
    } catch (err) {
      setSidePrepError(String((err as Error).message || err));
    } finally {
      setSidePrepBusyKey(null);
    }
  };

  // ---- Step 3 data: individual orders + which sides each menu item needs ---
  // Static reference (same for every order) — fetched once, independent of
  // the date range.
  const [sidesByItem, setSidesByItem] = useState<SidesByItem | null>(null);
  useEffect(() => {
    fetch('/api/recipes/sides-by-item')
      .then((resp) => resp.json())
      .then((json: { sidesByItem?: SidesByItem }) => setSidesByItem(json.sidesByItem || {}))
      .catch(() => setSidesByItem({})); // non-fatal — combine hints just won't show
  }, []);

  const [packingData, setPackingData] = useState<PackingResponse | null>(null);
  const [isLoadingPacking, setIsLoadingPacking] = useState(false);
  const [packingError, setPackingError] = useState('');

  const handleFetchPacking = async () => {
    if (!odooFrom || !odooTo || isLoadingPacking) return;
    setIsLoadingPacking(true);
    setPackingError('');
    try {
      const resp = await fetch(`/api/odoo/order-packing?from=${odooFrom}&to=${odooTo}`);
      let json: PackingResponse & { error?: string };
      try {
        json = await resp.json();
      } catch {
        throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
      }
      if (!resp.ok) throw new Error(json.error || 'Odoo request failed.');
      setPackingData(json);
    } catch (err) {
      setPackingError(String((err as Error).message || err));
    } finally {
      setIsLoadingPacking(false);
    }
  };

  // ---- Step 3: what time did the customer actually ask for? --------------
  // Odoo carries the request as free text at the end of the order note, so
  // reading it is a Gemini pass rather than a match (see
  // server/integrations/geminiContent.js readOrderTimePreferences). Kicked off once the
  // orders have landed instead of as part of that fetch, so the board draws
  // straight away and the callouts fill in behind it; the server caches per
  // note, so re-fetching the same weekend re-reads nothing.
  //
  // Failing is non-fatal by design: no GEMINI_API_KEY, or a quota 503, costs
  // the highlights and nothing else. The note itself is still on the card.
  const [timePreferences, setTimePreferences] = useState<OrderTimePreferences>({});
  const [isReadingNotes, setIsReadingNotes] = useState(false);
  const [notesError, setNotesError] = useState('');

  const ordersWithNotes = useMemo(() => {
    if (!packingData) return [] as { orderId: number; note: string }[];
    return Object.values(packingData.slots)
      .flat()
      .filter((order): order is PackOrder & { note: string } => Boolean(order.note))
      .map((order) => ({ orderId: order.orderId, note: order.note }));
  }, [packingData]);

  // Which orders, and which notes — an order whose note was edited in Odoo
  // re-reads, one that only moved slots does not.
  const notesKey = useMemo(
    () => ordersWithNotes.map((order) => `${order.orderId}:${order.note.length}`).join('|'),
    [ordersWithNotes],
  );

  useEffect(() => {
    if (!notesKey) {
      setTimePreferences({});
      return;
    }
    let cancelled = false;
    setIsReadingNotes(true);
    setNotesError('');

    fetch('/api/orders/time-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: ordersWithNotes }),
    })
      .then(async (resp) => {
        const json: { preferences?: OrderTimePreferences; error?: string } = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Could not read the order notes.');
        if (!cancelled) setTimePreferences(json.preferences || {});
      })
      .catch((err) => {
        if (!cancelled) setNotesError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsReadingNotes(false);
      });

    return () => {
      cancelled = true;
    };
    // notesKey is the stable summary of ordersWithNotes: this re-reads when
    // the orders or their notes change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesKey]);

  // Step 2's box counts need the individual orders, not just the weekend
  // totals — sides only combine inside one customer's order. Same endpoint
  // and date range Step 3's button uses, pulled automatically the first time
  // Step 2 or 3 is opened so the estimate isn't waiting on a click; the
  // button below stays for re-fetching after the range changes. Failures are
  // non-fatal: Step 2 falls back to counting a box per plate and says so.
  useEffect(() => {
    if (step < 2 || !hasAnyOrders) return;
    if (packingData || isLoadingPacking || packingError) return;
    handleFetchPacking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, hasAnyOrders, packingData, isLoadingPacking, packingError]);

  // Every order across all four slots, each with its combinable side groups
  // pre-computed — "3 burgers in one order each wanting a salad" collapses
  // into one combine line for that order, same logic (and same container-
  // saved framing) as Order Packing's per-slot "Pack smart" box, just laid
  // out for the whole weekend up front here instead of slot-by-slot on
  // packing day.
  const packingOrdersBySlot = useMemo(() => {
    if (!packingData) return [];
    return SLOTS.map((slot) => ({
      slot,
      orders: (packingData.slots[slot.id as PackSlotId] || []).map((order) => {
        const sideGroups = buildOrderSideGroups(order, sidesByItem);
        // A group only counts as combinable when the container capacity
        // genuinely lets the portions share a box: 4 salads fit one 30 oz
        // tray, but 4 BBQ sauces are 4 full 30 ml cups.
        const combinable = sideGroups.filter((g) => g.boxes < g.portions);
        const singles = sideGroups.filter((g) => g.boxes >= g.portions);
        const containersSaved = sideGroups.reduce((sum, g) => sum + boxesSaved(g), 0);
        const orderBoxes = sideGroups.reduce((sum, g) => sum + g.boxes, 0);
        return { order, combinable, singles, containersSaved, orderBoxes };
      }),
    }));
  }, [packingData, sidesByItem]);

  // Pipeline state for every order on the board, fetched once for the whole
  // weekend rather than per column.
  const packingOrderIds = useMemo(
    () => packingOrdersBySlot.flatMap((group) => group.orders.map(({ order }) => order.orderId)),
    [packingOrdersBySlot],
  );
  const fulfilment = useOrderFulfilment(packingOrderIds);

  // One slot's orders at a time — the strip above picks which. Saturday Lunch
  // is the default since it's the first slot of the weekend; it isn't reset
  // when the data re-fetches, so re-fetching mid-service leaves whoever's
  // working on the slot they were already looking at.
  // How many of the weekend's orders actually asked for a time — worth
  // saying once up front, since the callouts themselves only show on the one
  // slot being looked at.
  const timePreferenceCount = useMemo(
    () => Object.values(timePreferences).filter((preference) => preference.hasPreference).length,
    [timePreferences],
  );

  const [activePackSlot, setActivePackSlot] = useState<string>(SLOTS[0].id);
  const activePackOrders = useMemo(
    () => packingOrdersBySlot.find((group) => group.slot.id === activePackSlot)?.orders || [],
    [packingOrdersBySlot, activePackSlot],
  );

  // Bulk apply walks the orders one at a time (see setStatusBulk), so the bar
  // needs its own busy flag rather than reading any single order's.
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const handleBulkApply = async (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => {
    setIsBulkBusy(true);
    try {
      await fulfilment.setStatusBulk(orders, status);
    } finally {
      setIsBulkBusy(false);
    }
  };

  // ---- Step 2: boxes to pack ---------------------------------------------
  // Every packable side across the weekend with the number of boxes it
  // actually needs — the portion count times its per-portion size, divided
  // into the container that side goes in (server/core/packagingConfig.js), summed
  // one order at a time so sides that share a box inside an order only count
  // once. Where the individual orders aren't on hand it degrades to counting
  // every plate separately, which over-estimates rather than under-estimates.
  const allPackingOrders = useMemo(
    () => packingOrdersBySlot.flatMap((group) => group.orders.map(({ order }) => order)),
    [packingOrdersBySlot],
  );
  const usingPerOrderBoxes = allPackingOrders.length > 0 && Boolean(sidesByItem);
  const sideBoxRows: SideBoxTotal[] = useMemo(
    () =>
      usingPerOrderBoxes
        ? sideBoxTotals(allPackingOrders, sidesByItem)
        : sideBoxTotalsFromCounts(orderCounts, sidesByItem),
    [usingPerOrderBoxes, allPackingOrders, sidesByItem, orderCounts],
  );
  const sideBoxByKey = useMemo(() => new Map(sideBoxRows.map((row) => [row.key, row])), [sideBoxRows]);
  // The batch-detail table below runs in prep order rather than by portion
  // count: sides banded by server/ops/b2c/recipes.js PREP_TIERS, biggest job first
  // within a band. Empty bands drop out so the table only shows the ones the
  // weekend actually has work in.
  const sidesByPrepTier = useMemo(() => {
    if (!swiggyPlan) return [];
    return swiggyPlan.prepTiers
      .map((band) => ({
        ...band,
        rows: swiggyPlan.sides.filter((side) => side.prepTier === band.tier).sort((a, b) => b.portions - a.portions),
      }))
      .filter((band) => band.rows.length > 0);
  }, [swiggyPlan]);
  const totalSideBoxes = useMemo(() => sideBoxRows.reduce((sum, row) => sum + row.boxes, 0), [sideBoxRows]);
  // What the combining is worth across the weekend: boxes if every portion
  // were packed on its own, minus the boxes actually needed.
  const totalSideBoxesSaved = useMemo(
    () => sideBoxRows.reduce((sum, row) => sum + Math.max(0, row.portions - row.boxes), 0),
    [sideBoxRows],
  );

  const totalContainersSaved = useMemo(
    () => packingOrdersBySlot.reduce((sum, group) => sum + group.orders.reduce((s, o) => s + o.containersSaved, 0), 0),
    [packingOrdersBySlot],
  );
  const totalPackingOrders = useMemo(
    () => packingOrdersBySlot.reduce((sum, group) => sum + group.orders.length, 0),
    [packingOrdersBySlot],
  );

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
          <div className={`wizard-step ${step === 3 ? 'active' : ''}`}>3. Pre-Packing Guidelines</div>
        </div>

        <div className="wizard-card">
          {step === 1 && (
            <div>
              <h2>Step 1: Weekend orders</h2>
              <div className="prep-paste-panel">
                <label>
                  Odoo — B2C orders and quotations in a date range
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
                    {isFetchingOdoo ? 'Fetching…' : 'Refresh from Odoo'}
                  </button>
                </div>
                {odooError && <p className="chat-error">{odooError}</p>}
                {odooStatus && !odooError && <p className="status-message">{odooStatus}</p>}
              </div>

              {(quotations.length > 0 || quotationNotice || quotationError) && (
                <div className="prep-quotations">
                  <div className="prep-quotations-head">
                    <strong>
                      Quotations awaiting confirmation
                      {quotations.length > 0 ? ` (${quotations.length})` : ''}
                    </strong>
                    <span>
                      Not counted in the totals below. Confirm one here — it runs Odoo's own Confirm on the
                      quotation and folds that order's items into the plan.
                    </span>
                  </div>
                  {quotationError && <p className="chat-error">{quotationError}</p>}
                  {quotationNotice && !quotationError && <p className="status-message">{quotationNotice}</p>}
                  <div className="prep-quotation-chips">
                    {quotations.map((quotation) => (
                      <button
                        type="button"
                        key={quotation.orderId}
                        className={`prep-quotation-chip${quotation.slotIssue ? ' has-issue' : ''}`}
                        onClick={() => setOpenQuotationId(quotation.orderId)}
                      >
                        <strong>{quotation.orderName}</strong>
                        <span>
                          {quotation.slotLabel || 'No slot'}
                          {quotation.amountTotal
                            ? ` · ₹${Math.round(quotation.amountTotal).toLocaleString('en-IN')}`
                            : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

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

              <div className="prep-summary-grid">
                {ORDER_TILES.map((tile) => {
                  const total = tile.parts.reduce((sum, part) => sum + rowTotal(part.itemId), 0);
                  return (
                    <div key={tile.id} className="prep-summary-card">
                      <div className="prep-summary-label">{tile.label}</div>
                      <div className="prep-summary-value">{total}</div>
                      {tile.parts.length > 1 && (
                        <div className="prep-summary-split">
                          {tile.parts.map((part) => (
                            <span key={part.itemId}>
                              {part.label} <strong>{rowTotal(part.itemId)}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
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

              {/* Same fold as Kitchen prep below: the buy decision is the one thing worth
                  re-reading on prep day, so it stays open by default but can be folded away
                  once the meat is ordered and the list below is what's left to work through. */}
              <button
                type="button"
                className="inv-prep-toggle"
                onClick={() => setShowMeatToBuy((open) => !open)}
                aria-expanded={showMeatToBuy}
              >
                <span className="inv-prep-toggle-caret">{showMeatToBuy ? '▾' : '▸'}</span>
                <span className="inv-prep-toggle-label">🥩 Meat to buy</span>
                <span className="inv-prep-toggle-hint">
                  {showMeatToBuy
                    ? 'Per-order weights, the subtotal per cut, and the buy line after smoking loss'
                    : 'Show per-order weights, the subtotal per cut, and the buy line after smoking loss'}
                </span>
              </button>

              {showMeatToBuy && (
                <>
                  <p className="inv-section-hint">
                    Every order's line-item weight, the output subtotal per cut, and a clear "Buy" line after
                    smoking loss — one static reference to come back to on prep day.
                  </p>
                  {meatPlanError && <p className="chat-error">Couldn't load meat needed: {meatPlanError}</p>}
                  {isLoadingMeatPlan && !rawMeatPlan && <p className="inv-note">Working out meat needed…</p>}
                  {rawMeatPlan && (
                    <div className="inv-compact-grid">
                      <MeatCategoryTile
                        icon="🐔"
                        title={rawMeatPlan.chicken.label}
                        colorClass="chicken"
                        loss={effectiveLoss.chicken}
                        requiredNoun="shredded chicken"
                        buyNoun={rawMeatPlan.chicken.sourceMaterialName || 'chicken'}
                        breakdownLines={rawMeatPlan.chicken.breakdown}
                        outputGrams={rawMeatPlan.chicken.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.chicken.buyGrams)}
                        wastageGrams={rawMeatPlan.chicken.wastageGrams}
                      />

                      <MeatCategoryTile
                        icon="🍖"
                        title={rawMeatPlan.pulledPork.label}
                        colorClass="pork"
                        loss={effectiveLoss.pulledPork}
                        requiredNoun="shredded pork"
                        buyNoun={rawMeatPlan.pulledPork.sourceMaterialName || 'pork'}
                        breakdownLines={rawMeatPlan.pulledPork.breakdown}
                        outputGrams={rawMeatPlan.pulledPork.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.pulledPork.buyGrams)}
                        wastageGrams={rawMeatPlan.pulledPork.wastageGrams}
                        extra={
                          rawMeatPlan.pulledPork.orderMultipleG ? (
                            <p className="inv-compact-caption">
                              Needs {formatWeight(rawMeatPlan.pulledPork.rawGrams)}, rounded up to the{' '}
                              {formatWeight(rawMeatPlan.pulledPork.orderMultipleG)} minimum buy unit.
                            </p>
                          ) : null
                        }
                      />

                      <MeatCategoryTile
                        icon="🍗"
                        title={rawMeatPlan.ribs.label}
                        colorClass="pork"
                        loss={effectiveLoss.ribs}
                        requiredNoun="ribs"
                        buyNoun={rawMeatPlan.ribs.sourceMaterialName || 'ribs'}
                        breakdownLines={rawMeatPlan.ribs.breakdown}
                        outputGrams={rawMeatPlan.ribs.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.ribs.buyGrams)}
                        wastageGrams={rawMeatPlan.ribs.wastageGrams}
                      />

                      <MeatCategoryTile
                        icon="🥓"
                        title={rawMeatPlan.porkBelly.label}
                        colorClass="pork"
                        loss={effectiveLoss.porkBelly}
                        requiredNoun="pork belly"
                        buyNoun={rawMeatPlan.porkBelly.sourceMaterialName || 'pork belly'}
                        breakdownLines={rawMeatPlan.porkBelly.breakdown}
                        outputGrams={rawMeatPlan.porkBelly.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.porkBelly.buyGrams)}
                        wastageGrams={rawMeatPlan.porkBelly.wastageGrams}
                      />

                      <MeatCategoryTile
                        icon="🍈"
                        title={rawMeatPlan.jackfruit.label}
                        colorClass="jackfruit"
                        loss={effectiveLoss.jackfruit}
                        requiredNoun="pulled jackfruit"
                        buyNoun={rawMeatPlan.jackfruit.sourceMaterialName || 'jackfruit'}
                        breakdownLines={rawMeatPlan.jackfruit.breakdown}
                        outputGrams={rawMeatPlan.jackfruit.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.jackfruit.buyGrams)}
                        wastageGrams={rawMeatPlan.jackfruit.wastageGrams}
                      />

                      <MeatCategoryTile
                        icon="🐄"
                        title={rawMeatPlan.beefRibs.label}
                        colorClass="beef"
                        loss={effectiveLoss.beefRibs}
                        requiredNoun="beef ribs"
                        buyNoun={rawMeatPlan.beefRibs.sourceMaterialName || 'beef ribs'}
                        breakdownLines={rawMeatPlan.beefRibs.breakdown}
                        outputGrams={rawMeatPlan.beefRibs.outputGrams}
                        buyLabel={formatWeight(rawMeatPlan.beefRibs.buyGrams)}
                        wastageGrams={rawMeatPlan.beefRibs.wastageGrams}
                      />
                    </div>
                  )}
                  {meatPlan && meatPlan.gaps.length > 0 && (
                    <div className="prep-unmatched">
                      <strong>Data gaps found while working this out:</strong>
                      <ul>
                        {meatPlan.gaps.map((gap, index) => (
                          <li key={index}>{gap}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {/* The bakery run stands on its own: it's a separate vendor with its own
                  lead time, ordered before prep day like the meat, so it doesn't belong
                  buried in the prep-day detail below. */}
              <button
                type="button"
                className="inv-prep-toggle"
                onClick={() => setShowBakeryOrder((open) => !open)}
                aria-expanded={showBakeryOrder}
              >
                <span className="inv-prep-toggle-caret">{showBakeryOrder ? '▾' : '▸'}</span>
                <span className="inv-prep-toggle-label">🍞 Bread &amp; wraps to order</span>
                <span className="inv-prep-toggle-hint">
                  {showBakeryOrder
                    ? "Order quantities rounded to each item's multiple, per vendor"
                    : "Show order quantities rounded to each item's multiple, per vendor"}
                </span>
              </button>

              {showBakeryOrder && (
                <>
                <p className="inv-section-hint">
                  The bakery run — order quantities rounded up to each item's order multiple, where one's on
                  file. Bakery items that come off Instamart instead (tortillas) are down with the Swiggy
                  order, so each vendor's list is one list.
                </p>
                {bakeryPlanError && <p className="chat-error">Couldn't load the bread &amp; wraps order: {bakeryPlanError}</p>}
                {isLoadingBakeryPlan && !bakeryPlan && <p className="inv-note">Working out the bread &amp; wraps order…</p>}
                {bakeryOrdersByVendor.map((group) => (
                  <div key={group.vendorId || group.vendorName} className="prep-vendor-group">
                    <h4 className="inv-section-subtitle">
                      {group.vendorId === BAKERY_VENDOR_ID ? '🍞' : '🛵'} {group.vendorName}
                    </h4>
                    <div className="prep-table-wrap">
                      <table className="prep-table">
                        <thead>
                          <tr>
                            <th className="prep-item-col">Item</th>
                            <th>Needed</th>
                            <th>Order qty</th>
                            <th>Unit price</th>
                            <th>Est. cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map((row) => (
                            <tr key={row.materialId || row.name}>
                              <td className="prep-item-col">{row.name}</td>
                              <td className="prep-total-cell">
                                {row.totalQty} {row.unit}
                              </td>
                              <td className="prep-total-cell">
                                {row.orderQty} {row.unit}
                                {row.orderMultiple ? (
                                  <span className="inv-note-inline"> (multiples of {row.orderMultiple})</span>
                                ) : null}
                              </td>
                              <td className="prep-total-cell">{row.unitPriceInr != null ? inrFormat(row.unitPriceInr) : '—'}</td>
                              <td className="prep-total-cell inv-cost-cell">
                                {row.costInr != null ? inrFormat(row.costInr) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="inv-total-row">
                            <td className="prep-item-col" colSpan={4}>
                              Estimated {group.vendorName} total
                            </td>
                            <td className="prep-total-cell prep-grand-total">{inrFormat(group.totalCost)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                ))}
                </>
              )}

              {/* Meat is the one thing that has to be ordered days ahead, so it leads Step 2
                  on its own, with the bakery run — the other vendor with a lead time — next.
                  Everything under those is prep-day reading, folded away behind one click so the
                  buy decisions aren't buried in it. */}
              <button
                type="button"
                className="inv-prep-toggle"
                onClick={() => setShowKitchenPrep((open) => !open)}
                aria-expanded={showKitchenPrep}
              >
                <span className="inv-prep-toggle-caret">{showKitchenPrep ? '▾' : '▸'}</span>
                <span className="inv-prep-toggle-label">👩‍🍳 Kitchen prep</span>
                <span className="inv-prep-toggle-hint">
                  {showKitchenPrep
                    ? 'Dish types, boxes, sides, and the Swiggy run'
                    : 'Show dish types, boxes, sides, and the Swiggy run'}
                </span>
              </button>

              {showKitchenPrep && (
                <>
                  {/* Same sides logic (server/ops/b2c/recipes.js computeSwiggyPlan) and "boxes to pack" language
                      Order Packing uses for its per-slot sides summary, so this reads as one system
                      instead of two. */}
                  {isLoadingSwiggyPlan && <p className="status-message">Working out sides…</p>}
                  {swiggyPlanError && <p className="chat-error">{swiggyPlanError}</p>}

                  {swiggyPlan && swiggyPlan.dishTypeTotals.some((d) => d.total > 0) && (
                    <>
                      <h3 className="inv-section-title">🍽️ Dish type summary</h3>
                      <p className="inv-section-hint">How the {grandTotal} orders break down by dish type.</p>
                      <div className="prep-summary-grid">
                        {swiggyPlan.dishTypeTotals.map((d) => {
                          const split = sauceSplit(d.items);
                          const ribs = ribsSplit(d.items);
                          return (
                            <div key={d.id} className="prep-summary-card">
                              <div className="prep-summary-label">{d.label}</div>
                              <div className="prep-summary-value">{d.total}</div>
                              {split && (
                                <div className="prep-summary-split">
                                  <span>
                                    BBQ <strong>{split.bbq}</strong>
                                  </span>
                                  <span>
                                    Glaze <strong>{split.glaze}</strong>
                                  </span>
                                </div>
                              )}
                              {!split && ribs && (
                                <div className="prep-summary-split">
                                  <span>
                                    Ribs <strong>{ribs.total}</strong>
                                  </span>
                                  {ribs.portions > 0 && (
                                    <span>
                                      250 g <strong>{ribs.portions}</strong>
                                    </span>
                                  )}
                                  {ribs.halfRacks > 0 && (
                                    <span>
                                      ½ rack <strong>{ribs.halfRacks}</strong>
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {swiggyPlan && swiggyPlan.sides.length > 0 && (
                    <>
                      <h3 className="inv-section-title">📦 Boxes to pack</h3>
                      <p className="inv-section-hint">
                        Not one box per portion — how many boxes the quantity actually fills. Each side's total
                        is divided into the container it's packed in (a 15 g dressing goes in a 30 ml portion
                        cup, so two of them share one cup; four 100 g salads fit one 30 oz box — sides
                        measured in grams are counted against the box's millilitres 1:1). Boxes the kitchen
                        counts by the serving are divided by portions instead: one caramelised onion or
                        chopped onion to a 2 oz container, six chip portions to a foil sheet.{' '}
                        {usingPerOrderBoxes
                          ? 'Counted one order at a time, since sides only share a box within a single customer’s order.'
                          : 'Counted a plate at a time — the individual orders aren’t loaded, so nothing is combined across a customer’s plates and this reads high.'}
                      </p>
                      <p className="pack-sides-summary">
                        {totalSideBoxes} side box{totalSideBoxes === 1 ? '' : 'es'} for the weekend
                        {totalSideBoxesSaved > 0
                          ? ` — ${totalSideBoxesSaved} fewer than packing every portion on its own.`
                          : '.'}
                      </p>
                      <div className="pack-sides-grid">
                        {swiggyPlan.sides.map((side) => {
                          // Box counts come from the client-side maths where it
                          // has the individual orders to combine within; the
                          // server's plate-by-plate number is the fallback.
                          const row = sideBoxByKey.get(side.key);
                          const boxes = row ? row.boxes : side.boxes;
                          return (
                            <div key={side.key} className="pack-sides-card">
                              {/* Portions lead — that's what the kitchen makes.
                                  How many boxes it lands in is the line under. */}
                              <div className="pack-sides-count">{side.portions}</div>
                              <div className="pack-sides-name">
                                {side.name}
                                {side.hasUnparsedQty && <span className="inv-assumed">partial</span>}
                              </div>
                              <div className="pack-sides-qty">
                                portion{side.portions === 1 ? '' : 's'} · {side.totalQty} {side.unit}
                              </div>
                              <div className="pack-sides-box">
                                {side.container
                                  ? describePacking(side.portions, boxes, side.container)
                                  : 'no container on file — 1 box per order'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  <h3 className="inv-section-title">🥗 Sides needed — batch detail</h3>
                  <p className="inv-section-hint">
                    Same sides as the boxes above, broken out with prep detail — the box count and the
                    container it goes in, then how much to actually prep or buy. Where a side is made
                    in-house from a known-yield batch recipe, the batch count needed is shown too. Run
                    top to bottom: the bands are the order the kitchen makes them in, and within a band
                    the order is yours.
                  </p>
                  {swiggyPlan && swiggyPlan.sides.length > 0 && (
                    <div className="prep-table-wrap">
                      <table className="prep-table">
                        <thead>
                          <tr>
                            <th className="prep-item-col">Side</th>
                            <th>Portions</th>
                            <th>How it's packed</th>
                            <th>Quantity needed</th>
                            <th>Batches</th>
                            <th>Prep</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sidesByPrepTier.map((band) => (
                            <Fragment key={band.tier}>
                              <tr className="prep-group-row">
                                <td colSpan={6}>
                                  {band.tier}. {band.label}
                                  <span className="inv-note-inline">
                                    {' '}
                                    — {band.rows.map((side) => side.name).join(', ')}
                                  </span>
                                </td>
                              </tr>
                              {band.rows.map((side) => (
                                <tr key={side.key}>
                                  <td className="prep-item-col">
                                    {side.name}
                                    {side.hasUnparsedQty && <span className="inv-assumed">partial</span>}
                                  </td>
                                  <td className="prep-total-cell">{side.portions}</td>
                                  <td className="prep-total-cell">
                                    {side.container
                                      ? describePacking(
                                          side.portions,
                                          sideBoxByKey.get(side.key)?.boxes ?? side.boxes,
                                          side.container,
                                        )
                                      : '—'}
                                  </td>
                                  <td className="prep-total-cell">
                                    {side.totalQty} {side.unit}
                                  </td>
                                  <td className="prep-total-cell">
                                    {side.batchInfo
                                      ? `${side.batchInfo.batches} × ${side.batchInfo.batchYield}${side.batchInfo.batchUnit} batch`
                                      : '—'}
                                  </td>
                                  {/* Tier 4 is bought, not made — there's no batch to start,
                                      so it gets no buttons. */}
                                  <td className="prep-status-cell">
                                    {side.prepTier === 4 ? (
                                      <span className="prep-status-buy">buy</span>
                                    ) : (
                                      <SidePrepControl
                                        side={side}
                                        state={sidePrepStatuses[side.key]}
                                        busy={sidePrepBusyKey === side.key}
                                        disabled={Boolean(sidePrepBusyKey) && sidePrepBusyKey !== side.key}
                                        onSet={handleSetSidePrep}
                                      />
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {sidePrepError && <p className="chat-error">{sidePrepError}</p>}

                  <h3 className="inv-section-title">🛒 Swiggy Instamart order (raw ingredients)</h3>
                  <p className="inv-section-hint">
                    Everything on the Instamart run in one list — the raw groceries behind the sides above
                    (in-house preps with a known batch yield broken down into what goes into them, direct items
                    like Chips listed as-is), plus the Bakery-category items that come off Instamart rather
                    than the bakery.
                  </p>
                  {swiggyPlan && (swiggyPlan.swiggyList.length > 0 || swiggyBakeryGroup) ? (
                    <div className="prep-table-wrap">
                      <table className="prep-table">
                        <thead>
                          <tr>
                            <th className="prep-item-col">Ingredient</th>
                            <th>Quantity needed</th>
                            <th>Order qty</th>
                            <th>Est. cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {swiggyPlan.swiggyList.map((row) => (
                            <tr key={`${row.materialId || row.name}-${row.unit}`}>
                              <td className="prep-item-col">{row.name}</td>
                              <td className="prep-total-cell">
                                {row.qty} {row.unit}
                              </td>
                              {/* Raw ingredients carry no order multiple or unit
                                  price in materials.csv — buy the quantity
                                  needed, priced at the till. */}
                              <td className="prep-total-cell">—</td>
                              <td className="prep-total-cell">—</td>
                            </tr>
                          ))}
                          {swiggyBakeryGroup?.rows.map((row) => (
                            <tr key={row.materialId || row.name}>
                              <td className="prep-item-col">
                                {row.name}
                                <span className="inv-note-inline"> (bakery item, bought here)</span>
                              </td>
                              <td className="prep-total-cell">
                                {row.totalQty} {row.unit}
                              </td>
                              <td className="prep-total-cell">
                                {row.orderQty} {row.unit}
                                {row.orderMultiple ? (
                                  <span className="inv-note-inline"> (multiples of {row.orderMultiple})</span>
                                ) : null}
                              </td>
                              <td className="prep-total-cell inv-cost-cell">
                                {row.costInr != null ? inrFormat(row.costInr) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        {swiggyBakeryGroup && swiggyBakeryGroup.totalCost > 0 && (
                          <tfoot>
                            <tr className="inv-total-row">
                              <td className="prep-item-col" colSpan={3}>
                                Estimated cost of the priced lines above
                              </td>
                              <td className="prep-total-cell prep-grand-total">{inrFormat(swiggyBakeryGroup.totalCost)}</td>
                            </tr>
                          </tfoot>
                        )}
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
                      <li>
                        Buy figures use the planned loss %s set in server/core/meatConfig.js — 50% pulled chicken, 56%
                        pulled pork, 30% for every other meat — not the smoking-session history. Planned:{' '}
                        {(Object.keys(LOSS_TILE_LABELS) as (keyof YieldStats)[])
                          .map((k) => `${LOSS_TILE_LABELS[k]} (${effectiveLoss[k].pct}%)`)
                          .join(', ')}
                        .{' '}
                        {(Object.keys(LOSS_TILE_LABELS) as (keyof YieldStats)[]).some((k) => effectiveLoss[k].measuredPct != null) ? (
                          <>
                            Completed sessions (Smoking Session → Resting/Shredding logs raw vs. finished weight)
                            have measured:{' '}
                            {(Object.keys(LOSS_TILE_LABELS) as (keyof YieldStats)[])
                              .filter((k) => effectiveLoss[k].measuredPct != null)
                              .map((k) => `${LOSS_TILE_LABELS[k]} (${effectiveLoss[k].measuredPct}%, ${effectiveLoss[k].sessionCount} session${effectiveLoss[k].sessionCount === 1 ? '' : 's'})`)
                              .join(', ')}
                            {' '}— shown for comparison only. Edit meatConfig.js to adopt a measured number.
                          </>
                        ) : (
                          <>No completed smoking sessions on file yet to compare against.</>
                        )}
                      </li>
                      <li>
                        Per-order meat weights come from recipe_lines.csv and the Bread Time Stories
                        order from materials.csv; the loss %s and which cut each meat is bought as (pulled
                        chicken → chicken legs, pulled pork → pork shoulder) are config in server/core/meatConfig.js —
                        see any gaps listed above the Meat needed tiles for anything still missing. Ribs and
                        chicken buy quantities are shown in kg (how Karnataka Pork Shop/Nayas Chicken actually
                        price them), not a rack/leg count — there's no reliable per-rack or per-leg raw weight on
                        file to convert to.
                      </li>
                      <li>Pulled pork can only be bought in 1.2kg minimum units (server/core/meatConfig.js, pulledPork cut.minBuyKg) — the Buy figure is rounded up to the nearest 1.2kg, shown alongside the exact amount needed.</li>
                      <li>Bun/taco-shell/garlic-bread prices and order multiples (materials.csv standard_cost_inr/order_multiple) are kitchen figures, not yet vendor-invoice-confirmed in writing — worth double-checking with Bread Time Stories. Tortilla's ₹30/pc and 6-piece minimum are the Swiggy pack price (₹180 for 6) divided out, so they move with whatever Instamart is charging that week.</li>
                      <li>Sides needed &amp; the Swiggy order above are driven by menu.csv/recipe_ingredients.csv/rub_recipes.csv instead of guesses — see "Data gaps found" above for anything still missing from that data.</li>
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Step 3: Pre-packing guidelines</h2>
              <p>
                Per-order packing intelligence for {odooFrom} – {odooTo}, laid out as the weekend's four delivery
                slots side by side — Saturday Lunch, Saturday Dinner, Sunday Lunch, Sunday Dinner. Where an order
                needs 2+ of the same side (e.g. 3 burgers each wanting a salad), pack it as one combined container
                instead of one per dish. Each order also carries its Odoo Fulfilment Status dropdown — IN_SMOKER →
                PREPPING → PACKED → PARTNER_ASGN → OUT_FOR_DEL → DELIVERED — which writes straight to the sale
                order.
              </p>

              <div className="prep-paste-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleFetchPacking}
                  disabled={!odooFrom || !odooTo || isLoadingPacking}
                >
                  {isLoadingPacking ? 'Fetching…' : 'Fetch pre-packing guidelines'}
                </button>
              </div>
              {packingError && <p className="chat-error">{packingError}</p>}

              {!packingData && !isLoadingPacking && !packingError && (
                <div className="empty-state">
                  <div className="empty-state-icon">📦</div>
                  <h3>No guidelines fetched yet</h3>
                  <p>Click "Fetch pre-packing guidelines" above — it builds itself from confirmed Odoo orders.</p>
                </div>
              )}

              {packingData && packingData.unmatched.length > 0 && (
                <div className="prep-unmatched">
                  <strong>Couldn't confidently place these — check Odoo and re-fetch:</strong>
                  <ul>
                    {packingData.unmatched.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}

              {packingData && totalPackingOrders > 0 && (
                <>
                  <p className="status-message">
                    {totalPackingOrders} order{totalPackingOrders === 1 ? '' : 's'} across the weekend
                    {totalContainersSaved > 0
                      ? ` — combining repeat sides saves ${totalContainersSaved} container${totalContainersSaved === 1 ? '' : 's'}.`
                      : '.'}
                  </p>

                  {/* The note read is a background pass over the orders above,
                      so it reports itself here rather than blocking anything.
                      A failure says so plainly instead of silently showing no
                      callouts, which would be indistinguishable from "nobody
                      asked for a time". */}
                  {isReadingNotes && (
                    <p className="pack-guide-note">⏰ Reading the customer notes for delivery-time requests…</p>
                  )}
                  {notesError && (
                    <p className="chat-error">
                      ⏰ Could not read the order notes, so any time requests in them are not flagged below:{' '}
                      {notesError}
                    </p>
                  )}
                  {!isReadingNotes && !notesError && timePreferenceCount > 0 && (
                    <p className="pack-guide-note">
                      ⏰ {timePreferenceCount} order{timePreferenceCount === 1 ? '' : 's'} asked for a specific
                      {' '}delivery time — flagged on the card{timePreferenceCount === 1 ? '' : 's'} below.
                    </p>
                  )}

                  {/* The weekend's four delivery slots as a picker — pick
                      one and its orders fill the width below, rather than
                      four narrow columns competing for it. Every slot stays
                      on the strip even when empty, so the strip doubles as
                      the weekend's shape at a glance. */}
                  <div className="slot-picker">
                    {packingOrdersBySlot.map(({ slot, orders: slotOrders }) => (
                      <button
                        key={slot.id}
                        type="button"
                        className={`slot-picker-btn ${activePackSlot === slot.id ? 'active' : ''} ${
                          slotOrders.length === 0 ? 'empty' : ''
                        }`}
                        onClick={() => setActivePackSlot(slot.id)}
                      >
                        <span className="slot-picker-name">
                          {slot.part === 'Lunch' ? '🌤️' : '🌙'} {slot.day} {slot.part}
                        </span>
                        <span className="slot-picker-count">
                          {slotOrders.length} order{slotOrders.length === 1 ? '' : 's'} ·{' '}
                          {slotOrders.reduce((sum, o) => sum + o.order.itemCount, 0)} items
                        </span>
                      </button>
                    ))}
                  </div>

                  {activePackOrders.length === 0 ? (
                    <p className="pack-slot-empty">Nothing for this slot.</p>
                  ) : (
                    <>
                      <BulkStatusBar
                        orders={activePackOrders.map(({ order }) => order)}
                        statuses={fulfilment.statuses}
                        busy={isBulkBusy}
                        onApply={handleBulkApply}
                      />

                      <div className="pack-order-grid">
                        {activePackOrders.map(({ order, combinable, singles, containersSaved, orderBoxes }) => (
                          <div key={order.orderId} className="pack-order-card">
                            <div className="pack-order-header">
                              <span className="pack-order-name">{order.orderName}</span>
                              <FulfilmentBadge order={order} status={fulfilment.statuses[String(order.orderId)]} />
                            </div>
                            <div className="pack-order-customer">{order.customer}</div>

                            <TimePreferenceCallout preference={timePreferences[String(order.orderId)]} />

                            <FulfilmentControl
                              order={order}
                              status={fulfilment.statuses[String(order.orderId)]}
                              busy={Boolean(fulfilment.busy[String(order.orderId)])}
                              error={fulfilment.errors[String(order.orderId)]}
                              onSetStatus={fulfilment.setStatus}
                              onRetryInvoice={fulfilment.retryInvoice}
                            />

                            <ul className="pack-order-items">
                              {order.items.map((item) => (
                                <li key={item.itemId}>
                                  <span>{item.name}</span>
                                  <span className="pack-order-item-qty">× {item.qty}</span>
                                </li>
                              ))}
                            </ul>

                            {(combinable.length > 0 || singles.length > 0) && (
                              <div className="pack-order-smart">
                                <div className="pack-order-smart-title">
                                  📦 Pack smart
                                  <span className="pack-order-boxes">
                                    {orderBoxes} box{orderBoxes === 1 ? '' : 'es'}
                                  </span>
                                  {containersSaved > 0 && (
                                    <span className="pack-order-savings">
                                      saves {containersSaved} container{containersSaved === 1 ? '' : 's'}
                                    </span>
                                  )}
                                </div>
                                {combinable.length > 0 ? (
                                  <ul className="pack-order-smart-list">
                                    {combinable.map((g) => (
                                      <li key={g.key} className="pack-order-smart-combine">
                                        <span className="pack-smart-line">
                                          <span className="pack-smart-main">
                                            {g.portions}× <strong>{g.name}</strong>
                                            {g.baseQty != null ? ` (${roundQty(g.baseQty)} ${g.baseUnit} total)` : ''}
                                          </span>
                                          <span className="pack-smart-sub">
                                            Combine into {describePacking(g.portions, g.boxes, g.container)}
                                          </span>
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="inv-note">
                                    Nothing combines on this order — every side already fills its own box.
                                  </p>
                                )}
                                {singles.length > 0 && (
                                  <ul className="pack-order-smart-list">
                                    {singles.map((g) => (
                                      <li key={g.key} className="pack-order-smart-single">
                                        <span className="pack-smart-line">
                                          <span className="pack-smart-main">
                                            {g.portions}× <strong>{g.name}</strong>
                                            {g.baseQty != null ? ` (${roundQty(g.baseQty)} ${g.baseUnit})` : ''}
                                          </span>
                                          <span className="pack-smart-sub">
                                            {describePacking(g.portions, g.boxes, g.container)}
                                            {g.boxes === g.portions && g.portions > 1 && !g.container?.portionCapacity
                                              ? ' — one each, they won’t share'
                                              : ''}
                                          </span>
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="wizard-actions">
          {step > 1 && (
            <button type="button" className="secondary-button" onClick={handleBack}>
              Back
            </button>
          )}
          {step === 1 && (
            <button type="button" className="primary-button" onClick={handleNext}>
              Next: Estimate inventory
            </button>
          )}
          {step === 2 && (
            <button type="button" className="primary-button" onClick={handleNext}>
              Next: Pre-packing guidelines
            </button>
          )}
        </div>
      </div>

      {openQuotation && (
        <div
          className="prep-modal-overlay"
          role="presentation"
          onClick={() => {
            if (confirmingOrderId === null) setOpenQuotationId(null);
          }}
        >
          <div
            className="prep-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Quotation ${openQuotation.orderName}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="prep-modal-head">
              <div className="prep-quotation-title">
                <strong>{openQuotation.orderName}</strong>
                <span className="prep-quotation-state">
                  {openQuotation.state === 'sent' ? 'Sent to customer' : 'Draft'}
                </span>
              </div>
              <button
                type="button"
                className="prep-modal-close"
                aria-label="Close"
                onClick={() => setOpenQuotationId(null)}
                disabled={confirmingOrderId !== null}
              >
                ×
              </button>
            </div>

            <dl className="prep-modal-facts">
              <div>
                <dt>Customer</dt>
                <dd>{openQuotation.customer}</dd>
              </div>
              <div>
                <dt>Contact</dt>
                <dd>
                  {openQuotation.customerPhone ? (
                    <a href={`tel:${openQuotation.customerPhone.replace(/\s+/g, '')}`}>
                      {openQuotation.customerPhone}
                    </a>
                  ) : (
                    <span className="prep-modal-missing">No number on the Odoo contact</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Promised</dt>
                <dd>
                  {formatPromised(openQuotation.promised)}
                  {openQuotation.slotLabel ? ` · ${openQuotation.slotLabel}` : ''}
                </dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>
                  {openQuotation.amountTotal
                    ? `₹${Math.round(openQuotation.amountTotal).toLocaleString('en-IN')}`
                    : '—'}
                </dd>
              </div>
            </dl>

            <ul className="prep-quotation-items">
              {openQuotation.items.length === 0 && <li>No product lines on this quotation.</li>}
              {openQuotation.items.map((line, index) => (
                <li key={index} className={line.itemId ? '' : 'prep-quotation-item-unmatched'}>
                  {line.qty} × {line.name}
                  {line.itemId ? '' : ' — no matching menu item, won’t be added'}
                </li>
              ))}
            </ul>

            {openQuotation.slotIssue && <p className="prep-quotation-warning">{openQuotation.slotIssue}</p>}
            {quotationError && <p className="chat-error">{quotationError}</p>}

            <div className="prep-modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setOpenQuotationId(null)}
                disabled={confirmingOrderId !== null}
              >
                Close
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => handleConfirmQuotation(openQuotation)}
                disabled={confirmingOrderId !== null}
              >
                {confirmingOrderId === openQuotation.orderId ? 'Confirming…' : 'Confirm in Odoo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WeekendPrepPlanner;
