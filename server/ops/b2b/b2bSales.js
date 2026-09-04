// B2B sales and receivables — what each wholesale account was billed, and
// whether the money has come in yet.
//
// The B2B side does not get paid at the point of sale the way a B2C weekend
// order does. A delivery goes out, an invoice follows it, and the money
// arrives on a cycle — fifteen days here unless an account negotiated
// otherwise. That gap is the whole reason this module exists: "how much did
// we sell" and "how much have we actually been paid" are different numbers on
// the B2B book, and only one of them pays for next week's pork.
//
// So every sale carries two dates. `deliveredOn` is when the food went out,
// which is what revenue is counted against. `paymentDueOn` is when the money
// is owed by, computed once at entry as deliveredOn + the client's
// payment_terms_days and then left alone — see the note in schema.sql on why
// it is stored rather than derived: re-deriving it would quietly un-overdue
// every old invoice the day an account is moved to 30-day terms.
//
// Rows are entered by hand rather than synced from Odoo. Odoo does carry
// amount_total on a sale order, and server/integrations/odoo.js already reads
// it for other purposes, but a wholesale delivery is not reliably an Odoo
// order at the moment it happens — some go out against a WhatsApp
// confirmation and get invoiced later, and an account paying in cash may
// never appear there at all. Hand entry covers every case; a sync could be
// added later against `invoiceNumber` without changing the shape of this
// table.
//
// A sale can be a lump sum or an itemised invoice. Lines are optional: a
// delivery already billed elsewhere is logged as one amount, while one
// invoiced from here carries a line per product, and the amount then IS the
// sum of those lines. The lines are what gets pushed to Odoo as a posted
// customer invoice, and the rate on each of them becomes the price this
// client's next invoice pre-fills with.
//
// The one structural decision worth knowing before reading listSales: revenue
// is scoped to a date range, and receivables are not. What was sold in August
// is a question about August. What is still owed is a question about right
// now, and an invoice from June that nobody has paid must not vanish from it
// because the range starts in July.
import { insert, nextId, remove, select, selectOne, transaction, update } from '../../core/repo.js';
// Straight to db.js for the one read repo.js cannot express: the price a
// client last paid for a product is a join across two tables, ordered and
// deduplicated (see lastPricesForClient).
import { all } from '../../core/db.js';
import { listClients } from './b2bClients.js';
import {
  createCustomerInvoice,
  fetchProductNames,
  fetchInvoicePdf,
  fetchPricelistRules,
  fetchPricelists,
  fetchSellableProducts,
  priceFromRules,
} from '../../integrations/odoo.js';

const SALES_TABLE = 'b2b_sale';

// The house cycle, used when a client row somehow has no terms of its own.
// The column is NOT NULL DEFAULT 15, so this is a belt-and-braces figure
// rather than a live default — but it keeps the arithmetic below total.
const DEFAULT_TERMS_DAYS = 15;

// How far back listSales looks when the caller names no range. Long enough to
// cover a quarter of trading, short enough that the revenue tiles are about
// current business rather than all of history.
const DEFAULT_RANGE_DAYS = 90;

// An invoice this close to its due date is called out separately on the
// board. Not a status the database stores — it is a function of today, so it
// is computed on read.
const DUE_SOON_DAYS = 3;

// What a sale can be, in the order the board sorts them: the ones costing
// money first.
const STATUSES = [
  { key: 'overdue', label: 'Overdue', description: 'Past its due date with money still outstanding.' },
  { key: 'due_soon', label: 'Due soon', description: `Falls due within ${DUE_SOON_DAYS} days.` },
  { key: 'open', label: 'Awaiting payment', description: 'Invoiced, inside the payment cycle.' },
  { key: 'paid', label: 'Paid', description: 'Settled in full.' },
];
const STATUS_KEYS = STATUSES.map((s) => s.key);
const STATUS_ORDER = Object.fromEntries(STATUS_KEYS.map((key, i) => [key, i]));

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Quantities are weights, and this business sells meat by the gram. 0.364 kg
// is 364 g; rounding it to 0.36 hands the client 4 g for nothing, which on a
// 25-line delivery came to 27 rupees given away without anybody typing a
// wrong number. So money keeps two decimals, because a paisa is the smallest
// thing that can actually be paid, and a quantity gets three, because a gram
// is the smallest thing that gets weighed.
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

const pad = (n) => String(n).padStart(2, '0');

// Local-calendar 'YYYY-MM-DD', never UTC — the same rule serviceWeeks.js
// follows. toISOString() would hand back yesterday's date for the first five
// and a half hours of every IST day, which on this module means an invoice
// reading as due a day late.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Whole days from `from` to `to`, signed. Built off UTC midnights rather than
// local ones so a DST-style hour shift can never turn 15 days into 14.9 and
// round the wrong way; both arguments are plain dates, so there is no local
// time being discarded here.
function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Dates arrive from <input type="date"> as 'YYYY-MM-DD' and from nothing else,
// but a bad one stored is a row that sorts and compares wrongly forever, so
// the shape is checked rather than trusted.
function cleanDate(value, what) {
  const s = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) badRequest(`${what} must be a date (YYYY-MM-DD).`);
  return s;
}

