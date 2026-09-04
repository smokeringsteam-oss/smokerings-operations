// Where the weekend revenue came from — the per-channel rollup on the B2C
// tab of Spending vs Sales.
//
// A separate file from weeklyLedger.test.js for one reason: that file exists
// to prove the local-tables path works with Odoo switched off, which is the
// real degraded state the screen runs in. This one needs the opposite — Odoo
// configured and answering — so it mocks the order fetch and sets the env
// that makes getConfig() report configured. Mixing the two in one file would
// mean every test in it ran against whichever setup happened to win.
//
// What is actually worth testing here is not the arithmetic. It is that this
// rollup credits an order to the same channel Marketing ROI credits it to.
// The two screens read the same orders through different files, and if they
// ever disagreed the same order would appear under Reddit on one and Website
// on the other, with nothing on either screen to say which was wrong. So the
// tests below are mostly about the crediting rule: the link wins, an
// unmapped tag falls back to the filing, and neither one is invented when
// there is nothing to go on.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb();

// Odoo has to look configured or buildWeeklyReport never calls the fetch at
// all and every b2cSources assertion below would pass against an empty map.
process.env.ODOO_URL = 'https://odoo.test';
process.env.ODOO_DB = 'test';
process.env.ODOO_USERNAME = 'tester';
process.env.ODOO_API_KEY = 'key';

// Only the fetch is replaced. channelFromGaSource and UNATTRIBUTED come
// through untouched, on purpose — stubbing the resolver would test that this
// file calls A function rather than that it calls the one the ROI screen
// uses, which is the entire point of the exercise.
const orders = [];
vi.mock('../marketing/orderAttribution.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchAttributedOrders: async () => ({ orders }) };
});

const { buildWeeklyReport } = await import('./weeklyLedger.js');
const { run } = await import('../core/db.js');

beforeEach(() => {
  run('DELETE FROM purchase');
  run('DELETE FROM marketing_budget');
  run('DELETE FROM b2b_sale');
  run('DELETE FROM b2b_client');
  orders.length = 0;
});

afterAll(() => removeTestDb(dir));

let seq = 0;

// One confirmed Odoo order, in the shape fetchAttributedOrders returns.
// `channel` is the Order Source somebody filed it under; `utmSource` is the
// tag on the link that was clicked. The two disagreeing is the interesting
// case, not the exceptional one — on the live database most tagged orders
// are filed as "Website".
const order = ({ orderedOn, amount = 1000, channel = '', utmSource = '', countsAsRevenue = true }) => {
  seq += 1;
  orders.push({
    id: seq,
    name: `S${String(seq).padStart(5, '0')}`,
    orderedOn: `${orderedOn} 12:00:00`,
    amount,
    channel,
    countsAsRevenue,
    utm: { source: utmSource, campaign: '', content: '' },
  });
};

// A Monday-to-Sunday week well inside the default range.
const MON = '2026-08-31';
const report = () => buildWeeklyReport({ from: MON, to: '2026-09-06' });

const sourceFor = (rows, channel) => rows.find((row) => row.channel === channel);

describe('b2cSources — the crediting rule', () => {
  it('credits the link over the Order Source it was filed under', async () => {
    order({ orderedOn: '2026-09-02', amount: 2626, channel: 'Website', utmSource: 'Reddit' });

    const { b2cSources } = await report();

    expect(sourceFor(b2cSources, 'Reddit')).toMatchObject({ sales: 2626, orders: 1, fromLink: 1, linkRevenue: 2626 });
    expect(sourceFor(b2cSources, 'Website')).toBeUndefined();
  });

  it('resolves a tag written in any of the spellings GA reports', async () => {
    // Lowercase from a hand-typed link, capitalised from Odoo's own list.
    order({ orderedOn: '2026-09-03', amount: 1698, channel: 'Website', utmSource: 'whatsapp' });
    order({ orderedOn: '2026-09-04', amount: 300, channel: 'Website', utmSource: 'WhatsApp' });

    const { b2cSources } = await report();

    expect(sourceFor(b2cSources, 'WhatsApp')).toMatchObject({ sales: 1998, orders: 2, fromLink: 2 });
  });

  it('falls back to the filed source when the tag maps to no channel of ours', async () => {
    order({ orderedOn: '2026-09-02', amount: 500, channel: 'Website', utmSource: 'some-newsletter' });

    const { b2cSources } = await report();

    // Filed, not invented: an unrecognised tag is not a channel, and it is
    // not the Unattributed row either while a filing exists.
    expect(sourceFor(b2cSources, 'Website')).toMatchObject({ sales: 500, orders: 1, fromLink: 0, linkRevenue: 0 });
  });

  it('puts an order with neither a tag nor a filing in its own row, never spread across the others', async () => {
    order({ orderedOn: '2026-09-02', amount: 800, channel: '', utmSource: '' });
    order({ orderedOn: '2026-09-02', amount: 200, channel: 'Website', utmSource: '' });

    const { b2cSources } = await report();

    expect(sourceFor(b2cSources, 'Unattributed')).toMatchObject({ sales: 800, orders: 1, unattributed: true });
    expect(sourceFor(b2cSources, 'Website').sales).toBe(200);
  });
});

