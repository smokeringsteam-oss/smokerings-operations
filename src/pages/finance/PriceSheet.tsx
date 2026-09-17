import { useCallback, useEffect, useMemo, useState } from 'react';

// The price sheet — the bottom of Cost to Make, where the gaps get filled.
//
// Every cost on the screen above is a floor because most ingredients have no
// price, or no statement of what one purchased unit of them is. This used to
// be a read-only list of those gaps; this is the same list with the two
// inputs that close them, pre-filled from whatever the purchase log already
// knows:
//
//   * bought before  the price is the newest purchase and is shown, not
//                    asked. Only the pack size is asked — what the "1" on
//                    that purchase line was.
//   * never bought   price and pack size both, saved as the material's
//                    standard cost. The next real purchase replaces it.
//   * bought but not linked to an ingredient ("Amul Blend Diced Cheese
//                    200 g") — listed underneath with the catalogue names it
//                    most resembles, one click to link it.
//
// Every row shows what the recipes use of it and what that works out to at
// the pack size typed, before it is saved. That preview is the guard against
// the one mistake this form invites: a recipe that counts egg in grams, given
// a pack of "30 pcs", would cost a coleslaw ₹600 of egg.
//
// Backend: server/finance/materialPrices.js. Saving does not re-read Odoo,
// so the report above is recalculated only when asked.

type Pack = { packSize: number; packUnit: string };

type PurchaseView = {
  purchaseId: string;
  date: string;
  vendor: string;
  itemName: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
  notes: string;
};

type Usage = {
  parentId: string;
  parentName: string;
  quantity: number;
  per: 'plate' | 'batch';
  batchOutput: number | null;
};

type Row = {
  materialId: string;
  name: string;
  category: string;
  group: string;
  dishes: string[];
  dishCount: number;
  gap: string | null;
  price: { perUnit: number; source: 'purchase' | 'standard'; asOf: string; ref: string } | null;
  standardCostInr: number | null;
  costBasis: string;
  pack: Pack | null;
  packFrom: 'sheet' | 'books' | null;
  perBomUnit: number | null;
  bomUnit: string;
  purchases: PurchaseView[];
  purchaseCount: number;
  suggestion: (Pack & { from: string; why: string }) | null;
  usage: Usage[];
};

type Unlinked = PurchaseView & {
  pack: Pack | null;
  candidates: { materialId: string; name: string; score: number }[];
};

type Sheet = {
  rows: Row[];
  unlinked: Unlinked[];
  recipeGaps: { id: string; name: string; reason: string; dishCount: number }[];
  packUnits: string[];
  totals: { used: number; usedPriced: number; missing: number; needPackOnly: number };
};

// What one of each pack unit is in the units a recipe counts in. Mirrors
// PACK_UNITS in server/core/purchaseUnits.js — the server is the one that
// saves, this is only the live preview.
const PACK_MULTIPLIER: Record<string, { bomUnits: number; unit: string }> = {
  g: { bomUnits: 1, unit: 'g' },
  kg: { bomUnits: 1000, unit: 'g' },
  ml: { bomUnits: 1, unit: 'ml' },
  L: { bomUnits: 1000, unit: 'ml' },
  pcs: { bomUnits: 1, unit: 'pc' },
  dozen: { bomUnits: 12, unit: 'pc' },
  roll: { bomUnits: 1, unit: 'roll' },
};

// Which unit the dropdown opens on when nothing is known. Only the dropdown:
// the number stays empty until someone types it or a purchase supplies it.
const DEFAULT_UNIT: Record<string, string> = {
  'Packaging & Supplies': 'pcs',
  Bakery: 'pcs',
  Meat: 'kg',
  Produce: 'kg',
  'Oils & Liquids': 'ml',
  'Sauces & Condiments': 'ml',
  'Spices & Seasonings': 'g',
  'Dairy & Eggs': 'g',
  Sweeteners: 'g',
  'Snacks & Sides': 'g',
};