function cleanMoney(value, what, { allowZero = false } = {}) {
  const n = Number(String(value ?? '').trim());
  if (!Number.isFinite(n)) badRequest(`${what} must be an amount in rupees.`);
  if (n < 0) badRequest(`${what} cannot be negative.`);
  if (!allowZero && n === 0) badRequest(`${what} must be more than zero.`);
  return round2(n);
}

// The client book, keyed for lookup. Read through b2bClients.listClients
// rather than the table directly so the name, stage and payment terms this
// module reports are the same ones the Clients tab shows — including the
// defaulting it does for the columns the schema leaves NULL.
function clientIndex() {
  const { clients } = listClients();
  return new Map(clients.map((c) => [c.id, c]));
}

function loadSale(id) {
  const row = selectOne(SALES_TABLE, { sale_id: String(id || '').trim() });
  if (!row) {
    const err = new Error(`No B2B sale with id ${id}.`);
    err.status = 404;
    throw err;
  }
  return row;
}

function termsDaysFor(client) {
  const n = Number(client?.paymentTermsDays);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_TERMS_DAYS;
}

// A row plus everything that is a function of today rather than of the row:
// what is still owed, whether the due date has passed, and by how long. All
// derived on read because all three change without anyone writing to the
// table — an invoice becomes overdue at midnight, not when someone opens the
// page and saves something.
function toSale(row, clients, now, linesBySale) {
  const client = clients.get(row.client_id);
  const lines = (linesBySale && linesBySale.get(row.sale_id)) || [];
  const amount = round2(Number(row.amount_inr) || 0);
  const paid = round2(Number(row.amount_paid_inr) || 0);
  const outstanding = round2(amount - paid);
  const settled = outstanding <= 0;
  const daysToDue = daysBetween(now, row.payment_due_on);

  let status;
  if (settled) status = 'paid';
  else if (daysToDue < 0) status = 'overdue';
  else if (daysToDue <= DUE_SOON_DAYS) status = 'due_soon';
  else status = 'open';

  return {
    id: row.sale_id,
    clientId: row.client_id,
    // A sale whose client row was deleted cannot happen — the foreign key
    // cascades — but the join is still defended, because a blank name on a
    // money screen reads as a bug rather than as missing data.
    clientName: client ? client.name : row.client_id,
    clientStage: client ? client.stage : '',
    deliveredOn: row.delivered_on,
    amount,
    amountPaid: paid,
    outstanding: Math.max(outstanding, 0),
    paymentDueOn: row.payment_due_on,
    paidOn: row.paid_on || '',
    status,
    // Negative days-to-due is how far past the date it is. Reported as its
    // own positive number so the UI never has to negate anything to say
    // "11 days late".
    daysToDue,
    daysOverdue: status === 'overdue' ? -daysToDue : 0,
    // True only for a row with money in against it but not all of it — the
    // case the single amount_paid column would otherwise hide behind a
    // status of "open", which reads as though nothing has been received.
    partPaid: !settled && paid > 0,
    // The cycle this invoice was actually written on, not the client's
    // current one — see schema.sql. Shown on the row so a 30-day invoice
    // sitting among 15-day ones explains itself.
    termsDays: daysBetween(row.delivered_on, row.payment_due_on),
    lines,
    invoiceNumber: row.invoice_number || '',
    orderRef: row.order_ref || '',
    // The Odoo side. `hasInvoice` is what the UI switches on — an id is
    // present exactly when the invoice was raised and posted, which is also
    // the point after which the lines are frozen (see setLines).
    odooInvoiceId: row.odoo_invoice_id || null,
    odooInvoiceState: row.odoo_invoice_state || '',
    hasInvoice: Boolean(row.odoo_invoice_id),
    odooError: row.odoo_error || '',
    notes: row.notes || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function loadSales(now) {
  const clients = clientIndex();
  const linesBySale = groupLines();
  return select(SALES_TABLE, {}, { orderBy: 'delivered_on' }).map((row) => toSale(row, clients, now, linesBySale));
}

const sum = (list, pick) => round2(list.reduce((total, s) => total + pick(s), 0));

// Revenue over the chosen range, per account and in total.
//
// Counted on `deliveredOn` rather than on when the invoice was raised or paid:
// that is the date the food and the cost attached to it left the kitchen, and
// it is the one that lines up with the client-tagged spend in purchase_log,
// so the two can be put side by side later without either being shifted by a
// payment cycle.
function summarizeRange(sales, clients) {
  const byClient = [...clients.values()]
    .map((client) => {
      const mine = sales.filter((s) => s.clientId === client.id);
      return {
        clientId: client.id,
        clientName: client.name,
        stage: client.stage,
        orders: mine.length,
        revenue: sum(mine, (s) => s.amount),
        collected: sum(mine, (s) => s.amountPaid),
        outstanding: sum(mine, (s) => s.outstanding),
      };
    })
    .filter((c) => c.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);

  // Calendar months, oldest first — the shape a small bar chart or a row of
  // tiles reads straight off.
  const months = new Map();
  sales.forEach((s) => {
    const key = s.deliveredOn.slice(0, 7);
    months.set(key, round2((months.get(key) || 0) + s.amount));
  });

  return {
    revenue: sum(sales, (s) => s.amount),
    collected: sum(sales, (s) => s.amountPaid),
    orders: sales.length,
    // Average invoice value — the number that says whether a quiet month was
    // fewer deliveries or smaller ones.
    averageSale: sales.length ? round2(sum(sales, (s) => s.amount) / sales.length) : 0,
    byClient,
    byMonth: [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, revenue]) => ({ month, revenue })),
  };
}

