import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveStatus,
  useOrderFulfilment,
  type FulfilmentOrder,
  type PackingStatus,
} from './orderFulfilment';
import {
  SMOKER_LOADS,
  defaultB2BRange,
  defaultWeekendRange,
  formatDateInput,
  orderNeedsLoad,
  smokerDays,
  type MeatByItem,
  type PackGroup,
  type PackOrder,
  type PackingResponse,
  type SmokerDay,
  type SmokerLoad,
} from './packing';
import { usePersistedState } from '../../../lib/usePersistedState';

// Set Smoker Status — the step that comes immediately before Order Management
// on the B2C flow, and the only thing it does is put a whole day's meat on:
// one switch per smoker load (Pork, Beef, Chicken), per service day, sweeping every
// order that carries that meat to IN_SMOKER in one go.
//
// It's its own page rather than a panel on the Order Management board because
// the two are different moments in the morning. This one is flipped twice a
// day, from the pit, the second the meat goes on; the board next door is
// worked order by order for the rest of the service. Mixing them meant
// scrolling past forty order cards to reach two switches.
//
// The day split is the point (see smokerDays in packing.ts): Saturday's
// orders are smoked on Saturday and Sunday's on Sunday, so a single
// range-wide switch would drag Sunday's orders to IN_SMOKER a day early.
// Both days are shown at once — one is being lit, the other is tomorrow's
// count, which is worth seeing while the pit is still cold.
//
// Which orders a load covers comes from the recipes, not from the dish name:
// GET /api/recipes/meat-by-item maps every menu item to its smoked-meat
// components, so a combo platter carrying pork belly moves on the pork
// switch without anyone having to remember that it does. Jackfruit has no
// switch (see SMOKER_LOADS) — those orders are still driven one at a time
// from Order Management's per-order dropdown.

type PackChannel = 'B2C' | 'B2B';

const DEFAULT_ODOO_RANGE = defaultWeekendRange();
const DEFAULT_B2B_RANGE = defaultB2BRange();

// An order counts as "on" once it has left pending — in the smoker, or
// anywhere past it. A load whose orders are all packed already is done, not
// waiting to be lit.
const hasMoved = (order: FulfilmentOrder, status: PackingStatus | undefined) =>
  effectiveStatus(order, status) !== 'pending';

type LoadCardProps = {
  day: SmokerDay;
  load: SmokerLoad;
  meatByItem: MeatByItem | null;
  statuses: Record<string, PackingStatus>;
  // This card's own switch is mid-flight — it says "Working…".
  busy: boolean;
  // Some other card is mid-flight. setStatusBulk walks Odoo one order at a
  // time, so the rest of the board waits rather than stacking requests
  // behind it.
  locked: boolean;
  onLight: (orders: PackOrder[]) => void;
};

