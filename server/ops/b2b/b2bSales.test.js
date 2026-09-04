// The B2B sales book: the arithmetic the money tiles are built on, and the
// rules that keep an invoice's status honest.
//
// Most of what is worth testing here is the payment cycle. A due date is
// derived once and then has to stop moving; an invoice is overdue on a date
// rather than on a flag somebody remembered to set; and "how much is still
// owed" has to survive the date range the revenue figures are scoped to,
// because an unpaid invoice from three months ago is the one that matters
// most and the one a range filter would quietly hide.
//
// The second describe block covers the invoice half: lines totalling into
// the sale, the per-client price book derived from them, and the freeze that
// comes down once Odoo has posted the invoice. Nothing here talks to Odoo —
// every guard tested is one that fires before the first RPC call.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const { dir } = createTestDb();

const {
  listSales,
  addSale,
  updateSale,
  setLines,
  recordPayment,
  deleteSale,
  raiseInvoice,
  invoicePdf,
  lastPricesForClient,
  consolidateLines,
} = await import('./b2bSales.js');
const { addClient, updateClient, deleteClient } = await import('./b2bClients.js');
const { run, all } = await import('../../core/db.js');

beforeEach(() => {
  // Lines before sales: ON DELETE CASCADE would take them anyway, but the
  // fixture should not depend on the thing several tests below are about.
  run('DELETE FROM b2b_sale_line');
  run('DELETE FROM b2b_sale');
  run('DELETE FROM b2b_client_demand');
  run('DELETE FROM b2b_client');
});

afterAll(() => removeTestDb(dir));

const pad = (n) => String(n).padStart(2, '0');

// Dates relative to today, in the same local calendar the module works in —
// the fixtures have to move with the clock, since "overdue" is a function of
// what day it is rather than of anything stored.
function daysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const newClient = (name = 'Toit Brewpub') => addClient({ name }).client;

// The store's own rounding, restated here so the rounding test can show
// what the discarded alternative would have produced.
const round2Of = (n) => Math.round(n * 100) / 100;