// What is still owed, across every sale ever entered — deliberately not
// scoped to the range (see the module note). An unpaid invoice is outstanding
// until it is paid, and a receivables figure that quietly excluded the oldest
// debts would be worse than no figure at all.
function summarizeReceivables(allSales) {
  const unpaid = allSales.filter((s) => s.outstanding > 0);
  const overdue = unpaid.filter((s) => s.status === 'overdue');
  const dueSoon = unpaid.filter((s) => s.status === 'due_soon');

  const byClient = new Map();
  unpaid.forEach((s) => {
    const entry = byClient.get(s.clientId) || {
      clientId: s.clientId,
      clientName: s.clientName,
      outstanding: 0,
      overdue: 0,
      invoices: 0,
      oldestDueOn: '',
    };
    entry.outstanding = round2(entry.outstanding + s.outstanding);
    if (s.status === 'overdue') entry.overdue = round2(entry.overdue + s.outstanding);
    entry.invoices += 1;
    if (!entry.oldestDueOn || s.paymentDueOn < entry.oldestDueOn) entry.oldestDueOn = s.paymentDueOn;
    byClient.set(s.clientId, entry);
  });

  return {
    outstanding: sum(unpaid, (s) => s.outstanding),
    invoices: unpaid.length,
    overdue: sum(overdue, (s) => s.outstanding),
    overdueInvoices: overdue.length,
    dueSoon: sum(dueSoon, (s) => s.outstanding),
    dueSoonInvoices: dueSoon.length,
    // The single worst number on the page: how long the oldest unpaid
    // invoice has been sitting there.
    oldestOverdueDays: overdue.reduce((worst, s) => Math.max(worst, s.daysOverdue), 0),
    // Biggest debtor first — that is the call to make this morning.
    byClient: [...byClient.values()].sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding),
  };
}

// ?from / ?to bound the revenue figures; ?clientId and ?status filter the
// list. The receivables block ignores all four by design — it is always the
// whole book, so the outstanding total on screen is the real one no matter
// what the filters are set to.
function listSales({ from, to, clientId, status } = {}) {
  const now = today();
  const toDate = to ? cleanDate(to, 'The end of the range') : now;
  const fromDate = from ? cleanDate(from, 'The start of the range') : addDays(toDate, -DEFAULT_RANGE_DAYS);
  if (fromDate > toDate) badRequest('The start of the range is after its end.');

  const clients = clientIndex();
  const all = loadSales(now);
  const inRange = all.filter((s) => s.deliveredOn >= fromDate && s.deliveredOn <= toDate);

  const wantClient = String(clientId || '').trim();
  const wantStatus = String(status || '').trim();
  if (wantStatus && !STATUS_KEYS.includes(wantStatus)) badRequest(`"${wantStatus}" is not a payment status.`);

  const sales = inRange
    .filter((s) => (!wantClient || s.clientId === wantClient) && (!wantStatus || s.status === wantStatus))
    // Overdue first, then by how late — the list is a call sheet before it is
    // a ledger. Paid rows fall to the bottom, newest delivery first.
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.status === 'paid' ? (a.deliveredOn < b.deliveredOn ? 1 : -1) : a.paymentDueOn < b.paymentDueOn ? -1 : 1),
    );

  return {
    sales,
    range: { from: fromDate, to: toDate, days: daysBetween(fromDate, toDate) + 1 },
    // Scoped to the range, and to nothing else: the client and status filters
    // narrow the list on screen, not the totals above it, so switching to
    // "overdue only" doesn't make the month's revenue appear to collapse.
    summary: summarizeRange(inRange, clients),
    receivables: summarizeReceivables(all),
    statuses: STATUSES,
    // Every account that could be invoiced, for the picker — lost accounts
    // included, because a sale can be logged against one after the fact.
    clients: [...clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      stage: c.stage,
      paymentTermsDays: termsDaysFor(c),
      paymentTerms: c.paymentTerms,
    })),
    defaultTermsDays: DEFAULT_TERMS_DAYS,
  };
}

function readBack(saleId) {
  const now = today();
  return { sale: toSale(loadSale(saleId), clientIndex(), now, groupLines()) };
}

