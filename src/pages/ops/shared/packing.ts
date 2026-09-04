// Side-packing maths shared by the two boards that pack sides — Order
// Management (per slot, on packing day) and the Weekend Prep Planner (Step 2's
// whole-weekend box estimate).
//
// The two pages deliberately mirror each other's language and shapes rather
// than importing components from one another, but the container arithmetic
// has to agree between them to the box or the prep-day estimate and the
// packing-day reality won't add up — so it lives here, in one place, instead
// of being copied twice.
//
// The container a side goes into, and how much it holds, comes from the
// server (server/core/packagingConfig.js) attached to every sides-by-item line —
// nothing here hardcodes a box size.

export type PackOrderItem = { itemId: string; name: string; qty: number };
export type PackOrder = {
  orderId: number;
  orderName: string;
  customer: string;
  packBy: string | null;
  // Odoo's own "Fulfilment Status" as it stood at fetch time — a snapshot
  // used to flag drift, not the pipeline this app drives.
  odooFulfilment: string | null;
  // The order's free-text note from Odoo as plain text (server/integrations/odoo.js
  // htmlToText), null when it has none. For a website order this is the
  // checkout summary, and its last line is whatever the customer typed into
  // the note box — which is the only place they can ask for a delivery time.
  note: string | null;
  itemCount: number;
  items: PackOrderItem[];
};
export type PackSlotId = 'satLunch' | 'satEvening' | 'sunLunch' | 'sunEvening';

// One column of Order Management's picker strip. The server builds these so
// both channels arrive in the same shape (server/integrations/odoo.js b2cGroups/b2bGroups):
// for B2C the four weekend services in the order they happen, for B2B one per
// delivery day, earliest first. `id` is the slot id or the 'YYYY-MM-DD' day.
export type PackGroup = {
  id: string;
  label: string;
  sublabel: string;
  emoji: string;
  orders: PackOrder[];
};

export type PackingResponse = {
  groups: PackGroup[];
  // The B2C weekend's slot-keyed form, still returned alongside `groups` for
  // anything that wants an order list by slot id rather than the strip order.
  // Empty for B2B, whose groups are delivery days, not fixed slots.
  slots: Record<PackSlotId, PackOrder[]>;
  unmatched: string[];
  ordersFound: number;
};

// What Gemini made of one order's note (POST /api/orders/time-preferences,
// server/integrations/geminiContent.js readOrderTimePreferences). Orders whose note asked
// for nothing about timing come back with hasPreference false rather than
// being left out, so the board can tell "read it, nothing there" apart from
// "not read yet".
export type OrderTimePreference = {
  hasPreference: boolean;
  // Short badge text — "Deliver by 1:00 PM", "ASAP". Empty when there is none.
  label: string;
  // 24-hour HH:MM when the customer named a clock time, else empty. This is
  // what makes a preference sortable/comparable; label alone is only text.
  preferredTime: string;
  // The customer's own words, verbatim, so the kitchen can judge it rather
  // than trust a paraphrase.
  quote: string;
  confidence: 'high' | 'medium' | 'low';
};
export type OrderTimePreferences = Record<string, OrderTimePreference>;

// The box a side is packed in — material_id/name straight out of
// materials.csv. Sized one of two ways (server/core/packagingConfig.js):
// capacity in ml (grams compared 1 g ~ 1 ml), or portionCapacity in whole
// servings for the boxes the kitchen counts by the portion — one caramelised
// onion per 2 oz tub, six chip portions per foil sheet. portionCapacity wins
// where both are on file; null for a side with no container mapped at all.
export type SideContainer = {
  materialId: string;
  name: string;
  capacity: number | null;
  portionCapacity?: number | null;
} | null;

// Static per-item reference (GET /api/recipes/sides-by-item): which packable
// sides a menu item needs. qty is the amount to show; baseQty is the planner's
// figure for the same line, which is what divides into a container capacity.
export type SideByItemLine = {
  key: string;
  name: string;
  qty: number | null;
  baseQty: number | null;
  container: SideContainer;
};
export type SidesByItem = Record<string, SideByItemLine[]>;

// For one order: every packable side it needs, aggregated across its line
// items (the same sub-recipe/material on two different dishes in one order —
// e.g. Salad mix on a burger and a rib order together — collapses into a
// single "pack together" line, the same key computeSwiggyPlan groups by).
export type OrderSideGroup = {
  key: string;
  name: string;
  portions: number;
  totalQty: number | null;
  // The figure `boxes` is derived from — usually identical to totalQty, and
  // different only on a line that carries a separate planner number.
  baseQty: number | null;
  container: SideContainer;
  // How many boxes this group actually needs once the container's capacity
  // is respected — 4 x 30 ml BBQ sauce is 4 cups, not "1 container".
  boxes: number;
};

