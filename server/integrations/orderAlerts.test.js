// The new-order push: what it says about an order, and that each order is
// announced exactly once.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const odoo = vi.hoisted(() => ({ orders: [], asked: [] }));

vi.mock('./odoo.js', () => ({
  getConfig: () => ({ configured: true }),
  fetchNewlyConfirmedOrders: async ({ since }) => {
    odoo.asked.push(since);
    return odoo.orders;
  },
}));

// Real claims (they live in the test database); stubbed delivery, so nothing
// leaves the machine and the payloads can be read back.
const push = vi.hoisted(() => ({ subscribers: 1, sent: [] }));

vi.mock('../core/pushNotify.js', async (importOriginal) => ({
  ...(await importOriginal()),
  subscriptionCount: () => push.subscribers,
  sendToAll: async (payload) => {
    push.sent.push(payload);
    return { sent: push.subscribers };
  },
}));

let dir;
let alerts;
let repo;

const NOW = new Date('2026-10-09T12:00:00Z');

function order(overrides = {}) {
  return {
    orderId: 42,
    orderName: 'S00142',
    customer: 'Priya Raman',
    confirmedAt: '2026-10-09 11:58:00',
    // 14:00 UTC Saturday = 19:30 IST, Saturday Dinner.
    promised: '2026-10-10 14:00:00',
    slotId: 'satEvening',
    slotLabel: 'Saturday Dinner',
    amountTotal: 2450,
    items: [
      { name: 'Brisket 500g', qty: 2 },
      { name: 'Pulled Pork', qty: 1 },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  ({ dir } = createTestDb());
  repo = await import('../core/repo.js');
  alerts = await import('./orderAlerts.js');
});

afterAll(() => removeTestDb(dir));

beforeEach(() => {
  repo.select('push_delivery').forEach((row) => repo.remove('push_delivery', { notify_key: row.notify_key }));
  odoo.orders = [];
  odoo.asked = [];
  push.subscribers = 1;
  push.sent = [];
});

describe('orderPayload', () => {
  it('names the order, the slot with its IST time, the items and the total', () => {
    const payload = alerts.orderPayload(order());
    expect(payload.title).toBe('New order S00142 · Priya Raman');
    expect(payload.body).toBe('🌙 Saturday Dinner · Sat 10 Oct, 7:30 pm\n2 × Brisket 500g, 1 × Pulled Pork\n₹2,450');
    expect(payload.tag).toBe('order-42');
    // Not an alarm: a new order is a normal notification.
    expect(payload.alarm).toBeUndefined();
  });

  it('gives a weekday or B2B order its promised time without a slot name', () => {
    // 05:30 UTC Wednesday = 11:00 IST.
    const payload = alerts.orderPayload(order({ slotId: null, slotLabel: null, promised: '2026-10-14 05:30:00' }));
    expect(payload.body.split('\n')[0]).toBe('Deliver Wed 14 Oct, 11:00 am');
  });

  it('says so when the order has no slot at all', () => {
    const payload = alerts.orderPayload(order({ slotId: null, slotLabel: null, promised: null }));
    expect(payload.body.split('\n')[0]).toBe('⚠️ No delivery slot set in Odoo');
  });
});

describe('runOrderAlertTick', () => {
  it('asks Odoo for orders confirmed inside the grace window', async () => {
    await alerts.runOrderAlertTick(NOW);
    expect(odoo.asked[0].toISOString()).toBe(
      new Date(NOW.getTime() - alerts.DEFAULT_GRACE_MINUTES * 60000).toISOString(),
    );
  });

  it('announces a newly confirmed order once, however many ticks see it', async () => {
    odoo.orders = [order()];
    const first = await alerts.runOrderAlertTick(NOW);
    const second = await alerts.runOrderAlertTick(NOW);
    expect(first.announced).toBe(1);
    expect(second.announced).toBe(0);
    expect(push.sent).toHaveLength(1);
  });

  it('claims nothing while no phone is subscribed', async () => {
    // Otherwise the order is marked announced for a notification nobody got,
    // and turning notifications on a minute later would never surface it.
    push.subscribers = 0;
    odoo.orders = [order()];
    await alerts.runOrderAlertTick(NOW);
    expect(repo.select('push_delivery')).toHaveLength(0);

    push.subscribers = 1;
    const later = await alerts.runOrderAlertTick(NOW);
    expect(later.announced).toBe(1);
  });

  it('announces several orders oldest first', async () => {
    odoo.orders = [
      order({ orderId: 2, orderName: 'S2', confirmedAt: '2026-10-09 11:59:00' }),
      order({ orderId: 1, orderName: 'S1', confirmedAt: '2026-10-09 11:50:00' }),
    ];
    await alerts.runOrderAlertTick(NOW);
    expect(push.sent.map((p) => p.tag)).toEqual(['order-1', 'order-2']);
  });
});