function addSale({
  clientId,
  deliveredOn,
  amount,
  lines,
  paymentDueOn,
  invoiceNumber,
  orderRef,
  notes,
  amountPaid,
  paidOn,
} = {}) {
  const clients = clientIndex();
  const client = clients.get(String(clientId || '').trim());
  if (!client) badRequest('Pick which client this sale was for.');

  const delivered = cleanDate(deliveredOn || today(), 'The delivery date');

  // Itemised or lump sum. When lines come with the sale the total is
  // theirs — an `amount` sent alongside them is ignored rather than
  // reconciled, because there is only one right answer and it is the one
  // printed on the invoice.
  const itemised = Array.isArray(lines) && lines.length > 0;
  const lineRows = itemised ? cleanLines(lines) : { rows: [], total: 0 };
  if (itemised && !lineRows.rows.length) badRequest('None of those invoice lines had a quantity and a rate.');
  const value = itemised ? lineRows.total : cleanMoney(amount, 'The sale amount');

  // The client's cycle unless the caller overrode it — which is the case for
  // an invoice that was raised late, or one where a specific date was agreed
  // on the phone.
  const due = paymentDueOn ? cleanDate(paymentDueOn, 'The payment due date') : addDays(delivered, termsDaysFor(client));
  if (due < delivered) badRequest('The payment due date is before the delivery date.');

  // Paid-at-entry is a real case on this book — an account that settled on
  // delivery — so it is accepted here rather than forcing a second call to
  // recordPayment for a sale that was never actually outstanding.
  const paid = amountPaid === undefined ? 0 : cleanMoney(amountPaid, 'The amount received', { allowZero: true });
  if (paid > value) badRequest('The amount received is more than the sale is for.');
  const settledOn = paid >= value ? cleanDate(paidOn || today(), 'The payment date') : null;

  const now = new Date().toISOString();
  const row = {
    sale_id: nextId(SALES_TABLE, 'sale_id', 'B2BS'),
    client_id: client.id,
    delivered_on: delivered,
    amount_inr: value,
    payment_due_on: due,
    amount_paid_inr: paid,
    paid_on: settledOn,
    invoice_number: String(invoiceNumber || '').trim(),
    order_ref: String(orderRef || '').trim(),
    notes: String(notes || '').trim(),
    created_at: now,
    updated_at: now,
  };

  // The sale and its lines land together or not at all: a sale row whose
  // lines failed to insert would claim a total nothing on it adds up to.
  transaction(() => {
    insert(SALES_TABLE, row);
    lineRows.rows.forEach((line) =>
      insert(LINES_TABLE, { line_id: nextId(LINES_TABLE, 'line_id', 'B2BL'), sale_id: row.sale_id, ...line }),
    );
  });
  return readBack(row.sale_id);
}

// JSON key -> column for the plain text fields. Money and dates are not in
// here: each of them has a rule attached and is handled below.
const EDITABLE_FIELDS = {
  invoiceNumber: 'invoice_number',
  orderRef: 'order_ref',
  notes: 'notes',
};

function updateSale({ id, ...fields } = {}) {
  const row = loadSale(id);
  // A patch of only what changed, for the same reason b2bClients.updateClient
  // builds one: an UPDATE that names every column would undo whatever
  // somebody else edited between this read and this write.
  const patch = {};

  Object.entries(EDITABLE_FIELDS).forEach(([key, column]) => {
    if (fields[key] === undefined) return;
    patch[column] = String(fields[key] ?? '').trim();
  });

  if (fields.clientId !== undefined) {
    const client = clientIndex().get(String(fields.clientId || '').trim());
    if (!client) badRequest('Pick which client this sale was for.');
    patch.client_id = client.id;
  }

  // Delivery date and amount can both be corrected — a mistyped invoice is
  // the ordinary reason a row is edited at all — but the due date does not
  // move on its own when the delivery date does. Recomputing it here would
  // silently reset a date that was agreed with the client; the caller sends
  // paymentDueOn too if it should change.
  const delivered = fields.deliveredOn === undefined ? row.delivered_on : cleanDate(fields.deliveredOn, 'The delivery date');
  if (fields.deliveredOn !== undefined) patch.delivered_on = delivered;

  const due = fields.paymentDueOn === undefined ? row.payment_due_on : cleanDate(fields.paymentDueOn, 'The payment due date');
  if (fields.paymentDueOn !== undefined) patch.payment_due_on = due;
  if (due < delivered) badRequest('The payment due date is before the delivery date.');

  if (fields.amount !== undefined) {
    // An itemised sale's total is its lines' — correcting it here would
    // make the row disagree with the invoice it was billed on.
    if (loadLines(row.sale_id).length) {
      badRequest('This sale is itemised. Change the invoice lines and the total follows.');
    }
    const value = cleanMoney(fields.amount, 'The sale amount');
    // Correcting an invoice downwards below what has already been received
    // would leave the row overpaid, which the schema refuses outright — so it
    // is refused here with a message that says what to do about it.
    const paid = round2(Number(row.amount_paid_inr) || 0);
    if (value < paid) {
      badRequest(`This sale already has ₹${paid} received against it. Correct the payment before lowering the amount.`);
    }
    patch.amount_inr = value;
    // Dropping the amount to exactly what was received settles it; raising it
    // on a settled invoice reopens it. Either way paid_on has to follow, or
    // the row breaks the "settled means settled" CHECK.
    patch.paid_on = paid >= value ? row.paid_on || today() : null;
  }

  patch.updated_at = new Date().toISOString();
  update(SALES_TABLE, { sale_id: row.sale_id }, patch);
  return readBack(row.sale_id);
}

