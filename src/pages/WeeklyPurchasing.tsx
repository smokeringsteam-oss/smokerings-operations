import React, { useEffect, useMemo, useState } from 'react';

// Weekly Purchasing — logs purchases from all three vendor types (meat
// shops, Bread Time Stories, Swiggy) against the shared knowledge-base
// catalog (server/purchasing.js -> vendors.csv / raw_materials.csv /
// inventory.csv / purchases.csv), and can send the same line items to Odoo
// as a draft Purchase Order (an RFQ — nothing is confirmed/committed there
// automatically, see server/odoo.js createPurchaseOrder).

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

type InventoryRow = {
  material_id: string;
  item_name: string;
  quantity_on_hand: string;
  unit_of_measure: string;
  category: string;
  reorder_level: string;
  last_updated: string;
};

type PurchaseRecord = {
  purchase_id: string;
  material_id: string;
  item_name: string;
  purchase_date: string;
  quantity_purchased: string;
  unit_of_measure: string;
  unit_price: string;
  total_cost: string;
  supplier: string;
  odoo_po_id?: string;
  odoo_po_line_id?: string;
};

type CartLine = {
  key: string;
  materialId: string;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
};

const CUSTOM_ITEM_VALUE = '__custom__';

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

const WeeklyPurchasing: React.FC = () => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [lowStock, setLowStock] = useState<InventoryRow[]>([]);
  const [loadError, setLoadError] = useState('');

  const [vendorName, setVendorName] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(formatDateInput(new Date()));
  const [cart, setCart] = useState<CartLine[]>([]);

  const [materialChoice, setMaterialChoice] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');

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
      const [vendorsResp, materialsResp, inventoryResp] = await Promise.all([
        fetch('/api/purchasing/vendors'),
        fetch('/api/purchasing/materials'),
        fetch('/api/purchasing/inventory'),
      ]);
      const vendorsData = await readJson<{ vendors?: Vendor[]; error?: string }>(vendorsResp);
      if (!vendorsResp.ok) throw new Error(vendorsData.error || 'Failed to load vendors.');
      const materialsData = await readJson<{ materials?: RawMaterial[]; error?: string }>(materialsResp);
      if (!materialsResp.ok) throw new Error(materialsData.error || 'Failed to load materials.');
      const inventoryData = await readJson<{ inventory?: InventoryRow[]; lowStock?: InventoryRow[]; error?: string }>(
        inventoryResp,
      );
      if (!inventoryResp.ok) throw new Error(inventoryData.error || 'Failed to load inventory.');

      setVendors(vendorsData.vendors || []);
      setMaterials(materialsData.materials || []);
      setLowStock(inventoryData.lowStock || []);
    } catch (err) {
      setLoadError(String((err as Error).message || err));
    }
  };

  const loadPurchases = async () => {
    if (!rangeFrom || !rangeTo) return;
    setIsLoadingPurchases(true);
    setPurchasesError('');
    try {
      const resp = await fetch(`/api/purchasing/purchases?from=${rangeFrom}&to=${rangeTo}`);
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

  useEffect(() => {
    loadPurchases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeFrom, rangeTo]);

  const selectedVendor = vendors.find((v) => v.vendor_name === vendorName);
  // Meat vendors (the pork/chicken shops) only ever sell meat — keep the
  // item list to the Meat category so nothing else can accidentally get
  // logged against them. Conversely, meat only comes from meat vendors, so
  // it's hidden from every other vendor's item list too.
  const isMeatVendor = selectedVendor?.vendor_type === 'Meat Vendor';
  const visibleMaterials = useMemo(
    () => materials.filter((m) => (isMeatVendor ? m.category === 'Meat' : m.category !== 'Meat')),
    [materials, isMeatVendor],
  );

  const materialsByCategory = useMemo(() => {
    const groups = new Map<string, RawMaterial[]>();
    visibleMaterials.forEach((m) => {
      const list = groups.get(m.category) || [];
      list.push(m);
      groups.set(m.category, list);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visibleMaterials]);

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

  const handleAddLine = () => {
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    const itemName = isCustom ? customName.trim() : selectedMaterial?.item_name || '';
    if (!itemName) return;
    const unit = isCustom ? customUnit.trim() : selectedMaterial?.unit_of_measure || '';
    const price = Number(unitPrice) || 0;

    setCart((current) => [
      ...current,
      {
        key: `${Date.now()}-${Math.random()}`,
        materialId: isCustom ? '' : materialChoice,
        itemName,
        unit,
        quantity: qty,
        unitPrice: price,
      },
    ]);

    setMaterialChoice('');
    setCustomName('');
    setCustomUnit('');
    setQuantity('');
    setUnitPrice('');
  };

  const handleRemoveLine = (key: string) => {
    setCart((current) => current.filter((line) => line.key !== key));
  };

  const cartTotal = useMemo(() => cart.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), [cart]);

  // Single action: logs the cart to purchases.csv/inventory.csv first (the
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
          lines: cart.map(({ materialId, itemName, unit, quantity: qty, unitPrice: price }) => ({
            materialId,
            itemName,
            unit,
            quantity: qty,
            unitPrice: price,
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
        `Logged ${cart.length} line item${cart.length === 1 ? '' : 's'} from ${vendorName} to the CSV.${poNote}`,
      );
      setCart([]);
      await Promise.all([loadCatalog(), loadPurchases()]);
    } catch (err) {
      setSubmitError(String((err as Error).message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Deletes one purchases.csv row, reverses its inventory adjustment, and —
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

  // Autocomplete suggestions drawn from existing vendors — vendor_type in
  // particular matters beyond cosmetics: it has to read exactly "Meat
  // Vendor" for the meat-only item filter above to pick it up, so surfacing
  // the existing values as suggestions (rather than a free-for-all text box)
  // heads off typos that would silently break that filter for the new vendor.
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

  const purchasesTotal = useMemo(
    () => purchases.reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0),
    [purchases],
  );
  const purchasesByVendor = useMemo(() => {
    const totals = new Map<string, number>();
    purchases.forEach((p) => {
      totals.set(p.supplier, (totals.get(p.supplier) || 0) + (Number(p.total_cost) || 0));
    });
    return Array.from(totals.entries()).sort(([, a], [, b]) => b - a);
  }, [purchases]);

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
              <select value={materialChoice} onChange={(e) => setMaterialChoice(e.target.value)}>
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
                  Unit
                  <input value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="kg / pcs / ml" />
                </label>
              </div>
            )}

            <div className="purch-form-row">
              <label>
                Quantity
                <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </label>
              <label>
                Unit price (₹)
                <input type="number" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
              </label>
            </div>

            <button
              type="button"
              className="secondary-button small"
              onClick={handleAddLine}
              disabled={!quantity || (isCustom ? !customName.trim() : !materialChoice)}
            >
              + Add line
            </button>
          </div>

          {cart.length > 0 && (
            <div className="prep-table-wrap purch-cart-wrap">
              <table className="prep-table">
                <thead>
                  <tr>
                    <th className="prep-item-col">Item</th>
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
                      <td className="prep-total-cell">
                        {line.quantity} {line.unit}
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
                    <td className="prep-item-col" colSpan={3}>
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
          {lowStock.length > 0 && (
            <div className="wizard-card purch-lowstock">
              <h2>⚠️ Low stock</h2>
              <p className="inv-section-hint">On hand is below the reorder level — worth putting on this week's list.</p>
              <ul className="purch-lowstock-list">
                {lowStock.map((row) => (
                  <li key={row.material_id}>
                    <span>{row.item_name}</span>
                    <span>
                      {row.quantity_on_hand} / {row.reorder_level} {row.unit_of_measure}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="wizard-card">
            <h2>This week's purchases</h2>
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
                <div className="prep-summary-card prep-summary-card-total purch-week-total">
                  <div className="prep-summary-label">Week total</div>
                  <div className="prep-summary-value">{inrFormat(purchasesTotal)}</div>
                </div>

                {deleteError && <p className="chat-error">{deleteError}</p>}

                <div className="prep-table-wrap">
                  <table className="prep-table">
                    <thead>
                      <tr>
                        <th className="prep-item-col">Item</th>
                        <th>Vendor</th>
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
                          <td>{p.supplier}</td>
                          <td>{p.purchase_date}</td>
                          <td className="prep-total-cell">
                            {p.quantity_purchased} {p.unit_of_measure}
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