describe('b2bSales', () => {
  it('falls due 15 days after delivery on the house terms', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 12000 });

    expect(sale.id).toBe('B2BS-0001');
    expect(sale.paymentDueOn).toBe('2026-08-16');
    expect(sale.termsDays).toBe(15);
    expect(sale.outstanding).toBe(12000);
    expect(sale.status).toBe('overdue');
  });

  it('uses the account own cycle when it has negotiated one', () => {
    const client = newClient();
    updateClient({ id: client.id, paymentTermsDays: 30 });

    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 5000 });
    expect(sale.paymentDueOn).toBe('2026-08-31');
    expect(sale.termsDays).toBe(30);
  });

  it('does not move a due date already on the book when the terms change', () => {
    // The point of storing payment_due_on rather than deriving it: moving an
    // account to 30-day terms must not retroactively un-overdue an invoice
    // that has been sitting past its date for a fortnight.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 5000 });
    expect(sale.paymentDueOn).toBe('2026-08-16');

    updateClient({ id: client.id, paymentTermsDays: 45 });
    const [after] = listSales({ from: '2026-01-01', to: '2026-12-31' }).sales;
    expect(after.paymentDueOn).toBe('2026-08-16');
  });

  it('calls an invoice overdue on the day after its due date, not before', () => {
    const client = newClient();
    // Delivered 15 days ago on 15-day terms: due today, so not yet late.
    const dueToday = addSale({ clientId: client.id, deliveredOn: daysFromToday(-15), amount: 1000 }).sale;
    // A day older, so a day past.
    const late = addSale({ clientId: client.id, deliveredOn: daysFromToday(-16), amount: 1000 }).sale;
    // Delivered today: well inside the cycle.
    const fresh = addSale({ clientId: client.id, deliveredOn: daysFromToday(0), amount: 1000 }).sale;
    // Due in two days, which is inside the "due soon" window.
    const soon = addSale({ clientId: client.id, deliveredOn: daysFromToday(-13), amount: 1000 }).sale;

    expect(dueToday.status).toBe('due_soon');
    expect(dueToday.daysOverdue).toBe(0);
    expect(late.status).toBe('overdue');
    expect(late.daysOverdue).toBe(1);
    expect(fresh.status).toBe('open');
    expect(soon.status).toBe('due_soon');
  });

  it('settles a sale in full and stamps the date it was paid', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 8000 });

    const paid = recordPayment({ id: sale.id, amountPaid: 8000, paidOn: '2026-08-14' }).sale;
    expect(paid.status).toBe('paid');
    expect(paid.outstanding).toBe(0);
    expect(paid.paidOn).toBe('2026-08-14');
    expect(paid.partPaid).toBe(false);
  });

  it('keeps a part-paid invoice outstanding and undated', () => {
    // The case a single amount_paid column could otherwise hide: money has
    // come in, but the invoice is still owed and still has to appear on the
    // chase list.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 10000 });

    const part = recordPayment({ id: sale.id, amountPaid: 4000 }).sale;
    expect(part.outstanding).toBe(6000);
    expect(part.paidOn).toBe('');
    expect(part.partPaid).toBe(true);
    expect(part.status).toBe('overdue');

    const { receivables } = listSales({ from: '2026-01-01', to: '2026-12-31' });
    expect(receivables.outstanding).toBe(6000);
    expect(receivables.invoices).toBe(1);
  });

  it('treats the amount received as a running total, not a top-up', () => {
    // A resubmitted form must not pay the invoice twice.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 9000 });

    recordPayment({ id: sale.id, amountPaid: 3000 });
    const again = recordPayment({ id: sale.id, amountPaid: 3000 }).sale;
    expect(again.amountPaid).toBe(3000);
    expect(again.outstanding).toBe(6000);
  });

  it('refuses more money in than the sale is for', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 2000 });
    expect(() => recordPayment({ id: sale.id, amountPaid: 2500 })).toThrow(/more than the/);
  });

  it('reopens a settled invoice when its amount is corrected upwards', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 2000, amountPaid: 2000 });
    expect(sale.status).toBe('paid');

    const corrected = updateSale({ id: sale.id, amount: 3000 }).sale;
    expect(corrected.status).toBe('overdue');
    expect(corrected.outstanding).toBe(1000);
    expect(corrected.paidOn).toBe('');
  });

  it('refuses to correct an amount below what has already been received', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 5000 });
    recordPayment({ id: sale.id, amountPaid: 4000 });
    expect(() => updateSale({ id: sale.id, amount: 3000 })).toThrow(/Correct the payment/);
  });

  it('does not slide the due date when the delivery date is corrected', () => {
    // The agreed date is the agreed date. Recomputing it off a typo fix would
    // silently move money owed.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 1000 });
    const moved = updateSale({ id: sale.id, deliveredOn: '2026-08-03' }).sale;
    expect(moved.deliveredOn).toBe('2026-08-03');
    expect(moved.paymentDueOn).toBe('2026-08-16');
  });

  it('counts revenue inside the range and receivables across the whole book', () => {
    // The one structural rule of listSales. August's revenue is an August
    // question; an unpaid June invoice is still owed today.
    const client = newClient();
    addSale({ clientId: client.id, deliveredOn: '2026-06-10', amount: 7000 });
    addSale({ clientId: client.id, deliveredOn: '2026-08-05', amount: 3000 });
    addSale({ clientId: client.id, deliveredOn: '2026-08-20', amount: 5000, amountPaid: 5000 });

    const { summary, receivables, sales } = listSales({ from: '2026-08-01', to: '2026-08-31' });
    expect(sales).toHaveLength(2);
    expect(summary.revenue).toBe(8000);
    expect(summary.collected).toBe(5000);
    expect(summary.orders).toBe(2);
    expect(summary.averageSale).toBe(4000);
    // The June invoice is out of range for revenue and still in the debt.
    expect(receivables.outstanding).toBe(10000);
    expect(receivables.invoices).toBe(2);
  });

  it('rolls revenue up per client and per month', () => {
    const toit = newClient('Toit Brewpub');
    const arbor = newClient('Arbor Brewing');
    addSale({ clientId: toit.id, deliveredOn: '2026-07-10', amount: 4000 });
    addSale({ clientId: toit.id, deliveredOn: '2026-08-10', amount: 6000 });
    addSale({ clientId: arbor.id, deliveredOn: '2026-08-12', amount: 2500 });

    const { summary } = listSales({ from: '2026-07-01', to: '2026-08-31' });
    expect(summary.byClient.map((c) => [c.clientName, c.revenue, c.orders])).toEqual([
      ['Toit Brewpub', 10000, 2],
      ['Arbor Brewing', 2500, 1],
    ]);
    expect(summary.byMonth).toEqual([
      { month: '2026-07', revenue: 4000 },
      { month: '2026-08', revenue: 8500 },
    ]);
  });

  it('ranks the chase list by who owes the most overdue money', () => {
    const toit = newClient('Toit Brewpub');
    const arbor = newClient('Arbor Brewing');
    // Both overdue; Arbor owes more.
    addSale({ clientId: toit.id, deliveredOn: daysFromToday(-40), amount: 3000 });
    addSale({ clientId: arbor.id, deliveredOn: daysFromToday(-20), amount: 9000 });
    // Not yet due, so it counts as outstanding but not as overdue.
    addSale({ clientId: toit.id, deliveredOn: daysFromToday(-1), amount: 1000 });

    const { receivables } = listSales({ from: daysFromToday(-60), to: daysFromToday(0) });
    expect(receivables.overdue).toBe(12000);
    expect(receivables.overdueInvoices).toBe(2);
    expect(receivables.outstanding).toBe(13000);
    expect(receivables.oldestOverdueDays).toBe(25);
    expect(receivables.byClient.map((c) => [c.clientName, c.overdue, c.outstanding])).toEqual([
      ['Arbor Brewing', 9000, 9000],
      ['Toit Brewpub', 3000, 4000],
    ]);
  });

  it('narrows the list by client and status without moving the totals', () => {
    // The filters are for the list, not the tiles: switching to "overdue
    // only" must not make the month's revenue appear to collapse.
    const toit = newClient('Toit Brewpub');
    const arbor = newClient('Arbor Brewing');
    addSale({ clientId: toit.id, deliveredOn: '2026-08-01', amount: 4000 });
    addSale({ clientId: arbor.id, deliveredOn: '2026-08-02', amount: 6000, amountPaid: 6000 });

    const filtered = listSales({ from: '2026-08-01', to: '2026-08-31', clientId: toit.id, status: 'overdue' });
    expect(filtered.sales.map((s) => s.clientName)).toEqual(['Toit Brewpub']);
    expect(filtered.summary.revenue).toBe(10000);
    expect(filtered.receivables.outstanding).toBe(4000);
  });

  it('sorts the list as a call sheet: latest first, paid last', () => {
    const client = newClient();
    addSale({ clientId: client.id, deliveredOn: daysFromToday(-3), amount: 1000 });
    addSale({ clientId: client.id, deliveredOn: daysFromToday(-40), amount: 2000 });
    addSale({ clientId: client.id, deliveredOn: daysFromToday(-25), amount: 3000 });
    addSale({ clientId: client.id, deliveredOn: daysFromToday(-30), amount: 4000, amountPaid: 4000 });

    const { sales } = listSales({ from: daysFromToday(-90), to: daysFromToday(0) });
    expect(sales.map((s) => [s.status, s.amount])).toEqual([
      ['overdue', 2000],
      ['overdue', 3000],
      ['open', 1000],
      ['paid', 4000],
    ]);
  });

  it('refuses a sale with no client, no amount, or a due date before delivery', () => {
    const client = newClient();
    expect(() => addSale({ deliveredOn: '2026-08-01', amount: 100 })).toThrow(/which client/);
    expect(() => addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 0 })).toThrow(/more than zero/);
    expect(() => addSale({ clientId: client.id, deliveredOn: 'sometime', amount: 100 })).toThrow(/must be a date/);
    expect(() =>
      addSale({ clientId: client.id, deliveredOn: '2026-08-10', amount: 100, paymentDueOn: '2026-08-01' }),
    ).toThrow(/before the delivery date/);
  });

  it('takes an account sales history with it when the account is deleted', () => {
    // ON DELETE CASCADE. A sale row whose client is gone would be revenue
    // attributed to nobody, and the next account to take that id would
    // inherit it.
    const client = newClient();
    addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 1000 });
    deleteClient({ id: client.id });
    expect(all('SELECT * FROM b2b_sale')).toHaveLength(0);
  });

  it('deletes one sale without touching the rest', () => {
    const client = newClient();
    const first = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 1000 }).sale;
    addSale({ clientId: client.id, deliveredOn: '2026-08-02', amount: 2000 });

    expect(deleteSale({ id: first.id })).toEqual({ deleted: first.id });
    expect(all('SELECT * FROM b2b_sale')).toHaveLength(1);
    expect(() => deleteSale({ id: first.id })).toThrow(/No B2B sale/);
  });
});