// How many boxes a side needs. Portions win over volume where the container
// is sized in portions — that's the only sizing that works for sides
// recorded in "burger portion"/"taco portion", which have no millilitres to
// divide. A side with no container on file falls back to one box per group,
// which is what the boards assumed everywhere before capacities existed.
export const containersNeeded = (qty: number | null, container: SideContainer, portions?: number): number => {
  if (!container) return 1;
  if (container.portionCapacity && container.portionCapacity > 0) {
    if (!portions || portions <= 0) return 1;
    return Math.ceil(portions / container.portionCapacity);
  }
  if (!container.capacity) return 1;
  if (!qty || qty <= 0) return 1;
  return Math.ceil(qty / container.capacity);
};

// How the portions actually split across the boxes, largest box first: 8 chip
// portions at 6 to a foil sheet is [6, 2], not "2 sheets" — the kitchen fills
// one sheet before starting the next, and the pack card should say so.
// Returns [] for volume-sized containers, where portions don't divide evenly
// into anything worth naming.
export const portionSplit = (portions: number, container: SideContainer): number[] => {
  const per = container?.portionCapacity || 0;
  if (per <= 0 || portions <= 0 || per >= portions) return [];
  const split: number[] = [];
  let left = portions;
  while (left > 0) {
    split.push(Math.min(per, left));
    left -= per;
  }
  return split;
};

export const buildOrderSideGroups = (order: PackOrder, sidesByItem: SidesByItem | null): OrderSideGroup[] => {
  if (!sidesByItem) return [];
  const groups = new Map<string, OrderSideGroup>();
  order.items.forEach((item) => {
    const lines = sidesByItem[item.itemId] || [];
    lines.forEach((line) => {
      if (!groups.has(line.key)) {
        groups.set(line.key, {
          key: line.key,
          name: line.name,
          portions: 0,
          totalQty: 0,
          baseQty: 0,
          container: line.container || null,
          boxes: 0,
        });
      }
      const group = groups.get(line.key)!;
      group.portions += item.qty;
      if (line.qty != null && group.totalQty != null) group.totalQty += line.qty * item.qty;
      else group.totalQty = null;
      if (line.baseQty != null && group.baseQty != null) group.baseQty += line.baseQty * item.qty;
      else group.baseQty = null;
    });
  });
  const rows = Array.from(groups.values());
  // Boxes are worked out once the whole order is aggregated, not per line —
  // that's the entire point of combining: three 15 g dressings in one order
  // are 45 g, which is two 30 ml cups, not three.
  rows.forEach((group) => {
    group.boxes = containersNeeded(group.baseQty, group.container, group.portions);
  });
  return rows.sort((a, b) => b.portions - a.portions);
};

// "2 x 30 ml portion cup", or a plain container count for a side with no
// capacity on file.
export const describeBoxes = (boxes: number, container: SideContainer): string => {
  if (!container) return `${boxes} container${boxes === 1 ? '' : 's'}`;
  return `${boxes} × ${container.name}`;
};

// The packing line that sits under a side's portion count: how many boxes,
// which box, and — where the container is sized in portions — how the
// portions actually land in them ("2 x aluminium foil sheet — 6 + 2
// portions"). Portions lead on the boards; this is the subtext.
export const describePacking = (portions: number, boxes: number, container: SideContainer): string => {
  const label = describeBoxes(boxes, container);
  // "1 + 1 + 1 + 1 portions" is noise — a one-portion box just says so.
  if (container?.portionCapacity === 1) return portions > 1 ? `${label} — one portion each` : label;
  const split = portionSplit(portions, container);
  if (split.length > 1) return `${label} — ${split.join(' + ')} portions`;
  return label;
};

// What the group actually saves against packing every portion on its own —
// 4 salads into one 30 oz tray saves 3 boxes; 4 BBQ sauces into 4 cups saves
// nothing, because a 30 ml cup holds exactly one 30 ml portion.
export const boxesSaved = (group: OrderSideGroup): number => Math.max(0, group.portions - group.boxes);

// ---- Whole-weekend / whole-slot totals -----------------------------------
// One row per side across many orders, with boxes summed order by order —
// sides only combine inside a single customer's order, so this can't be done
// from slot totals alone (see sideBoxTotalsFromCounts for when they're all
// there is).
export type SideBoxTotal = {
  key: string;
  name: string;
  portions: number;
  totalQty: number | null;
  container: SideContainer;
  boxes: number;
};

const emptyTotal = (group: { key: string; name: string; container: SideContainer }): SideBoxTotal => ({
  key: group.key,
  name: group.name,
  portions: 0,
  totalQty: 0,
  container: group.container,
  boxes: 0,
});

export const sideBoxTotals = (orders: PackOrder[], sidesByItem: SidesByItem | null): SideBoxTotal[] => {
  const totals = new Map<string, SideBoxTotal>();
  orders.forEach((order) => {
    buildOrderSideGroups(order, sidesByItem).forEach((group) => {
      const row = totals.get(group.key) || emptyTotal(group);
      row.portions += group.portions;
      if (group.totalQty != null && row.totalQty != null) row.totalQty += group.totalQty;
      else row.totalQty = null;
      row.boxes += group.boxes;
      totals.set(group.key, row);
    });
  });
  return Array.from(totals.values()).sort((a, b) => b.boxes - a.boxes || b.portions - a.portions);
};

