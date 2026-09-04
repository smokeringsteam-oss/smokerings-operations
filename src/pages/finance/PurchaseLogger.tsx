import { useCallback, useEffect, useMemo, useState } from 'react';
import { REPORT_START } from '../reportRange';

// Purchase Logger — what the money bought, not only who it was spent for.
//
// The gap this fills: every buy in this app has always said B2C or B2B and
// nothing else. That is who the spend was on behalf of, and it is half an
// answer. A ₹1,200 line against B2C is a print run of posters, a bag of
// charcoal, or a pork shoulder cooked on a Tuesday to trial a rub, and
// averaged into one "B2C spend" figure those three read as the same thing.
//
// So the category is a dimension INSIDE the channel, never instead of it.
// Equipment bought for the wholesale kitchen is B2B + Equipment; posters for
// the weekend counter are B2C + Marketing collateral. Every rollup on this
// screen keeps both columns for exactly that reason.
//
// WHY IT IS A FINANCE SCREEN AND NOT A SECOND OPS ONE
//
// Ops' Weekly Purchasing is a stock screen that records money on the way past:
// pick materials off the catalogue, log the buy, move the walk-in count. It is
// the right tool for the Friday butcher run and the wrong one for a print
// bill, which has no material, no stock and nothing to reorder. This screen is
// the other half — and it writes the same `purchase` table, so there is one
// ledger and Spending vs Sales picks all of it up without being told.
//
// THREE THINGS IT DOES, IN THE ORDER THEY SIT ON THE PAGE
//
//   1. Log a buy, with a category on it. Stock optional.
//   2. Show where the money went — category × channel, over a range.
//   3. Work the queue of lines with no category on them. Weekly Purchasing
//      leaves its off-catalogue lines blank on purpose (a default of "Raw
//      materials" would file the interesting spend under the boring name), and
//      everything bought before this column had a writer is blank too.
//
// Backend: server/finance/purchaseLog.js. The category list itself is served
// from server/core/expenseCategories.js rather than typed again here — two
// copies of a vocabulary is a vocabulary that drifts.
//
// Styling: the shared `.mkt-*` report language, same as Spending vs Sales.

type Category = { category: string; hint: string; movesStock?: boolean };

type Vendor = { vendor_id: string; vendor_name: string; vendor_type: string };

type Material = { material_id: string; item_name: string; category: string };

type LogRow = {
  purchase_id: string;
  purchase_date: string;
  channel: string;
  expense_category: string | null;
  client_name: string | null;
  smoking_session_id: string | null;
  material_id: string | null;
  item_name: string;
  quantity_purchased: number;
  unit_price: number | null;
  total_cost: number | null;
  notes: string | null;
  vendor_name: string | null;
};

type CategoryRollup = {
  category: string;
  spend: number;
  b2c: number;
  b2b: number;
  lines: number;
  retired: boolean;
};

type Report = {
  range: { from: string; to: string };
  rows: LogRow[];
  categories: CategoryRollup[];
  // Blank OR filed under a name that is not one of the twelve — both need
  // the same fixing, and the server builds this list ignoring the filters
  // because it is a standing chore, not a view of the current selection.
  needsFiling: {
    lines: number;
    spend: number;
    blankLines: number;
    retiredLines: number;
    rows: LogRow[];
    truncated: boolean;
  };
  totals: {
    spend: number;
    b2c: number;
    b2b: number;
    lines: number;
    uncostedLines: number;
    shownLines: number;
    shownSpend: number;
  };
};

// One row of the form. `materialId` is what makes a line move stock; it is
// blank for most of what gets logged here, because a poster has no shelf.
type FormLine = { itemName: string; quantity: string; unitPrice: string; materialId: string };

const emptyLine = (): FormLine => ({ itemName: '', quantity: '', unitPrice: '', materialId: '' });

const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (value: number) => `₹${grouped.format(Math.round(value))}`;

// An uncosted line and a free one are different facts and have to look
// different, or a category full of lines nobody has priced reads as a cheap
// one. Same rule as the server, which counts them separately.
const cost = (value: number | null) => (value == null ? '—' : money(value));

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const daysAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return iso(date);
};