// Money in. `amountPaid` is the running total received, not a delta — the UI
// edits it as a field showing what has come in so far, and a delta would turn
// a double-submitted form into a double payment.
function recordPayment({ id, amountPaid, paidOn } = {}) {
  const row = loadSale(id);
  const amount = round2(Number(row.amount_inr) || 0);

  const paid = amountPaid === undefined ? amount : cleanMoney(amountPaid, 'The amount received', { allowZero: true });
  if (paid > amount) badRequest(`That is more than the ₹${amount} this sale is for.`);

  const settled = paid >= amount;
  const patch = {
    amount_paid_inr: paid,
    // Only a fully settled invoice gets a date. A part payment leaves it
    // NULL, which is what keeps the row in the receivables list where it
    // belongs.
    paid_on: settled ? cleanDate(paidOn || today(), 'The payment date') : null,
    updated_at: new Date().toISOString(),
  };
  if (settled && patch.paid_on < row.delivered_on) badRequest('The payment date is before the delivery date.');

  update(SALES_TABLE, { sale_id: row.sale_id }, patch);
  return readBack(row.sale_id);
}

function deleteSale({ id } = {}) {
  const row = loadSale(id);
  // Deleting the record of a posted invoice would leave Odoo holding a
  // numbered document this side has no memory of — and the client holding
  // a copy of it. Odoo's answer to a wrong posted invoice is a credit
  // note, so that has to be the answer here too.
  if (row.odoo_invoice_id) {
    badRequest(`This sale is invoiced in Odoo as ${row.invoice_number || row.odoo_invoice_id}. Credit it there instead of deleting it here.`);
  }
  // The lines go with it — ON DELETE CASCADE would do this anyway, but it
  // is spelled out so the behaviour doesn't quietly depend on foreign keys
  // being switched on for whichever connection is in play.
  transaction(() => {
    remove(LINES_TABLE, { sale_id: row.sale_id }, { required: false });
    remove(SALES_TABLE, { sale_id: row.sale_id });
  });
  return { deleted: row.sale_id };
}

// ---- Invoice lines --------------------------------------------------------
// What a sale is actually made of. Optional: a sale logged as a lump sum has
// none and keeps the amount somebody typed. Once a sale has lines, its
// amount_inr becomes their sum and the store maintains that — see the note in
// schema.sql on why the two must never be allowed to disagree.

const LINES_TABLE = 'b2b_sale_line';

function toLine(row) {
  return {
    id: row.line_id,
    saleId: row.sale_id,
    position: Number(row.position) || 0,
    productId: row.odoo_product_id == null ? null : Number(row.odoo_product_id),
    description: row.description || '',
    unitLabel: row.unit_label || '',
    quantity: round3(Number(row.quantity) || 0),
    unitPrice: round2(Number(row.unit_price) || 0),
    lineTotal: round2(Number(row.line_total) || 0),
  };
}

function loadLines(saleId) {
  return select(LINES_TABLE, { sale_id: saleId }, { orderBy: 'position' }).map(toLine);
}

// Every sale's lines in one pass, keyed by sale — so listing 200 invoices is
// one query rather than 200.
function groupLines() {
  const bySale = new Map();
  select(LINES_TABLE, {}, { orderBy: 'position' }).forEach((row) => {
    const list = bySale.get(row.sale_id) || [];
    list.push(toLine(row));
    bySale.set(row.sale_id, list);
  });
  return bySale;
}

// Validates and normalises a set of lines. Returns the rows to insert and the
// invoice total, which is the sum of the per-line roundings rather than a
// rounding of the sum — the invoice has to add up the way it is printed.
function cleanLines(lines) {
  if (!Array.isArray(lines)) badRequest('Invoice lines must be an array.');

  const cleaned = lines
    .map((line, index) => {
      const description = String(line?.description || '').trim();
      if (!description) badRequest('Every invoice line needs a description.');

      const quantity = Number(line?.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) badRequest(`Quantity for "${description}" must be more than zero.`);

      const unitPrice = Number(line?.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) badRequest(`Rate for "${description}" must be an amount in rupees.`);

      const productId = Number(line?.productId);
      return {
        position: index,
        // Null rather than 0 for a free-text line: 0 is a product id Odoo
        // would try to look up.
        odoo_product_id: Number.isInteger(productId) && productId > 0 ? productId : null,
        description,
        unit_label: String(line?.unitLabel || '').trim(),
        quantity: round3(quantity),
        unit_price: round2(unitPrice),
        line_total: round2(round3(quantity) * round2(unitPrice)),
      };
    })
    // A zero-total line is a blank row the editor left behind, not a thing
    // anybody meant to bill.
    .filter((line) => line.line_total > 0);

  return { rows: cleaned, total: round2(cleaned.reduce((sum, line) => sum + line.line_total, 0)) };
}

