import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPurchaseDraft,
  clearStoredPurchaseDraft,
  describePurchaseRestore,
  hasDraftContent,
  readStoredPurchaseDraft,
  reconcileDraftLines,
  restorePurchaseDraft,
  writeStoredPurchaseDraft,
  type LinePurpose,
} from './purchaseDraft';

// Weekly Purchasing — logs purchases from all three vendor types (meat
// shops, Bread Time Stories, Swiggy) against the shared knowledge-base
// catalog (server/ops/shared/purchasing.js -> vendors.csv / materials.csv /
// materials.csv / purchase_log.csv), and can send the same line items to Odoo
// as a draft Purchase Order (an RFQ — nothing is confirmed/committed there
// automatically, see server/integrations/odoo.js createPurchaseOrder).

type Vendor = {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  supplies_category: string;
};

type RawMaterial = {
  material_id: string;
  item_name: string;
  category: string;
  reorder_level: string;
};

type PurchaseRecord = {
  purchase_id: string;
  material_id: string;
  item_name: string;
  purchase_date: string;
  quantity_purchased: string;
  // The piece-bought pair, blank on everything sold by weight: what one piece
  // weighs, and what the line comes to in kg (derived server-side from the
  // two beside it — see PURCHASE_SQL in server/core/kbViews.js).
  weight_per_unit_kg?: string;
  total_weight_kg?: string;
  unit_price: string;
  total_cost: string;
  // purchase_log.csv's own column names — the log records vendor_id/vendor_name,
  // and `channel` is which side of the business the buy was made for.
  vendor_name: string;
  channel: string;
  // 'Order' or 'Practice' — blank on rows logged before the column existed.
  purpose?: string;
  // Cost attribution, both optional. `client_name` is which B2B account the
  // spend was for (set here, per line); `smoking_session_id` is which cook it
  // was bought for (set later, at Start Smoking — see server/ops/shared/smoking.js
  // startSmoking). Neither exists on B2C rows.
  client_id?: string;
  client_name?: string;
  smoking_session_id?: string;
  odoo_po_id?: string;
  odoo_po_line_id?: string;
  // 'material', 'service' (labour, subscriptions — nothing to stock) or blank
  // for an ad hoc line; and what the money was for.
  item_type?: string;
  expense_category?: string;
};

// One catalogue item the server thinks an ad hoc purchase line probably was,
// as GET /api/purchasing/purchases/:id/match-suggestions returns it. `source`
// says which pass produced it — Gemini reading the two names, or plain string
// similarity when there's no key or the call failed — and the panel shows it,
// because "similar name" and "same cut, butcher's abbreviation" are worth
// different amounts of trust. See server/ops/shared/materialMatch.js.
type MatchSuggestion = {
  materialId: string;
  itemName: string;
  category: string;
  quantityOnHand: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  score: number;
  source: 'gemini' | 'local';
};

// One wholesale/corporate account, as GET /api/b2b/clients returns it (see
// toClient in server/ops/b2b/b2bClients.js). Only the two fields the picker needs.
type B2BClient = { id: string; name: string; stage: string };

type CartLine = {
  key: string;
  materialId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  // For an item bought by the piece, what one piece weighs — 0 when it
  // doesn't apply or hasn't been weighed. See canBuyByPiece below.
  weightPerUnitKg: number;
  // Which B2B account this one line is for. Per line rather than per cart
  // because one butcher run routinely covers two accounts, and one cart
  // routinely mixes a client's meat with packaging bought for nobody in
  // particular — see recordPurchases in server/ops/shared/purchasing.js. Always
  // optional: an untagged line is general overhead, which is a real answer.
  clientId: string;
  clientName: string;
  // Order or Practice, per line for the same reason as the client tag.
  purpose: LinePurpose;
  // Set only on lines a bill scan produced (see handleScanBill). `billText`
  // is the vendor's own wording for the item, kept beside the catalog name so
  // the review can be done against the paper without translating; `matched`
  // says whether the catalog recognised the item at all, and `derivedPrice`
  // / `derivedQuantity` that the unit price or the quantity was worked out
  // from the other two numbers rather than read off the bill. All four exist
  // to mark the lines worth a second look — they are display only and never
  // sent to the server.
  billText?: string;
  // What the bill priced by ("kg", "pc"), so the cart can say "₹560 / kg"
  // instead of leaving the rate unitless. Display only, like the rest.
  unit?: string;
  matched?: boolean;
  derivedPrice?: boolean;
  derivedQuantity?: boolean;
};

// One bill read, as POST /api/purchasing/scan-bill returns it (see
// normaliseScannedBill in server/ops/shared/purchaseScan.js). Nothing here is
// saved anywhere — it's a draft to load into the cart and check.
type ScannedBill = {
  vendorName: string;
  vendorText: string;
  purchaseDate: string;
  dateText: string;
  notes: string;
  lines: {
    materialId: string;
    itemName: string;
    billText: string;
    unit: string;
    quantity: number;
    derivedQuantity: boolean;
    unitPrice: number;
    derivedPrice: boolean;
    lineTotal: number;
    matched: boolean;
  }[];
  skipped: { itemName: string; reason: string }[];
};

const CUSTOM_ITEM_VALUE = '__custom__';

// Items the vendor sells and prices by the piece, but the kitchen uses by the
// weight — whole chicken (RM-047) is the one on the books today. The butcher
// hands over four birds and charges per bird; every plan downstream of the
// buy is in kg (a session's raw weight, a B2B client's kg/week, the meat
// plan), and a bird is not a fixed weight, so the count alone can't answer
// them. For these the line is entered as three numbers — how many, what one
// weighs, what one costs — instead of the usual quantity/unit-price pair.
//
// Which materials may be bought this way. Meat is the qualifier that keeps
// buns, sporks and containers out of it: those are bought by the piece and
// used by the piece, and asking what one spork weighs is noise.
//
// It used to also require that the material was stocked in 'pcs', which made
// the form switch itself over with no input from the buyer. Nothing records a
// unit of measure any more, and "meat" alone would put the piece boxes in
// front of every pork-shoulder line bought by weight — so the buyer says so
// instead, with the tick box below, and it starts off.
const canBuyByPiece = (m?: RawMaterial) => !!m && m.category === 'Meat';

// Which materials.csv categories (and, for the two meat categories,
// which item-name keyword) each vendor's `supplies_category` value is
// allowed to buy — keyed on vendors.csv's supplies_category column so a new
// vendor only needs the right value there (the Add-vendor form's datalist
// already suggests the values in use) rather than a code change here.
// "Meat" covers both pork and chicken raw materials, so pork/chicken vendors
// narrow it further by a keyword in the item name (all current Meat rows
// have "pork" or "chicken" in their name). Keep the "Groceries & Misc
// (on-demand)" list in sync with SWIGGY_CATEGORIES in server/ops/b2c/recipes.js —
// that's the same on-demand-grocery vendor (Swiggy) sourcing the Weekend
// Prep Planner's shopping list.
const SUPPLIES_CATEGORY_RULES: Record<string, { categories: string[]; nameFilter?: RegExp }> = {
  Pork: { categories: ['Meat'], nameFilter: /pork/i },
  Chicken: { categories: ['Meat'], nameFilter: /chicken/i },
  Bakery: { categories: ['Bakery'] },
  'Groceries & Misc (on-demand)': {
    categories: ['Dairy & Eggs', 'Produce', 'Sauces & Condiments', 'Spices & Seasonings', 'Sweeteners', 'Oils & Liquids', 'Snacks & Sides'],
  },
  'Packaging & Supplies': { categories: ['Packaging & Supplies'] },
};

// Labour, logistics and miscellaneous spend are purchase lines too — a service
// under a vendor and category of the same name (see recordExpense in
// server/ops/shared/purchasing.js). The category is what tells them apart
// from a buy.
// Investment is kept out of spend on Spending vs Sales and counted only in its
// Total investment tile (see server/finance/weeklyLedger.js).
const EXPENSE_KINDS = ['Labour', 'Logistics', 'Investment', 'Miscellaneous'] as const;
type ExpenseKind = (typeof EXPENSE_KINDS)[number];
const EXPENSE_VENDOR_TYPE = 'Expense';const expenseKindOf = (p: PurchaseRecord): ExpenseKind | null =>
  (EXPENSE_KINDS as readonly string[]).includes(p.expense_category ?? '') ? (p.expense_category as ExpenseKind) : null;

const inrFormat = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const formatDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The Monday-to-Sunday week a date falls in — the same week boundary the
// spend reports use (see server/finance/weeklyLedger.js for why Monday).
const weekRangeOf = (date: Date) => {
  const daysSinceMonday = (date.getDay() + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: formatDateInput(monday), to: formatDateInput(sunday) };
};

const parseDateInput = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const getThisWeekRange = () => weekRangeOf(new Date());
const DEFAULT_RANGE = getThisWeekRange();

// Every purchase is filed in the current Monday–Sunday week — the one this
// screen opens on — whatever date a restored draft or a scanned bill carries.
// A date inside this week is kept; anything else becomes today. A bill dated
// last Sunday and logged on Monday used to land in last week, out of sight of
// the table below, and got logged again (the Swiggy bill, three times).
const inThisWeek = (iso: string | undefined) => {
  const week = getThisWeekRange();
  return Boolean(iso) && (iso as string) >= week.from && (iso as string) <= week.to;
};
const thisWeekDate = (iso: string | undefined) => (inThisWeek(iso) ? (iso as string) : formatDateInput(new Date()));

// "6 Sep" — one date, spelled the way the week labels below are.
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// "7–13 Sep" / "29 Sep – 5 Oct" — the week an expense is filed against.
const weekLabel = (start: string, end: string) => {
  const fmt = (iso: string, withMonth: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', withMonth ? { day: 'numeric', month: 'short' } : { day: 'numeric' });
  };
  return start.slice(5, 7) === end.slice(5, 7) ? `${fmt(start, false)}–${fmt(end, true)}` : `${fmt(start, true)} – ${fmt(end, true)}`;
};