describe('b2bSales invoice lines', () => {
  const line = (over = {}) => ({ productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 5, unitPrice: 1120, ...over });

  it('totals a sale from its lines rather than a typed amount', () => {
    const client = newClient();
    const { sale } = addSale({
      clientId: client.id,
      deliveredOn: '2026-08-01',
      // Deliberately wrong, and deliberately ignored: the invoice total is what
      // the lines add up to.
      amount: 99,
      lines: [line(), line({ productId: 138, description: 'Pulled Pork (Bulk 1kg)', quantity: 2, unitPrice: 1970 })],
    });

    expect(sale.amount).toBe(5 * 1120 + 2 * 1970);
    expect(sale.lines).toHaveLength(2);
    expect(sale.lines[0].lineTotal).toBe(5600);
    expect(sale.lines[1].lineTotal).toBe(3940);
    // Order entered is order printed.
    expect(sale.lines.map((l) => l.position)).toEqual([0, 1]);
  });

  it('rounds each line before summing, so the total matches the printed invoice', () => {
    // 1.5 kg at ₹33.33 is ₹49.995, which prints as ₹50.00. Two such lines
    // total ₹100.00 the way an invoice adds up — rounding only at the end
    // would give ₹99.99, and a client reconciling the PDF against the amount
    // being chased would find a paisa missing.
    const client = newClient();
    const { sale } = addSale({
      clientId: client.id,
      deliveredOn: '2026-08-01',
      lines: [line({ quantity: 1.5, unitPrice: 33.33 }), line({ quantity: 1.5, unitPrice: 33.33 })],
    });
    expect(sale.lines[0].lineTotal).toBe(50);
    expect(sale.amount).toBe(100);
    expect(round2Of(1.5 * 33.33 * 2)).toBe(99.99);
  });

  it('drops a blank row the editor left behind', () => {
    const client = newClient();
    const { sale } = addSale({
      clientId: client.id,
      deliveredOn: '2026-08-01',
      lines: [line(), { description: 'Delivery', quantity: 1, unitPrice: 0 }],
    });
    expect(sale.lines).toHaveLength(1);
  });

  it('refuses a line with no description, no quantity or a negative rate', () => {
    const client = newClient();
    const bad = (over) => () => addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line(over)] });
    expect(bad({ description: '  ' })).toThrow(/needs a description/);
    expect(bad({ quantity: 0 })).toThrow(/more than zero/);
    expect(bad({ unitPrice: -5 })).toThrow(/amount in rupees/);
  });

  it('keeps a free-text line, with no Odoo product behind it', () => {
    const client = newClient();
    const { sale } = addSale({
      clientId: client.id,
      deliveredOn: '2026-08-01',
      lines: [{ description: 'Delivery charge', quantity: 1, unitPrice: 250 }],
    });
    expect(sale.lines[0].productId).toBeNull();
    expect(sale.amount).toBe(250);
  });

  it('re-totals the sale when its lines are replaced', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    expect(sale.amount).toBe(5600);

    const edited = setLines({ id: sale.id, lines: [line({ quantity: 10 })] }).sale;
    expect(edited.amount).toBe(11200);
    expect(edited.lines).toHaveLength(1);
    // Replaced, not appended.
    expect(all('SELECT * FROM b2b_sale_line')).toHaveLength(1);
  });

  it('refuses to bill less than has already been received', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    recordPayment({ id: sale.id, amountPaid: 5000 });
    expect(() => setLines({ id: sale.id, lines: [line({ quantity: 1 })] })).toThrow(/Correct the payment/);
  });

  it('settles a sale when its lines are cut to what was already paid', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    recordPayment({ id: sale.id, amountPaid: 2240 });

    const cut = setLines({ id: sale.id, lines: [line({ quantity: 2 })] }).sale;
    expect(cut.amount).toBe(2240);
    expect(cut.status).toBe('paid');
    expect(cut.paidOn).not.toBe('');
  });

  it('will not let an itemised sale total be corrected by hand', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    expect(() => updateSale({ id: sale.id, amount: 100 })).toThrow(/itemised/);
  });

  it('takes the lines with the sale when it is deleted', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    deleteSale({ id: sale.id });
    expect(all('SELECT * FROM b2b_sale_line')).toHaveLength(0);
  });

  it('remembers what this client last paid for a product, newest delivery first', () => {
    // The per-client price book. It is derived from what was logged rather
    // than kept in a table of its own, so it cannot go stale.
    const toit = newClient('Toit Brewpub');
    const arbor = newClient('Arbor Brewing');
    addSale({ clientId: toit.id, deliveredOn: '2026-07-01', lines: [line({ unitPrice: 1000 })] });
    addSale({ clientId: toit.id, deliveredOn: '2026-08-01', lines: [line({ unitPrice: 1080 })] });
    addSale({ clientId: arbor.id, deliveredOn: '2026-08-05', lines: [line({ unitPrice: 1200 })] });

    expect(lastPricesForClient(toit.id)[137]).toEqual({ unitPrice: 1080, lastChargedOn: '2026-08-01' });
    // Each account has its own rate; one client's price never leaks to another.
    expect(lastPricesForClient(arbor.id)[137]).toEqual({ unitPrice: 1200, lastChargedOn: '2026-08-05' });
  });

  it('has no remembered price for a free-text line', () => {
    // Nothing identifies it across invoices, so there is nothing to carry
    // forward — and guessing by description would price the wrong thing.
    const client = newClient();
    addSale({
      clientId: client.id,
      deliveredOn: '2026-08-01',
      lines: [{ description: 'Delivery charge', quantity: 1, unitPrice: 250 }],
    });
    expect(Object.keys(lastPricesForClient(client.id))).toHaveLength(0);
  });

  it('freezes the lines and the row once the invoice is posted in Odoo', () => {
    // Odoo's copy is numbered and may already be in the client's hands by
    // then. Editing this side would leave two documents with one number
    // saying different things, so both paths refuse and point at a credit
    // note instead.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    run("UPDATE b2b_sale SET odoo_invoice_id = 42, invoice_number = 'INV/26-27/0042' WHERE sale_id = ?", sale.id);

    expect(() => setLines({ id: sale.id, lines: [line({ quantity: 1 })] })).toThrow(/Credit it there/);
    expect(() => deleteSale({ id: sale.id })).toThrow(/Credit it there/);
  });

  it('reports the invoice against the sale once it has one', () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    expect(sale.hasInvoice).toBe(false);

    run("UPDATE b2b_sale SET odoo_invoice_id = 42, odoo_invoice_state = 'posted', invoice_number = 'INV/26-27/0042' WHERE sale_id = ?", sale.id);
    const [after] = listSales({ from: '2026-01-01', to: '2026-12-31' }).sales;
    expect(after.hasInvoice).toBe(true);
    expect(after.odooInvoiceId).toBe(42);
    expect(after.invoiceNumber).toBe('INV/26-27/0042');
  });

  it('refuses to invoice a sale twice, or one with no lines', async () => {
    // The guard that stops a double-clicked button billing a client twice.
    // Neither case reaches Odoo, so neither needs it to be reachable.
    const client = newClient();
    const lump = addSale({ clientId: client.id, deliveredOn: '2026-08-01', amount: 500 }).sale;
    await expect(raiseInvoice({ id: lump.id })).rejects.toThrow(/at least one line/);

    const itemised = addSale({ clientId: client.id, deliveredOn: '2026-08-02', lines: [line()] }).sale;
    run("UPDATE b2b_sale SET odoo_invoice_id = 42, invoice_number = 'INV/26-27/0042' WHERE sale_id = ?", itemised.id);
    await expect(raiseInvoice({ id: itemised.id })).rejects.toThrow(/already invoiced/);
  });

  it('has no PDF to hand back before the invoice exists', async () => {
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-08-01', lines: [line()] });
    await expect(invoicePdf({ id: sale.id })).rejects.toThrow(/not been invoiced/);
  });
});