type Filter = 'missing' | 'used' | 'all';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (iso: string) => {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

const rupees = (value: number) => {
  if (value >= 100) return `₹${Math.round(value).toLocaleString('en-IN')}`;
  if (value >= 1) return `₹${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
  return `₹${value.toFixed(value >= 0.1 ? 2 : 3)}`;
};

const qtyText = (value: number | null) => (value == null ? '?' : Number.isInteger(value) ? String(value) : String(+value.toFixed(3)));

const PriceSheet = ({ onCostsChanged }: { onCostsChanged: () => void }) => {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('missing');
  const [saved, setSaved] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const resp = await fetch('/api/finance/material-prices');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not read the price sheet.');
      setSheet(data);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    if (!sheet) return [];
    if (filter === 'missing') return sheet.rows.filter((row) => row.gap && row.dishCount > 0);
    if (filter === 'used') return sheet.rows.filter((row) => row.dishCount > 0);
    return sheet.rows;
  }, [sheet, filter]);

  const onSaved = (next: Sheet, name: string) => {
    setSheet(next);
    setSaved((list) => [...list, name]);
  };

  const recalculate = () => {
    setSaved([]);
    onCostsChanged();
  };

  if (error && !sheet) return <div className="mkt-alert mkt-alert-error">{error}</div>;
  if (!sheet) return null;

  const { totals } = sheet;

  return (
    <section className="mkt-panel" id="price-sheet">
      <div className="mkt-panel-head">
        <h4>Price sheet — fill in what is missing</h4>
        <span className="mkt-panel-hint">
          {totals.usedPriced} of {totals.used} ingredients costed · {totals.missing} to go, {totals.needPackOnly} of them
          only need a pack size
        </span>
      </div>

      {saved.length > 0 ? (
        <div className="mkt-alert mkt-alert-warn ue-price-saved">
          <span>
            Saved {saved.length === 1 ? saved[0] : `${saved.length} ingredients`}. The costs above were worked out before
            {saved.length === 1 ? ' this' : ' these'}.
          </span>
          <button type="button" className="mkt-primary mkt-primary-sm" onClick={recalculate}>
            Recalculate costs
          </button>
        </div>
      ) : null}
      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}

      <div className="mkt-tabs" role="tablist" aria-label="Which ingredients">
        {(
          [
            ['missing', `Missing (${totals.missing})`],
            ['used', `Used in a dish (${totals.used})`],
            ['all', `Whole catalogue (${sheet.rows.length})`],
          ] as [Filter, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={`mkt-tab${filter === id ? ' is-active' : ''}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="mkt-alert">Nothing missing — every ingredient a dish uses has a price and a pack size.</div>
      ) : (
        <div className="mkt-table-wrap">
          <table className="mkt-table ue-price-table">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th>From past purchases</th>
                <th>Price ₹</th>
                <th>For a pack of</th>
                <th>Works out to</th>
                <th aria-label="Save" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // Keyed on what the defaults are built from, so a row whose
                // purchases or saved pack change (a link, a save) re-opens on
                // the new values rather than whatever was typed before.
                <PriceRow
                  key={`${row.materialId}:${row.purchaseCount}:${row.costBasis}`}
                  row={row}
                  packUnits={sheet.packUnits}
                  onSaved={onSaved}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UnlinkedPurchases rows={sheet.unlinked} materials={sheet.rows} onLinked={load} />

      {sheet.recipeGaps.length > 0 ? (
        <p className="mkt-panel-hint">
          Not fixable here: the rubs and brines ({sheet.recipeGaps.map((gap) => gap.name).join(', ')}) have no amount per
          kg of meat and no ingredients recorded, so no price can cost them yet. They need their recipes written up on the
          recipe screen first.
        </p>
      ) : null}

      <p className="mkt-panel-hint">
        A price from a purchase always wins over a typed one — to change it, log the new purchase. A typed price is saved
        as the ingredient&apos;s standard cost and used until the first purchase of it is logged. Pack sizes in ml are
        costed as if 1 ml weighs 1 g, because the recipes do not say which of the two they count in.
      </p>
    </section>
  );
};

// ---- One ingredient --------------------------------------------------------