// One switch and the orders behind it. The list is shown rather than just a
// count because flipping this writes to every one of those sale orders in
// Odoo — the pitmaster should be able to see what is about to move.
const LoadCard: React.FC<LoadCardProps> = ({ day, load, meatByItem, statuses, busy, locked, onLight }) => {
  const orders = useMemo(
    () => day.orders.filter((order) => orderNeedsLoad(order, meatByItem, load)),
    [day.orders, meatByItem, load],
  );
  const waiting = orders.filter((order) => !hasMoved(order, statuses[String(order.orderId)]));
  const isOn = orders.length > 0 && waiting.length === 0;
  // Nothing to do in either direction: no orders need this meat today, or
  // every one of them is already on.
  const disabled = busy || locked || orders.length === 0 || waiting.length === 0;

  return (
    <div className={`smoker-load ${isOn ? 'on' : ''} ${orders.length === 0 ? 'empty' : ''}`}>
      <div className="smoker-load-head">
        <span className="smoker-load-name">
          {load.emoji} {load.label}
        </span>
        <label className="smoker-switch">
          <input
            type="checkbox"
            checked={isOn}
            disabled={disabled}
            onChange={() => {
              if (!disabled) onLight(waiting);
            }}
          />
          <span className="smoker-switch-track" />
          <span className="smoker-switch-label">
            {busy ? 'Working…' : isOn ? 'On the smoker' : `Put ${load.label.toLowerCase()} on`}
          </span>
        </label>
      </div>

      <p className="smoker-load-count">
        {orders.length === 0
          ? `No ${day.label} order needs ${load.label.toLowerCase()}.`
          : isOn
            ? `All ${orders.length} ${day.label} order${orders.length === 1 ? '' : 's'} with ${load.label.toLowerCase()} are in the smoker.`
            : `${waiting.length} of ${orders.length} ${day.label} order${orders.length === 1 ? '' : 's'} with ${load.label.toLowerCase()} still to move → IN_SMOKER.`}
      </p>

      {orders.length > 0 && (
        <ul className="smoker-load-orders">
          {orders.map((order) => {
            const moved = hasMoved(order, statuses[String(order.orderId)]);
            return (
              <li key={order.orderId} className={moved ? 'moved' : ''}>
                <span className="smoker-order-name">{order.orderName}</span>
                <span className="smoker-order-customer">{order.customer}</span>
                <span className="smoker-order-stage">{moved ? '🔥 On' : 'Waiting'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const SmokerStatus: React.FC<{ channel?: PackChannel }> = ({ channel = 'B2C' }) => {
  const defaultRange = channel === 'B2B' ? DEFAULT_B2B_RANGE : DEFAULT_ODOO_RANGE;

  // Same persisted range as Order Management, under its own key: this step
  // and that one are opened at different points in the day and a range
  // narrowed here is not a range meant for there. A window whose end has
  // already passed is dropped rather than restored — see the note on Order
  // Management's copy.
  const [range, setRange] = usePersistedState(
    `smokerings.smokerStatus.${channel}.range`,
    defaultRange,
    (stored) => {
      if (!stored || typeof stored !== 'object') return undefined;
      const { from, to } = stored as Record<string, unknown>;
      if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return undefined;
      return to >= formatDateInput(new Date()) ? { from, to } : undefined;
    },
  );
  const { from: odooFrom, to: odooTo } = range;
  const setOdooFrom = (from: string) => setRange((current) => ({ ...current, from }));
  const setOdooTo = (to: string) => setRange((current) => ({ ...current, to }));
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<PackingResponse | null>(null);

  const handleFetch = async () => {
    if (!odooFrom || !odooTo || isFetching) return;
    setIsFetching(true);
    setError('');
    try {
      const resp = await fetch(
        `/api/odoo/order-packing?from=${odooFrom}&to=${odooTo}&channel=${channel.toLowerCase()}`,
      );
      let json: PackingResponse & { error?: string };
      try {
        json = await resp.json();
      } catch {
        throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
      }
      if (!resp.ok) throw new Error(json.error || 'Odoo request failed.');
      setData(json);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsFetching(false);
    }
  };

  // Same auto-fetch as Order Management: opening the step is the fetch. The
  // ref keeps StrictMode's double-mount from firing a second request.
  const autoFetchedRange = useRef('');
  useEffect(() => {
    if (!odooFrom || !odooTo) return;
    const key = `${channel}|${odooFrom}|${odooTo}`;
    if (autoFetchedRange.current === key) return;
    autoFetchedRange.current = key;
    void handleFetch();
  }, [channel, odooFrom, odooTo]);

  // Which dish carries which meat. Static reference data, so it's fetched
  // once and never with the orders. Failing here is not cosmetic — without
  // it no order can be matched to a load, so the switches say so rather than
  // sitting there reading "nothing needs pork" (see orderNeedsLoad, which
  // deliberately matches nothing rather than guessing).
  const [meatByItem, setMeatByItem] = useState<MeatByItem | null>(null);
  const [meatError, setMeatError] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/recipes/meat-by-item')
      .then(async (resp) => {
        const json: { meatByItem?: MeatByItem; error?: string } = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Could not load the meat-by-dish reference.');
        if (!cancelled) setMeatByItem(json.meatByItem || {});
      })
      .catch((err) => {
        if (!cancelled) setMeatError(String((err as Error).message || err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo<PackGroup[]>(() => data?.groups || [], [data]);
  const days = useMemo(() => smokerDays(groups), [groups]);

  // Pipeline state for every order in range, so a switch knows what is
  // already on without a second fetch per day.
  const allOrders = useMemo(() => groups.flatMap((g) => g.orders), [groups]) as PackOrder[];
  const fulfilment = useOrderFulfilment(
    useMemo(() => allOrders.map((o) => o.orderId), [allOrders]),
    channel,
  );

  // One switch at a time. setStatusBulk walks the orders sequentially (it
  // tags each one in Odoo), so the whole board locks while a load is going
  // on rather than letting a second switch stack requests behind the first.
  const [lightingKey, setLightingKey] = useState('');
  const handleLight = async (key: string, orders: PackOrder[]) => {
    if (!orders.length || lightingKey) return;
    setLightingKey(key);
    try {
      await fulfilment.setStatusBulk(orders, 'in_smoker');
    } finally {
      setLightingKey('');
    }
  };

  const hasResult = data != null;

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Set Smoker Status{channel === 'B2B' ? ' — B2B' : ''}</h1>
        <p>
          Put the weekend's meat on. Each switch moves every {channel === 'B2B' ? 'delivery day' : 'Saturday or Sunday'}{' '}
          order carrying that meat to IN_SMOKER in Odoo, stamped with the time — one switch per load,
          per day. Everything after this (prepping, packing, delivery) is Order Management, the next step.
        </p>
      </div>

      <div className="wizard-shell">
        <div className="wizard-card">
          <div className="prep-paste-panel">
            <label>
              Fetch from Odoo — confirmed {channel} orders in a date range
              <div className="prep-odoo-dates">
                <span>
                  From
                  <input type="date" value={odooFrom} onChange={(e) => setOdooFrom(e.target.value)} />
                </span>
                <span>
                  To
                  <input type="date" value={odooTo} onChange={(e) => setOdooTo(e.target.value)} />
                </span>
              </div>
            </label>
            <div className="prep-paste-actions">
              <button
                type="button"
                className="primary-button"
                onClick={handleFetch}
                disabled={!odooFrom || !odooTo || isFetching}
              >
                {isFetching ? 'Fetching…' : 'Refresh orders'}
              </button>
              <span className="prep-paste-hint">
                Same weekend the Order Management board opens on — change the range here and it only changes here.
              </span>
            </div>
            {error && <p className="chat-error">{error}</p>}
          </div>

          {meatError && (
            <p className="chat-error">
              🍖 Could not load which dish carries which meat, so no order can be matched to a switch:{' '}
              {meatError}
            </p>
          )}

          {!hasResult && !error && (
            <div className="empty-state">
              <div className="empty-state-icon">🔥</div>
              <h3>No orders fetched yet</h3>
              <p>Pick a date range above and fetch — the days build themselves from confirmed Odoo orders.</p>
              <span className="badge-soon">Nothing on the smoker</span>
            </div>
          )}

          {hasResult && days.length === 0 && (
            <p className="status-message">
              Nothing confirmed in Odoo for {channel} between those dates — no day to put on the smoker.
            </p>
          )}

          {hasResult &&
            days.map((day) => (
              <section key={day.id} className="smoker-day">
                <h4 className="pack-orders-title">
                  {day.emoji} {day.label} — {day.orders.length} order{day.orders.length === 1 ? '' : 's'}
                </h4>
                {day.orders.length === 0 ? (
                  <p className="pack-slot-empty">Nothing to smoke for {day.label}.</p>
                ) : (
                  <div className="smoker-loads">
                    {SMOKER_LOADS.map((load) => (
                      <LoadCard
                        key={load.id}
                        day={day}
                        load={load}
                        meatByItem={meatByItem}
                        statuses={fulfilment.statuses}
                        busy={lightingKey === `${day.id}:${load.id}`}
                        locked={lightingKey !== '' && lightingKey !== `${day.id}:${load.id}`}
                        onLight={(orders) => void handleLight(`${day.id}:${load.id}`, orders)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
        </div>
      </div>
    </div>
  );
};

export default SmokerStatus;
