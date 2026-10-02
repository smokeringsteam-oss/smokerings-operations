// The Porter delivery watch. Porter and Odoo are both stubbed — what is under
// test is the decision-making: when it looks again, what it refuses to
// conclude, and what it does when a step half-fails.
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const { dir } = createTestDb();
const { closeDb, run, get } = await import('../../core/db.js');
const { selectOne, upsert } = await import('../../core/repo.js');
const {
  MAX_WATCH_HOURS,
  POLL_CEILING_MIN,
  POLL_FLOOR_MIN,
  backfillWatches,
  checkWatchNow,
  getDeliveryWatches,
  nextCheckAt,
  openWatchCount,
  runDeliveryWatchTick,
  startWatch,
  stopWatch,
} = await import('./deliveryWatch.js');

// Nothing in this suite should ever reach a push service; sendToAll bails out
// before the network with no subscriptions on file, which is the state a fresh
// test database is in.

const NOW = new Date('2026-09-19T08:00:00.000Z');
const later = (minutes) => new Date(NOW.getTime() + minutes * 60000);
const PICKUP = { lat: 12.9957451, lng: 77.678655 };
const DROP = { lat: 13.0220971, lng: 77.6730522 };
const LINK = 'https://porter.in/rd/bb04ee9fda';

function porter({ status, phase, endedAt = null, etaMinutes = 12, now = NOW }) {
  return {
    trackUrl: 'https://porter.in/track_live_order_v2?booking_id=CRN1',
    crn: 'CRN1',
    status,
    phase,
    known: true,
    acceptedAt: NOW.toISOString(),
    endedAt,
    partner: { name: 'Manu T S', mobile: '99', vehicle: 'KA-05-KV-9812', vehicleType: 'Scooter' },
    riderAt: phase === 'delivered' ? null : { lat: 13.0014383, lng: 77.67832 },
    pickupAt: PICKUP,
    dropAt: DROP,
    dropLandmark: 'Sobha Eternia',
    eta:
      phase === 'delivered' || phase === 'cancelled'
        ? null
        : { etaMinutes, etaAt: new Date(now.getTime() + etaMinutes * 60000).toISOString(), basis: 'rider', distanceKm: 2.4 },
  };
}

const reader = (...responses) => {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
};

function seedOrder({ orderId = 101, status = 'out_for_delivery', trackingUrl = LINK } = {}) {
  upsert('sales_order', ['order_id'], {
    order_id: orderId,
    order_name: `S00${orderId}`,
    channel: 'B2C',
    status,
    tracking_url: trackingUrl,
    updated_at: NOW.toISOString(),
  });
  return orderId;
}

beforeEach(() => {
  run('DELETE FROM delivery_watch');
  run('DELETE FROM sales_order');
});

afterAll(() => {
  closeDb();
  removeTestDb(dir);
});

describe('startWatch', () => {
  it('queues the order at its ETA and records what Porter said', async () => {
    const orderId = seedOrder();
    const result = await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way', etaMinutes: 7 })) },
    });

    expect(result.watched).toBe(true);
    expect(result.porter.eta.etaMinutes).toBe(7);
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('watching');
    expect(watch.porterStatus).toBe('live');
    expect(watch.rider).toBe('Manu T S');
    expect(new Date(watch.nextCheckAt).toISOString()).toBe(later(7).toISOString());
  });

  it('does not watch another courier’s link, and says why', async () => {
    const orderId = seedOrder({ trackingUrl: 'https://dunzo.in/t/abc' });
    const result = await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: 'https://dunzo.in/t/abc',
      deps: { now: NOW },
    });
    expect(result).toEqual({ watched: false, reason: 'not_porter' });
    expect(openWatchCount()).toBe(0);
  });

  it('still queues the order when Porter could not be read at save time', async () => {
    // A blip while the link is being pasted is not a reason to stop following
    // the order — it is a reason to try again in a minute.
    const orderId = seedOrder();
    const result = await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(new Error('socket hang up')) },
    });

    expect(result.watched).toBe(true);
    expect(result.error).toBe('socket hang up');
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('watching');
    expect(watch.errors).toBe(1);
    expect(new Date(watch.nextCheckAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('queues a trip that has already ended for the next tick rather than marking it here', async () => {
    // One code path marks an order delivered. startWatch only ever schedules,
    // so a link pasted after the rider has already handed over goes through
    // exactly the same checks as every other order.
    const orderId = seedOrder();
    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: {
        now: NOW,
        readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered', endedAt: NOW.toISOString() })),
      },
    });

    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('watching');
    expect(watch.nextCheckAt).toBe(NOW.toISOString());
    expect(selectOne('sales_order', { order_id: orderId }).status).toBe('out_for_delivery');
  });

  it('starts over when a link is re-pasted on an order whose watch had closed', async () => {
    const orderId = seedOrder();
    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'cancelled', phase: 'cancelled' })) },
    });
    await runDeliveryWatchTick(NOW, {
      readPorterOrder: reader(porter({ status: 'cancelled', phase: 'cancelled' })),
    });
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].state).toBe('cancelled');

    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: 'https://porter.in/rd/newlink',
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })) },
    });
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('watching');
    expect(watch.closedAt).toBe(null);
    expect(watch.errors).toBe(0);
  });
});