async function readJson<T>(resp: Response): Promise<T> {
  try {
    return await resp.json();
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
}

// `channel` is which side of the business this screen buys for — B2C by
// default, "B2B" from the B2B dashboard. It tags what gets logged and scopes
// the Recent purchases panel below, because that panel is a spend view and
// mixing the two sides' spend would make its week total mean nothing. The
// catalog, the vendors and the inventory it feeds are shared: a channel is
// who the buy was FOR, not a separate stock cupboard.
const WeeklyPurchasing: React.FC<{ channel?: 'B2C' | 'B2B' }> = ({ channel = 'B2C' }) => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loadError, setLoadError] = useState('');

  // The cart, the vendor, the date and the half-typed line all come back from
  // localStorage at mount rather than starting empty — this screen is used on
  // a phone at a shop counter, and a backgrounded tab is evicted whenever the
  // OS wants the memory. See src/pages/ops/shared/purchaseDraft.ts for what is
  // kept and why the restore is synchronous rather than gated behind a fetch.
  const [restored] = useState(() => restorePurchaseDraft(readStoredPurchaseDraft(channel)));

  const [vendorName, setVendorName] = useState(restored.vendorName);
  const [purchaseDate, setPurchaseDate] = useState(thisWeekDate(restored.purchaseDate));
  const [cart, setCart] = useState<CartLine[]>(restored.lines);
  // What the restore picked up, said out loud: a cart that reappears on its
  // own is a cart someone can log twice, so the buyer is told how many lines
  // came back, when they were last touched and what date they will be filed
  // under. Cleared with the cart.
  const [restoreNotice, setRestoreNotice] = useState(() => describePurchaseRestore(restored));

  // Only fetched (and only rendered) on the B2B side — B2C has no account
  // book to attribute spend to.
  const [clients, setClients] = useState<B2BClient[]>([]);
  const [lineClientId, setLineClientId] = useState(restored.entry.lineClientId);
  // Sticky like the client pick: every line added (or scanned) takes it.
  const [linePurpose, setLinePurpose] = useState<LinePurpose>(restored.entry.linePurpose);

  const [materialChoice, setMaterialChoice] = useState(restored.entry.materialChoice);
  const [customName, setCustomName] = useState(restored.entry.customName);
  const [quantity, setQuantity] = useState(restored.entry.quantity);
  const [unitPrice, setUnitPrice] = useState(restored.entry.unitPrice);
  const [weightPerPiece, setWeightPerPiece] = useState(restored.entry.weightPerPiece);
  // Ticked by the buyer for a meat line bought as birds/racks rather than by
  // weight — see canBuyByPiece.
  const [boughtByPiece, setBoughtByPiece] = useState(restored.entry.boughtByPiece);
  const [addLineError, setAddLineError] = useState('');

  // Bill scanning. `scanReview` holds what the last read couldn't do for
  // itself — an unknown vendor, an unusable date, lines it dropped — and
  // stays on screen until the cart is logged or cleared, because that list is
  // exactly what the pitmaster is checking the cart against.
  const billInputRef = React.useRef<HTMLInputElement>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanReview, setScanReview] = useState<
    {
      added: number;
      vendorText: string;
      vendorMatched: boolean;
      dateText: string;
      dateUsed: boolean;
      notes: string;
      skipped: ScannedBill['skipped'];
      billDate?: string;
      billDateChoice?: 'bill' | 'today' | null;
    } | null
  >(restored.scanReview);

  // Where the last logged cart landed, when that was not the week on screen.
  // A flag rather than a jump: the table is meant to be this week's, and a
  // screen that moves itself is a screen you have to re-read. Cleared on the
  // next log, and by the button that goes and looks.
  const [landedElsewhere, setLandedElsewhere] = useState<{ from: string; to: string; lines: number } | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [poResult, setPoResult] = useState<{ name: string; url: string | null } | null>(null);

  const [rangeFrom, setRangeFrom] = useState(DEFAULT_RANGE.from);
  const [rangeTo, setRangeTo] = useState(DEFAULT_RANGE.to);
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [isLoadingPurchases, setIsLoadingPurchases] = useState(false);
  const [purchasesError, setPurchasesError] = useState('');

  const [expensesError, setExpensesError] = useState('');
  // One entry card for all three kinds of spend. Switching away from Purchase
  // only hides the cart — it isn't cleared, so a half-built bill survives a
  // quick labour entry in between.
  const [entryMode, setEntryMode] = useState<'Purchase' | ExpenseKind>('Purchase');
  const expenseKind: ExpenseKind = entryMode === 'Purchase' ? 'Labour' : entryMode;
  const [expenseDate, setExpenseDate] = useState(formatDateInput(new Date()));
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  // Investment only: it is logged as item × quantity × unit price, not as one amount.
  const [expenseQuantity, setExpenseQuantity] = useState('');
  const [expenseUnitPrice, setExpenseUnitPrice] = useState('');
  const isInvestment = expenseKind === 'Investment';
  const [isAddingExpense, setIsAddingExpense] = useState(false);
  const [expenseStatus, setExpenseStatus] = useState('');

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  // The ad hoc line being given a catalogue row, and the two fields that
  // can't be read off the purchase itself. `catalogTarget` is a purchase_id,
  // so only one row's form is open at a time — this is a correction made one
  // item at a time while looking at what was actually bought, not a batch.
  const [catalogTarget, setCatalogTarget] = useState<string | null>(null);
  const [catalogCategory, setCatalogCategory] = useState('');
  const [catalogReorder, setCatalogReorder] = useState('');
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogStatus, setCatalogStatus] = useState('');

  // Which of the two endings the open panel is offering. 'map' is the default
  // because it is the commoner right answer by a distance — "PORK SHLDR B/L"
  // is almost always an item the catalogue already has under other wording,
  // and adding it as a new material would split that ingredient's stock in
  // two. See linkPurchaseToMaterial in server/ops/shared/purchasing.js.
  const [catalogMode, setCatalogMode] = useState<'map' | 'new'>('map');
  const [matchSuggestions, setMatchSuggestions] = useState<MatchSuggestion[]>([]);
  const [matchNote, setMatchNote] = useState('');
  const [matchSource, setMatchSource] = useState<'gemini' | 'local' | ''>('');
  const [isMatching, setIsMatching] = useState(false);
  // The item the pitmaster has actually picked. Never pre-filled from the top
  // suggestion, however confident it is: this click moves stock onto a real
  // count, and a pre-selected answer is one someone can confirm without ever
  // having read it.
  const [matchChoice, setMatchChoice] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  const [showAddVendor, setShowAddVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState('');
  const [newVendorType, setNewVendorType] = useState('');
  const [newSuppliesCategory, setNewSuppliesCategory] = useState('');
  const [newContactPerson, setNewContactPerson] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [isAddingVendor, setIsAddingVendor] = useState(false);
  const [addVendorStatus, setAddVendorStatus] = useState('');
  const [addVendorError, setAddVendorError] = useState('');

  const loadCatalog = async () => {
    setLoadError('');
    try {
      const [vendorsResp, materialsResp] = await Promise.all([
        fetch('/api/purchasing/vendors'),
        fetch('/api/purchasing/materials'),
      ]);
      const vendorsData = await readJson<{ vendors?: Vendor[]; error?: string }>(vendorsResp);
      if (!vendorsResp.ok) throw new Error(vendorsData.error || 'Failed to load vendors.');
      const materialsData = await readJson<{ materials?: RawMaterial[]; error?: string }>(materialsResp);
      if (!materialsResp.ok) throw new Error(materialsData.error || 'Failed to load materials.');

      setVendors(vendorsData.vendors || []);
      setMaterials(materialsData.materials || []);
    } catch (err) {
      setLoadError(String((err as Error).message || err));
    }
  };

  const loadPurchases = async () => {
    if (!rangeFrom || !rangeTo) return;
    setIsLoadingPurchases(true);
    setPurchasesError('');
    try {
      const resp = await fetch(`/api/purchasing/purchases?from=${rangeFrom}&to=${rangeTo}&channel=${channel}`);
      const data = await readJson<{ purchases?: PurchaseRecord[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to load purchases.');
      setPurchases(data.purchases || []);
    } catch (err) {
      setPurchasesError(String((err as Error).message || err));
    } finally {
      setIsLoadingPurchases(false);
    }
  };

  useEffect(() => {
    loadCatalog();
  }, []);

  // Autosave. Every change rather than on a timer: the switch away this exists
  // to survive is not announced, and a debounce is that many seconds of work to
  // lose. The draft is a handful of names and numbers, so writing it on a
  // keystroke costs nothing worth measuring.
  //
  // No `hydrated` gate is needed here, unlike the reel editor: the restore
  // above already happened, synchronously, as this component's initial state.
  // There is no window in which this effect can run before it.
  useEffect(() => {
    const state = {
      vendorName,
      purchaseDate,
      lines: cart,
      scanReview,
      entry: { materialChoice, customName, quantity, unitPrice, weightPerPiece, boughtByPiece, lineClientId, linePurpose },
    };
    // An empty cart with no vendor and nothing half-typed is a screen someone
    // opened, not a draft. Clearing rather than writing one keeps a logged
    // cart from leaving a permanent empty record behind.
    if (hasDraftContent(state)) writeStoredPurchaseDraft(buildPurchaseDraft(state), channel);
    else clearStoredPurchaseDraft(channel);
  }, [
    channel,
    vendorName,
    purchaseDate,
    cart,
    scanReview,
    materialChoice,
    customName,
    quantity,
    unitPrice,
    weightPerPiece,
    boughtByPiece,
    lineClientId,
    linePurpose,
  ]);

  // A restored line can point at a material that has since been deleted, and
  // purchase.material_id is a foreign key — logging it would fail the whole
  // cart on a constraint naming a column this screen never shows. So the ids
  // are checked once, against a catalogue that actually arrived.
  //
  // That guard is the load-bearing part: a failed GET /materials leaves
  // `materials` at [], and reconciling against an empty catalogue would strip
  // every id in the cart. No catalogue means no reconciliation, which is the
  // safe direction — the ids are left exactly as they were saved.
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current || !materials.length || !restored.lines.length) return;
    reconciled.current = true;

    // Against the restored lines rather than the current cart: this runs once,
    // early, and anything typed since is the buyer's and not a draft's to
    // second-guess. The client book is passed through as-is — client_id is
    // plain text with no key behind it, so an unknown tag is cosmetic, and
    // reconcileDraftLines leaves tags alone when the list is empty.
    const result = reconcileDraftLines(restored.lines, materials, clients);
    if (!result.unlinked.length && !result.untagged.length) return;

    const repaired = new Map(result.lines.map((line) => [line.key, line]));
    setCart((current) => current.map((line) => repaired.get(line.key) ?? line));
    setRestoreNotice(describePurchaseRestore(restored, result));
  }, [materials, clients, restored]);

  // Failing to load the account list must not break purchasing — the client
  // tag is an optional extra on top of logging the buy, so an empty list just
  // hides the picker rather than blocking the screen with an error.
  useEffect(() => {
    if (channel !== 'B2B') {
      setClients([]);
      return;
    }
    fetch('/api/b2b/clients')
      .then((resp) => (resp.ok ? resp.json() : Promise.reject(new Error('failed'))))
      .then((data: { clients?: B2BClient[] }) => setClients(data.clients || []))
      .catch(() => setClients([]));
  }, [channel]);

  useEffect(() => {
    loadPurchases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, rangeTo, channel]);

  // A new expense goes against the week being looked at: someone who has
  // stepped the range back to last week to fill in last week's labour should
  // not have to set the date a second time. Today, when today is in range.
  useEffect(() => {
    if (!rangeFrom) return;
    const today = formatDateInput(new Date());
    setExpenseDate(today >= rangeFrom && (!rangeTo || today <= rangeTo) ? today : rangeFrom);
  }, [rangeFrom, rangeTo]);

  const selectedVendor = vendors.find((v) => v.vendor_name === vendorName);
  const isMeatVendor = selectedVendor?.vendor_type === 'Meat Vendor';
  const categoryRule = selectedVendor ? SUPPLIES_CATEGORY_RULES[selectedVendor.supplies_category] : undefined;
  const visibleMaterials = useMemo(() => {
    if (categoryRule) {
      return materials.filter(
        (m) => categoryRule.categories.includes(m.category) && (!categoryRule.nameFilter || categoryRule.nameFilter.test(m.item_name)),
      );
    }
    // No vendor selected yet, or its supplies_category isn't one of the
    // rules above (e.g. blank, or a vendor type this table doesn't cover
    // yet) — fall back to the old meat/non-meat split so nothing silently
    // disappears from the item list.
    return materials.filter((m) => (isMeatVendor ? m.category === 'Meat' : m.category !== 'Meat'));
  }, [materials, categoryRule, isMeatVendor]);

  const materialsByCategory = useMemo(() => {
    const groups = new Map<string, RawMaterial[]>();
    visibleMaterials.forEach((m) => {
      const list = groups.get(m.category) || [];
      list.push(m);
      groups.set(m.category, list);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visibleMaterials]);

  // Full catalog grouped by category, independent of any vendor selection.
  const allMaterialsByCategory = useMemo(() => {
    const groups = new Map<string, RawMaterial[]>();
    materials.forEach((m) => {
      const list = groups.get(m.category) || [];
      list.push(m);
      groups.set(m.category, list);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [materials]);

  // Vendor changed — drop any item selection that's no longer valid for it.
  useEffect(() => {
    setMaterialChoice((current) => {
      if (!current || current === CUSTOM_ITEM_VALUE) return current;
      return visibleMaterials.some((m) => m.material_id === current) ? current : '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorName]);

  const selectedMaterial = materials.find((m) => m.material_id === materialChoice);
  const isCustom = materialChoice === CUSTOM_ITEM_VALUE;
  const pieceOffered = canBuyByPiece(selectedMaterial);
  const byPiece = pieceOffered && boughtByPiece;
  // The running total the three piece boxes add up to, so the pitmaster can
  // see 4 × 1.6 kg = 6.4 kg before committing the line rather than after.
  const piecePreview = useMemo(() => {
    if (!byPiece) return null;
    const pieces = Number(quantity) || 0;
    const each = Number(weightPerPiece) || 0;
    if (!pieces) return null;
    return {
      pieces,
      totalKg: each ? Math.round(pieces * each * 1000) / 1000 : 0,
      totalCost: pieces * (Number(unitPrice) || 0),
    };
  }, [byPiece, quantity, weightPerPiece, unitPrice]);

  const handleAddLine = () => {
    setAddLineError('');
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setAddLineError('Enter a quantity greater than 0.');
      return;
    }
    const itemName = isCustom ? customName.trim() : selectedMaterial?.item_name || '';
    if (!itemName) {
      setAddLineError(isCustom ? 'Enter an item name.' : "Select an item from the list — it didn't register, try picking it again.");
      return;
    }
    const price = Number(unitPrice) || 0;
    // Blank is allowed and means "not weighed yet" — the same answer the log
    // already accepts for a price that hasn't arrived. A number that isn't a
    // weight is not: 0 kg per bird would sail through and total the whole buy
    // to nothing.
    const perPiece = byPiece && weightPerPiece.trim() ? Number(weightPerPiece) : 0;
    if (byPiece && weightPerPiece.trim() && !(perPiece > 0)) {
      setAddLineError('Weight of one piece has to be more than 0 kg — leave it blank if you haven’t weighed them.');
      return;
    }

    setCart((current) => [
      ...current,
      {
        key: `${Date.now()}-${Math.random()}`,
        materialId: isCustom ? '' : materialChoice,
        itemName,
        quantity: qty,
        unitPrice: price,
        weightPerUnitKg: perPiece,
        clientId: channel === 'B2B' ? lineClientId : '',
        clientName: channel === 'B2B' ? clients.find((c) => c.id === lineClientId)?.name || '' : '',
        purpose: linePurpose,
      },
    ]);

    setMaterialChoice('');
    setCustomName('');
    setQuantity('');
    setUnitPrice('');
    setWeightPerPiece('');
    setBoughtByPiece(false);
  };

  const handleRemoveLine = (key: string) => {
    setCart((current) => current.filter((line) => line.key !== key));
  };

  // Throws away a cart that came back from the browser. Offered next to the
  // notice because the restore is automatic: someone who has already bought
  // and logged this trip elsewhere, or who simply does not want yesterday's
  // half-list, needs one button rather than a row of × clicks. Confirmed,
  // because it is the only control on this screen that destroys work, and the
  // autosave will write the emptiness out a tick later.
  const discardRestoredCart = () => {
    if (cart.length && !window.confirm(`Discard the ${cart.length} unlogged line${cart.length === 1 ? '' : 's'} in this cart?`)) {
      return;
    }
    setCart([]);
    setScanReview(null);
    setRestoreNotice('');
  };

  // The cart is editable in place rather than remove-and-retype, because the
  // whole point of the scan is that most of a line is already right and one
  // number needs fixing. It also serves the hand-typed lines: a price
  // corrected here is one fewer line deleted and entered again.
  const handleUpdateLine = (key: string, patch: Partial<CartLine>) => {
    setCart((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  // Reads a photo/PDF of the vendor's bill and loads what it found into the
  // cart. Nothing is logged here — the lines land in the same cart a typed
  // line lands in, editable, and the existing Log purchase button below is
  // still the only thing that writes. A scan that reads six lines perfectly
  // and one wrong should cost one correction, not a re-entry.
  const handleScanBill = async (file: File) => {
    setScanError('');
    setScanReview(null);
    setIsScanning(true);
    try {
      const body = new FormData();
      body.append('bill', file);
      const resp = await fetch('/api/purchasing/scan-bill', { method: 'POST', body });
      const data = await readJson<ScannedBill & { error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Could not read that bill.');

      const scanned = data.lines || [];
      if (!scanned.length && !(data.skipped || []).length) {
        throw new Error(
          data.notes || 'Nothing on that image looked like bill line items. Try a straighter, better-lit photo.',
        );
      }

      setCart((current) => [
        ...current,
        ...scanned.map((line, idx) => ({
          key: `scan-${Date.now()}-${idx}`,
          materialId: line.materialId,
          itemName: line.itemName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          // A bill prices by whatever the vendor sells by, and never says what
          // one piece weighs. Left blank for the pitmaster to fill in on the
          // meat lines they weighed — the log takes blank as "unweighed".
          weightPerUnitKg: 0,
          clientId: channel === 'B2B' ? lineClientId : '',
          clientName: channel === 'B2B' ? clients.find((c) => c.id === lineClientId)?.name || '' : '',
          purpose: linePurpose,
          billText: line.billText,
          unit: line.unit,
          matched: line.matched,
          derivedPrice: line.derivedPrice,
          derivedQuantity: line.derivedQuantity,
        })),
      ]);

      // A vendor is only filled in when the read matched one in the book and
      // nothing is selected yet: a bill scanned into a cart already half
      // typed against another vendor must not silently move that spend.
      const vendorMatched = Boolean(data.vendorName);
      if (vendorMatched && !vendorName) setVendorName(data.vendorName);
      // The bill's own date is used only when it falls in this week; a bill
      // from another week is filed under today, and the review says so.
      const dateUsed = Boolean(data.purchaseDate);
      const billElsewhere = dateUsed && !inThisWeek(data.purchaseDate);
      if (dateUsed) setPurchaseDate(thisWeekDate(data.purchaseDate));

      setScanReview({
        billDate: billElsewhere ? data.purchaseDate : undefined,
        billDateChoice: billElsewhere ? 'today' : null,
        added: scanned.length,
        vendorText: data.vendorText || '',
        vendorMatched,
        dateText: data.dateText || '',
        dateUsed,
        notes: data.notes || '',
        skipped: data.skipped || [],
      });
    } catch (err) {
      setScanError(String((err as Error).message || err));
    } finally {
      setIsScanning(false);
      // Cleared so the same bill can be picked again after a failed read —
      // an unchanged value fires no change event.
      if (billInputRef.current) billInputRef.current.value = '';
    }
  };

  const cartTotal = useMemo(() => cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), [cart]);

  // Single action: logs the cart to purchase_log.csv/materials.csv first (the
  // source of truth), then sends the same lines to Odoo as a draft PO. If
  // the CSV log fails, nothing is sent to Odoo and the cart is kept as-is.
  // If the CSV log succeeds but the Odoo call fails, the purchase is still
  // logged (and the cart still clears) — the Odoo failure is only reported,
  // not rolled back, since the CSV log already succeeded.
  const handleLogPurchase = async () => {
    if (!vendorName || !cart.length || isSubmitting) return;
    // The cart's numbers are editable now (a scanned line usually needs one
    // fixing), so a line can be emptied here as well as filled. recordPurchases
    // would quietly drop a 0-quantity line rather than fail, which on a
    // scanned cart would mean silently logging five of the six lines on the
    // bill — so it's caught here, by name, while the cart is still on screen.
    const empty = cart.find((line) => !line.itemName.trim() || !(line.quantity > 0));
    if (empty) {
      setSubmitError(
        `"${empty.itemName.trim() || 'One line'}" needs a name and a quantity above 0 — fix it or remove the line.`,
      );
      return;
    }
    setIsSubmitting(true);
    setSubmitError('');
    setSubmitStatus('');
    setPoResult(null);
    try {
      const logResp = await fetch('/api/purchasing/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorName,
          purchaseDate,
          channel,
          lines: cart.map(({ materialId, itemName, quantity: qty, unitPrice: price, weightPerUnitKg, clientId, purpose }) => ({
            materialId,
            itemName,
            quantity: qty,
            unitPrice: price,
            // Blank rather than 0 when it doesn't apply or wasn't weighed —
            // the column is nullable so it can say "unknown" instead of
            // claiming a weightless bird.
            weightPerUnitKg: weightPerUnitKg > 0 ? weightPerUnitKg : '',
            // Id only — the server resolves the name off the B2B client book
            // so a renamed account can't leave two spellings in the log.
            clientId,
            purpose,
          })),
        }),
      });
      const logData = await readJson<{
        purchases?: PurchaseRecord[];
        // Lines that were logged but whose stock didn't move — almost always
        // an item typed in by name that the catalogue has never heard of. See
        // recordPurchases in server/ops/shared/purchasing.js.
        inventorySkipped?: { purchase_id: string | null; item_name: string; reason: string }[];
        error?: string;
      }>(logResp);
      if (!logResp.ok) throw new Error(logData.error || 'Failed to log the purchase.');
      const purchaseIds = (logData.purchases || []).map((p) => p.purchase_id);

      let poNote = '';
      try {
        const poResp = await fetch('/api/purchasing/send-po', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendorName,
            purchaseIds,
            lines: cart.map(({ itemName, quantity: qty, unitPrice: price }) => ({
              itemName,
              quantity: qty,
              unitPrice: price,
            })),
          }),
        });
        const poData = await readJson<{ name?: string; url?: string | null; error?: string }>(poResp);
        if (!poResp.ok) throw new Error(poData.error || 'Failed to send PO to Odoo.');
        setPoResult({ name: poData.name || '', url: poData.url ?? null });
      } catch (poErr) {
        poNote = ` Odoo PO failed: ${String((poErr as Error).message || poErr)}`;
      }

      // The buy is logged either way — this says so, and then says which of
      // its lines only made it half way, rather than letting a stock count
      // that quietly didn't move read as a clean success.
      // A bill is dated by the bill, and the table below is showing one week
      // — usually this one. Log a Sunday bill on the Monday after it and the
      // lines land outside the range that is on screen, so the table refreshes
      // to exactly what it showed before and the buy reads as having silently
      // failed. That is what it reads as, and it is why the same bill has been
      // logged three times over.
      //
      // So the range follows the purchase: the week the lines were actually
      // written into is the week worth looking at right after writing them,
      // and the status message says it moved rather than leaving someone to
      // notice the dates above changed.
      const landedOutsideView = purchaseDate < rangeFrom || purchaseDate > rangeTo;
      const landedWeek = weekRangeOf(parseDateInput(purchaseDate));

      const skipped = logData.inventorySkipped || [];
      const skippedNote = skipped.length
        ? ` ${skipped.length} line${skipped.length === 1 ? '' : 's'} (${skipped
            .map((line) => line.item_name)
            .join(', ')}) ${skipped.length === 1 ? "isn't" : "aren't"} in the materials catalogue, so stock wasn't updated — add ${
            skipped.length === 1 ? 'it' : 'them'
          } from the purchase table below.`
        : '';
      setSubmitStatus(
        `Logged ${cart.length} line item${cart.length === 1 ? '' : 's'} from ${vendorName} to the purchase log.${skippedNote}${poNote}`,
      );
      setLandedElsewhere(landedOutsideView ? { ...landedWeek, lines: cart.length } : null);
      setCart([]);
      // The scan's own review notes go with the cart they were about.
      setScanReview(null);
      setScanError('');
      // And so does the "picked up where you left off" line: the cart it was
      // about has just been logged, and leaving it up would read as if those
      // lines were still waiting.
      setRestoreNotice('');
      await Promise.all([loadCatalog(), loadPurchases()]);
    } catch (err) {
      setSubmitError(String((err as Error).message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Deletes one purchase_log.csv row, reverses its inventory adjustment, and —
  // if that row was linked to an Odoo draft PO line (see handleLogPurchase /
  // linkPurchasesToOdoo) — removes the matching line from that PO too.
  const handleDeletePurchase = async (purchaseId: string) => {
    if (deletingId) return;
    if (!window.confirm('Delete this purchase? This also reverses its inventory update and removes the matching Odoo PO line.')) {
      return;
    }
    setDeletingId(purchaseId);
    setDeleteError('');
    try {
      const resp = await fetch(`/api/purchasing/purchases/${purchaseId}`, { method: 'DELETE' });
      const data = await readJson<{
        deleted?: PurchaseRecord;
        inventoryReversal?: { item_name: string; newQuantity: number } | null;
        odoo?: { removed: boolean; error?: string } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to delete purchase.');
      await Promise.all([loadCatalog(), loadPurchases()]);
    } catch (err) {
      setDeleteError(String((err as Error).message || err));
    } finally {
      setDeletingId(null);
    }
  };

  // Opens (or closes) the panel on one ad hoc line, and asks the server what
  // that line probably was. The ask fires on open rather than behind a
  // "suggest" button: the whole reason this correction doesn't get made is the
  // sixty-row dropdown, and a suggestion that needs an extra click first is
  // still a dropdown.
  const openUncatalogued = (purchaseId: string) => {
    const closing = catalogTarget === purchaseId;
    setCatalogError('');
    setCatalogStatus('');
    setCatalogCategory('');
    setCatalogReorder('');
    setCatalogMode('map');
    setMatchChoice('');
    setMatchSuggestions([]);
    setMatchNote('');
    setMatchSource('');
    setCatalogTarget(closing ? null : purchaseId);
    if (!closing) void loadMatchSuggestions(purchaseId);
  };

  // Reads GET .../match-suggestions. A failure here is deliberately not shown
  // as an error on the row: the dropdown below the suggestions is the whole
  // catalogue and still works, so a dead suggestion list costs convenience,
  // not the correction itself.
  const loadMatchSuggestions = async (purchaseId: string) => {
    setIsMatching(true);
    try {
      const resp = await fetch(`/api/purchasing/purchases/${purchaseId}/match-suggestions`);
      const data = await readJson<{
        suggestions?: MatchSuggestion[];
        source?: 'gemini' | 'local';
        note?: string;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Could not look for a match.');
      setMatchSuggestions(data.suggestions || []);
      setMatchSource(data.source || '');
      setMatchNote(data.note || '');
    } catch (err) {
      setMatchSuggestions([]);
      setMatchSource('');
      setMatchNote(`Couldn't suggest a match (${String((err as Error).message || err)}) — pick the item below.`);
    } finally {
      setIsMatching(false);
    }
  };

  // Points the ad hoc line at an item the catalogue already has and lets the
  // server apply its quantity to that item's running count — see
  // linkPurchaseToMaterial in server/ops/shared/purchasing.js.
  const handleLinkPurchase = async (purchaseId: string) => {
    if (isLinking || !matchChoice) return;
    setIsLinking(true);
    setCatalogError('');
    setCatalogStatus('');
    try {
      const resp = await fetch(`/api/purchasing/purchases/${purchaseId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialId: matchChoice }),
      });
      const data = await readJson<{
        material?: RawMaterial;
        inventoryUpdated?: { item_name: string; newQuantity: number } | null;
        renamedFrom?: string | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to map the line.');

      const stocked = data.inventoryUpdated;
      setCatalogStatus(
        `Mapped ${data.renamedFrom ? `"${data.renamedFrom}"` : 'that line'} to ${data.material?.item_name} (${
          data.material?.material_id
        })${stocked ? ` — stock is now ${stocked.newQuantity}` : ''}.`,
      );
      setCatalogTarget(null);
      setMatchChoice('');
      setMatchSuggestions([]);
      // The purchase reload is what makes the row stop reporting itself as
      // uncatalogued; the catalog reload refreshes the on-hand numbers the
      // suggestion panel shows beside each item.
      await Promise.all([loadCatalog(), loadPurchases()]);
    } catch (err) {
      setCatalogError(String((err as Error).message || err));
    } finally {
      setIsLinking(false);
    }
  };

  // Gives an already-logged ad hoc line the catalogue row it never had, then
  // lets the server apply that line's quantity to stock — the second half of
  // logging a purchase for an item nobody had written down yet. See
  // catalogPurchaseItem in server/ops/shared/purchasing.js.
  //
  // Deliberately per line rather than a "catalogue all of these" button: the
  // category is a judgement call about one item, and stocking several buys of
  // the same untyped name in one go would claim stock for lines that may
  // already have been counted by hand.
  const handleCatalogItem = async (purchaseId: string) => {
    if (catalogBusyId) return;
    setCatalogBusyId(purchaseId);
    setCatalogError('');
    setCatalogStatus('');
    try {
      const resp = await fetch(`/api/purchasing/purchases/${purchaseId}/catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: catalogCategory.trim(),
          // Blank means "no reorder point set", which is a real answer — the
          // low-stock banner simply skips a material with no level.
          reorderLevel: catalogReorder.trim(),
        }),
      });
      const data = await readJson<{
        material?: RawMaterial;
        inventoryUpdated?: { item_name: string; newQuantity: number } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to add the item to the catalogue.');

      const stocked = data.inventoryUpdated;
      setCatalogStatus(
        `Added ${data.material?.item_name} (${data.material?.material_id}) to the catalogue${
          stocked ? ` — stock is now ${stocked.newQuantity}` : ''
        }.`,
      );
      setCatalogTarget(null);
      setCatalogCategory('');
      setCatalogReorder('');
      // Both, and in this order for a reason: the catalog reload is what puts
      // the new material in the item dropdown, and the purchase reload is
      // what makes the row stop reporting itself as uncatalogued.
      await Promise.all([loadCatalog(), loadPurchases()]);
    } catch (err) {
      setCatalogError(String((err as Error).message || err));
    } finally {
      setCatalogBusyId(null);
    }
  };

  // Every category already in use, for the picker on that form. Existing
  // values rather than a free text box for the same reason the vendor form
  // suggests vendor_type: a typo makes a category of one, and the purchasing
  // screen groups its item list by exactly this string.
  const materialCategories = useMemo(
    () => Array.from(new Set(materials.map((m) => m.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [materials],
  );

  // Logged buys whose stock never moved, because the item they name has no
  // material row to move. Recomputed from the log rather than remembered from
  // the last submit, so it still shows after a reload and still covers lines
  // logged in an earlier session.
  // A service line (labour, a subscription) has no stock to add, so it is
  // never "not in stock".
  const uncatalogued = useMemo(
    () => purchases.filter((p) => !p.material_id && p.item_type !== 'service'),
    [purchases],
  );

  // Autocomplete suggestions drawn from existing vendors — vendor_type and
  // supplies_category both matter beyond cosmetics: vendor_type has to read
  // exactly "Meat Vendor" for the meat/non-meat fallback filter above, and
  // supplies_category has to match a key in SUPPLIES_CATEGORY_RULES (e.g.
  // "Pork", "Chicken", "Bakery") for the per-vendor item list to pick it up.
  // Surfacing the existing values as suggestions (rather than a
  // free-for-all text box) heads off typos that would silently break either
  // filter for the new vendor.
  const vendorTypeOptions = useMemo(
    () => Array.from(new Set(vendors.map((v) => v.vendor_type).filter(Boolean))),
    [vendors],
  );
  const suppliesCategoryOptions = useMemo(
    () => Array.from(new Set(vendors.map((v) => v.supplies_category).filter(Boolean))),
    [vendors],
  );

  // Adds the vendor to vendors.csv first (the source of truth), then
  // best-effort creates/finds the matching res.partner in Odoo — same "CSV
  // first, Odoo second and non-fatal" pattern as handleLogPurchase.
  const handleAddVendor = async () => {
    if (!newVendorName.trim() || isAddingVendor) return;
    setIsAddingVendor(true);
    setAddVendorError('');
    setAddVendorStatus('');
    try {
      const resp = await fetch('/api/purchasing/vendors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorName: newVendorName.trim(),
          vendorType: newVendorType.trim(),
          suppliesCategory: newSuppliesCategory.trim(),
          contactPerson: newContactPerson.trim(),
          phone: newPhone.trim(),
          email: newEmail.trim(),
          address: newAddress.trim(),
          notes: newNotes.trim(),
        }),
      });
      const data = await readJson<{
        vendor?: Vendor;
        odoo?: { id?: number; created?: boolean; error?: string } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to add vendor.');

      let odooNote = '';
      if (data.odoo?.error) odooNote = ` Odoo: failed to create it there (${data.odoo.error}).`;
      else if (data.odoo?.created) odooNote = ' Also created in Odoo.';
      else if (data.odoo) odooNote = ' Already existed in Odoo under that name.';

      setAddVendorStatus(`Added vendor ${data.vendor?.vendor_name} (${data.vendor?.vendor_id}).${odooNote}`);
      setVendorName(data.vendor?.vendor_name || newVendorName.trim());
      setNewVendorName('');
      setNewVendorType('');
      setNewSuppliesCategory('');
      setNewContactPerson('');
      setNewPhone('');
      setNewEmail('');
      setNewAddress('');
      setNewNotes('');
      setShowAddVendor(false);
      await loadCatalog();
    } catch (err) {
      setAddVendorError(String((err as Error).message || err));
    } finally {
      setIsAddingVendor(false);
    }
  };

  // One purchase line, written by the server to the purchase table and
  // purchase_log.csv, then sent to Odoo as a draft PO. The Odoo half failing
  // doesn't fail the save — the reason comes back as a note instead. Listed,
  // deleted and totalled with every other purchase from here on.
  const handleAddExpense = async () => {
    if (isAddingExpense) return;
    setIsAddingExpense(true);
    setExpensesError('');
    setExpenseStatus('');
    try {
      const resp = await fetch('/api/purchasing/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: expenseKind,
          purchaseDate: expenseDate,
          channel,
          description: expenseDescription.trim(),
          ...(isInvestment
            ? { quantity: expenseQuantity, unitPrice: expenseUnitPrice }
            : { amount: expenseAmount }),
        }),
      });
      const data = await readJson<{
        purchases?: PurchaseRecord[];
        csv?: { mirrored: boolean; reason?: string };
        odoo?: { name?: string; url?: string | null; error?: string };
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to save the expense.');
      const saved = data.purchases?.[0];
      const odooNote = data.odoo?.error
        ? ` Odoo PO failed: ${data.odoo.error}`
        : data.odoo?.name
          ? ` Draft PO ${data.odoo.name} created in Odoo.`
          : '';
      const csvNote = data.csv && !data.csv.mirrored ? ` ${data.csv.reason || 'The CSV mirror was skipped.'}` : '';
      setExpenseStatus(
        (saved
          ? `Saved ${expenseKind.toLowerCase()} ${inrFormat(Number(saved.total_cost) || 0)} on ${dayLabel(saved.purchase_date)}.`
          : 'Saved.') +
          csvNote +
          odooNote,
      );
      setExpenseDescription('');
      setExpenseAmount('');
      setExpenseQuantity('');
      setExpenseUnitPrice('');
      await loadPurchases();
    } catch (err) {
      setExpensesError(String((err as Error).message || err));
    } finally {
      setIsAddingExpense(false);
    }
  };

  const purchasesTotal = useMemo(
    () => purchases.filter((p) => !expenseKindOf(p)).reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const labourTotal = useMemo(
    () => purchases.filter((p) => expenseKindOf(p) === 'Labour').reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const logisticsTotal = useMemo(
    () =>
      purchases.filter((p) => expenseKindOf(p) === 'Logistics').reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const investmentTotal = useMemo(
    () =>
      purchases.filter((p) => expenseKindOf(p) === 'Investment').reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const miscTotal = useMemo(
    () =>
      purchases
        .filter((p) => expenseKindOf(p) === 'Miscellaneous')
        .reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  // The slice of Purchases bought for practice cooks, shown under it.
  const practiceTotal = useMemo(
    () =>
      purchases
        .filter((p) => !expenseKindOf(p) && p.purpose === 'Practice')
        .reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const expenseTotal = purchasesTotal + labourTotal + logisticsTotal + investmentTotal + miscTotal;
  // Real suppliers only — labour, logistics and misc already have their own lines in the
  // totals above.
  const purchasesByVendor = useMemo(() => {
    const totals = new Map<string, number>();
    purchases
      .filter((p) => !expenseKindOf(p))
      .forEach((p) => {
        totals.set(p.vendor_name, (totals.get(p.vendor_name) || 0) + (Number(p.total_cost) || 0));
      });
    return Array.from(totals.entries()).sort(([, a], [, b]) => b - a);
  }, [purchases]);

  // The payoff of tagging: what each account cost us this range. Untagged
  // spend is shown as its own line rather than dropped or spread across the
  // accounts — general overhead is a real category, and hiding it would make
  // the per-client figures look like they add up to the week total when they
  // don't.
  const purchasesByClient = useMemo(() => {
    if (channel !== 'B2B') return [];
    const totals = new Map<string, number>();
    purchases.forEach((p) => {
      const key = p.client_name || 'Untagged (general)';
      totals.set(key, (totals.get(key) || 0) + (Number(p.total_cost) || 0));
    });
    return Array.from(totals.entries()).sort(([, a], [, b]) => b - a);
  }, [purchases, channel]);

  const isB2B = channel === 'B2B';

  return (
    <div className="wizard-page purch-page">
      <div className="wizard-header">
        <h1>Weekly Purchasing</h1>
        <p>
          Log what's bought from each vendor — meat shops, Bread Time Stories, Swiggy — into the shared
          inventory catalog, and send the same line items to Odoo as a draft Purchase Order. The week's labour,
          logistics and other extras are logged from the same card — switch the type at the top.
        </p>
      </div>

      {loadError && (
        <div className="prep-unmatched">
          <strong>Couldn't load the purchasing catalog:</strong>
          <p>{loadError}</p>
        </div>
      )}

      {restoreNotice && (
        <div className="purch-restored">
          <p>{restoreNotice}</p>
          <button type="button" className="secondary-button small" onClick={discardRestoredCart}>
            Discard it
          </button>
        </div>
      )}

      <div className="purch-grid">
        <div className="wizard-card">
          <h2>{entryMode === 'Purchase' ? 'Log a purchase' : `Log ${entryMode.toLowerCase()}`}</h2>

          <div className="purch-entry-modes" role="tablist" aria-label="Type of spend">
            {(['Purchase', ...EXPENSE_KINDS] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={entryMode === mode}
                className={entryMode === mode ? 'is-active' : ''}
                onClick={() => setEntryMode(mode)}
              >
                {mode === 'Miscellaneous' ? 'Misc' : mode}
              </button>
            ))}
          </div>

          {entryMode !== 'Purchase' && (
            <>
              <p className="inv-section-hint">
                Spend that comes off no vendor bill — wages, delivery runs, and extras like ice. Saved as a purchase
                line under &ldquo;{expenseKind}&rdquo;, so it lists, totals and deletes with everything else.
              </p>
              {cart.length > 0 && (
                <p className="inv-note">
                  {cart.length} line{cart.length === 1 ? '' : 's'} still in the purchase cart — switch back to Purchase
                  to log {cart.length === 1 ? 'it' : 'them'}.
                </p>
              )}
              <div className="purch-expense-form">
                <label>
                  Date
                  <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
                </label>
                {isInvestment ? (
                  <>
                    <label>
                      Item
                      <input
                        value={expenseDescription}
                        onChange={(e) => setExpenseDescription(e.target.value)}
                        maxLength={200}
                        placeholder="e.g. Chest freezer, offset smoker"
                      />
                    </label>
                    <div className="purch-form-row">
                      <label>
                        Quantity
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={expenseQuantity}
                          onChange={(e) => setExpenseQuantity(e.target.value)}
                        />
                      </label>
                      <label>
                        Unit price (₹)
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={expenseUnitPrice}
                          onChange={(e) => setExpenseUnitPrice(e.target.value)}
                        />
                      </label>
                    </div>
                    {Number(expenseQuantity) > 0 && Number(expenseUnitPrice) > 0 && (
                      <p className="inv-note">
                        Total {inrFormat(Math.round(Number(expenseQuantity) * Number(expenseUnitPrice) * 100) / 100)} —
                        counted in Total investment on Spending vs Sales, not in spending.
                      </p>
                    )}
                  </>
                ) : (
                <div className="purch-form-row">
                  <label>
                    {expenseKind === 'Miscellaneous' ? 'What was it for' : 'Who / what (optional)'}
                    <input
                      value={expenseDescription}
                      onChange={(e) => setExpenseDescription(e.target.value)}
                      maxLength={200}
                      placeholder={
                        expenseKind === 'Labour'
                          ? 'e.g. Kitchen helper, Fri–Sun'
                          : expenseKind === 'Logistics'
                            ? 'e.g. Porter delivery, courier'
                            : 'e.g. Ice, auto to the butcher'
                      }
                    />
                  </label>
                  <label>
                    Amount (₹)
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                    />
                  </label>
                </div>
                )}
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleAddExpense}
                  disabled={
                    isAddingExpense ||
                    !expenseDate ||
                    (isInvestment
                      ? !expenseDescription.trim() || !(Number(expenseQuantity) > 0) || !(Number(expenseUnitPrice) > 0)
                      : !(Number(expenseAmount) > 0)) ||
                    (expenseKind === 'Miscellaneous' && !expenseDescription.trim())
                  }
                >
                  {isAddingExpense ? 'Saving…' : 'Save'}
                </button>
              </div>
              {expensesError && <p className="chat-error">{expensesError}</p>}
              {expenseStatus && !expensesError && <p className="status-message">{expenseStatus}</p>}
            </>
          )}

          {entryMode === 'Purchase' && (
          <>
          <div className="purch-form-row">
            <label>
              Vendor
              <select value={vendorName} onChange={(e) => setVendorName(e.target.value)}>
                <option value="">Select a vendor…</option>
                {vendors.filter((v) => v.vendor_type !== EXPENSE_VENDOR_TYPE).map((v) => (
                  <option key={v.vendor_id} value={v.vendor_name}>
                    {v.vendor_name} ({v.vendor_type})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Purchase date
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </label>
          </div>

          <button
            type="button"
            className="secondary-button small purch-add-vendor-toggle"
            onClick={() => setShowAddVendor((v) => !v)}
          >
            {showAddVendor ? '− Cancel new vendor' : '+ Add a new vendor'}
          </button>

          {showAddVendor && (
            <div className="purch-add-line">
              <div className="purch-form-row">
                <label>
                  Vendor name
                  <input value={newVendorName} onChange={(e) => setNewVendorName(e.target.value)} placeholder="e.g. Fresh Farms Meats" />
                </label>
                <label>
                  Vendor type
                  <input
                    list="purch-vendor-type-options"
                    value={newVendorType}
                    onChange={(e) => setNewVendorType(e.target.value)}
                    placeholder="e.g. Meat Vendor"
                  />
                  <datalist id="purch-vendor-type-options">
                    {vendorTypeOptions.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </label>
              </div>

              <div className="purch-form-row">
                <label>
                  Supplies category
                  <input
                    list="purch-supplies-category-options"
                    value={newSuppliesCategory}
                    onChange={(e) => setNewSuppliesCategory(e.target.value)}
                    placeholder="e.g. Pork"
                  />
                  <datalist id="purch-supplies-category-options">
                    {suppliesCategoryOptions.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
                <label>
                  Contact person
                  <input value={newContactPerson} onChange={(e) => setNewContactPerson(e.target.value)} />
                </label>
              </div>

              <div className="purch-form-row">
                <label>
                  Phone
                  <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                </label>
                <label>
                  Email
                  <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                </label>
              </div>

              <label>
                Address
                <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} />
              </label>
              <label>
                Notes
                <input value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
              </label>

              <button
                type="button"
                className="secondary-button small"
                onClick={handleAddVendor}
                disabled={!newVendorName.trim() || isAddingVendor}
              >
                {isAddingVendor ? 'Adding…' : 'Add vendor (CSV + Odoo)'}
              </button>
              {addVendorError && <p className="chat-error">{addVendorError}</p>}
              {addVendorStatus && !addVendorError && <p className="status-message">{addVendorStatus}</p>}
            </div>
          )}

          {/* Scanning is offered before the manual form, because on a Friday
              the bill is already in hand and typing it out is the slow path.
              It only ever fills the cart in — every line is editable below
              and nothing is written until Log purchase. */}
          <div className="purch-scan">
            <div className="purch-scan-head">
              <div>
                <strong>Scan a bill</strong>
                <p className="inv-section-hint">
                  Photo or PDF of the vendor's bill — the butcher's slip, a Bread Time Stories invoice, a Swiggy
                  screenshot. Gemini reads it into the cart below for you to check, correct and then log.
                </p>
              </div>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => billInputRef.current?.click()}
                disabled={isScanning}
              >
                {isScanning ? 'Reading bill…' : '📷 Scan a bill'}
              </button>
            </div>
            <input
              ref={billInputRef}
              type="file"
              className="purch-scan-input"
              accept="image/*,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleScanBill(file);
              }}
            />
            {scanError && <p className="chat-error">{scanError}</p>}
            {scanReview && (
              <div className="purch-scan-review">
                <strong>
                  Read {scanReview.added} line{scanReview.added === 1 ? '' : 's'} off the bill — check them against the
                  paper, then hit Save.
                </strong>
                <ul>
                  {scanReview.vendorText && !scanReview.vendorMatched && (
                    <li>
                      Bill says <em>{scanReview.vendorText}</em>, which isn't in the vendor book — pick the vendor above
                      (or add it) before logging.
                    </li>
                  )}
                  {scanReview.dateText && !scanReview.dateUsed && (
                    <li>
                      Couldn't read the bill date (<em>{scanReview.dateText}</em>) — the date above is unchanged.
                    </li>
                  )}
                  {/* Said, not asked: the buy always goes into this week. */}
                  {scanReview.billDate && (
                    <li>
                      Bill is dated {dayLabel(scanReview.billDate)} — filed under {dayLabel(purchaseDate)} so it lands in
                      this week.
                    </li>
                  )}
                  {scanReview.notes && <li>{scanReview.notes}</li>}
                  {scanReview.skipped.map((s, idx) => (
                    <li key={`${s.itemName}-${idx}`}>
                      Left out {s.itemName ? <em>{s.itemName}</em> : 'a line'} — {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className={`purch-add-line${linePurpose === 'Practice' ? ' is-practice' : ''}`}>
            {/* First, because it frames the rest of the line — and it stays
                put between lines, so a whole practice run is one tap. */}
            <div className="purch-purpose">
              <span className="purch-purpose-label">This buy is for</span>
              <div className="purch-purpose-modes" role="radiogroup" aria-label="This buy is for">
                {(['Order', 'Practice'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={linePurpose === p}
                    className={`${linePurpose === p ? 'is-active' : ''}${p === 'Practice' ? ' is-practice' : ''}`}
                    onClick={() => setLinePurpose(p)}
                  >
                    {p === 'Order' ? `${channel} orders` : 'Practice cook'}
                  </button>
                ))}
              </div>
            </div>

            <label>
              Item
              <select
                value={materialChoice}
                onChange={(e) => {
                  setMaterialChoice(e.target.value);
                  // Cleared with the item, not left behind: the box is hidden
                  // for anything not bought by the piece, and a weight typed
                  // for chicken must not reappear on the next bird-shaped
                  // item the pitmaster picks.
                  setWeightPerPiece('');
                }}
              >
                <option value="">Select an item…</option>
                <option value={CUSTOM_ITEM_VALUE}>— Custom item (not in catalog) —</option>
                {materialsByCategory.map(([category, items]) => (
                  <optgroup key={category} label={category}>
                    {items.map((m) => (
                      <option key={m.material_id} value={m.material_id}>
                        {m.item_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            {isCustom && (
              <div className="purch-form-row">
                <label>
                  Item name
                  <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="e.g. Butcher paper" />
                </label>
              </div>
            )}

            {pieceOffered && (
              <label className="purch-form-check">
                <input
                  type="checkbox"
                  checked={boughtByPiece}
                  onChange={(e) => setBoughtByPiece(e.target.checked)}
                />
                Bought by the piece (birds, racks) rather than by weight
              </label>
            )}

            {/* Bought by the piece, used by the weight — see canBuyByPiece.
                Same three underlying numbers as every other line (quantity,
                unit price, plus the piece weight), relabelled to the words the
                butcher actually uses so nobody has to work out whether
                "quantity" means birds or kilos. */}
            <div className={`purch-form-row${byPiece ? ' purch-form-row-3' : ''}`}>
              <label>
                {byPiece ? 'Number of pieces' : 'Quantity'}
                <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </label>
              {byPiece && (
                <label>
                  Weight of one piece (kg)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={weightPerPiece}
                    onChange={(e) => setWeightPerPiece(e.target.value)}
                    placeholder="e.g. 1.6"
                  />
                </label>
              )}
              <label>
                {byPiece ? 'Cost of each (₹)' : 'Unit price (₹)'}
                <input type="number" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
              </label>
            </div>

            {byPiece && (
              <p className="inv-section-hint purch-piece-hint">
                {piecePreview ? (
                  <>
                    {piecePreview.pieces} ×{' '}
                    {piecePreview.totalKg ? `${weightPerPiece} kg = ${piecePreview.totalKg} kg total` : '? kg'}
                    {piecePreview.totalCost ? ` · ${inrFormat(piecePreview.totalCost)}` : ''}
                    {!piecePreview.totalKg && ' — weigh them and the plans downstream get the kg they work in.'}
                  </>
                ) : (
                  'Stock and the vendor bill stay in pieces; the weight is what the cook, the meat plan and a client’s kg/week are in. Leave it blank if they haven’t been weighed.'
                )}
              </p>
            )}

            {/* Sticky on purpose — it isn't cleared when a line is added, so
                three lines for the same account cost one pick, while a cart
                that switches accounts halfway still can. */}
            {isB2B && clients.length > 0 && (
              <label>
                For client (optional)
                <select value={lineClientId} onChange={(e) => setLineClientId(e.target.value)}>
                  <option value="">Untagged — general / shared stock</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="inv-section-hint">
                  Tags this line's spend to an account. Meat also gets tagged to a cook later, at Start Smoking.
                </span>
              </label>
            )}

            <button
              type="button"
              className="secondary-button purch-add-line-btn"
              onClick={handleAddLine}
              disabled={!quantity || (isCustom ? !customName.trim() : !materialChoice)}
            >
              {linePurpose === 'Practice' ? '+ Add practice line' : '+ Add line'}
            </button>
            {addLineError && <p className="chat-error">{addLineError}</p>}
          </div>

          {cart.length > 0 && (
            <div className="prep-table-wrap purch-cart-wrap">
              {/* On a phone the rows become stacked cards (see
                  .purch-cart-table in App.css) — as a five-column table the
                  number inputs were squeezed until "560" showed as "5". The
                  data-label on each cell is the heading the card shows. */}
              <table className="prep-table purch-cart-table">
                <thead>
                  <tr>
                    <th className="prep-item-col">Item</th>
                    {isB2B && <th>Client</th>}
                    <th>Qty</th>
                    <th>Unit price</th>
                    <th>Line total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {cart.map((line) => (
                    <tr key={line.key} className={line.billText && !line.matched ? 'purch-cart-unmatched' : undefined}>
                      <td className="prep-item-col">
                        {/* Editable for the same reason the numbers are: a
                            scanned line the catalog didn't recognise is
                            logged under whatever name is here, so a mangled
                            one should cost a retype, not a re-entry. */}
                        <input
                          className="purch-cart-name"
                          value={line.itemName}
                          onChange={(e) => handleUpdateLine(line.key, { itemName: e.target.value })}
                        />
                        <button
                          type="button"
                          className={`purch-purpose-pill${line.purpose === 'Practice' ? ' is-practice' : ''}`}
                          title="Tap to switch between order and practice"
                          onClick={() =>
                            handleUpdateLine(line.key, { purpose: line.purpose === 'Practice' ? 'Order' : 'Practice' })
                          }
                        >
                          {line.purpose === 'Practice' ? 'Practice' : `${channel} order`}
                        </button>
                        {line.billText && (
                          <small className="purch-cart-source">
                            Bill: {line.billText}
                            {!line.matched && ' · not in catalog, stock won’t move'}
                          </small>
                        )}
                      </td>
                      {isB2B && <td data-label="Client">{line.clientName || '—'}</td>}
                      <td className="prep-total-cell" data-label={line.unit ? `Qty (${line.unit})` : 'Qty'}>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className="purch-cart-num"
                          value={line.quantity}
                          onChange={(e) =>
                            handleUpdateLine(line.key, { quantity: Number(e.target.value) || 0, derivedQuantity: false })
                          }
                        />
                        {line.derivedQuantity && <small className="purch-cart-source">from total ÷ rate</small>}
                        {line.weightPerUnitKg > 0 && (
                          <>
                            <br />
                            <small>
                              {line.weightPerUnitKg} kg each ={' '}
                              {Math.round(line.quantity * line.weightPerUnitKg * 1000) / 1000} kg
                            </small>
                          </>
                        )}
                      </td>
                      <td className="prep-total-cell" data-label={line.unit ? `Price / ${line.unit}` : 'Unit price'}>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className="purch-cart-num"
                          value={line.unitPrice}
                          onChange={(e) => handleUpdateLine(line.key, { unitPrice: Number(e.target.value) || 0 })}
                        />
                        {line.derivedPrice && <small className="purch-cart-source">from line total</small>}
                        {line.unit && !line.derivedPrice && <small className="purch-cart-source">per {line.unit}</small>}
                      </td>
                      <td className="prep-total-cell purch-cart-total" data-label="Total">
                        {inrFormat(line.quantity * line.unitPrice)}
                      </td>
                      <td className="purch-remove-cell">
                        <button type="button" className="purch-remove-btn" onClick={() => handleRemoveLine(line.key)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="prep-item-col" colSpan={isB2B ? 4 : 3}>
                      Total
                    </td>
                    <td className="prep-total-cell prep-grand-total" colSpan={2}>
                      {inrFormat(cartTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="wizard-actions-bottom purch-actions">
            <button
              type="button"
              className="primary-button"
              onClick={handleLogPurchase}
              disabled={!vendorName || !cart.length || isSubmitting}
            >
              {isSubmitting ? 'Saving…' : 'Save'}
            </button>
          </div>
          {submitError && <p className="chat-error">{submitError}</p>}
          {submitStatus && !submitError && <p className="status-message">{submitStatus}</p>}
          {/* The flag. The table below stays on this week whatever gets
              logged — that is what it is for — so a buy dated into another
              week says where it went and offers to take you there, rather
              than moving the screen under you or, worse, saying nothing and
              reading as a save that failed. */}
          {landedElsewhere && !submitError && (
            <p className="status-message purch-landed">
              <span>
                Those {landedElsewhere.lines} line{landedElsewhere.lines === 1 ? '' : 's'} are dated{' '}
                {dayLabel(purchaseDate)}, so they went into the week of{' '}
                <strong>{weekLabel(landedElsewhere.from, landedElsewhere.to)}</strong> — not the week showing below.
              </span>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => {
                  setRangeFrom(landedElsewhere.from);
                  setRangeTo(landedElsewhere.to);
                  setLandedElsewhere(null);
                }}
              >
                Show that week
              </button>
            </p>
          )}
          {poResult && !submitError && (
            <p className="status-message">
              Created draft PO {poResult.name} in Odoo.{' '}
              {poResult.url && (
                <a href={poResult.url} target="_blank" rel="noreferrer">
                  Open in Odoo →
                </a>
              )}
            </p>
          )}
          </>
          )}
        </div>

        <div className="purch-side">
          <div className="wizard-card">
            <h2>This week's {channel} expenses</h2>
            <div className="prep-odoo-dates purch-range">
              <span>
                From
                <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
              </span>
              <span>
                To
                <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
              </span>
            </div>

            {purchasesError && <p className="chat-error">{purchasesError}</p>}
            {/* In the other modes the entry card shows this beside the form. */}
            {entryMode === 'Purchase' && expensesError && <p className="chat-error">{expensesError}</p>}
            {isLoadingPurchases && <p className="status-message">Loading…</p>}

            {/* The three kinds of spend, then the one figure they add up to —
                what the week actually cost this side of the business. */}
            <ul className="purch-vendor-totals">
              <li>
                <span>Purchases</span>
                <span>{inrFormat(purchasesTotal)}</span>
              </li>
              {practiceTotal > 0 && (
                <li className="purch-practice-total">
                  <span>of which practice</span>
                  <span>{inrFormat(practiceTotal)}</span>
                </li>
              )}
              <li>
                <span>Labour</span>
                <span>{inrFormat(labourTotal)}</span>
              </li>
              <li>
                <span>Logistics</span>
                <span>{inrFormat(logisticsTotal)}</span>
              </li>
              <li>
                <span>Investment</span>
                <span>{inrFormat(investmentTotal)}</span>
              </li>
              <li>
                <span>Miscellaneous</span>
                <span>{inrFormat(miscTotal)}</span>
              </li>
            </ul>
            <div className="prep-summary-card prep-summary-card-total purch-week-total">
              <div className="prep-summary-label">Week total · {channel}</div>
              <div className="prep-summary-value">{inrFormat(expenseTotal)}</div>
            </div>

            <h3 className="inv-section-title">All spend</h3>
            {!isLoadingPurchases && purchases.length === 0 && !purchasesError && (
              <p className="inv-note">Nothing logged in this range yet.</p>
            )}

            {purchases.length > 0 && (
              <>
                {purchasesByVendor.length > 0 && (
                  <ul className="purch-vendor-totals">
                    {purchasesByVendor.map(([supplier, total]) => (
                      <li key={supplier}>
                        <span>{supplier}</span>
                        <span>{inrFormat(total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {isB2B && purchasesByClient.length > 0 && (
                  <>
                    <h3 className="inv-section-title">Spend by client</h3>
                    <ul className="purch-vendor-totals">
                      {purchasesByClient.map(([client, total]) => (
                        <li key={client}>
                          <span>{client}</span>
                          <span>{inrFormat(total)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {deleteError && <p className="chat-error">{deleteError}</p>}

                {uncatalogued.length > 0 && (
                  <p className="purch-uncat-banner">
                    {uncatalogued.length} line{uncatalogued.length === 1 ? '' : 's'} below{' '}
                    {uncatalogued.length === 1 ? 'is' : 'are'} logged as spend but{' '}
                    {uncatalogued.length === 1 ? "isn't" : "aren't"} in the materials catalogue, so{' '}
                    {uncatalogued.length === 1 ? 'it' : 'they'} never moved stock. Add{' '}
                    {uncatalogued.length === 1 ? 'it' : 'them'} to fix the count.
                  </p>
                )}
                {catalogError && <p className="chat-error">{catalogError}</p>}
                {catalogStatus && !catalogError && <p className="status-message">{catalogStatus}</p>}

                <div className="prep-table-wrap">
                  <table className="prep-table">
                    <thead>
                      <tr>
                        <th className="prep-item-col">Item</th>
                        <th>Vendor</th>
                        {isB2B && <th>Client</th>}
                        {isB2B && <th>Cook</th>}
                        <th>Date</th>
                        <th>Qty</th>
                        <th>Cost</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {purchases.map((p) => (
                        <React.Fragment key={p.purchase_id}>
                        <tr>
                          <td className="prep-item-col">
                            {p.item_name}
                            {p.purpose === 'Practice' && (
                              <>
                                {' '}
                                <span className="purch-purpose-pill is-practice">Practice</span>
                              </>
                            )}
                            {!p.material_id && p.item_type !== 'service' && (
                              <>
                                {' '}
                                <span className="purch-uncat-pill" title="Logged as spend, but no stock was added">
                                  not in stock
                                </span>
                                <br />
                                <button
                                  type="button"
                                  className="purch-uncat-btn"
                                  onClick={() => openUncatalogued(p.purchase_id)}
                                >
                                  {catalogTarget === p.purchase_id ? 'Cancel' : 'Fix this line'}
                                </button>
                              </>
                            )}
                          </td>
                          <td>{p.vendor_name || '—'}</td>
                          {isB2B && <td>{p.client_name || '—'}</td>}
                          {/* Read-only here: the cook tag is set at Start
                              Smoking, where the pitmaster can actually see
                              which session is going on. */}
                          {isB2B && <td>{p.smoking_session_id || '—'}</td>}
                          <td>{p.purchase_date}</td>
                          <td className="prep-total-cell">
                            {p.quantity_purchased}
                            {p.total_weight_kg && (
                              <>
                                <br />
                                <small>
                                  {p.weight_per_unit_kg} kg each = {p.total_weight_kg} kg
                                </small>
                              </>
                            )}
                          </td>
                          <td className="prep-total-cell">{p.total_cost ? inrFormat(Number(p.total_cost)) : '—'}</td>
                          <td className="purch-remove-cell">
                            <button
                              type="button"
                              className="purch-remove-btn"
                              onClick={() => handleDeletePurchase(p.purchase_id)}
                              disabled={deletingId === p.purchase_id}
                              title="Delete this purchase"
                            >
                              {deletingId === p.purchase_id ? '…' : '×'}
                            </button>
                          </td>
                        </tr>
                        {catalogTarget === p.purchase_id && (
                          <tr className="purch-uncat-row">
                            <td colSpan={isB2B ? 8 : 6}>
                              {/* Two endings for the same line, and choosing
                                  between them is the actual decision: mapping
                                  moves this buy onto a count that already
                                  exists, adding starts a new one. Getting it
                                  wrong the "add" way is the costly direction —
                                  one ingredient in two rows, neither of which
                                  reads true. */}
                              <div className="purch-uncat-modes">
                                <button
                                  type="button"
                                  className={catalogMode === 'map' ? 'is-active' : ''}
                                  onClick={() => setCatalogMode('map')}
                                >
                                  Map to an existing item
                                </button>
                                <button
                                  type="button"
                                  className={catalogMode === 'new' ? 'is-active' : ''}
                                  onClick={() => setCatalogMode('new')}
                                >
                                  Add as a new item
                                </button>
                              </div>

                              {catalogMode === 'map' && (
                                <>
                                  {isMatching && <p className="inv-note">Looking for the matching item…</p>}

                                  {!isMatching && matchSuggestions.length > 0 && (
                                    <>
                                      {/* Where the ranking came from, because
                                          it changes what a row is worth: one
                                          pass read both names and judged them
                                          the same ingredient, the other only
                                          measured how alike the strings are. */}
                                      <p className="purch-match-caption">
                                        {matchSource === 'gemini'
                                          ? 'Matched on what the names mean, then narrowed to the closest in the catalogue.'
                                          : 'Ranked by name similarity alone.'}
                                      </p>
                                    <ul className="purch-match-list">
                                      {matchSuggestions.map((sugg) => (
                                        <li key={sugg.materialId}>
                                          <button
                                            type="button"
                                            className={`purch-match-option${
                                              matchChoice === sugg.materialId ? ' is-chosen' : ''
                                            }`}
                                            onClick={() => setMatchChoice(sugg.materialId)}
                                          >
                                            <span className="purch-match-name">
                                              {sugg.itemName}
                                              <span className={`purch-match-conf purch-match-conf-${sugg.confidence}`}>
                                                {sugg.confidence}
                                              </span>
                                            </span>
                                            <span className="purch-match-meta">
                                              {[
                                                sugg.category,
                                                sugg.quantityOnHand != null ? `${sugg.quantityOnHand} on hand` : '',
                                                sugg.reason,
                                              ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                            </span>
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                    </>
                                  )}

                                  {/* Always present, never only the suggestions:
                                      the model gets to narrow the list, not to
                                      decide what the pitmaster is allowed to
                                      pick. */}
                                  <div className="purch-uncat-form">
                                    <span>
                                      {matchSuggestions.length ? 'Or pick any item' : 'Item'}
                                      <select value={matchChoice} onChange={(e) => setMatchChoice(e.target.value)}>
                                        <option value="">Select an item…</option>
                                        {allMaterialsByCategory.map(([category, items]) => (
                                          <optgroup key={category} label={category}>
                                            {items.map((m) => (
                                              <option key={m.material_id} value={m.material_id}>
                                                {m.item_name}
                                              </option>
                                            ))}
                                          </optgroup>
                                        ))}
                                      </select>
                                    </span>
                                    <button
                                      type="button"
                                      className="secondary-button small"
                                      onClick={() => handleLinkPurchase(p.purchase_id)}
                                      disabled={!matchChoice || isLinking}
                                    >
                                      {isLinking ? 'Mapping…' : `Map and stock ${p.quantity_purchased}`}
                                    </button>
                                  </div>

                                  {matchNote && <p className="inv-note">{matchNote}</p>}
                                  <p className="inv-note">
                                    Adds {p.quantity_purchased} to the chosen item&apos;s count, dated {p.purchase_date},
                                    and re-words this line to the catalogue&apos;s name for it — what was typed at the
                                    counter is kept in the purchase&apos;s notes.
                                  </p>
                                </>
                              )}

                              {catalogMode === 'new' && (
                                <>
                              <div className="purch-uncat-form">
                                <span>
                                  Category
                                  <input
                                    list="purch-material-categories"
                                    value={catalogCategory}
                                    onChange={(e) => setCatalogCategory(e.target.value)}
                                    placeholder="e.g. Produce"
                                  />
                                </span>
                                <span>
                                  Reorder level
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    value={catalogReorder}
                                    onChange={(e) => setCatalogReorder(e.target.value)}
                                    placeholder="optional"
                                  />
                                </span>
                                <button
                                  type="button"
                                  className="secondary-button small"
                                  onClick={() => handleCatalogItem(p.purchase_id)}
                                  disabled={catalogBusyId === p.purchase_id}
                                >
                                  {catalogBusyId === p.purchase_id
                                    ? 'Adding…'
                                    : `Add "${p.item_name}" and stock ${p.quantity_purchased}`}
                                </button>
                              </div>
                              {/* The buy's own unit price becomes the standing
                                  cost and its vendor the default supplier —
                                  both server-side, both editable later, and
                                  neither worth a form field at the counter. */}
                              <p className="inv-note">
                                Creates a new RM- item at zero stock, links this purchase to it, and adds{' '}
                                {p.quantity_purchased} to the count, dated {p.purchase_date}. Check the map tab first — a
                                second row for an item the catalogue already has splits that item&apos;s stock in two.
                              </p>
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                  <datalist id="purch-material-categories">
                    {materialCategories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WeeklyPurchasing;