// Replaces a sale's lines and re-totals it, in one transaction.
//
// Replace rather than per-line edits for the same reason setDemands does it:
// the UI edits the table as a block, and a partial save is the one way to end
// up with an invoice total that isn't the sum of what is on the invoice.
//
// Refused once the invoice has been raised in Odoo. Odoo's copy is posted and
// numbered by then — a document the client may already be holding — and
// editing this side would leave two versions of the same invoice number
// saying different things. Odoo's own answer to a wrong posted invoice is a
// credit note, and that has to be this one too.
function setLines({ id, lines } = {}) {
  const row = loadSale(id);
  if (row.odoo_invoice_id) {
    badRequest('This sale has already been invoiced in Odoo. Credit it there before changing what was billed.');
  }

  const { rows, total } = cleanLines(lines);
  const paid = round2(Number(row.amount_paid_inr) || 0);
  if (rows.length && total < paid) {
    badRequest(`This sale already has ₹${paid} received against it. Correct the payment before billing less than that.`);
  }

  transaction(() => {
    // A sale with no lines yet is the normal case, so a delete that matches
    // nothing is expected rather than a 404.
    remove(LINES_TABLE, { sale_id: row.sale_id }, { required: false });
    rows.forEach((line) => insert(LINES_TABLE, { line_id: nextId(LINES_TABLE, 'line_id', 'B2BL'), sale_id: row.sale_id, ...line }));

    // Clearing every line leaves the amount where it was rather than zeroing
    // it — the schema forbids a zero amount, and "I deleted the breakdown"
    // does not mean "the delivery was free".
    const patch = { updated_at: new Date().toISOString() };
    if (rows.length) {
      patch.amount_inr = total;
      // The same settled-flag bookkeeping updateSale does: re-totalling can
      // settle or reopen a sale, and paid_on has to follow or the row breaks
      // the "settled means settled" CHECK.
      patch.paid_on = paid >= total ? row.paid_on || today() : null;
    }
    update(SALES_TABLE, { sale_id: row.sale_id }, patch);
  });

  return readBack(row.sale_id);
}

// What this client was last charged for each product, newest delivery first.
//
// This is the per-client price book, and it is derived rather than stored: the
// rate on the most recent line for a product IS the agreed rate, and it stays
// right without anybody maintaining a second table. Odoo cannot answer this —
// its pricelists are not readable over RPC (see fetchSellableProducts in
// server/integrations/odoo.js) — so the app owns the number and pushes it onto
// the invoice line explicitly.
function lastPricesForClient(clientId) {
  const rows = all(
    `SELECT l.odoo_product_id AS product_id, l.unit_price, l.unit_label, s.delivered_on
       FROM b2b_sale_line l
       JOIN b2b_sale s ON s.sale_id = l.sale_id
      WHERE s.client_id = ? AND l.odoo_product_id IS NOT NULL
      ORDER BY s.delivered_on DESC, l.line_id DESC`,
    clientId,
  );

  const prices = {};
  rows.forEach((row) => {
    // First row wins — the query is newest-first, so a later delivery's rate
    // is never overwritten by an older one.
    if (prices[row.product_id] === undefined) {
      prices[row.product_id] = { unitPrice: round2(Number(row.unit_price) || 0), lastChargedOn: row.delivered_on };
    }
  });
  return prices;
}

// ---- Odoo invoicing -------------------------------------------------------