// The delivery that found both of these bugs, kept as the fixture for both.
//
// A wholesale drop weighed piece by piece: twenty-five rows, seven products,
// one rate each. Eleven of the quantities have a third decimal, because that
// is what a scale reading meat in grams produces, and four products were
// entered under more than one description because that is what the person
// packing them wrote down.
const DELIVERY = [
  [137, 'Pulled Chicken (Bulk 1kg)', 0.5, 1120],
  [137, 'Pulled Chicken (Bulk 1kg)', 0.5, 1120],
  [137, 'Pulled Chicken (Bulk 1kg)', 0.5, 1120],
  [137, 'Pulled Chicken (Bulk 1kg)', 0.364, 1120],
  [136, 'Smoked Chicken Whole Legs (Bulk 1kg)', 0.59, 760],
  [136, 'Smoked Chicken Whole Legs (Bulk 1kg)', 0.59, 760],
  [139, 'Smoked Pork Chops (Bulk 1kg)', 0.304, 1600],
  [145, 'Smoked Whole Chicken (Bulk 1kg)', 0.4, 700],
  [135, 'Smoked Chicken Fillet (Bulk 1kg)', 0.54, 800],
  [139, 'Smoked Pork Chops (Bulk 1kg)', 0.535, 1600],
  [139, 'Smoked Pork Chops (Bulk 1kg)', 0.5, 1600],
  [145, 'Half chicken', 0.348, 700],
  [145, 'Half chicken', 0.33, 700],
  [145, 'Half chicken', 0.39, 700],
  [136, 'Smoked Chicken Whole Legs (Bulk 1kg)', 0.403, 760],
  [135, 'Chicken breast', 0.6, 800],
  [141, 'Pork burnt ends', 0.46, 1700],
  [139, 'Smoked Pork Chops (Bulk 1kg)', 0.494, 1600],
  [135, 'Smoked Chicken Fillet (Bulk 1kg)', 0.69, 800],
  [136, 'Smoked Chicken Whole Legs (Bulk 1kg)', 0.576, 760],
  [140, 'Smoked Pork Ribs (Bulk 1kg)', 0.811, 1700],
  [140, 'Smoked Pork Ribs (Bulk 1kg)', 0.673, 1700],
  [141, 'Smoked Pork Belly (Bulk 1kg)', 0.614, 1700],
  [141, 'Smoked Pork Belly (Bulk 1kg)', 0.63, 1700],
  [140, 'Smoked Pork Ribs (Bulk 1kg)', 0.764, 1700],
].map(([productId, description, quantity, unitPrice]) => ({
  productId,
  description,
  unitLabel: 'kg',
  quantity,
  unitPrice,
}));

