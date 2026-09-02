import React, { useEffect, useMemo, useState } from 'react';

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
  unit_of_measure: string;
  reorder_level: string;
};

type PurchaseRecord = {
  purchase_id: string;
  material_id: string;
  item_name: string;
  purchase_date: string;
  quantity_purchased: string;
  unit_of_measure: string;
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
  // Cost attribution, both optional. `client_name` is which B2B account the
  // spend was for (set here, per line); `smoking_session_id` is which cook it
  // was bought for (set later, at Start Smoking — see server/ops/shared/smoking.js
  // startSmoking). Neither exists on B2C rows.
  client_id?: string;
  client_name?: string;
  smoking_session_id?: string;
  odoo_po_id?: string;
  odoo_po_line_id?: string;
};

// One wholesale/corporate account, as GET /api/b2b/clients returns it (see
// toClient in server/ops/b2b/b2bClients.js). Only the two fields the picker needs.
type B2BClient = { id: string; name: string; stage: string };

type CartLine = {
  key: string;
  materialId: string;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  // For an item bought by the piece, what one piece weighs — 0 when it
  // doesn't apply or hasn't been weighed. See isWeighedByPiece below.
  weightPerUnitKg: number;
  // Which B2B account this one line is for. Per line rather than per cart
  // because one butcher run routinely covers two accounts, and one cart
  // routinely mixes a client's meat with packaging bought for nobody in
  // particular — see recordPurchases in server/ops/shared/purchasing.js. Always
  // optional: an untagged line is general overhead, which is a real answer.
  clientId: string;
  clientName: string;
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
// Keyed on the catalogue rather than on the item's name, so a second whole
// bird or a rack sold by the piece needs a materials row and nothing here.
// Meat is the qualifier that keeps buns, sporks and containers out of it:
// those are bought by the piece and used by the piece, and asking what one
// spork weighs is noise.
const isWeighedByPiece = (m?: RawMaterial) =>
  !!m && m.unit_of_measure === 'pcs' && m.category === 'Meat';

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

type InventoryAdjustment = {
  adjustment_id: string;
  adjustment_date: string;
  material_id: string;
  item_name: string;
  quantity: string;
  unit_of_measure: string;
  reason: string;
};

const inrFormat = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const formatDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const getThisWeekRange = () => {
  const today = new Date();
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: formatDateInput(monday), to: formatDateInput(sunday) };
};
const DEFAULT_RANGE = getThisWeekRange();

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

  const [vendorName, setVendorName] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(formatDateInput(new Date()));
  const [cart, setCart] = useState<CartLine[]>([]);

  // Only fetched (and only rendered) on the B2B side — B2C has no account
  // book to attribute spend to.
  const [clients, setClients] = useState<B2BClient[]>([]);
  const [lineClientId, setLineClientId] = useState('');

  const [materialChoice, setMaterialChoice] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [weightPerPiece, setWeightPerPiece] = useState('');
  const [addLineError, setAddLineError] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [poResult, setPoResult] = useState<{ name: string; url: string | null } | null>(null);

  const [rangeFrom, setRangeFrom] = useState(DEFAULT_RANGE.from);
  const [rangeTo, setRangeTo] = useState(DEFAULT_RANGE.to);
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [isLoadingPurchases, setIsLoadingPurchases] = useState(false);
  const [purchasesError, setPurchasesError] = useState('');

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const [showAddInventory, setShowAddInventory] = useState(false);
  const [invMaterialChoice, setInvMaterialChoice] = useState('');
  const [invQuantity, setInvQuantity] = useState('');
  const [invReason, setInvReason] = useState('');
  const [invDate, setInvDate] = useState(formatDateInput(new Date()));
  const [isAddingInventory, setIsAddingInventory] = useState(false);
  const [addInventoryStatus, setAddInventoryStatus] = useState('');
  const [addInventoryError, setAddInventoryError] = useState('');

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

  // Full catalog grouped by category, independent of any vendor selection —
  // used by the manual "Add inventory" form below, which isn't tied to a
  // vendor the way logging a purchase is.
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
  const byPiece = isWeighedByPiece(selectedMaterial);
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
    const unit = isCustom ? customUnit.trim() : selectedMaterial?.unit_of_measure || '';
    // A unit of measure that's just digits is almost always a mis-click into
    // the wrong box (this exact mistake once turned "Quantity 1" into
    // "Quantity 1, Unit 1" — displayed as "1 1", easy to misread as "11").
    // Catch it here instead of letting it into the CSV.
    if (unit && /^\d+$/.test(unit)) {
      setAddLineError(
        `"${unit}" doesn't look like a unit (kg, pcs, plan…) — that number might belong in Quantity instead of Unit.`,
      );
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
        unit,
        quantity: qty,
        unitPrice: price,
        weightPerUnitKg: perPiece,
        clientId: channel === 'B2B' ? lineClientId : '',
        clientName: channel === 'B2B' ? clients.find((c) => c.id === lineClientId)?.name || '' : '',
      },
    ]);

    setMaterialChoice('');
    setCustomName('');
    setCustomUnit('');
    setQuantity('');
    setUnitPrice('');
    setWeightPerPiece('');
  };

  const handleRemoveLine = (key: string) => {
    setCart((current) => current.filter((line) => line.key !== key));
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
          lines: cart.map(({ materialId, itemName, unit, quantity: qty, unitPrice: price, weightPerUnitKg, clientId }) => ({
            materialId,
            itemName,
            unit,
            quantity: qty,
            unitPrice: price,
            // Blank rather than 0 when it doesn't apply or wasn't weighed —
            // the column is nullable so it can say "unknown" instead of
            // claiming a weightless bird.
            weightPerUnitKg: weightPerUnitKg > 0 ? weightPerUnitKg : '',
            // Id only — the server resolves the name off the B2B client book
            // so a renamed account can't leave two spellings in the log.
            clientId,
          })),
        }),
      });
      const logData = await readJson<{ purchases?: PurchaseRecord[]; error?: string }>(logResp);
      if (!logResp.ok) throw new Error(logData.error || 'Failed to log purchase to CSV.');
      const purchaseIds = (logData.purchases || []).map((p) => p.purchase_id);

      let poNote = '';
      try {
        const poResp = await fetch('/api/purchasing/send-po', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendorName,
            purchaseIds,
            lines: cart.map(({ itemName, unit, quantity: qty, unitPrice: price }) => ({
              itemName,
              unit,
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

      setSubmitStatus(
        `Logged ${cart.length} line item${cart.length === 1 ? '' : 's'} from ${vendorName} to the purchase log.${poNote}`,
      );
      setCart([]);
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

  // Adds stock outside of a vendor purchase (opening stock, a count
  // correction, a return) — logs to inventory_adjustments.csv and bumps
  // quantity_on_hand the same way logging a purchase does, just without a
  // vendor/price attached. See server/core/inventoryStore.js addInventoryAdjustment.
  const handleAddInventory = async () => {
    if (!invMaterialChoice || isAddingInventory) return;
    setIsAddingInventory(true);
    setAddInventoryError('');
    setAddInventoryStatus('');
    try {
      const resp = await fetch('/api/purchasing/inventory/adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialId: invMaterialChoice,
          quantity: invQuantity,
          reason: invReason.trim(),
          date: invDate,
        }),
      });
      const data = await readJson<{
        adjustment?: InventoryAdjustment;
        inventoryUpdated?: { item_name: string; newQuantity: number } | null;
        odoo?: { applied?: boolean; newQuantity?: number; error?: string } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to add inventory.');

      const updated = data.inventoryUpdated;
      let odooNote = '';
      if (data.odoo?.error) odooNote = ` Odoo: failed to sync on-hand stock (${data.odoo.error}).`;
      else if (data.odoo?.applied !== false) odooNote = ' Also synced to Odoo on-hand stock.';

      setAddInventoryStatus(
        (updated
          ? `Added ${data.adjustment?.quantity} ${data.adjustment?.unit_of_measure || ''} of ${data.adjustment?.item_name} — now ${updated.newQuantity} on hand.`
          : `Logged the adjustment, but couldn't find that item in materials.csv to update on-hand quantity.`) + odooNote,
      );
      setInvMaterialChoice('');
      setInvQuantity('');
      setInvReason('');
      await loadCatalog();
    } catch (err) {
      setAddInventoryError(String((err as Error).message || err));
    } finally {
      setIsAddingInventory(false);
    }
  };

  const purchasesTotal = useMemo(
    () => purchases.reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const purchasesByVendor = useMemo(() => {
    const totals = new Map<string, number>();
    purchases.forEach((p) => {
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
          inventory catalog, and send the same line items to Odoo as a draft Purchase Order.
        </p>
      </div>

      {loadError && (
        <div className="prep-unmatched">
          <strong>Couldn't load the purchasing catalog:</strong>
          <p>{loadError}</p>
        </div>
      )}

      <div className="purch-grid">
        <div className="wizard-card">
          <h2>Log a purchase</h2>

          <div className="purch-form-row">
            <label>
              Vendor
              <select value={vendorName} onChange={(e) => setVendorName(e.target.value)}>
                <option value="">Select a vendor…</option>
                {vendors.map((v) => (
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

          <div className="purch-add-line">
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
                        {m.item_name} ({m.unit_of_measure})
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
                <label>
                  Unit (optional — how it's measured, not how many)
                  <input value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="kg / pcs / ml / plan — leave blank if none" />
                </label>
              </div>
            )}

            {/* Bought by the piece, used by the weight — see isWeighedByPiece.
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
              className="secondary-button small"
              onClick={handleAddLine}
              disabled={!quantity || (isCustom ? !customName.trim() : !materialChoice)}
            >
              + Add line
            </button>
            {addLineError && <p className="chat-error">{addLineError}</p>}
          </div>

          {cart.length > 0 && (
            <div className="prep-table-wrap purch-cart-wrap">
              <table className="prep-table">
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
                    <tr key={line.key}>
                      <td className="prep-item-col">{line.itemName}</td>
                      {isB2B && <td>{line.clientName || '—'}</td>}
                      <td className="prep-total-cell">
                        {line.quantity} {line.unit}
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
                      <td className="prep-total-cell">{inrFormat(line.unitPrice)}</td>
                      <td className="prep-total-cell">{inrFormat(line.quantity * line.unitPrice)}</td>
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
              {isSubmitting ? 'Logging…' : 'Log purchase to CSV and Odoo'}
            </button>
          </div>
          {submitError && <p className="chat-error">{submitError}</p>}
          {submitStatus && !submitError && <p className="status-message">{submitStatus}</p>}
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
        </div>

        <div className="purch-side">
          <div className="wizard-card">
            <h2>Add inventory</h2>
            <p className="inv-section-hint">
              Stock that didn't come through a vendor purchase — an opening count, a correction found while
              counting, a return. Logged separately from purchases (no vendor/price needed) but updates on-hand
              the same way.
            </p>

            <button
              type="button"
              className="secondary-button small purch-add-vendor-toggle"
              onClick={() => setShowAddInventory((v) => !v)}
            >
              {showAddInventory ? '− Cancel' : '+ Add inventory'}
            </button>

            {showAddInventory && (
              <div className="purch-add-line">
                <label>
                  Item
                  <select value={invMaterialChoice} onChange={(e) => setInvMaterialChoice(e.target.value)}>
                    <option value="">Select an item…</option>
                    {allMaterialsByCategory.map(([category, items]) => (
                      <optgroup key={category} label={category}>
                        {items.map((m) => (
                          <option key={m.material_id} value={m.material_id}>
                            {m.item_name} ({m.unit_of_measure})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                <div className="purch-form-row">
                  <label>
                    Quantity to add
                    <input type="number" min="0" step="any" value={invQuantity} onChange={(e) => setInvQuantity(e.target.value)} />
                  </label>
                  <label>
                    Date
                    <input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} />
                  </label>
                </div>

                <label>
                  Reason (optional)
                  <input
                    value={invReason}
                    onChange={(e) => setInvReason(e.target.value)}
                    placeholder="e.g. Opening stock count, returned unused, count correction"
                  />
                </label>

                <button
                  type="button"
                  className="secondary-button small"
                  onClick={handleAddInventory}
                  disabled={!invMaterialChoice || !invQuantity || isAddingInventory}
                >
                  {isAddingInventory ? 'Adding…' : 'Add to inventory'}
                </button>
                {addInventoryError && <p className="chat-error">{addInventoryError}</p>}
                {addInventoryStatus && !addInventoryError && <p className="status-message">{addInventoryStatus}</p>}
              </div>
            )}
          </div>

          <div className="wizard-card">
            <h2>This week's {channel} purchases</h2>
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
            {isLoadingPurchases && <p className="status-message">Loading…</p>}

            {!isLoadingPurchases && purchases.length === 0 && !purchasesError && (
              <p className="inv-note">No purchases logged in this range yet.</p>
            )}

            {purchases.length > 0 && (
              <>
                <ul className="purch-vendor-totals">
                  {purchasesByVendor.map(([supplier, total]) => (
                    <li key={supplier}>
                      <span>{supplier}</span>
                      <span>{inrFormat(total)}</span>
                    </li>
                  ))}
                </ul>
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

                <div className="prep-summary-card prep-summary-card-total purch-week-total">
                  <div className="prep-summary-label">Week total · {channel}</div>
                  <div className="prep-summary-value">{inrFormat(purchasesTotal)}</div>
                </div>

                {deleteError && <p className="chat-error">{deleteError}</p>}

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
                        <tr key={p.purchase_id}>
                          <td className="prep-item-col">{p.item_name}</td>
                          <td>{p.vendor_name || '—'}</td>
                          {isB2B && <td>{p.client_name || '—'}</td>}
                          {/* Read-only here: the cook tag is set at Start
                              Smoking, where the pitmaster can actually see
                              which session is going on. */}
                          {isB2B && <td>{p.smoking_session_id || '—'}</td>}
                          <td>{p.purchase_date}</td>
                          <td className="prep-total-cell">
                            {p.quantity_purchased} {p.unit_of_measure}
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
                      ))}
                    </tbody>
                  </table>
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