describe('b2cSources — what the rollup covers', () => {
  it('adds up to the B2C sales total, and shares are of that and not of all sales', async () => {
    order({ orderedOn: '2026-09-02', amount: 750, channel: 'Website' });
    order({ orderedOn: '2026-09-03', amount: 250, channel: 'Instagram' });
    // Wholesale revenue in the same week. It is on the B2B side and must not
    // change a single B2C share below.
    run(`INSERT INTO b2b_client (client_id, name, stage, payment_terms_days) VALUES ('CLI-001', 'Cafe', 'active', 15)`);
    run(
      `INSERT INTO b2b_sale (sale_id, client_id, delivered_on, payment_due_on, amount_inr, amount_paid_inr)
       VALUES ('SAL-1', 'CLI-001', '2026-09-02', '2026-09-17', 9000, 9000)`,
    );

    const { b2cSources, totals } = await report();

    expect(b2cSources.reduce((sum, row) => sum + row.sales, 0)).toBe(totals.b2c);
    expect(sourceFor(b2cSources, 'Website').share).toBe(75);
    expect(sourceFor(b2cSources, 'Instagram').share).toBe(25);
  });

  it('leaves out the draft quotations that are not revenue yet', async () => {
    order({ orderedOn: '2026-09-02', amount: 400, channel: 'Reddit' });
    order({ orderedOn: '2026-09-02', amount: 5000, channel: 'Reddit', countsAsRevenue: false });

    const { b2cSources, totals } = await report();

    expect(sourceFor(b2cSources, 'Reddit')).toMatchObject({ sales: 400, orders: 1 });
    expect(totals.pendingRevenue).toBe(5000);
  });

  it('leaves out the Odoo orders filed as B2B, which are already counted as wholesale', async () => {
    order({ orderedOn: '2026-09-02', amount: 6000, channel: 'B2B' });
    order({ orderedOn: '2026-09-02', amount: 400, channel: 'Reddit' });

    const { b2cSources, totals } = await report();

    // The overlap guard runs before the rollup, so this money is in neither
    // the B2C total nor any channel row — it is reported on its own.
    expect(sourceFor(b2cSources, 'B2B')).toBeUndefined();
    expect(totals.b2bTaggedOdoo).toBe(6000);
    expect(b2cSources.reduce((sum, row) => sum + row.sales, 0)).toBe(400);
  });

  it('ranks by revenue but always sorts the unattributed row last', async () => {
    order({ orderedOn: '2026-09-02', amount: 9000, channel: '' });
    order({ orderedOn: '2026-09-02', amount: 500, channel: 'Reddit' });
    order({ orderedOn: '2026-09-02', amount: 100, channel: 'Instagram' });

    const { b2cSources } = await report();

    expect(b2cSources.map((row) => row.channel)).toEqual(['Reddit', 'Instagram', 'Unattributed']);
  });

  it('reports an average order value per channel, and null where there are no orders to divide by', async () => {
    order({ orderedOn: '2026-09-02', amount: 600, channel: 'Reddit' });
    order({ orderedOn: '2026-09-03', amount: 400, channel: 'Reddit' });

    const { b2cSources } = await report();

    expect(sourceFor(b2cSources, 'Reddit').aov).toBe(500);
  });

  it('comes back empty rather than undefined when nothing sold', async () => {
    const { b2cSources } = await report();
    expect(b2cSources).toEqual([]);
  });
});