// One invoice line per product, out of a delivery sheet that has one row per
// weighing.
//
// These are two documents with two different jobs, and they are allowed to
// disagree about shape. The sheet has four rows of pulled chicken because
// four bags went on the scale, and it keeps them: that is the record of what
// was packed and what each bag weighed. The invoice is what the client is
// being asked to pay for, and that is 1.86 kg of pulled chicken at one rate.
// A bill repeating the same product twenty-five times is one nobody on
// either side can check.
//
// Grouped on the product AND the rate, never on the product alone. Two rows
// of one product billed at different rates are two different agreements, and
// summing their quantities against a single rate would change what the
// invoice adds up to. Keeping them apart costs an extra line and keeps the
// total honest.
//
// A free-text line has no product to group on, so it groups on its
// description instead, compared case- and space-insensitively — "Delivery"
// and "delivery " are one charge typed twice. Nothing else is matched by
// description: two rows of the same product described differently ("Half
// chicken" against "Smoked Whole Chicken (Bulk 1kg)") are one product
// weighed twice, and the invoice should say so.
//
// Groups come back in the order their first row appeared, so the invoice
// prints in the order the delivery was entered.
function consolidateLines(lines) {
  const groups = new Map();

  lines.forEach((line) => {
    const unitPrice = round2(line.unitPrice);
    const text = String(line.description || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const key = line.productId ? `p:${line.productId}@${unitPrice}` : `t:${text}@${unitPrice}`;

    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        productId: line.productId,
        // The label, unless the group turns out to cover rows described
        // differently — see raiseInvoice, which then bills it under the
        // product's own catalogue name rather than whichever description was
        // typed first.
        description: line.description,
        descriptions: [line.description],
        unitLabel: line.unitLabel,
        unitPrice,
        quantity: round3(line.quantity),
        // How many delivery rows this line stands in for. Reported back so
        // the screen can say "25 rows, 7 lines" before anybody posts it.
        rows: 1,
      });
      return;
    }

    group.quantity = round3(group.quantity + line.quantity);
    group.rows += 1;
    if (!group.descriptions.includes(line.description)) group.descriptions.push(line.description);
    // A row that carried a unit when the first one didn't ("kg" against a
    // blank) is worth keeping: it is the same measure either way.
    if (!group.unitLabel) group.unitLabel = line.unitLabel;
  });

  const rows = [...groups.values()].map((group) => ({
    ...group,
    // Quantity times rate, which is the arithmetic Odoo will do to this line
    // itself. Deriving it any other way would print a subtotal Odoo
    // disagrees with.
    lineTotal: round2(group.quantity * group.unitPrice),
  }));

  return { rows, total: round2(rows.reduce((sum, line) => sum + line.lineTotal, 0)) };
}