const PriceRow = ({
  row,
  packUnits,
  onSaved,
}: {
  row: Row;
  packUnits: string[];
  onSaved: (sheet: Sheet, name: string) => void;
}) => {
  const fromPurchase = row.price?.source === 'purchase';
  const startPack = row.pack || row.suggestion;
  const [price, setPrice] = useState(fromPurchase ? '' : row.standardCostInr != null ? String(row.standardCostInr) : '');
  const [packSize, setPackSize] = useState(startPack ? String(startPack.packSize) : '');
  const [packUnit, setPackUnit] = useState(startPack?.packUnit || DEFAULT_UNIT[row.category] || 'g');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const effectivePrice = fromPurchase ? row.price!.perUnit : Number(price);
  const size = Number(packSize);
  const multiplier = PACK_MULTIPLIER[packUnit];
  const perUnit =
    effectivePrice > 0 && size > 0 && multiplier ? effectivePrice / (size * multiplier.bomUnits) : null;

  // Unchanged from what is saved: nothing to save. A suggestion that has not
  // been saved yet counts as a change — it is only a pre-fill.
  const dirty =
    !row.pack ||
    String(row.pack.packSize) !== packSize ||
    row.pack.packUnit !== packUnit ||
    (!fromPurchase && String(row.standardCostInr ?? '') !== price);
  const canSave = dirty && size > 0 && effectivePrice > 0 && !saving;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const resp = await fetch(`/api/finance/material-prices/${encodeURIComponent(row.materialId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceInr: fromPurchase ? undefined : Number(price), packSize: size, packUnit }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not save.');
      onSaved(data, row.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const latest = row.purchases[0];

  return (
    <tr className={row.gap ? '' : 'ue-price-done'}>
      <td>
        <strong>{row.name}</strong>
        <div className="ue-price-sub">
          {row.dishCount > 0 ? `${row.dishCount} ${row.dishCount === 1 ? 'dish' : 'dishes'}` : 'No dish uses it'} ·{' '}
          {row.gap ? <span className="mkt-bad">{row.gap}</span> : <span className="mkt-good">costed</span>}
        </div>
        {row.usage.length > 0 ? (
          <div className="ue-price-sub" title={row.usage.map((use) => `${use.parentName}: ${use.quantity}`).join('\n')}>
            Recipes use{' '}
            {row.usage
              .slice(0, 3)
              .map((use) =>
                use.per === 'plate'
                  ? `${qtyText(use.quantity)} per plate`
                  : `${qtyText(use.quantity)} in ${use.parentName}${use.batchOutput ? ` (of ${use.batchOutput})` : ''}`,
              )
              .filter((text, index, all) => all.indexOf(text) === index)
              .join(', ')}
          </div>
        ) : row.category === 'Meat' ? (
          <div className="ue-price-sub">Raw cut for a smoked product — recipes count finished grams</div>
        ) : null}
      </td>
      <td>
        {latest ? (
          <>
            <div>
              {rupees(latest.unitPrice ?? (latest.total && latest.quantity ? latest.total / latest.quantity : 0))} for{' '}
              {qtyText(latest.quantity)}
              <span className="mkt-muted">
                {' '}
                · {shortDay(latest.date)}
                {latest.vendor ? ` · ${latest.vendor}` : ''}
              </span>
            </div>
            {row.purchases.slice(1).map((buy) => (
              <div key={buy.purchaseId} className="ue-price-sub">
                {rupees(buy.unitPrice ?? 0)} for {qtyText(buy.quantity)} · {shortDay(buy.date)}
              </div>
            ))}
            {row.purchaseCount > row.purchases.length ? (
              <div className="ue-price-sub">and {row.purchaseCount - row.purchases.length} older</div>
            ) : null}
          </>
        ) : (
          <span className="mkt-muted">Never bought</span>
        )}
        {row.suggestion ? (
          <div className="ue-price-hint">
            {row.suggestion.packSize} {row.suggestion.packUnit} {row.suggestion.why} ({row.suggestion.from}) — filled in
          </div>
        ) : null}
      </td>
      <td>
        {fromPurchase ? (
          <span title={`Newest purchase, ${row.price!.ref}`}>
            {rupees(row.price!.perUnit)}
            <div className="ue-price-sub">from {row.price!.ref}</div>
          </span>
        ) : (
          <input
            className="ue-price-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="₹"
            aria-label={`Price of ${row.name}`}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        )}
      </td>
      <td>
        <div className="ue-price-pack">
          <input
            className="ue-price-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="size"
            aria-label={`Pack size of ${row.name}`}
            value={packSize}
            onChange={(event) => setPackSize(event.target.value)}
          />
          <select
            aria-label={`Pack unit of ${row.name}`}
            value={packUnit}
            onChange={(event) => setPackUnit(event.target.value)}
          >
            {packUnits.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </div>
        {row.packFrom === 'books' ? <div className="ue-price-sub">set in purchaseUnits.js</div> : null}
      </td>
      <td>
        {perUnit != null && multiplier ? (
          <>
            <div>
              {rupees(perUnit)} / {multiplier.unit}
            </div>
            {row.usage.slice(0, 2).map((use) => (
              <div key={`${use.parentId}-${use.quantity}`} className="ue-price-sub">
                {use.per === 'plate' ? 'per plate' : use.parentName}: {rupees(use.quantity * perUnit)}
              </div>
            ))}
          </>
        ) : (
          <span className="mkt-muted">—</span>
        )}
      </td>
      <td>
        <button type="button" className="mkt-primary mkt-primary-sm" disabled={!canSave} onClick={save}>
          {saving ? 'Saving…' : row.pack && !dirty ? 'Saved' : 'Save'}
        </button>
        {error ? <div className="ue-price-sub mkt-bad">{error}</div> : null}
      </td>
    </tr>
  );
};

// ---- Purchases no ingredient claims ------------------------------------------

// Money that was spent on something the recipes use, but whose price reaches
// no dish because the line was never tied to a material. Linking is the
// Purchasing screen's own endpoint — it also adds the quantity to that
// material's stock, dated to the buy — and afterwards the purchase is that
// ingredient's newest price like any other.
const UnlinkedPurchases = ({
  rows,
  materials,
  onLinked,
}: {
  rows: Unlinked[];
  materials: Row[];
  onLinked: () => void;
}) => {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (rows.length === 0) return null;

  const link = async (purchaseId: string, materialId: string) => {
    if (!materialId) return;
    setBusy(purchaseId);
    setError('');
    try {
      const resp = await fetch(`/api/purchasing/purchases/${encodeURIComponent(purchaseId)}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not link the purchase.');
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const byName = [...materials].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="ue-price-unlinked">
      <h5 className="ue-detail-title">Bought, but not tied to an ingredient — {rows.length}</h5>
      <p className="mkt-panel-hint">
        Their prices reach no dish until they are. Linking one also adds its quantity to that ingredient&apos;s stock.
      </p>
      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      <ul className="ue-price-unlinked-list">
        {rows.map((buy) => (
          <li key={buy.purchaseId}>
            <div>
              <strong>{buy.itemName}</strong>{' '}
              <span className="mkt-muted">
                {rupees(buy.unitPrice ?? buy.total ?? 0)} for {qtyText(buy.quantity)} · {shortDay(buy.date)}
                {buy.vendor ? ` · ${buy.vendor}` : ''} · {buy.purchaseId}
              </span>
              {buy.pack ? (
                <div className="ue-price-hint">
                  Says {buy.pack.packSize} {buy.pack.packUnit} — pre-filled as the pack size once it is linked
                </div>
              ) : null}
            </div>
            <div className="ue-price-link">
              {buy.candidates.map((candidate) => (
                <button
                  key={candidate.materialId}
                  type="button"
                  className="mkt-chip mkt-chip-sm"
                  disabled={busy === buy.purchaseId}
                  onClick={() => link(buy.purchaseId, candidate.materialId)}
                >
                  It&apos;s {candidate.name}
                </button>
              ))}
              <select
                aria-label={`Link ${buy.itemName} to an ingredient`}
                value={picked[buy.purchaseId] || ''}
                onChange={(event) => setPicked({ ...picked, [buy.purchaseId]: event.target.value })}
              >
                <option value="">Something else…</option>
                {byName.map((material) => (
                  <option key={material.materialId} value={material.materialId}>
                    {material.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="mkt-chip mkt-chip-sm"
                disabled={!picked[buy.purchaseId] || busy === buy.purchaseId}
                onClick={() => link(buy.purchaseId, picked[buy.purchaseId])}
              >
                Link
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PriceSheet;