describe('nextCheckAt', () => {
  it('never looks again sooner than the floor', () => {
    expect(nextCheckAt(NOW, later(0.5).toISOString())).toBe(later(POLL_FLOOR_MIN).toISOString());
  });

  it('never leaves a gap longer than the ceiling, however far out the ETA is', () => {
    // A long ETA is a guess. Waiting it out would leave an order that landed
    // early sitting un-invoiced until it expired.
    expect(nextCheckAt(NOW, later(90).toISOString())).toBe(later(POLL_CEILING_MIN).toISOString());
  });

  it('uses the ETA in between', () => {
    expect(nextCheckAt(NOW, later(6).toISOString())).toBe(later(6).toISOString());
  });

  it('copes with a missing or unreadable ETA', () => {
    expect(nextCheckAt(NOW, null)).toBe(later(POLL_FLOOR_MIN).toISOString());
    expect(nextCheckAt(NOW, 'not a date')).toBe(later(POLL_FLOOR_MIN).toISOString());
  });
});

describe('runDeliveryWatchTick', () => {
  const queue = async (overrides = {}) => {
    const orderId = seedOrder(overrides.order || {});
    await startWatch({
      orderId,
      orderName: `S00${orderId}`,
      trackingUrl: overrides.trackingUrl || LINK,
      deps: { now: NOW, readPorterOrder: reader(overrides.initial || porter({ status: 'live', phase: 'on_the_way' })) },
    });
    return orderId;
  };

  it('leaves orders alone until they are due', async () => {
    await queue();
    const readPorterOrder = reader(porter({ status: 'completed', phase: 'delivered' }));
    const result = await runDeliveryWatchTick(NOW, { readPorterOrder });
    expect(result.checked).toBe(0);
    expect(readPorterOrder).not.toHaveBeenCalled();
  });

  it('marks the order delivered when Porter says the trip ended', async () => {
    const orderId = await queue();
    const markDelivered = vi.fn(async () => ({ odooError: null, odooFulfilment: 'delivered' }));
    const result = await runDeliveryWatchTick(later(30), {
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered', endedAt: later(25).toISOString() })),
      markDelivered,
    });

    expect(result.delivered).toBe(1);
    expect(markDelivered).toHaveBeenCalledWith({ orderId, orderName: 'S00101', channel: 'B2C' });
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('delivered');
    // Porter's own handover time, not the moment the tick noticed it.
    expect(watch.porterEndedAt).toBe(later(25).toISOString());
  });

  it('never marks delivered on anything but Porter’s own end states', async () => {
    // The whole point. A status that is not `ended` or `completed` keeps the
    // order where it is, however long the trip has run and however close the
    // rider is to the drop.
    for (const status of ['open', 'allocated', 'accepted', 'live', 'loading', 'unloading', 'a_new_state']) {
      run('DELETE FROM delivery_watch');
      run('DELETE FROM sales_order');
      const orderId = await queue();
      const markDelivered = vi.fn();
      await runDeliveryWatchTick(later(30), {
        readPorterOrder: reader(porter({ status, phase: status === 'unloading' || status === 'a_new_state' ? 'on_the_way' : status === 'open' || status === 'allocated' ? 'searching' : 'on_the_way' })),
        markDelivered,
      });
      expect(markDelivered, `status ${status} must not mark delivered`).not.toHaveBeenCalled();
      expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].state).toBe('watching');
    }
  });

  it('recomputes the ETA from where the rider now is', async () => {
    const orderId = await queue();
    const at = later(30);
    await runDeliveryWatchTick(at, {
      readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way', etaMinutes: 4, now: at })),
    });
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.checks).toBe(2);
    expect(watch.nextCheckAt).toBe(new Date(at.getTime() + 4 * 60000).toISOString());
  });

  it('closes without touching Odoo when Porter cancels the trip', async () => {
    const orderId = await queue();
    const markDelivered = vi.fn();
    const result = await runDeliveryWatchTick(later(30), {
      readPorterOrder: reader(porter({ status: 'cancelled', phase: 'cancelled' })),
      markDelivered,
    });

    expect(result.cancelled).toBe(1);
    expect(markDelivered).not.toHaveBeenCalled();
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].state).toBe('cancelled');
    expect(selectOne('sales_order', { order_id: orderId }).status).toBe('out_for_delivery');
  });

  it('backs off and retries when Porter cannot be reached', async () => {
    const orderId = await queue();
    const at = later(30);
    await runDeliveryWatchTick(at, { readPorterOrder: reader(new Error('ETIMEDOUT')) });

    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('watching');
    expect(watch.errors).toBe(1);
    expect(watch.lastError).toBe('ETIMEDOUT');
    expect(new Date(watch.nextCheckAt).getTime()).toBeGreaterThan(at.getTime());
  });

  it('clears the error count once a read works again', async () => {
    const orderId = await queue();
    await runDeliveryWatchTick(later(30), { readPorterOrder: reader(new Error('ETIMEDOUT')) });
    await runDeliveryWatchTick(later(60), {
      readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way', now: later(60) })),
    });
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.errors).toBe(0);
    expect(watch.lastError).toBe(null);
  });

  it('gives up on a link that keeps failing rather than retrying forever', async () => {
    const orderId = await queue();
    let at = NOW;
    for (let i = 0; i < 14; i += 1) {
      at = new Date(at.getTime() + 30 * 60000);
      await runDeliveryWatchTick(at, { readPorterOrder: reader(new Error('ETIMEDOUT')) });
      if (getDeliveryWatches({ orderIds: [orderId] })[orderId].state !== 'watching') break;
    }
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].state).toBe('given_up');
  });

  it('gives up on a trip that is still running many hours later', async () => {
    const orderId = await queue();
    const result = await runDeliveryWatchTick(later((MAX_WATCH_HOURS + 1) * 60), {
      readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })),
    });
    expect(result.gaveUp).toBe(1);
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('given_up');
    // Not marked delivered — an order nobody can account for is a question for
    // a human, not a status to invent.
    expect(selectOne('sales_order', { order_id: orderId }).status).toBe('out_for_delivery');
  });

  it('stands down when the order was marked delivered by hand', async () => {
    const orderId = await queue();
    run("UPDATE sales_order SET status = 'delivered' WHERE order_id = ?", orderId);
    const markDelivered = vi.fn();
    await runDeliveryWatchTick(later(30), {
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered' })),
      markDelivered,
    });

    expect(markDelivered).not.toHaveBeenCalled();
    const watch = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(watch.state).toBe('stopped');
    expect(watch.closedReason).toBe('already_delivered');
  });

  it('stands down when the order’s tracking link was changed underneath it', async () => {
    const orderId = await queue();
    run("UPDATE sales_order SET tracking_url = 'https://porter.in/rd/other' WHERE order_id = ?", orderId);
    const markDelivered = vi.fn();
    await runDeliveryWatchTick(later(30), {
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered' })),
      markDelivered,
    });
    // Following a stale link could mark this order delivered off a different
    // rider's trip.
    expect(markDelivered).not.toHaveBeenCalled();
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].closedReason).toBe('tracking_link_changed');
  });

  it('keeps the watch open when Odoo refuses the status, and retries it', async () => {
    const orderId = await queue();
    const markDelivered = vi
      .fn()
      .mockResolvedValueOnce({ odooError: 'XML-RPC: connection refused' })
      .mockResolvedValueOnce({ odooError: null, odooFulfilment: 'delivered' });

    const first = await runDeliveryWatchTick(later(30), {
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered' })),
      markDelivered,
    });
    expect(first.delivered).toBe(0);
    const pending = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    // Still open, and still due — a watch closed on a failed Odoo push is
    // precisely the un-invoiced order this exists to prevent.
    expect(pending.state).toBe('watching');
    expect(pending.closedAt).toBe(null);
    expect(pending.lastError).toContain('connection refused');

    const second = await runDeliveryWatchTick(later(120), {
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered' })),
      markDelivered,
    });
    expect(second.delivered).toBe(1);
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId].state).toBe('delivered');
  });

  it('carries on down the queue when one order throws', async () => {
    const good = await queue();
    run('DELETE FROM delivery_watch');
    run('DELETE FROM sales_order');
    seedOrder({ orderId: 101 });
    seedOrder({ orderId: 102 });
    await startWatch({
      orderId: 101,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })) },
    });
    await startWatch({
      orderId: 102,
      orderName: 'S00102',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })) },
    });

    let call = 0;
    const readPorterOrder = vi.fn(async () => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('boom'), { code: 'WEIRD' });
      return porter({ status: 'live', phase: 'on_the_way', now: later(30) });
    });
    const result = await runDeliveryWatchTick(later(30), { readPorterOrder });
    expect(result.checked).toBe(2);
    expect(readPorterOrder).toHaveBeenCalledTimes(2);
    expect(good).toBe(101);
  });

  it('catches up on everything that came due while the server was down', async () => {
    // The restart case: this server restarts on every backend edit, so the
    // first tick after boot routinely finds work that was due an hour ago.
    seedOrder({ orderId: 101 });
    seedOrder({ orderId: 102 });
    for (const orderId of [101, 102]) {
      await startWatch({
        orderId,
        orderName: `S00${orderId}`,
        trackingUrl: LINK,
        deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })) },
      });
    }
    const markDelivered = vi.fn(async () => ({ odooError: null }));
    const result = await runDeliveryWatchTick(later(90), {
      readPorterOrder: reader(porter({ status: 'ended', phase: 'delivered', endedAt: later(45).toISOString() })),
      markDelivered,
    });
    expect(result.checked).toBe(2);
    expect(result.delivered).toBe(2);
  });
});

