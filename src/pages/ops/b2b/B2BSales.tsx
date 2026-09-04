import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { REPORT_START } from '../../reportRange';

// B2B Sales & Payments — how much wholesale business happened, and how much of
// it has actually been paid for.
//
// Two questions on one screen, deliberately kept apart because they are
// answered over different spans of time. The revenue row across the top is
// scoped to the date range: what was delivered in this window, per account and
// per month. The receivables row underneath is not scoped to anything — an
// invoice is owed until it is paid, and a total that quietly dropped June's
// unpaid delivery because the range starts in July would be the one number on
// this page nobody could trust.
//
// The default payment cycle is 15 days from delivery, set per account on the
// Clients tab. A row goes amber three days out and red the day after its due
// date, so the list doubles as the morning chase sheet: overdue first, longest
// overdue at the top, settled invoices at the bottom.
//
// A sale is logged one of two ways. Itemised — a line per product, picked
// from Odoo's own catalogue with the rate this client last paid pre-filled —
// which can then be raised as a posted invoice in Odoo and its PDF pulled
// back here. Or as a lump sum, one figure, for a delivery already billed
// somewhere else. The lump-sum path stays because it is the one that still
// works when Odoo is down and the food has already gone out.
//
// Backend is server/ops/b2b/b2bSales.js.