describe('b2bSales quantities', () => {
  it('bills the weight that was on the scale, to the gram', () => {
    // The bug this is here for: quantities used to be rounded to two
    // decimals, the same as money. 0.364 kg became 0.36 kg — 4 g of chicken
    // given away on one row, and across the eleven rows of this delivery
    // that had a third decimal, ₹27.52 of meat billed at zero.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-09-01', lines: DELIVERY });

    expect(sale.amount).toBe(15871.32);
    // What two decimals used to produce, restated so the gap is on the record
    // rather than only in the commit that closed it.
    const at2dp = round2Of(
      DELIVERY.reduce((total, line) => total + round2Of(round2Of(line.quantity) * line.unitPrice), 0),
    );
    expect(at2dp).toBe(15843.8);
    expect(round2Of(sale.amount - at2dp)).toBe(27.52);

    // Read back off the row, not just returned from the write: the quantity
    // has to survive the round trip through SQLite too.
    expect(sale.lines[3].quantity).toBe(0.364);
    expect(sale.lines[3].lineTotal).toBe(407.68);
  });

  it('rounds a quantity at the gram and not before it', () => {
    // Three decimals is the floor, not "no rounding at all" — a quantity
    // arriving with float dust on it still gets settled to something a scale
    // could have read.
    const client = newClient();
    const { sale } = addSale({
      clientId: client.id,
      deliveredOn: '2026-09-01',
      lines: [{ productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 0.3644449, unitPrice: 1120 }],
    });
    expect(sale.lines[0].quantity).toBe(0.364);
  });
});