describe('checkWatchNow', () => {
  it('checks an order before it is due', async () => {
    const orderId = seedOrder();
    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way', etaMinutes: 40 })) },
    });
    const markDelivered = vi.fn(async () => ({ odooError: null }));
    const result = await checkWatchNow(orderId, {
      now: later(1),
      readPorterOrder: reader(porter({ status: 'completed', phase: 'delivered' })),
      markDelivered,
    });
    expect(result.outcome).toBe('delivered');
    expect(result.watch.state).toBe('delivered');
  });

  it('refuses an order that is not being watched', async () => {
    await expect(checkWatchNow(999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('stopWatch', () => {
  it('closes an open watch and leaves a closed one alone', async () => {
    const orderId = seedOrder();
    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way' })) },
    });
    expect(stopWatch(orderId, 'delivered_on_the_board').state).toBe('stopped');
    expect(stopWatch(orderId, 'again')).toBe(null);
    expect(get("SELECT closed_reason FROM delivery_watch WHERE order_id = ?", orderId).closed_reason).toBe(
      'delivered_on_the_board',
    );
  });

  it('is a no-op for an order that was never watched', () => {
    expect(stopWatch(12345)).toBe(null);
  });
});

describe('backfillWatches', () => {
  it('picks up an order that is out with a Porter link and no watch on it', () => {
    seedOrder({ orderId: 101 });
    run("UPDATE sales_order SET out_for_delivery_at = ? WHERE order_id = 101", NOW.toISOString());
    expect(backfillWatches(later(30))).toEqual(['S00101']);
    const watch = getDeliveryWatches({ orderIds: [101] })[101];
    expect(watch.state).toBe('watching');
    // Due now — the tick reads Porter and takes it from there, through the
    // same checks as any other order. The backfill itself concludes nothing.
    expect(watch.porterStatus).toBe(null);
    expect(new Date(watch.nextCheckAt).getTime()).toBeLessThanOrEqual(later(30).getTime());
  });

  it('leaves history alone', () => {
    // Marking a week-old order Delivered would post an invoice in Odoo that
    // nobody asked for. The backfill is for what is still in flight.
    seedOrder({ orderId: 101 });
    run("UPDATE sales_order SET out_for_delivery_at = ? WHERE order_id = 101", NOW.toISOString());
    expect(backfillWatches(later((MAX_WATCH_HOURS + 1) * 60))).toEqual([]);
    expect(openWatchCount()).toBe(0);
  });

  it('skips orders that are delivered, not out yet, or on another courier', async () => {
    seedOrder({ orderId: 101, status: 'delivered' });
    seedOrder({ orderId: 102, status: 'packed' });
    seedOrder({ orderId: 103, trackingUrl: 'https://dunzo.in/t/abc' });
    run("UPDATE sales_order SET out_for_delivery_at = ? WHERE order_id IN (101, 103)", NOW.toISOString());
    expect(backfillWatches(later(30))).toEqual([]);
  });

  it('does not disturb an order that is already being watched', async () => {
    const orderId = seedOrder();
    run("UPDATE sales_order SET out_for_delivery_at = ? WHERE order_id = ?", NOW.toISOString(), orderId);
    await startWatch({
      orderId,
      orderName: 'S00101',
      trackingUrl: LINK,
      deps: { now: NOW, readPorterOrder: reader(porter({ status: 'live', phase: 'on_the_way', etaMinutes: 40 })) },
    });
    const before = getDeliveryWatches({ orderIds: [orderId] })[orderId];
    expect(backfillWatches(later(5))).toEqual([]);
    expect(getDeliveryWatches({ orderIds: [orderId] })[orderId]).toEqual(before);
  });
});
