import React, { useEffect, useMemo, useState } from 'react';
import {
  BulkStatusBar,
  FulfilmentBadge,
  FulfilmentControl,
  useOrderFulfilment,
  type FulfilmentOrder,
  type PackStatusValue,
  type PackingStatus,
} from './orderFulfilment';
import {
  boxesSaved,
  buildOrderSideGroups,
  describePacking,
  sideBoxTotals,
  type PackOrder,
  type PackingResponse,
  type SidesByItem,
  type PackGroup,
} from './packing';

// Order Packing — shows individual orders (not the aggregated totals the
// Weekend Prep Planner works with) on a picker strip of groups, where picking
// one shows that group's dashboard underneath: what to toast/warm, how many
// side boxes, what to batch, then its orders in pack-first order with the
// full page width to spread across instead of a quarter of it.
//
// Both dashboards run this same board; `channel` decides whose orders and how
// they group (server/integrations/odoo.js fetchOrderPackingList):
//   B2C — individual customers, grouped into the weekend's four fixed
//         services (Sat/Sun × Lunch/Dinner), every one shown even when empty
//         because "Sunday Dinner is empty" is itself information.
//   B2B — company accounts, grouped by delivery DAY. Wholesale accounts have
//         an order day (see server/ops/b2b/b2bClients.js), not a lunch/dinner sitting,
//         so the groups are discovered from the orders rather than fixed.
// Everything downstream — the pack cards, the side-box maths, and the whole
// IN_SMOKER → DELIVERED pipeline in orderFulfilment.tsx (which stamps every
// stage onto Kitchen/order_lifecycle_log.csv) — is channel-agnostic and shared.

// Sides breakdown — same shape server/ops/b2c/recipes.js's computeSwiggyPlan returns
// (already used by the Weekend Prep Planner's "Sides needed" table), reused
// here scoped to just the selected slot's orders instead of the whole weekend.
type SideRow = {
  key: string;
  name: string;
  portions: number; // how many orders/dish-instances need this side
  totalQty: number;
  unit: string;
  hasUnparsedQty: boolean;
  // The box this side goes in and how many of them the portions above need
  // once its capacity is respected (server/core/packagingConfig.js). Counted one
  // plate at a time here, since this endpoint only sees slot totals — the
  // per-order numbers on the cards below are what actually combine.
  container: { materialId: string; name: string; capacity: number | null; portionCapacity: number | null } | null;
  boxes: number;
};
type SwiggyPlan = { sides: SideRow[]; gaps: string[] };

// Prep-before-packing breakdown — buns, taco shells, tortillas, garlic bread
// (server/ops/b2c/recipes.js computePrepPlan). Same shape as SideRow minus gaps and
// containers, since these are always direct raw-material quantities that go
// into the dish itself rather than a side box.
type PrepRow = { name: string; portions: number; totalQty: number; unit: string; hasUnparsedQty: boolean };
type PrepPlan = { prep: PrepRow[] };

// Quantities are summed from CSV decimals (0.1 of a baguette, 15 g of
// dressing) — trim the float dust before they hit a pack card.
const roundQty = (n: number) => Math.round(n * 100) / 100;

type PackChannel = 'B2C' | 'B2B';

// Wording that differs per channel — the board itself is identical.
const CHANNEL_COPY: Record<PackChannel, { groupNoun: string; fetchHint: string; intro: string }> = {
  B2C: {
    groupNoun: 'delivery slot',
    fetchHint: 'Pulls confirmed, individual-customer Sales Orders — B2B/corporate orders are excluded.',
    intro:
      'Pick a delivery slot — Saturday Lunch, Saturday Dinner, Sunday Lunch or Sunday Dinner — and that slot’s orders fill the page',
  },
  B2B: {
    groupNoun: 'delivery day',
    fetchHint: 'Pulls confirmed Sales Orders for company accounts only — individual B2C orders are excluded.',
    intro: 'Pick a delivery day and that day’s wholesale orders fill the page',
  },
};

const formatDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The Odoo fetch filters on the PROMISED time (commitment_date), so this
// window picks a SERVICE weekend — not "when the order was typed in", which is
// what the old last-Fri-through-Mon default meant. Defaults to the Mon→Sun
// week containing the next Sat/Sun (the current weekend once it's Sat or Sun),
// since that's the weekend being prepped and packed for.
//
// The Monday start is load-bearing, not padding: an order with no promised
// time falls back to its date_order (server/integrations/odoo.js weekendOrderDomain), so
// the window must still cover the week it was placed in or it drops out
// entirely instead of surfacing as needs-fixing. Same default in the Weekend
// Prep Planner — keep the two in sync.
const getDefaultOdooRange = () => {
  const today = new Date();
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + ((7 - today.getDay()) % 7));
  const monday = new Date(sunday);
  monday.setDate(sunday.getDate() - 6);
  return { from: formatDateInput(monday), to: formatDateInput(sunday) };
};
const DEFAULT_ODOO_RANGE = getDefaultOdooRange();

// B2B deliveries land on whatever weekday the account ordered for, so the
// range that matters is the week ahead rather than the coming weekend.
const getDefaultB2BRange = () => {
  const today = new Date();
  const weekOut = new Date(today);
  weekOut.setDate(today.getDate() + 7);
  return { from: formatDateInput(today), to: formatDateInput(weekOut) };
};
const DEFAULT_B2B_RANGE = getDefaultB2BRange();

// packBy is Odoo's naive-UTC 'YYYY-MM-DD HH:mm:ss', so it needs both the
// space-to-T fixup and an explicit 'Z' — without the Z it parses as local time
// and reads 5½ hours early, which would contradict the Lunch/Dinner slot the
// server derived from this very field (server/integrations/odoo.js slotFromPromisedTime).
// Time only, no weekday: the picker strip already says which day this is.
const formatPackBy = (iso: string | null) => {
  if (!iso) return 'No time on file';
  const d = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
  });
};

// Pre-packing guidelines for whichever slot is selected. Worked out from just
// that slot's orders, so what's on screen is what this slot alone needs — the
// endpoints are the same order-counts-driven ones the Weekend Prep Planner
// uses, called again with the slot's own counts.
function useSlotPlan<T>(endpoint: string, orderCounts: Record<string, number>, hasOrders: boolean) {
  const [plan, setPlan] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const countsKey = JSON.stringify(orderCounts);

  useEffect(() => {
    if (!hasOrders) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError('');

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderCounts: JSON.parse(countsKey) }),
    })
      .then(async (resp) => {
        let json: T & { error?: string };
        try {
          json = await resp.json();
        } catch {
          throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
        }
        if (!resp.ok) throw new Error(json.error || 'Failed to work this slot out.');
        if (!cancelled) setPlan(json);
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // countsKey is a stable stringified snapshot of orderCounts — re-fetches
    // only when the counts actually change, not on every re-render.
  }, [endpoint, countsKey, hasOrders]);

  return { plan, isLoading, error };
}