// Raises the invoice in Odoo: creates it from this sale's lines, posts it, and
// keeps the invoice number, id and portal token against the row.
//
// Posting is not reversible from here — see createCustomerInvoice — so this
// refuses to run twice. A sale that already carries an invoice id hands back
// what it has rather than billing the client a second time, which is the
// failure a double-clicked button would otherwise cause.
async function raiseInvoice({ id } = {}) {
  const row = loadSale(id);
  if (row.odoo_invoice_id) {
    badRequest(`This sale is already invoiced in Odoo as ${row.invoice_number || row.odoo_invoice_id}.`);
  }

  const lines = loadLines(row.sale_id);
  if (!lines.length) badRequest('Add at least one line before sending this to Odoo.');

  const client = clientIndex().get(row.client_id);
  if (!client) badRequest('This sale has no client to invoice.');

  // The invoice is the consolidated view of the delivery — see
  // consolidateLines. The sale's own lines are not touched: the delivery
  // sheet keeps every weighing.
  const { rows: invoiceLines, total: invoiceTotal } = consolidateLines(lines);

  // Consolidation is allowed to move paisa and nothing more. Every group
  // shares one rate, so the only gap between the sum of the delivery rows
  // and the sum of the consolidated lines is where each was rounded to 2dp —
  // a few paisa over a long invoice. A whole rupee of drift means the
  // grouping merged something it should not have, and the place to find that
  // out is here rather than in a posted invoice that needs a credit note.
  const sheetTotal = round2(Number(row.amount_inr) || 0);
  if (Math.abs(invoiceTotal - sheetTotal) >= 1) {
    badRequest(
      `Rolling these ${lines.length} lines up to ${invoiceLines.length} would invoice ₹${invoiceTotal} against a ₹${sheetTotal} delivery. Check the rates on the lines before invoicing.`,
    );
  }

  try {
    // Where a group covers rows that were described differently, the line is
    // billed under the product's own name in Odoo. The alternative is
    // labelling 1.70 kg of pork belly "Pork burnt ends" because that row
    // happened to be entered first, which is a wrong invoice rather than an
    // untidy one. A failed lookup is not worth losing the invoice over — the
    // first description stands instead.
    const renaming = invoiceLines.filter((line) => line.productId && line.descriptions.length > 1);
    let names = {};
    if (renaming.length) {
      try {
        names = await fetchProductNames(renaming.map((line) => line.productId));
      } catch (err) {
        console.error('Could not read Odoo product names for the consolidated invoice:', err);
      }
    }

    const invoice = await createCustomerInvoice({
      partnerName: client.name,
      // The cached Odoo customer id when the account has one; otherwise
      // createCustomerInvoice finds or creates the partner and tells us which
      // id it settled on, and it gets written back below.
      partnerId: Number(client.odooPartnerId) || null,
      invoiceDate: row.delivered_on,
      dueDate: row.payment_due_on,
      reference: row.order_ref || '',
      lines: invoiceLines.map((line) => ({
        productId: line.productId,
        description: (line.productId && names[line.productId]) || line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    });

    // Cache the partner id on the account so the next invoice for them skips
    // the by-name lookup — and, more importantly, cannot land on a different
    // partner if somebody renames the client here or there.
    if (invoice.customerId && String(client.odooPartnerId || '') !== String(invoice.customerId)) {
      update('b2b_client', { client_id: client.id }, { odoo_partner_id: invoice.customerId });
    }

    update(
      SALES_TABLE,
      { sale_id: row.sale_id },
      {
        odoo_invoice_id: invoice.invoiceId,
        odoo_invoice_state: invoice.state,
        odoo_access_token: invoice.accessToken,
        // Odoo's number replaces whatever was typed here: from now on that is
        // what the client's copy says, and chasing them on a different one
        // helps nobody.
        invoice_number: invoice.invoiceNumber,
        odoo_error: null,
        updated_at: new Date().toISOString(),
      },
    );

    return {
      ...readBack(row.sale_id),
      odoo: {
        customerCreated: invoice.customerCreated,
        invoiceUrl: invoice.invoiceUrl,
        // What went to Odoo against what the delivery sheet holds, so the
        // screen can say the roll-up happened rather than leave it to be
        // discovered on the PDF.
        deliveryLines: lines.length,
        invoiceLines: invoiceLines.length,
      },
    };
  } catch (err) {
    // Kept on the row rather than only thrown, so a sale whose invoice failed
    // says so on its own line the next time the page is opened instead of
    // looking like one nobody has got round to yet.
    update(
      SALES_TABLE,
      { sale_id: row.sale_id },
      { odoo_error: String(err.message || err).slice(0, 500), updated_at: new Date().toISOString() },
    );
    throw err;
  }
}

// The PDF bytes for a sale's invoice, fetched from Odoo's customer portal.
// The access token stays here: the route hands the file to the browser rather
// than the URL (see server/index.js), because that URL is a credential.
async function invoicePdf({ id } = {}) {
  const row = loadSale(id);
  if (!row.odoo_invoice_id) badRequest('This sale has not been invoiced in Odoo yet.');
  const pdf = await fetchInvoicePdf({ invoiceId: row.odoo_invoice_id, accessToken: row.odoo_access_token });
  return { pdf, filename: `${(row.invoice_number || row.sale_id).replace(/[^\w.-]+/g, '-')}.pdf` };
}

// The line-item picker's contents: Odoo's sellable catalogue, priced for this
// particular client.
//
// The rate on each product comes from the Odoo pricelist attached to the
// account (b2b_client.odoo_pricelist_id — e.g. "Jango — B2B Wholesale" and its
// fixed per-product rules), evaluated here because Odoo will not evaluate one
// over RPC. Where the account has no pricelist, or a rule this code will not
// pretend to understand, the rate falls back to Odoo's list price and says so
// — `priceSource` is what the UI shows beside the number, so a pre-filled rate
// is never mistaken for one somebody chose.
//
// What this client was last charged rides alongside as a second opinion. It is
// not the price any more, but it is exactly what catches a pricelist that was
// changed in Odoo and shouldn't have been, or one nobody has set up yet.
//
// Odoo being unreachable is not an error here — it degrades to "no catalogue,
// type the line by hand", because a delivery that has already happened still
// has to be loggable when the internet is down.
async function invoiceCatalogue({ clientId } = {}) {
  const clean = String(clientId || '').trim();
  const lastPrices = clean ? lastPricesForClient(clean) : {};
  const client = clean ? clientIndex().get(clean) : null;
  const pricelistId = Number(client?.odooPricelistId) || null;

  let products = [];
  let rules = [];
  let pricelists = [];
  let odooError = '';
  try {
    // The pricelist's rules and the account's own catalogue are independent
    // reads, so they go together rather than one after the other.
    [products, pricelists, rules] = await Promise.all([
      fetchSellableProducts(),
      fetchPricelists(),
      pricelistId ? fetchPricelistRules(pricelistId) : Promise.resolve([]),
    ]);
  } catch (err) {
    odooError = String(err.message || err);
  }

  return {
    products: products.map((product) => {
      const last = lastPrices[product.id];
      const { price, source } = pricelistId
        ? priceFromRules(rules, product)
        : { price: product.listPrice, source: 'list' };
      return {
        ...product,
        listPrice: round2(product.listPrice),
        // What the rate box starts at. Editable either way — the point is
        // that the common case needs no typing and the uncommon one is
        // visible.
        price: round2(price),
        priceSource: source,
        lastChargedPrice: last ? last.unitPrice : null,
        lastChargedOn: last ? last.lastChargedOn : '',
      };
    }),
    // Echoed back so the form can name the pricelist it priced from, and so
    // the Clients tab can offer the picker without a second endpoint.
    pricelists,
    pricelistId: pricelistId || null,
    pricelistName: client?.odooPricelistName || '',
    odooError,
  };
}

export {
  STATUSES,
  DEFAULT_TERMS_DAYS,
  listSales,
  addSale,
  updateSale,
  setLines,
  recordPayment,
  deleteSale,
  raiseInvoice,
  invoicePdf,
  invoiceCatalogue,
  // Exported for its own tests: the roll-up is pure arithmetic over a set of
  // lines and is worth checking without an Odoo behind it.
  consolidateLines,
  // Exported for the tests: it is the per-client price book, and it is the
  // one piece of pricing logic that has no Odoo call in front of it.
  lastPricesForClient,
};