type SaleLine = {
  id: string;
  position: number;
  productId: number | null;
  description: string;
  unitLabel: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

// One row of Odoo's sellable catalogue, priced for the client on the form.
//
// `price` is what the rate box starts at and `priceSource` says where it came
// from — 'pricelist' when a rule on the account's Odoo pricelist decided it,
// 'list' when no rule covered the product, 'unsupported' when a rule matched
// but the server would not pretend to evaluate it. That distinction is shown
// rather than hidden: a rate nobody chose should not look like one somebody
// did.
type CatalogueProduct = {
  id: number;
  name: string;
  code: string;
  unit: string;
  listPrice: number;
  price: number;
  priceSource: 'pricelist' | 'list' | 'unsupported';
  lastChargedPrice: number | null;
  lastChargedOn: string;
};

type Catalogue = {
  products: CatalogueProduct[];
  pricelists: { id: number; name: string; currency: string }[];
  pricelistId: number | null;
  pricelistName: string;
  odooError?: string;
  error?: string;
};

type Sale = {
  id: string;
  clientId: string;
  clientName: string;
  clientStage: string;
  deliveredOn: string;
  amount: number;
  amountPaid: number;
  outstanding: number;
  paymentDueOn: string;
  paidOn: string;
  status: string;
  daysToDue: number;
  daysOverdue: number;
  partPaid: boolean;
  termsDays: number;
  lines: SaleLine[];
  invoiceNumber: string;
  orderRef: string;
  notes: string;
  odooInvoiceId: number | null;
  odooInvoiceState: string;
  hasInvoice: boolean;
  odooError: string;
};

// A line being edited. Numbers are strings while they are being typed, so a
// half-typed "1." or "12." doesn't get coerced under the cursor.
type LineDraft = {
  productId: string;
  description: string;
  unitLabel: string;
  quantity: string;
  unitPrice: string;
};

type Status = { key: string; label: string; description: string };
type SaleClient = { id: string; name: string; stage: string; paymentTermsDays: number; paymentTerms: string };

type SalesResponse = {
  sales: Sale[];
  range: { from: string; to: string; days: number };
  summary: {
    revenue: number;
    collected: number;
    orders: number;
    averageSale: number;
    byClient: { clientId: string; clientName: string; stage: string; orders: number; revenue: number; collected: number; outstanding: number }[];
    byMonth: { month: string; revenue: number }[];
  };
  receivables: {
    outstanding: number;
    invoices: number;
    overdue: number;
    overdueInvoices: number;
    dueSoon: number;
    dueSoonInvoices: number;
    oldestOverdueDays: number;
    byClient: { clientId: string; clientName: string; outstanding: number; overdue: number; invoices: number; oldestDueOn: string }[];
  };
  statuses: Status[];
  clients: SaleClient[];
  defaultTermsDays: number;
  error?: string;
};

async function readJson<T extends { error?: string }>(resp: Response, fallbackMessage: string): Promise<T> {
  let json: T;
  try {
    json = (await resp.json()) as T;
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
  if (!resp.ok) throw new Error(json.error || fallbackMessage);
  return json;
}

// Indian digit grouping (₹1,20,000, not ₹120,000) — this is a rupee book and
// the lakh grouping is what everyone reading it counts in.
const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;

const formatDate = (value: string) => {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const formatMonth = (value: string) => {
  const [y, m] = value.split('-').map(Number);
  if (!y || !m) return value;
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
};

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const today = () => isoDate(new Date());
const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDate(d);
};
const monthStart = () => {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
};

// The ranges worth one click. "This month" is the one the revenue question is
// usually asked in; the rest are for looking back without typing dates.
const PRESETS: { key: string; label: string; from: () => string }[] = [
  { key: 'month', label: 'This month', from: monthStart },
  { key: '30', label: 'Last 30 days', from: () => daysAgo(30) },
  { key: '90', label: 'Last 90 days', from: () => daysAgo(90) },
  { key: '365', label: 'Last year', from: () => daysAgo(365) },
];

const blankLine = (): LineDraft => ({ productId: '', description: '', unitLabel: '', quantity: '1', unitPrice: '' });

const draftTotal = (line: LineDraft) => {
  const qty = Number(line.quantity);
  const rate = Number(line.unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) return 0;
  // The same rounding the store does, so the total on screen is the one that
  // gets saved rather than a near miss. Three decimals on the weight and two
  // on the money, for the reason round3 gives in server/ops/b2b/b2bSales.js:
  // 0.364 kg is 364 g of meat and rounding it to 0.36 gives 4 g away.
  return Math.round((Math.round(qty * 1000) / 1000) * (Math.round(rate * 100) / 100) * 100) / 100;
};

const draftsTotal = (lines: LineDraft[]) => Math.round(lines.reduce((sum, l) => sum + draftTotal(l), 0) * 100) / 100;

// Rows that would survive the store's own filter — a line needs a
// description and a total to be worth sending.
const usableLines = (lines: LineDraft[]) => lines.filter((l) => l.description.trim() && draftTotal(l) > 0);

// A row somebody started filling in: it has a product picked or something
// typed in the description. A blank trailing row is not one of these, which
// is the point — the editor always leaves one and it should stay ignorable.
const startedLines = (lines: LineDraft[]) => lines.filter((l) => l.productId || l.description.trim());

// Started rows that would nonetheless be dropped on the way out, because
// their quantity or rate doesn't make a billable total. usableLines filters
// these silently, which is right for the blank trailing row and wrong for a
// line somebody meant to charge for, so they get named instead.
const unbillableLines = (lines: LineDraft[]) => startedLines(lines).filter((l) => draftTotal(l) <= 0);

// What the invoice will be, which is not what the delivery sheet is: the
// sheet keeps a row per weighing, the invoice carries one line per product
// and rate. This mirrors consolidateLines in server/ops/b2b/b2bSales.js —
// that function decides the grouping, this only counts it, so the roll-up can
// be seen before the button that posts it is pressed.
const invoiceLineCount = (lines: SaleLine[]) =>
  new Set(
    lines.map((l) => {
      const key = l.productId ?? `t:${l.description.trim().toLowerCase().replace(/\s+/g, ' ')}`;
      return `${key}@${Math.round(l.unitPrice * 100) / 100}`;
    }),
  ).size;

// What a row says about itself in one word, next to how late it is.
const statusNote = (sale: Sale) => {
  if (sale.status === 'paid') return `Paid ${formatDate(sale.paidOn)}`;
  if (sale.status === 'overdue') return `${sale.daysOverdue} day${sale.daysOverdue === 1 ? '' : 's'} late`;
  if (sale.daysToDue === 0) return 'Due today';
  return `Due in ${sale.daysToDue} day${sale.daysToDue === 1 ? '' : 's'}`;
};

const B2BSales: React.FC = () => {
  const [data, setData] = useState<SalesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  // Which row's write is in flight — one at a time per row, so a slow save
  // can't be raced by a second click on the same invoice.
  const [savingId, setSavingId] = useState<string | null>(null);

  const [from, setFrom] = useState(REPORT_START);
  const [to, setTo] = useState(today);
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState({
    clientId: '',
    deliveredOn: today(),
    amount: '',
    invoiceNumber: '',
    orderRef: '',
    notes: '',
  });

  // Itemised by default: it is the mode that can produce an invoice, and the
  // lump sum is the exception for a delivery billed elsewhere.
  const [itemised, setItemised] = useState(true);
  const [draftLines, setDraftLines] = useState<LineDraft[]>([blankLine()]);
  const [catalogue, setCatalogue] = useState<CatalogueProduct[]>([]);
  const [catalogueNote, setCatalogueNote] = useState('');
  // Which Odoo pricelist the rates on screen came from, so the form can name
  // it — and say plainly when the account has none attached, which is the
  // difference between "these are your agreed rates" and "these are retail".
  const [pricelistName, setPricelistName] = useState('');
  const [pricelists, setPricelists] = useState<{ id: number; name: string }[]>([]);
  // What the picker in the banner is set to, and whether an attach is in
  // flight. Bumping `catalogueNonce` re-reads the catalogue — attaching a
  // pricelist changes every rate on screen, so the lines have to be re-priced
  // rather than left showing list prices under a banner that now says
  // otherwise.
  const [pricelistPick, setPricelistPick] = useState('');
  const [isAttaching, setIsAttaching] = useState(false);
  const [catalogueNonce, setCatalogueNonce] = useState(0);

  // Which sale is being sent to Odoo. Separate from savingId because it is
  // the one action that can take several seconds and must not be clickable
  // twice — the second click would be a second invoice.
  const [invoicingId, setInvoicingId] = useState<string | null>(null);

  // Which invoice's payment box is open, and what has been typed into it.
  // Seeded from the row on open, so closing it discards the edit.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payment, setPayment] = useState({ amountPaid: '', paidOn: '' });

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      if (clientFilter) params.set('clientId', clientFilter);
      if (statusFilter) params.set('status', statusFilter);
      const resp = await fetch(`/api/b2b/sales?${params}`);
      setData(await readJson<SalesResponse>(resp, 'Could not load the B2B sales book.'));
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, [from, to, clientFilter, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // The catalogue is re-fetched whenever the form's client changes, because
  // the rates on it are that client's. Only while the form is open: it is an
  // Odoo round trip, and nobody needs it to look at the list.
  useEffect(() => {
    if (!showForm || !itemised) return;
    let cancelled = false;
    (async () => {
      try {
        const params = form.clientId ? `?clientId=${encodeURIComponent(form.clientId)}` : '';
        const resp = await fetch(`/api/b2b/sales/catalogue${params}`);
        const json = await readJson<Catalogue>(resp, 'Could not load the Odoo product list.');
        if (cancelled) return;
        setCatalogue(json.products || []);
        setPricelistName(json.pricelistName || '');
        setPricelists(json.pricelists || []);
        // Odoo being unreachable is not fatal here — the lines can still be
        // typed by hand and the sale logged. Say so rather than failing.
        setCatalogueNote(
          json.odooError ? `Odoo product list unavailable (${json.odooError}). Type the lines by hand.` : '',
        );
      } catch (err) {
        if (!cancelled) {
          setCatalogue([]);
          setPricelistName('');
          setCatalogueNote(String((err as Error).message || err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showForm, itemised, form.clientId, catalogueNonce]);

  // Preselect the pricelist whose name looks like this client's — "Jango"
  // against "Jango — B2B Wholesale". A suggestion, not an assumption: it fills
  // the picker, and attaching is still a deliberate click, because pricing an
  // invoice off the wrong account's rates is not a mistake worth risking to
  // save one.
  useEffect(() => {
    if (pricelistName || !form.clientId || !pricelists.length) {
      setPricelistPick('');
      return;
    }
    const name = (clients.find((c) => c.id === form.clientId)?.name || '').trim().toLowerCase();
    const match =
      name && pricelists.find((p) => p.name.toLowerCase().includes(name));
    setPricelistPick(match ? String(match.id) : '');
    // `clients` is derived from `data` each render, so it is deliberately not
    // a dependency — the client's name is what matters and that is keyed off
    // form.clientId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.clientId, pricelists, pricelistName]);

  // Every write re-reads the whole page afterwards: a payment moves the
  // receivables tiles and the row's own position in the list, and a stale
  // total on a money screen is worse than a slow one.
  const post = async (url: string, body: unknown, id: string) => {
    setSavingId(id);
    setSaveError('');
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await readJson<{ error?: string }>(resp, 'Could not save that change.');
      await load();
      return true;
    } catch (err) {
      setSaveError(String((err as Error).message || err));
      return false;
    } finally {
      setSavingId(null);
    }
  };

  // The browser refuses to submit a form holding a number it considers
  // invalid, and shows its bubble on the first offending input only — which,
  // eleven rows down a scrolling editor, is a submit that appears to do
  // nothing at all. `invalid` is non-delegated in React, so this fires from
  // the input itself and puts the browser's own message in the page banner
  // where it cannot be missed.
  const reportInvalid = (event: React.FormEvent<HTMLInputElement>, what: string) => {
    const input = event.currentTarget;
    setSaveError(`${what}: ${input.validationMessage || `"${input.value}" is not a valid number.`}`);
  };

  const createSale = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError('');

    // Lines that would be thrown away on the way out, named rather than
    // dropped. Checked before anything is sent, because the store never sees
    // these rows and so cannot complain about them.
    if (itemised) {
      const unbillable = unbillableLines(draftLines);
      if (unbillable.length) {
        setSaveError(
          `${unbillable.length} line${unbillable.length === 1 ? '' : 's'} ` +
            `${unbillable.length === 1 ? 'has' : 'have'} no quantity or no rate and would not be billed — ` +
            `${unbillable.map((l) => l.description.trim() || 'an unnamed line').join(', ')}. ` +
            'Fill them in or remove them.',
        );
        return;
      }
    }

    setIsCreating(true);
    try {
      const resp = await fetch('/api/b2b/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          // Sent only in itemised mode — the store takes the lines' total as
          // the amount whenever any are present, so passing an empty array in
          // lump-sum mode would be harmless but sending nothing is clearer.
          lines: itemised
            ? usableLines(draftLines).map((line) => ({
                productId: line.productId ? Number(line.productId) : null,
                description: line.description.trim(),
                unitLabel: line.unitLabel,
                quantity: Number(line.quantity),
                unitPrice: Number(line.unitPrice),
              }))
            : undefined,
        }),
      });
      await readJson<{ error?: string }>(resp, 'Could not log that sale.');
      setForm({ clientId: form.clientId, deliveredOn: today(), amount: '', invoiceNumber: '', orderRef: '', notes: '' });
      setDraftLines([blankLine()]);
      setShowForm(false);
      await load();
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setIsCreating(false);
    }
  };

  const openPayment = (sale: Sale) => {
    if (payingId === sale.id) {
      setPayingId(null);
      return;
    }
    setSaveError('');
    setPayingId(sale.id);
    // Pre-filled with the full amount, because settling in full is what
    // happens nearly every time; a part payment is a correction of this.
    setPayment({ amountPaid: String(sale.amount), paidOn: today() });
  };

  const submitPayment = async (sale: Sale) => {
    const ok = await post('/api/b2b/sales/payment', { id: sale.id, ...payment }, sale.id);
    if (ok) setPayingId(null);
  };

  const removeSale = async (sale: Sale) => {
    if (!window.confirm(`Delete the ${rupees(sale.amount)} sale to ${sale.clientName} on ${formatDate(sale.deliveredOn)}?`)) {
      return;
    }
    setSavingId(sale.id);
    setSaveError('');
    try {
      const resp = await fetch(`/api/b2b/sales/${sale.id}`, { method: 'DELETE' });
      await readJson<{ error?: string }>(resp, 'Could not delete that sale.');
      await load();
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setSavingId(null);
    }
  };

  // Attaches the chosen pricelist to the account and re-prices the form.
  // Writes through the Clients endpoint rather than one of its own: it is the
  // same field the Clients tab edits, and having two ways to set it that
  // could drift apart would be worse than the small detour.
  const attachPricelist = async () => {
    const picked = pricelists.find((p) => String(p.id) === pricelistPick);
    if (!picked) return;
    setIsAttaching(true);
    setSaveError('');
    try {
      const resp = await fetch('/api/b2b/clients/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: form.clientId, odooPricelistId: picked.id, odooPricelistName: picked.name }),
      });
      await readJson<{ error?: string }>(resp, 'Could not attach that pricelist.');
      // Re-read the catalogue so the rates on screen become the ones this
      // pricelist gives, and clear any rate already typed from a list price.
      setCatalogueNonce((n) => n + 1);
      setDraftLines((lines) => lines.map((line) => (line.productId ? { ...line, unitPrice: '' } : line)));
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setIsAttaching(false);
    }
  };

  // Picking a product fills the description, unit and rate in one go. The
  // description is still editable afterwards — "Pulled Pork (Bulk 1kg)" is
  // often worth qualifying with what the delivery actually was.
  const pickProduct = (index: number, productId: string) => {
    const product = catalogue.find((p) => String(p.id) === productId);
    setDraftLines((lines) =>
      lines.map((line, i) =>
        i !== index
          ? line
          : {
              ...line,
              productId,
              description: product ? product.name : line.description,
              unitLabel: product ? product.unit : '',
              unitPrice: product ? String(product.price) : line.unitPrice,
            },
      ),
    );
  };

  const editLine = (index: number, patch: Partial<LineDraft>) =>
    setDraftLines((lines) => lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const removeLine = (index: number) =>
    // Never down to nothing: an empty editor with no row is a dead end.
    setDraftLines((lines) => (lines.length === 1 ? [blankLine()] : lines.filter((_, i) => i !== index)));

  // Creates AND posts the invoice in Odoo. Confirmed first because it is the
  // one action here that writes to the accounts and cannot be undone from
  // this screen — Odoo's answer to a wrong posted invoice is a credit note.
  const sendToOdoo = async (sale: Sale) => {
    const rolled = invoiceLineCount(sale.lines);
    if (
      !window.confirm(
        `Raise and post an invoice in Odoo for ${sale.clientName}, ${rupees(sale.amount)}, due ${formatDate(sale.paymentDueOn)}?\n\n` +
          (rolled < sale.lines.length
            ? `The ${sale.lines.length} delivery lines go on it as ${rolled}, one per product and rate. This screen keeps all ${sale.lines.length}.\n\n`
            : '') +
          'This posts it to your accounts. Undoing it means a credit note in Odoo.',
      )
    ) {
      return;
    }
    setInvoicingId(sale.id);
    setSaveError('');
    try {
      const resp = await fetch('/api/b2b/sales/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sale.id }),
      });
      await readJson<{ error?: string }>(resp, 'Could not raise the invoice in Odoo.');
      await load();
    } catch (err) {
      setSaveError(String((err as Error).message || err));
      // Reload anyway: the store records the failure against the row, and
      // that is worth showing.
      await load();
    } finally {
      setInvoicingId(null);
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setFrom(preset.from());
    setTo(today());
  };

  const sales = data?.sales || [];
  const summary = data?.summary;
  const receivables = data?.receivables;
  const clients = data?.clients || [];
  const termsForForm = clients.find((c) => c.id === form.clientId)?.paymentTermsDays ?? data?.defaultTermsDays ?? 15;

  // The tallest month's bar is full height and every other is drawn against
  // it — the shape of the trend is the point, not the pixel values.
  const monthPeak = useMemo(
    () => Math.max(1, ...(summary?.byMonth || []).map((m) => m.revenue)),
    [summary],
  );

  if (isLoading && !data) return <p className="status-message">Loading the B2B sales book…</p>;
  if (error) return <p className="status-message error">{error}</p>;

  return (
    <div className="b2b-clients b2b-sales">
      <section className="b2b-summary">
        <div className="b2b-summary-tiles">
          <div className="b2b-stat">
            <span className="b2b-stat-label">Sales</span>
            <span className="b2b-stat-value">{rupees(summary?.revenue || 0)}</span>
            <span className="b2b-stat-sub">
              {summary?.orders || 0} deliver{summary?.orders === 1 ? 'y' : 'ies'} in this range
            </span>
          </div>
          <div className="b2b-stat">
            <span className="b2b-stat-label">Collected</span>
            <span className="b2b-stat-value">{rupees(summary?.collected || 0)}</span>
            <span className="b2b-stat-sub">of the sales above</span>
          </div>
          {/* The receivables tiles are all-time on purpose — see the note at
              the top of this file — so they say so rather than looking like
              they belong to the range beside them. */}
          <div className={`b2b-stat${(receivables?.outstanding || 0) > 0 ? ' is-owed' : ''}`}>
            <span className="b2b-stat-label">Outstanding</span>
            <span className="b2b-stat-value">{rupees(receivables?.outstanding || 0)}</span>
            <span className="b2b-stat-sub">{receivables?.invoices || 0} unpaid invoices, all time</span>
          </div>
          <div className={`b2b-stat${(receivables?.overdue || 0) > 0 ? ' is-overdue' : ''}`}>
            <span className="b2b-stat-label">Overdue</span>
            <span className="b2b-stat-value">{rupees(receivables?.overdue || 0)}</span>
            <span className="b2b-stat-sub">
              {receivables?.overdueInvoices || 0} past due
              {receivables?.oldestOverdueDays ? `, oldest ${receivables.oldestOverdueDays} days` : ''}
            </span>
          </div>
          <div className="b2b-stat">
            <span className="b2b-stat-label">Average sale</span>
            <span className="b2b-stat-value">{rupees(summary?.averageSale || 0)}</span>
            <span className="b2b-stat-sub">per delivery in this range</span>
          </div>
        </div>

        {(summary?.byMonth.length || 0) > 1 && (
          <div className="b2b-demand-roll">
            <span className="b2b-demand-roll-title">Sales by month</span>
            <div className="b2b-month-bars">
              {summary?.byMonth.map((m) => (
                <div className="b2b-month-bar" key={m.month} title={`${formatMonth(m.month)}: ${rupees(m.revenue)}`}>
                  <span className="b2b-month-bar-value">{rupees(m.revenue)}</span>
                  <span className="b2b-month-bar-fill" style={{ height: `${Math.round((m.revenue / monthPeak) * 100)}%` }} />
                  <span className="b2b-month-bar-label">{formatMonth(m.month)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(summary?.byClient.length || 0) > 0 && (
          <div className="b2b-demand-roll">
            <span className="b2b-demand-roll-title">Who it came from</span>
            <div className="b2b-demand-roll-grid">
              {summary?.byClient.map((c) => (
                <button
                  type="button"
                  className={`b2b-demand-tile b2b-client-tile${clientFilter === c.clientId ? ' is-active' : ''}`}
                  key={c.clientId}
                  onClick={() => setClientFilter(clientFilter === c.clientId ? '' : c.clientId)}
                >
                  <span className="b2b-demand-tile-name">{c.clientName}</span>
                  <span className="b2b-demand-tile-value">{rupees(c.revenue)}</span>
                  <span className="b2b-demand-tile-sub">
                    {c.orders} deliver{c.orders === 1 ? 'y' : 'ies'}
                  </span>
                  {c.outstanding > 0 && (
                    <span className="b2b-demand-tile-sub is-owed">{rupees(c.outstanding)} still owed</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="b2b-toolbar">
        <div className="b2b-stage-filters">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className="b2b-chip" onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
          <label className="b2b-range-field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="b2b-range-field">
            <span>To</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="b2b-toolbar-right">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="b2b-search">
            <option value="">All payment statuses</option>
            {(data?.statuses || []).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="b2b-search">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="primary-button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ Log a sale'}
          </button>
        </div>
      </div>

      {saveError && <p className="status-message error">{saveError}</p>}

      {showForm && (
        <form className="b2b-add-form" onSubmit={createSale}>
          <div className="b2b-form-row">
            <label className="b2b-field">
              <span>Client *</span>
              <select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
                <option value="">Pick an account…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="b2b-field">
              <span>Delivered on *</span>
              <input
                type="date"
                value={form.deliveredOn}
                onChange={(e) => setForm({ ...form, deliveredOn: e.target.value })}
                required
              />
            </label>
            {!itemised && (
              <label className="b2b-field">
                <span>Amount (₹) *</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  onInvalid={(e) => reportInvalid(e, 'Amount')}
                  required
                />
              </label>
            )}
          </div>

          <div className="b2b-mode-switch">
            <button
              type="button"
              className={`b2b-chip${itemised ? ' is-active' : ''}`}
              onClick={() => setItemised(true)}
            >
              Itemised invoice
            </button>
            <button
              type="button"
              className={`b2b-chip${itemised ? '' : ' is-active'}`}
              onClick={() => setItemised(false)}
            >
              Lump sum
            </button>
            <span className="b2b-form-hint">
              {itemised
                ? 'A line per product. Only an itemised sale can be raised as an invoice in Odoo.'
                : 'One figure, no breakdown — for a delivery already billed somewhere else.'}
            </span>
          </div>

          {itemised && (
            <div className="b2b-line-editor">
              {catalogueNote && <p className="status-message error">{catalogueNote}</p>}
              {form.clientId && !catalogueNote && (
                <p className="b2b-pricelist-banner">
                  {pricelistName ? (
                    <>
                      Rates from <strong>{pricelistName}</strong> in Odoo.
                    </>
                  ) : (
                    <>
                      <span>
                        No Odoo pricelist on this account, so the rates below are Odoo&rsquo;s list prices, not
                        {' '}
                        {clients.find((c) => c.id === form.clientId)?.name || 'this client'}&rsquo;s agreed ones.
                      </span>
                      {pricelists.length > 0 && (
                        <span className="b2b-pricelist-attach">
                          <select value={pricelistPick} onChange={(e) => setPricelistPick(e.target.value)}>
                            <option value="">Pick a pricelist…</option>
                            {pricelists.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="b2b-chip"
                            disabled={!pricelistPick || isAttaching}
                            onClick={attachPricelist}
                          >
                            {isAttaching ? 'Attaching…' : 'Attach to this account'}
                          </button>
                        </span>
                      )}
                    </>
                  )}
                </p>
              )}
              <div className="b2b-line-head">
                <span>Item</span>
                <span>Description</span>
                <span>Qty</span>
                <span>Rate (₹)</span>
                <span>Total</span>
                <span />
              </div>

              {draftLines.map((line, index) => {
                const product = catalogue.find((p) => String(p.id) === line.productId);
                return (
                  <div className="b2b-line-row" key={index}>
                    <select value={line.productId} onChange={(e) => pickProduct(index, e.target.value)}>
                      <option value="">Free text…</option>
                      {catalogue.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={line.description}
                      placeholder="What was delivered"
                      onChange={(e) => editLine(index, { description: e.target.value })}
                    />
                    <span className="b2b-line-qty">
                      {/* Grams, not tens of grams. A 0.01 step rejects the
                          0.364 kg that came off the scale, and the sale is
                          weighed to the gram. */}
                      <input
                        type="number"
                        min={0}
                        step="0.001"
                        value={line.quantity}
                        onChange={(e) => editLine(index, { quantity: e.target.value })}
                        onInvalid={(e) => reportInvalid(e, `Quantity on line ${index + 1}`)}
                      />
                      {line.unitLabel && <em>{line.unitLabel}</em>}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(e) => editLine(index, { unitPrice: e.target.value })}
                      onInvalid={(e) => reportInvalid(e, `Rate on line ${index + 1}`)}
                    />
                    <span className="b2b-line-total">{rupees(draftTotal(line))}</span>
                    <button type="button" className="b2b-line-remove" onClick={() => removeLine(index)} title="Remove line">
                      ×
                    </button>
                    {/* Where the rate came from, so a pre-filled number is
                        never mistaken for one somebody chose. */}
                    {product && (
                      <span className={`b2b-line-note${product.priceSource === 'pricelist' ? '' : ' is-warn'}`}>
                        {product.priceSource === 'pricelist' &&
                          `Pricelist rate ${rupees(product.price)}${
                            product.listPrice !== product.price ? ` (list ${rupees(product.listPrice)})` : ''
                          }`}
                        {product.priceSource === 'list' && `No pricelist rule — Odoo list price ${rupees(product.listPrice)}`}
                        {product.priceSource === 'unsupported' &&
                          `A pricelist rule covers this but could not be read here — check the rate against Odoo. List ${rupees(product.listPrice)}`}
                        {/* The second opinion: what this client was actually
                            billed last time. Shown when it differs, because
                            that gap is either a rate that moved or a
                            pricelist that is wrong. */}
                        {product.lastChargedPrice !== null && product.lastChargedPrice !== product.price && (
                          <em>
                            {' '}
                            · last charged {rupees(product.lastChargedPrice)} on {formatDate(product.lastChargedOn)}
                          </em>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}

              <div className="b2b-line-foot">
                <button type="button" className="b2b-chip" onClick={() => setDraftLines((l) => [...l, blankLine()])}>
                  + Add line
                </button>
                <span className="b2b-line-grand">Invoice total {rupees(draftsTotal(draftLines))}</span>
              </div>
            </div>
          )}
          <div className="b2b-form-row">
            <label className="b2b-field">
              <span>Invoice no.</span>
              <input value={form.invoiceNumber} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} />
            </label>
            <label className="b2b-field">
              <span>Order ref</span>
              <input
                value={form.orderRef}
                onChange={(e) => setForm({ ...form, orderRef: e.target.value })}
                placeholder="Odoo SO number, PO number…"
              />
            </label>
            <label className="b2b-field">
              <span>Notes</span>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
          </div>
          <div className="b2b-form-actions">
            <span className="b2b-form-hint">
              Payment will be due {termsForForm} days after delivery
              {form.clientId ? '' : ' on the house cycle'} — change an account&rsquo;s cycle on the Clients tab.
            </span>
            {/* Disabled only when there is genuinely nothing to save. A row
                that has been started but has no rate on it used to disable
                this too, which left the form refusing to submit and saying
                nothing about why; createSale now names those rows instead. */}
            <button
              type="submit"
              className="primary-button"
              disabled={isCreating || (itemised && startedLines(draftLines).length === 0)}
            >
              {isCreating ? 'Saving…' : 'Log the sale'}
            </button>
          </div>
        </form>
      )}

      {(receivables?.byClient.length || 0) > 0 && (
        <section className="b2b-panel b2b-chase">
          <h4>Who owes what</h4>
          <div className="b2b-chase-list">
            {receivables?.byClient.map((c) => (
              <div className={`b2b-chase-row${c.overdue > 0 ? ' is-overdue' : ''}`} key={c.clientId}>
                <span className="b2b-chase-name">{c.clientName}</span>
                <span className="b2b-chase-amount">{rupees(c.outstanding)}</span>
                <span className="b2b-chase-note">
                  {c.invoices} invoice{c.invoices === 1 ? '' : 's'}
                  {c.overdue > 0 ? ` · ${rupees(c.overdue)} overdue since ${formatDate(c.oldestDueOn)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {sales.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">💰</span>
          <p>
            {clientFilter || statusFilter
              ? 'No sales match this filter.'
              : 'No B2B sales logged in this range. Log a delivery and its payment clock starts.'}
          </p>
        </div>
      ) : (
        <div className="b2b-sale-list">
          {sales.map((sale) => {
            const isSaving = savingId === sale.id;
            const isPaying = payingId === sale.id;
            return (
              <article className={`b2b-sale-row is-${sale.status}`} key={sale.id}>
                <div className="b2b-sale-main">
                  <span className="b2b-sale-client">{sale.clientName}</span>
                  <span className="b2b-sale-meta">
                    Delivered {formatDate(sale.deliveredOn)} · due {formatDate(sale.paymentDueOn)} ({sale.termsDays}d)
                    {sale.invoiceNumber ? ` · ${sale.invoiceNumber}` : ''}
                    {sale.orderRef ? ` · ${sale.orderRef}` : ''}
                  </span>
                  {sale.lines.length > 0 && (
                    <span className="b2b-sale-lines">
                      {sale.lines
                        .map((l) => `${l.quantity}${l.unitLabel ? ` ${l.unitLabel}` : ''} × ${l.description} @ ${rupees(l.unitPrice)}`)
                        .join(' · ')}
                    </span>
                  )}
                  {/* The delivery sheet above, the invoice below. Said here
                      rather than only in the confirm dialog, because "why
                      does the PDF have seven lines" is a question best
                      answered before the PDF exists. */}
                  {!sale.hasInvoice && invoiceLineCount(sale.lines) < sale.lines.length && (
                    <span className="b2b-sale-rollup">
                      Invoices as {invoiceLineCount(sale.lines)} lines, one per product and rate — these{' '}
                      {sale.lines.length} stay here.
                    </span>
                  )}
                  {sale.notes && <span className="b2b-sale-notes">{sale.notes}</span>}
                  {/* The last Odoo failure, kept on the row by the store so it
                      is still here on the next page load rather than only in
                      a toast that has been dismissed. */}
                  {sale.odooError && !sale.hasInvoice && (
                    <span className="b2b-sale-odoo-error">Odoo: {sale.odooError}</span>
                  )}
                </div>

                <div className="b2b-sale-money">
                  <span className="b2b-sale-amount">{rupees(sale.amount)}</span>
                  {sale.partPaid && (
                    <span className="b2b-sale-part">
                      {rupees(sale.amountPaid)} in · {rupees(sale.outstanding)} left
                    </span>
                  )}
                </div>

                <span className={`b2b-sale-status is-${sale.status}`}>{statusNote(sale)}</span>

                <div className="b2b-sale-actions">
                  {sale.hasInvoice ? (
                    // A plain link rather than a fetch: the browser's own
                    // download handling is better than anything reconstructed
                    // from a blob, and the route streams the PDF as an
                    // attachment. The Odoo access token stays server-side.
                    <a className="b2b-chip" href={`/api/b2b/sales/${sale.id}/invoice.pdf`} download>
                      ⬇ Invoice PDF
                    </a>
                  ) : (
                    sale.lines.length > 0 && (
                      <button
                        type="button"
                        className="b2b-chip is-invoice"
                        disabled={isSaving || invoicingId === sale.id}
                        onClick={() => sendToOdoo(sale)}
                      >
                        {invoicingId === sale.id ? 'Sending…' : 'Invoice in Odoo'}
                      </button>
                    )
                  )}
                  {sale.status !== 'paid' && (
                    <button type="button" className="b2b-chip" disabled={isSaving} onClick={() => openPayment(sale)}>
                      {isPaying ? 'Cancel' : 'Record payment'}
                    </button>
                  )}
                  {sale.status === 'paid' && (
                    <button
                      type="button"
                      className="b2b-chip"
                      disabled={isSaving}
                      onClick={() => post('/api/b2b/sales/payment', { id: sale.id, amountPaid: 0 }, sale.id)}
                    >
                      Unpay
                    </button>
                  )}
                  {/* Deleting the record of a posted invoice would leave
                      Odoo — and the client — holding a numbered document this
                      side has no memory of. The store refuses it; the button
                      is not offered in the first place. */}
                  {!sale.hasInvoice && (
                    <button type="button" className="b2b-chip is-danger" disabled={isSaving} onClick={() => removeSale(sale)}>
                      Delete
                    </button>
                  )}
                </div>

                {isPaying && (
                  <div className="b2b-sale-pay">
                    <label className="b2b-field">
                      <span>Received (₹)</span>
                      <input
                        type="number"
                        min={0}
                        max={sale.amount}
                        step="0.01"
                        value={payment.amountPaid}
                        onChange={(e) => setPayment({ ...payment, amountPaid: e.target.value })}
                      />
                    </label>
                    <label className="b2b-field">
                      <span>On</span>
                      <input
                        type="date"
                        value={payment.paidOn}
                        onChange={(e) => setPayment({ ...payment, paidOn: e.target.value })}
                      />
                    </label>
                    <span className="b2b-form-hint">
                      Anything less than {rupees(sale.amount)} is recorded as a part payment and the invoice stays open.
                    </span>
                    <button type="button" className="primary-button" disabled={isSaving} onClick={() => submitPayment(sale)}>
                      {isSaving ? 'Saving…' : 'Save payment'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default B2BSales;