type SlotDashboardProps = {
  orders: PackOrder[];
  sidesByItem: SidesByItem | null;
  statuses: Record<string, PackingStatus>;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  isBulkBusy: boolean;
  onSetStatus: (order: FulfilmentOrder, status: Exclude<PackStatusValue, 'pending'>, deliveryPerson?: string) => void;
  onBulkApply: (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => void;
  onRetryInvoice: (order: FulfilmentOrder) => void;
};

const SlotDashboard: React.FC<SlotDashboardProps> = ({
  orders,
  sidesByItem,
  statuses,
  busy,
  errors,
  isBulkBusy,
  onSetStatus,
  onBulkApply,
  onRetryInvoice,
}) => {
  // { menuItemId -> total ordered } for just this slot — the same input shape
  // the Weekend Prep Planner sends, scoped down to one slot.
  const orderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    orders.forEach((order) => {
      order.items.forEach((item) => {
        counts[item.itemId] = (counts[item.itemId] || 0) + item.qty;
      });
    });
    return counts;
  }, [orders]);

  // Per-item totals across every order in this slot — "how much of each item
  // to pack", plus which items are worth batching because 2+ orders need them.
  const { itemTotals, combineItems } = useMemo(() => {
    const totals = new Map<string, { name: string; qty: number; orderCount: number }>();
    orders.forEach((order) => {
      order.items.forEach((item) => {
        if (!totals.has(item.itemId)) totals.set(item.itemId, { name: item.name, qty: 0, orderCount: 0 });
        const entry = totals.get(item.itemId)!;
        entry.qty += item.qty;
        entry.orderCount += 1;
      });
    });
    const sorted = Array.from(totals.values()).sort((a, b) => b.qty - a.qty);
    return { itemTotals: sorted, combineItems: sorted.filter((t) => t.orderCount >= 2) };
  }, [orders]);

  const hasOrders = orders.length > 0;
  const { plan: prepPlan, isLoading: isLoadingPrep, error: prepError } = useSlotPlan<PrepPlan>(
    '/api/recipes/prep-plan',
    orderCounts,
    hasOrders,
  );
  const { plan: sidesPlan, isLoading: isLoadingSides, error: sidesError } = useSlotPlan<SwiggyPlan>(
    '/api/recipes/swiggy-plan',
    orderCounts,
    hasOrders,
  );

  // Box counts for the slot, summed order by order so sides that share a
  // container inside one order only count once — the "Sides to box" tile
  // reads these instead of the plate-by-plate number the endpoint above can
  // work out from slot totals alone. Keyed the same way both sides key.
  const slotSideBoxes = useMemo(
    () => new Map(sideBoxTotals(orders, sidesByItem).map((row) => [row.key, row])),
    [orders, sidesByItem],
  );

  if (!hasOrders) return <p className="pack-slot-empty">Nothing for this slot.</p>;

  return (
    <>
      <div className="pack-guides">
        <div className="pack-guide">
          <h4>📋 What to pack</h4>
          <ul className="pack-guide-list">
            {itemTotals.map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <strong>{t.qty}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div className="pack-guide">
          <h4>🍞 Prep before packing</h4>
          {isLoadingPrep && <p className="pack-guide-note">Working it out…</p>}
          {prepError && <p className="chat-error">{prepError}</p>}
          {prepPlan && prepPlan.prep.length > 0 && (
            <ul className="pack-guide-list">
              {prepPlan.prep.map((p) => (
                <li key={p.name}>
                  <span>
                    {p.name}
                    {p.hasUnparsedQty && <span className="inv-assumed">partial</span>}
                  </span>
                  <strong>
                    {p.totalQty} <span className="pack-prep-unit">{p.unit}</span>
                  </strong>
                </li>
              ))}
            </ul>
          )}
          {prepPlan && prepPlan.prep.length === 0 && !isLoadingPrep && (
            <p className="pack-guide-note">Nothing to toast/warm for this slot.</p>
          )}
        </div>

        <div className="pack-guide">
          <h4>🥡 Sides to pack</h4>
          {isLoadingSides && <p className="pack-guide-note">Working it out…</p>}
          {sidesError && <p className="chat-error">{sidesError}</p>}
          {sidesPlan && sidesPlan.sides.length > 0 && (
            <ul className="pack-guide-list">
              {sidesPlan.sides.map((side) => {
                // The server row counts a box per plate (it only sees slot
                // totals); this slot's individual orders are right here, so
                // prefer the number that accounts for combining within each
                // order and falls back to the server's only if a side has no
                // matching row (a menu item with no sides-by-item entry yet).
                const exact = slotSideBoxes.get(side.key);
                const boxes = exact ? exact.boxes : side.boxes;
                return (
                  <li key={side.key} className="pack-guide-stacked">
                    <span>
                      {side.name}
                      {side.hasUnparsedQty && <span className="inv-assumed">partial</span>}
                    </span>
                    <strong>
                      {side.portions}
                      <span className="pack-prep-unit"> portion{side.portions === 1 ? '' : 's'}</span>
                      {/* How many portions to make leads; how they're boxed is
                          the subtext under it — the kitchen counts servings,
                          then packs them. */}
                      <span className="pack-guide-sub">
                        {describePacking(side.portions, boxes, side.container)} · {side.totalQty} {side.unit}
                      </span>
                    </strong>
                  </li>
                );
              })}
            </ul>
          )}
          {sidesPlan && sidesPlan.sides.length === 0 && !isLoadingSides && (
            <p className="pack-guide-note">No sides on file for this slot's items yet.</p>
          )}
          {sidesPlan && sidesPlan.gaps.length > 0 && (
            <div className="prep-unmatched">
              <strong>Data gaps:</strong>
              <ul>
                {sidesPlan.gaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {combineItems.length > 0 && (
          <div className="pack-guide">
            <h4>🔗 Batch together</h4>
            <div className="pack-combine-box">
              {combineItems.map((t) => (
                <div key={t.name} className="pack-combine-item">
                  <span className="pack-combine-name">{t.name}</span>
                  <span className="pack-combine-count">
                    {t.qty} / {t.orderCount} orders
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <h4 className="pack-orders-title">📦 Orders — pack in this order</h4>
      <BulkStatusBar orders={orders} statuses={statuses} busy={isBulkBusy} onApply={onBulkApply} />

      <div className="pack-order-grid">
        {orders.map((order, index) => {
          const sideGroups = buildOrderSideGroups(order, sidesByItem);
          // "Combinable" now means the container capacity actually lets the
          // portions share a box — 4 salads fit one 30 oz tray, but 4 BBQ
          // sauces are 4 full 30 ml cups and combine into nothing.
          const combinable = sideGroups.filter((g) => g.boxes < g.portions);
          const singles = sideGroups.filter((g) => g.boxes >= g.portions);
          const containersSaved = sideGroups.reduce((sum, g) => sum + boxesSaved(g), 0);
          const orderBoxes = sideGroups.reduce((sum, g) => sum + g.boxes, 0);
          const key = String(order.orderId);

          return (
            <div key={order.orderId} className="pack-order-card">
              <div className="pack-order-header">
                <span className="pack-order-rank">#{index + 1}</span>
                <span className="pack-order-name">{order.orderName}</span>
                <FulfilmentBadge order={order} status={statuses[key]} />
              </div>
              <div className="pack-order-customer">
                <span>{order.customer}</span>
                <span className="pack-order-time">{formatPackBy(order.packBy)}</span>
              </div>

              <FulfilmentControl
                order={order}
                status={statuses[key]}
                busy={Boolean(busy[key])}
                error={errors[key]}
                onSetStatus={onSetStatus}
                onRetryInvoice={onRetryInvoice}
              />

              <ul className="pack-order-items">
                {order.items.map((item) => (
                  <li key={item.itemId}>
                    <span>{item.name}</span>
                    <span className="pack-order-item-qty">× {item.qty}</span>
                  </li>
                ))}
              </ul>

              {sideGroups.length > 0 && (
                <div className="pack-order-smart">
                  <div className="pack-order-smart-title">
                    📦 Pack smart
                    <span className="pack-order-boxes">
                      {orderBoxes} box{orderBoxes === 1 ? '' : 'es'}
                    </span>
                    {containersSaved > 0 && (
                      <span className="pack-order-savings">
                        saves {containersSaved} container{containersSaved === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  {combinable.length > 0 ? (
                    <ul className="pack-order-smart-list">
                      {combinable.map((g) => (
                        <li key={g.key} className="pack-order-smart-combine">
                          <span className="pack-smart-line">
                            <span className="pack-smart-main">
                              {g.portions}× <strong>{g.name}</strong>
                              {g.baseQty != null ? ` (${roundQty(g.baseQty)} ${g.baseUnit})` : ''}
                            </span>
                            <span className="pack-smart-sub">
                              Combine into {describePacking(g.portions, g.boxes, g.container)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="inv-note">Nothing combines here — every side already fills its own box.</p>
                  )}
                  {singles.length > 0 && (
                    <ul className="pack-order-smart-list">
                      {singles.map((g) => (
                        <li key={g.key} className="pack-order-smart-single">
                          <span className="pack-smart-line">
                            <span className="pack-smart-main">
                              {g.portions}× <strong>{g.name}</strong>
                              {g.baseQty != null ? ` (${roundQty(g.baseQty)} ${g.baseUnit})` : ''}
                            </span>
                            <span className="pack-smart-sub">
                              {describePacking(g.portions, g.boxes, g.container)}
                              {g.boxes === g.portions && g.portions > 1 && !g.container?.portionCapacity
                                ? ' — one each, they won’t share'
                                : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
};

const OrderPacking: React.FC<{ channel?: PackChannel }> = ({ channel = 'B2C' }) => {
  const defaultRange = channel === 'B2B' ? DEFAULT_B2B_RANGE : DEFAULT_ODOO_RANGE;
  const copy = CHANNEL_COPY[channel];
  const [odooFrom, setOdooFrom] = useState(defaultRange.from);
  const [odooTo, setOdooTo] = useState(defaultRange.to);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<PackingResponse | null>(null);
  // One group's dashboard at a time — the picker strip below chooses which.
  // Held as an id rather than an index so a re-fetch that adds or drops a B2B
  // delivery day doesn't silently slide whoever's packing onto another day;
  // an id that's gone falls back to the first group instead.
  const [activeGroupId, setActiveGroupId] = useState('');

  // Static reference data (which sides each menu item needs) — same for
  // every order, so fetched once rather than per-order or per-slot.
  const [sidesByItem, setSidesByItem] = useState<SidesByItem | null>(null);
  useEffect(() => {
    fetch('/api/recipes/sides-by-item')
      .then((resp) => resp.json())
      .then((json: { sidesByItem?: SidesByItem }) => setSidesByItem(json.sidesByItem || {}))
      .catch(() => setSidesByItem({})); // non-fatal — per-order combine hints just won't show
  }, []);

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

  const groups = useMemo<PackGroup[]>(() => data?.groups || [], [data]);
  // The group being packed: whatever's selected, else the first one with
  // orders in it (an empty Saturday Lunch shouldn't be what the board opens
  // on), else just the first.
  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || groups.find((g) => g.orders.length > 0) || groups[0] || null,
    [groups, activeGroupId],
  );

  // Pipeline state is loaded for every group in range, not just the visible
  // one, so switching groups costs nothing.
  const allOrders = useMemo(() => groups.flatMap((g) => g.orders), [groups]) as PackOrder[];
  const fulfilment = useOrderFulfilment(
    useMemo(() => allOrders.map((o) => o.orderId), [allOrders]),
    channel,
  );

  // Bulk apply walks the orders one at a time (see setStatusBulk), so the bar
  // needs its own busy flag rather than reading any single order's.
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const handleBulkApply = async (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => {
    setIsBulkBusy(true);
    try {
      await fulfilment.setStatusBulk(orders, status);
    } finally {
      setIsBulkBusy(false);
    }
  };

  const hasResult = data != null;

  return (
    <div className="wizard-page">
      <div className="wizard-header">
        <h1>Order Packing{channel === 'B2B' ? ' — B2B' : ''}</h1>
        <p>
          {copy.intro}: what to toast/warm, how many side boxes, what's worth batching, then each order in
          promised-time order, earliest first. Each order's Fulfilment Status dropdown writes straight to Odoo
          (IN_SMOKER → PREPPING → PACKED → PARTNER_ASGN → OUT_FOR_DEL → DELIVERED) and is logged with its timestamp,
          or start the whole {copy.groupNoun} at once from the bulk bar. Marking Delivered also creates and posts the
          invoice, moving Odoo on to INVOICED.
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
                {isFetching ? 'Fetching…' : 'Fetch orders'}
              </button>
              <span className="prep-paste-hint">{copy.fetchHint}</span>
            </div>
            {error && <p className="chat-error">{error}</p>}
            {hasResult && !error && (
              <p className="status-message">
                Found {data!.ordersFound} order{data!.ordersFound === 1 ? '' : 's'} in that range.
              </p>
            )}
          </div>

          {data && data.unmatched.length > 0 && (
            <div className="prep-unmatched">
              <strong>Couldn't confidently place these — check Odoo and re-fetch:</strong>
              <ul>
                {data.unmatched.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {!hasResult && (
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
              <h3>No orders fetched yet</h3>
              <p>Pick a date range above and fetch — the {copy.groupNoun}s build themselves from confirmed Odoo orders.</p>
              <span className="badge-soon">Nothing to pack</span>
            </div>
          )}

          {hasResult && groups.length === 0 && (
            <p className="status-message">
              No {copy.groupNoun}s in that range — nothing confirmed in Odoo for {channel} between those dates.
            </p>
          )}

          {hasResult && groups.length > 0 && (
            <>
              {/* Empty B2C slots stay on the strip — the weekend has a fixed
                  four, and an empty one is part of its shape at a glance. B2B
                  days only exist where there's something to deliver, so the
                  strip is however many the range turned up. */}
              <div className="slot-picker">
                {groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`slot-picker-btn ${activeGroup?.id === group.id ? 'active' : ''} ${
                      group.orders.length === 0 ? 'empty' : ''
                    }`}
                    onClick={() => setActiveGroupId(group.id)}
                  >
                    <span className="slot-picker-name">
                      {group.emoji} {group.label}
                    </span>
                    <span className="slot-picker-count">
                      {group.orders.length} order{group.orders.length === 1 ? '' : 's'} ·{' '}
                      {group.orders.reduce((sum, o) => sum + o.itemCount, 0)} items
                    </span>
                  </button>
                ))}
              </div>

              <SlotDashboard
                orders={activeGroup?.orders || []}
                sidesByItem={sidesByItem}
                statuses={fulfilment.statuses}
                busy={fulfilment.busy}
                errors={fulfilment.errors}
                isBulkBusy={isBulkBusy}
                onSetStatus={fulfilment.setStatus}
                onBulkApply={handleBulkApply}
                onRetryInvoice={fulfilment.retryInvoice}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default OrderPacking;