const PurchaseLogger = () => {
  const today = iso(new Date());

  // ---- Reference data, fetched once ---------------------------------------
  const [categories, setCategories] = useState<Category[]>([]);
  const [channels, setChannels] = useState<string[]>(['B2C', 'B2B']);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);

  // ---- The form -----------------------------------------------------------
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [vendorName, setVendorName] = useState('');
  const [channel, setChannel] = useState('B2C');
  const [expenseCategory, setExpenseCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [formError, setFormError] = useState('');

  // ---- The report ---------------------------------------------------------
  const [from, setFrom] = useState(REPORT_START);
  const [to, setTo] = useState(today);
  const [channelFilter, setChannelFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ---- The backfill queue -------------------------------------------------
  const [picked, setPicked] = useState<string[]>([]);
  const [backfillCategory, setBackfillCategory] = useState('');
  const [backfilling, setBackfilling] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [catResp, vendorResp, materialResp] = await Promise.all([
          fetch('/api/finance/expense-categories'),
          fetch('/api/purchasing/vendors'),
          fetch('/api/purchasing/materials'),
        ]);
        const cats = await catResp.json();
        if (catResp.ok) {
          setCategories(cats.categories || []);
          if (Array.isArray(cats.channels) && cats.channels.length) setChannels(cats.channels);
        }
        const vend = await vendorResp.json();
        if (vendorResp.ok) setVendors(vend.vendors || []);
        // The material picker is a convenience, not a requirement — most of
        // what is logged here has no catalogue row — so a failure to load it
        // is left silent rather than blocking the form behind an error about
        // a dropdown nobody may open.
        const mats = await materialResp.json();
        if (materialResp.ok) setMaterials(mats.materials || []);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      if (channelFilter) params.set('channel', channelFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      const resp = await fetch(`/api/finance/purchase-log?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not read the purchase log.');
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, channelFilter, categoryFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const chosen = useMemo(
    () => categories.find((row) => row.category === expenseCategory) || null,
    [categories, expenseCategory],
  );

  const setLine = (index: number, patch: Partial<FormLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  // What the form would come to, shown live. A total that only appears after
  // saving is a total nobody can check against the bill in their hand.
  const formTotal = lines.reduce((sum, line) => {
    const quantity = line.quantity === '' ? 1 : Number(line.quantity);
    const price = Number(line.unitPrice);
    return sum + (Number.isFinite(quantity) && Number.isFinite(price) ? quantity * price : 0);
  }, 0);

  const canSubmit =
    !saving && !!vendorName && !!expenseCategory && lines.some((line) => line.itemName.trim());

  const submit = async () => {
    setSaving(true);
    setFormError('');
    setSaved('');
    try {
      const resp = await fetch('/api/finance/purchase-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorName,
          purchaseDate,
          channel,
          expenseCategory,
          notes: notes.trim() || null,
          lines: lines
            .filter((line) => line.itemName.trim())
            .map((line) => ({
              itemName: line.itemName.trim(),
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              materialId: line.materialId || '',
            })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not log that spend.');

      // Say out loud which lines moved stock and which did not. A buy that
      // lands in the ledger and not in the walk-in count looks exactly like a
      // clean save from here, and that is the one failure this screen can
      // produce that nobody would notice.
      const moved = (data.inventoryUpdated || []).length;
      const skipped = (data.inventorySkipped || []).length;
      setSaved(
        `Logged ${data.purchases.length} line${data.purchases.length === 1 ? '' : 's'} under ${expenseCategory} · ${channel}` +
          (moved ? `. ${moved} moved stock` : '') +
          (skipped ? `. ${skipped} had no catalogue material, so no stock moved — that is normal for this kind of spend` : '') +
          '.',
      );
      setLines([emptyLine()]);
      setNotes('');
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const needsFiling = report ? report.needsFiling.rows : [];

  const backfill = async () => {
    if (!picked.length || !backfillCategory) return;
    setBackfilling(true);
    setError('');
    try {
      const resp = await fetch('/api/finance/purchase-log/categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseIds: picked, expenseCategory: backfillCategory }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not set the category.');
      setPicked([]);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="mkt-roi">
      {/* A div, not a <header> — the parent dashboard already renders the dark
          hero, and a second one reads as a duplicate page title. */}
      <div className="mkt-head">
        <h3>Purchase Logger</h3>
        <p>
          Every rupee out, and what it was for. The category sits inside the channel rather than replacing it — posters
          for the weekend counter are B2C, a thermometer for the wholesale kitchen is B2B, and both are still spend
          against their own side of the book.
        </p>
      </div>

      {/* ---- Log a buy ---------------------------------------------------- */}
      <section className="mkt-panel">
        <div className="mkt-panel-head">
          <h4>Log spend</h4>
          <span className="mkt-panel-hint">Goes into the same ledger as Weekly Purchasing</span>
        </div>
        <p className="mkt-panel-hint">
          For the spend that is not a butcher run: practice cooks, posters, gas, equipment, a courier. Raw materials
          bought off the catalogue are quicker through Ops → Weekly Purchasing, which moves the stock count as it logs —
          though a line here can name a material too, and then it moves stock the same way.
        </p>

        {formError ? <div className="mkt-alert mkt-alert-error">{formError}</div> : null}
        {saved ? <div className="mkt-alert mkt-alert-ok">{saved}</div> : null}

        <div className="mkt-form">
          <label className="mkt-field">
            <span>Date</span>
            <input type="date" value={purchaseDate} max={today} onChange={(e) => setPurchaseDate(e.target.value)} />
          </label>
          <label className="mkt-field">
            <span>Vendor</span>
            <select value={vendorName} onChange={(e) => setVendorName(e.target.value)}>
              <option value="">Choose…</option>
              {vendors.map((vendor) => (
                <option key={vendor.vendor_id} value={vendor.vendor_name}>
                  {vendor.vendor_name}
                </option>
              ))}
            </select>
          </label>
          <label className="mkt-field">
            <span>Side of the business</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="mkt-field">
            <span>What it was for</span>
            <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)}>
              <option value="">Choose…</option>
              {categories.map((row) => (
                <option key={row.category} value={row.category}>
                  {row.category}
                </option>
              ))}
            </select>
          </label>
          <label className="mkt-field mkt-field-wide">
            <span>Note (optional)</span>
            <input
              type="text"
              placeholder="e.g. Diwali menu run, 50 off"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </div>

        {/* The chosen category's own explanation, from the server's list.
            Twelve categories is more than anyone holds in their head, and the
            difference between Marketing collateral and Samples is exactly the
            kind of thing that gets guessed differently twice. */}
        {chosen ? <p className="mkt-panel-hint">{chosen.hint}</p> : null}

        <div className="mkt-table-wrap">
          <table className="mkt-table">
            <thead>
              <tr>
                <th>What was bought</th>
                <th>Qty</th>
                <th>Unit price (₹)</th>
                <th>Line total</th>
                <th>Stock item (optional)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const quantity = line.quantity === '' ? 1 : Number(line.quantity);
                const price = Number(line.unitPrice);
                const lineTotal =
                  line.unitPrice !== '' && Number.isFinite(quantity) && Number.isFinite(price)
                    ? quantity * price
                    : null;
                return (
                  <tr key={index}>
                    <td>
                      <input
                        type="text"
                        placeholder="A3 posters, charcoal, thermometer…"
                        value={line.itemName}
                        onChange={(e) => setLine(index, { itemName: e.target.value })}
                      />
                    </td>
                    <td>
                      {/* Blank means one. Most of what lands here is bought as
                          a thing, not by the kilo, and typing "1" on every row
                          is friction for nothing. */}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="1"
                        value={line.quantity}
                        onChange={(e) => setLine(index, { quantity: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={line.unitPrice}
                        onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                      />
                    </td>
                    <td>{lineTotal == null ? <span className="mkt-muted">—</span> : money(lineTotal)}</td>
                    <td>
                      {/* Naming a material is what makes the line move stock.
                          Offered on every line rather than only on the two
                          categories that usually need it — a practice cook that
                          used shelf meat and a charcoal buy are both real, and
                          neither should have to change category to be counted. */}
                      <select
                        value={line.materialId}
                        onChange={(e) => setLine(index, { materialId: e.target.value })}
                      >
                        <option value="">Doesn&apos;t move stock</option>
                        {materials.map((material) => (
                          <option key={material.material_id} value={material.material_id}>
                            {material.item_name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {lines.length > 1 ? (
                        <button
                          type="button"
                          className="mkt-link-danger"
                          onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mkt-form-actions">
          <button type="button" className="mkt-chip" onClick={() => setLines((c) => [...c, emptyLine()])}>
            Add a line
          </button>
          <button type="button" className="mkt-primary" disabled={!canSubmit} onClick={submit}>
            {saving ? 'Logging…' : `Log ${formTotal ? money(formTotal) : 'spend'}`}
          </button>
          <span className="mkt-muted">
            One trip, one purpose — the category is set for the whole cart. A bill covering two purposes is two entries.
          </span>
        </div>
      </section>

      {/* ---- Where the money went ----------------------------------------- */}
      <div className="mkt-toolbar">
        <div className="mkt-range">
          <label className="mkt-range-field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="mkt-range-field">
            <span>To</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="mkt-presets">
            <button type="button" className="mkt-chip" onClick={() => { setFrom(daysAgo(29)); setTo(today); }}>
              Last 30 days
            </button>
            <button type="button" className="mkt-chip" onClick={() => { setFrom(daysAgo(89)); setTo(today); }}>
              Last 90 days
            </button>
            <button type="button" className="mkt-chip" onClick={() => { setFrom(REPORT_START); setTo(today); }}>
              Everything
            </button>
          </div>
        </div>

        <div className="mkt-tabs" role="group" aria-label="Side of the business">
          {['', ...channels].map((option) => (
            <button
              key={option || 'all'}
              type="button"
              className={`mkt-tab${channelFilter === option ? ' is-active' : ''}`}
              onClick={() => setChannelFilter(option)}
              aria-pressed={channelFilter === option}
            >
              {option || 'Both sides'}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {loading && !report ? <div className="mkt-alert">Reading the log…</div> : null}

      {report ? (
        <>
          <div className="mkt-tiles">
            <Tile label="Spend in range" value={money(report.totals.spend)} sub={`${report.totals.lines} lines`} />
            <Tile label="B2C" value={money(report.totals.b2c)} />
            <Tile label="B2B" value={money(report.totals.b2b)} />
            <Tile
              label="Not filed yet"
              value={money(report.needsFiling.spend)}
              sub={`${report.needsFiling.lines} lines to file`}
              tone={report.needsFiling.lines ? 'bad' : undefined}
            />
            {report.totals.uncostedLines ? (
              <Tile
                label="Not priced yet"
                value={String(report.totals.uncostedLines)}
                sub="Logged before the bill — counted as lines, not as money"
              />
            ) : null}
          </div>

          <section className="mkt-panel">
            <div className="mkt-panel-head">
              <h4>Where the money went</h4>
              <span className="mkt-panel-hint">Always over the whole range, whatever the filter shows</span>
            </div>
            <p className="mkt-panel-hint">
              Both columns on every row on purpose: the category says what the money bought, the split says which side of
              the business bought it. A category that only ever appears on one side still shows the other as zero, so two
              rows in this table always mean the same thing.
            </p>
            {report.categories.length ? (
              <div className="mkt-table-wrap">
                <table className="mkt-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Spend</th>
                      <th>B2C</th>
                      <th>B2B</th>
                      <th>Lines</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.categories.map((row) => (
                      <tr
                        key={row.category}
                        className={categoryFilter === row.category ? 'is-active' : undefined}
                        onClick={() => setCategoryFilter(categoryFilter === row.category ? '' : row.category)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          {row.category}
                          {/* A category retired from the list after rows were
                              written under it. The money was still spent, so
                              the row stays — labelled, not dropped. */}
                          {row.retired ? <span className="mkt-tag">no longer on the list</span> : null}
                        </td>
                        <td>{money(row.spend)}</td>
                        <td>{money(row.b2c)}</td>
                        <td>{money(row.b2b)}</td>
                        <td>{row.lines}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mkt-panel-hint">Nothing categorised in this range yet.</p>
            )}
            {categoryFilter ? (
              <p className="mkt-panel-hint">
                Showing {categoryFilter} only —{' '}
                <button type="button" className="mkt-chip" onClick={() => setCategoryFilter('')}>
                  clear
                </button>
              </p>
            ) : null}
          </section>

          {/* ---- The backfill queue ---------------------------------------- */}
          {needsFiling.length ? (
            <section className="mkt-panel">
              <div className="mkt-panel-head">
                <h4>Needs a category</h4>
                <span className="mkt-panel-hint">
                  {report.needsFiling.lines} lines
                  {report.needsFiling.truncated ? ` · showing the first ${needsFiling.length}` : ''}
                </span>
              </div>
              <p className="mkt-panel-hint">
                Two kinds of row end up here. Weekly Purchasing leaves an off-catalogue line blank rather than guessing
                at it — which is where the gas refills, the ice and the butcher paper live — and anything filed under a
                name that is no longer on the list (the CSV-era categories) is waiting to be moved onto it. This list
                ignores the filters above on purpose: it is a standing chore, not a view of what is selected. Tick what
                belongs together and file it in one go.
              </p>
              <div className="mkt-table-wrap">
                <table className="mkt-table">
                  <thead>
                    <tr>
                      <th />
                      <th>Date</th>
                      <th>Item</th>
                      <th>Filed as</th>
                      <th>Vendor</th>
                      <th>Side</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needsFiling.map((row) => (
                      <tr key={row.purchase_id}>
                        <td>
                          <input
                            type="checkbox"
                            className="mkt-checkbox"
                            checked={picked.includes(row.purchase_id)}
                            onChange={(e) =>
                              setPicked((current) =>
                                e.target.checked
                                  ? [...current, row.purchase_id]
                                  : current.filter((id) => id !== row.purchase_id),
                              )
                            }
                          />
                        </td>
                        <td>{row.purchase_date}</td>
                        <td>{row.item_name}</td>
                        {/* Why this row is on the list: nothing at all, or an
                            old name that no longer means anything to the
                            rollups. Both are here, so both have to say which
                            they are. */}
                        <td>
                          {row.expense_category ? (
                            <span className="mkt-tag">{row.expense_category}</span>
                          ) : (
                            <span className="mkt-muted">nothing</span>
                          )}
                        </td>
                        <td>{row.vendor_name || '—'}</td>
                        <td>{row.channel}</td>
                        <td>{cost(row.total_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mkt-form-actions">
                <button
                  type="button"
                  className="mkt-chip"
                  onClick={() =>
                    setPicked(
                      picked.length === needsFiling.length
                        ? []
                        : needsFiling.map((row) => row.purchase_id),
                    )
                  }
                >
                  {picked.length === needsFiling.length ? 'Clear selection' : 'Select all'}
                </button>
                <select value={backfillCategory} onChange={(e) => setBackfillCategory(e.target.value)}>
                  <option value="">File as…</option>
                  {categories.map((row) => (
                    <option key={row.category} value={row.category}>
                      {row.category}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="mkt-primary"
                  disabled={backfilling || !picked.length || !backfillCategory}
                  onClick={backfill}
                >
                  {backfilling ? 'Filing…' : `File ${picked.length || ''} ${picked.length === 1 ? 'line' : 'lines'}`}
                </button>
              </div>
            </section>
          ) : null}

          {/* ---- The log itself -------------------------------------------- */}
          <section className="mkt-panel">
            <div className="mkt-panel-head">
              <h4>The log</h4>
              <span className="mkt-panel-hint">
                {report.totals.shownLines} of {report.totals.lines} lines · {money(report.totals.shownSpend)}
              </span>
            </div>
            {report.rows.length ? (
              <div className="mkt-table-wrap">
                <table className="mkt-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Item</th>
                      <th>Category</th>
                      <th>Side</th>
                      <th>Vendor</th>
                      <th>Qty</th>
                      <th>Cost</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.purchase_id} className={row.expense_category ? undefined : 'mkt-row-unattributed'}>
                        <td>{row.purchase_date}</td>
                        <td>{row.item_name}</td>
                        <td>{row.expense_category || <span className="mkt-muted">not filed</span>}</td>
                        <td>
                          {row.channel}
                          {row.client_name ? <span className="mkt-tag">{row.client_name}</span> : null}
                        </td>
                        <td>{row.vendor_name || '—'}</td>
                        <td>{row.quantity_purchased}</td>
                        <td>{cost(row.total_cost)}</td>
                        <td className="mkt-muted">{row.notes || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mkt-panel-hint">Nothing matches those filters.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
};

const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) => (
  <div className="mkt-tile">
    <span className="mkt-tile-label">{label}</span>
    <span className={`mkt-tile-value${tone ? ` is-${tone}` : ''}`}>{value}</span>
    {sub ? <span className="mkt-tile-sub">{sub}</span> : null}
  </div>
);

export default PurchaseLogger;