// Fallback for when only per-menu-item counts are on hand (orders typed in
// by hand, or the individual orders not fetched yet): every plate is treated
// as its own order, so nothing combines. Always an over-estimate against
// sideBoxTotals, never an under-estimate — safe to shop and prep against.
export const sideBoxTotalsFromCounts = (
  orderCounts: Record<string, number>,
  sidesByItem: SidesByItem | null,
): SideBoxTotal[] => {
  if (!sidesByItem) return [];
  const totals = new Map<string, SideBoxTotal>();
  Object.entries(orderCounts).forEach(([itemId, count]) => {
    if (!count) return;
    (sidesByItem[itemId] || []).forEach((line) => {
      const row =
        totals.get(line.key) ||
        emptyTotal({ key: line.key, name: line.name, container: line.container || null });
      row.portions += count;
      if (line.qty != null && row.totalQty != null) row.totalQty += line.qty * count;
      else row.totalQty = null;
      row.boxes += count * containersNeeded(line.baseQty, line.container || null, 1);
      totals.set(line.key, row);
    });
  });
  return Array.from(totals.values()).sort((a, b) => b.boxes - a.boxes || b.portions - a.portions);
};

// ---- Which meats an order carries ---------------------------------------
// Static reference from GET /api/recipes/meat-by-item — every menu item's
// smoked-meat components, worked out from the same IP-xxx recipe lines the
// meat plan uses (server/ops/b2c/recipes.js getMeatByItem). Keyed by menu item
// id, same as SidesByItem; an item with no meat has no entry.
export type MeatByItemLine = {
  // meatConfig.js category key — 'chicken', 'pulledPork', 'ribs', …
  category: string;
  label: string;
  productName: string;
};
export type MeatByItem = Record<string, MeatByItemLine[]>;

// A smoker "load": one switch on the Order Management board, covering every
// meatConfig category that goes in together. Pork is one load whatever cut it
// is — shoulder, ribs and belly all go on the same smoke — so all three
// categories sit behind the single pork switch. Chicken is its own.
//
// A category missing from every group here simply has no switch (jackfruit
// and beef ribs today); those orders are still driven one at a time from the
// per-order dropdown, which is unchanged.
export type SmokerLoad = {
  id: 'pork' | 'chicken';
  label: string;
  emoji: string;
  categories: string[];
};

export const SMOKER_LOADS: SmokerLoad[] = [
  { id: 'pork', label: 'Pork', emoji: '🐖', categories: ['pulledPork', 'ribs', 'porkBelly'] },
  { id: 'chicken', label: 'Chicken', emoji: '🐔', categories: ['chicken'] },
];

// The meat categories one order actually needs, deduped across its line
// items — a burger and a rib plate in the same order come back as
// { chicken, ribs }.
export const orderMeatCategories = (order: PackOrder, meatByItem: MeatByItem | null): Set<string> => {
  const categories = new Set<string>();
  if (!meatByItem) return categories;
  order.items.forEach((item) => {
    (meatByItem[item.itemId] || []).forEach((line) => categories.add(line.category));
  });
  return categories;
};

// Does this order have anything in this smoker load? — the test behind
// "whichever order has pork moves to IN_SMOKER".
export const orderNeedsLoad = (order: PackOrder, meatByItem: MeatByItem | null, load: SmokerLoad): boolean => {
  const categories = orderMeatCategories(order, meatByItem);
  return load.categories.some((category) => categories.has(category));
};

// ---- Smoker days --------------------------------------------------------
// The meat goes on per SERVICE DAY, not per range: Saturday's orders are
// smoked on Saturday morning and Sunday's on Sunday. So the "set smoker
// status" step buckets the board's groups by the day they're delivered on and
// lights one day at a time — a single range-wide switch would drag Sunday's
// orders to IN_SMOKER a day early.
//
// B2C's four services collapse into their two days (satLunch + satEvening ->
// Saturday). B2B's groups are already one per delivery day, so each stays its
// own bucket with the label the server gave it.
export type SmokerDay = { id: string; label: string; emoji: string; orders: PackOrder[] };

const SLOT_DAY: Record<string, { id: string; label: string }> = {
  satLunch: { id: 'sat', label: 'Saturday' },
  satEvening: { id: 'sat', label: 'Saturday' },
  sunLunch: { id: 'sun', label: 'Sunday' },
  sunEvening: { id: 'sun', label: 'Sunday' },
};

export const smokerDays = (groups: PackGroup[]): SmokerDay[] => {
  const days: SmokerDay[] = [];
  const byId = new Map<string, SmokerDay>();
  groups.forEach((group) => {
    const slotDay = SLOT_DAY[group.id];
    const id = slotDay ? slotDay.id : group.id;
    const existing = byId.get(id);
    if (existing) {
      existing.orders = existing.orders.concat(group.orders);
      return;
    }
    // Groups arrive in service order, so the first one to claim a day fixes
    // where that day sits on the strip.
    const day: SmokerDay = {
      id,
      label: slotDay ? slotDay.label : group.label,
      emoji: '🔥',
      orders: [...group.orders],
    };
    byId.set(id, day);
    days.push(day);
  });
  return days;
};