describe('b2bSales invoice consolidation', () => {
  it('rolls a delivery up to one line per product for the invoice', () => {
    // Twenty-five weighings, seven products. The invoice is what the client
    // is asked to pay for and it says 1.864 kg of pulled chicken once; the
    // delivery sheet keeps all four bags.
    const { rows, total } = consolidateLines(DELIVERY);

    expect(rows).toHaveLength(7);
    expect(rows.map((r) => [r.productId, r.quantity, r.lineTotal, r.rows])).toEqual([
      [137, 1.864, 2087.68, 4],
      [136, 2.159, 1640.84, 4],
      [139, 1.833, 2932.8, 4],
      [145, 1.468, 1027.6, 4],
      [135, 1.83, 1464, 3],
      [141, 1.704, 2896.8, 3],
      [140, 2.248, 3821.6, 3],
    ]);
    // The whole point: fewer lines, same money. Nothing about consolidation
    // is allowed to change what is being charged.
    expect(total).toBe(15871.32);
    // Order of first appearance, so the invoice prints in the order the
    // delivery was entered.
    expect(rows[0].description).toBe('Pulled Chicken (Bulk 1kg)');
  });

  it('collects the descriptions a group covered, where they differ', () => {
    // Four products here were weighed under two names. The group knows it,
    // which is what tells raiseInvoice to bill the line under the product's
    // own catalogue name — the pork belly group would otherwise print as
    // "Pork burnt ends", the description that happened to be entered first.
    const { rows } = consolidateLines(DELIVERY);

    const belly = rows.find((r) => r.productId === 141);
    expect(belly.descriptions).toEqual(['Pork burnt ends', 'Smoked Pork Belly (Bulk 1kg)']);

    const chops = rows.find((r) => r.productId === 139);
    expect(chops.descriptions).toEqual(['Smoked Pork Chops (Bulk 1kg)']);
  });

  it('keeps one product billed at two rates on two lines', () => {
    // Two rates are two different agreements. Summing the quantities against
    // one of them would change the total, which is the one thing the roll-up
    // must never do.
    const { rows, total } = consolidateLines([
      { productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 1, unitPrice: 1120 },
      { productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 2, unitPrice: 1000 },
      { productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 3, unitPrice: 1120 },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ quantity: 4, unitPrice: 1120, lineTotal: 4480 });
    expect(rows[1]).toMatchObject({ quantity: 2, unitPrice: 1000, lineTotal: 2000 });
    expect(total).toBe(6480);
  });

  it('groups free-text lines on their description, ignoring case and spacing', () => {
    // No product id to group on, so the description is all there is. The
    // same charge typed twice is still one charge.
    const { rows } = consolidateLines([
      { productId: null, description: 'Delivery', quantity: 1, unitPrice: 250 },
      { productId: null, description: '  delivery ', quantity: 1, unitPrice: 250 },
      { productId: null, description: 'Crate deposit', quantity: 2, unitPrice: 100 },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ description: 'Delivery', quantity: 2, lineTotal: 500 });
    expect(rows[1]).toMatchObject({ description: 'Crate deposit', quantity: 2, lineTotal: 200 });
  });

  it('never merges a free-text line into a product line', () => {
    // A product line and a free-text line that happen to read the same are
    // still different things to Odoo: one bills against the catalogue and
    // one does not.
    const { rows } = consolidateLines([
      { productId: 137, description: 'Pulled Chicken (Bulk 1kg)', quantity: 1, unitPrice: 1120 },
      { productId: null, description: 'Pulled Chicken (Bulk 1kg)', quantity: 1, unitPrice: 1120 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.productId)).toEqual([137, null]);
  });

  it('leaves the delivery sheet alone', () => {
    // Consolidation happens on the way to Odoo and nowhere else. The sale
    // keeps its rows, because they are the record of what was packed.
    const client = newClient();
    const { sale } = addSale({ clientId: client.id, deliveredOn: '2026-09-01', lines: DELIVERY });

    expect(sale.lines).toHaveLength(25);
    expect(all('SELECT * FROM b2b_sale_line')).toHaveLength(25);
    expect(consolidateLines(sale.lines).total).toBe(sale.amount);
  });
});
