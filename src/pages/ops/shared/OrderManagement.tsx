import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  defaultB2BRange,
  defaultWeekendRange,
  formatClockMinutes,
  formatDateInput,
  hasDeadline,
  leaveByMinutes,
  prioritiseOrders,
  sortByDistance,
  suggestedGroupId,
  type OrderTimePreference,
  type OrderTimePreferences,
  type PackOrder,
  type PackingResponse,
  type PackGroup,
} from './packing';
import { usePersistedState } from '../../../lib/usePersistedState';
import { copyToClipboard } from '../../../lib/clipboard';

// Order Management — the whole service-day board for individual orders (not
// the aggregated totals the Weekend Prep Planner works with), off one fetch:
// the range's orders on a picker strip of groups, each with its Odoo
// Fulfilment Status dropdown and the bulk bar. Pre-packing guidelines and the
// smoker-status switches used to live here as extra steps; they were taken
// out, leaving this page to do one thing — move orders through the pipeline.
//
// Both dashboards run this same board; `channel` decides whose orders and how
// they group (server/integrations/odoo.js fetchOrderPackingList):
//   B2C — individual customers, grouped into the weekend's four fixed
//         services (Sat/Sun × Lunch/Dinner), every one shown even when empty
//         because "Sunday Dinner is empty" is itself information.
//   B2B — company accounts, grouped by delivery DAY. Wholesale accounts have
//         an order day (see server/ops/b2b/b2bClients.js), not a lunch/dinner sitting,
//         so the groups are discovered from the orders rather than fixed.
// The IN_SMOKER → DELIVERED pipeline in orderFulfilment.tsx (which stamps every
// stage onto Kitchen/order_lifecycle_log.csv) is channel-agnostic and shared.

type PackChannel = 'B2C' | 'B2B';

// ---- What the browser keeps between visits ---------------------------------
// The fetched board and the Gemini read of its notes, each tagged with what it
// was for so a stale one is never shown against a different range or notes.
type BoardCache = { rangeKey: string; fetchedAt: number; data: PackingResponse };
type NotesCache = { notesKey: string; preferences: OrderTimePreferences };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const reviveBoardCache = (stored: unknown): BoardCache | undefined => {
  if (!isRecord(stored) || typeof stored.rangeKey !== 'string' || typeof stored.fetchedAt !== 'number') return undefined;
  const data = stored.data;
  if (!isRecord(data) || !Array.isArray(data.groups) || !Array.isArray(data.unmatched)) return undefined;
  return stored as BoardCache;
};

const reviveNotesCache = (stored: unknown): NotesCache | undefined =>
  isRecord(stored) && typeof stored.notesKey === 'string' && isRecord(stored.preferences)
    ? (stored as NotesCache)
    : undefined;

// "10:42 AM" today, "Sat 10:42 AM" otherwise — enough to tell a board pulled
// this morning from one left over from yesterday.
const formatFetchedAt = (at: number): string => {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-IN', {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
};

// Wording that differs per channel — the board itself is identical.
const CHANNEL_COPY: Record<
  PackChannel,
  { groupNoun: string; fetchHint: string }
> = {
  B2C: {
    groupNoun: 'delivery slot',
    fetchHint: 'Pulls confirmed, individual-customer Sales Orders — B2B/corporate orders are excluded.',
  },
  B2B: {
    groupNoun: 'delivery day',
    fetchHint: 'Pulls confirmed Sales Orders for company accounts only — individual B2C orders are excluded.',
  },
};

// Both defaults live in packing.ts so Set Smoker Status opens on the very
// same window — see the note there for why the B2C one starts on Monday.
const DEFAULT_ODOO_RANGE = defaultWeekendRange();
const DEFAULT_B2B_RANGE = defaultB2BRange();

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

// What the customer asked for about timing, read out of the order's Odoo note
// by Gemini (server/integrations/geminiContent.js readOrderTimePreferences). Rendered as a
// callout rather than a chip because the customer's own words are the point —
// "by 1PM if possible" and "MUST be there by 1" are the same badge and very
// different kitchen decisions, so the quote is shown, not just a paraphrase.
// Nothing renders for the orders that asked for nothing, which is most of them.
//
// The same read also pulls out urgency flags ("Party at 1 PM") and a one-line
// kitchen summary ("No onions; sauces separate"), shown under the callout — or
// on their own when the note asked for no time at all.
const NoteHighlights: React.FC<{ order: PackOrder; preference: OrderTimePreference | undefined }> = ({
  order,
  preference,
}) => {
  if (!preference) return null;
  const flags = preference.urgencyFlags ?? [];
  const kitchen = preference.kitchenInstructions ?? '';
  const leaveBy = leaveByMinutes(order, preference);
  return (
    <>
      {preference.hasPreference && (
        <div className={`pack-time-pref pack-time-pref-${preference.confidence}`}>
          <span className="pack-time-pref-label">⏰ {preference.label || 'Time preference'}</span>
          {preference.quote && <span className="pack-time-pref-quote">“{preference.quote}”</span>}
          {leaveBy != null && (
            <span className="pack-time-pref-leave">
              🛵 Leave by ~{formatClockMinutes(leaveBy)}
              {order.distanceKm != null ? ` (~${order.distanceKm.toFixed(1)} km)` : ' (distance not measured)'}
            </span>
          )}
          {preference.confidence !== 'high' && (
            <span className="pack-time-pref-hint">Read from a vague note — worth a look before you promise it.</span>
          )}
        </div>
      )}
      {flags.length > 0 && (
        <div className="pack-urgency-flags">
          {flags.map((flag) => (
            <span key={flag} className="pack-urgency-flag">
              ⚠️ {flag}
            </span>
          ))}
        </div>
      )}
      {kitchen && <div className="pack-kitchen-line">🍳 {kitchen}</div>}
    </>
  );
};

// Where this order is going and who to ring when the rider cannot find it.
//
// Read off the order's Odoo delivery address rather than the account (see
// contactOf in server/integrations/odoo.js), because on a website order those
// are two different records: the account is whoever created the login, and the
// delivery partner is what the customer actually typed at checkout. Rendered
// on the card rather than behind a click - this is the one thing somebody
// standing over a packed box needs and could not otherwise get without opening
// Odoo on a phone with wet hands.
//
// Silent when Odoo has neither, which is normal for a walk-in or a B2B account
// that collects. An empty "Phone: -" line on every card would be noise, and
// noise is what makes people stop reading the block that matters.
// Copies one field and says so, briefly.
//
// Beside the phone and the address rather than instead of them, because the
// two gestures are different jobs: the tel: link rings the customer, and this
// puts the same text into whatever the rider's delivery app wants pasted into
// it. Selecting an address by dragging across it on a phone, with one hand,
// mid-service, is not a thing anyone gets right first time.
const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The timeout outlives the card when a re-fetch replaces the board mid-copy,
  // and setting state on a card that is gone is a warning nobody can act on.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    // Says "Couldn't copy" rather than "Copied" on a webview that blocks it.
    // A button that claims success and left the clipboard empty is worse than
    // one that admits it, because the address then gets typed from memory.
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button
      type="button"
      className={`pack-copy-btn${state === 'copied' ? ' copied' : ''}${state === 'failed' ? ' failed' : ''}`}
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy'}
    </button>
  );
};

// The customer's own note on the order, exactly as Odoo has it.
//
// It was always fetched (server/integrations/odoo.js fetchOrderPackingList reads
// sale.order.note) but until now the only thing on the card that came out of it
// was the Gemini time-preference callout above — so a note that asked for
// anything OTHER than a delivery time ("no spice", "leave with the guard")
// showed up nowhere, and a note asking for a time vanished too whenever the
// Gemini pass was rate-limited. This renders the text itself, with no model in
// the way: if Odoo has a note, the packer sees it.
//
// Clamped rather than truncated, because a website checkout can write its whole
// order dump into this same field and a card that is mostly boilerplate stops
// being read. Anything past the first few lines is one tap away.
const NOTE_CLAMP_CHARS = 180;

const CustomerNote: React.FC<{ order: PackOrder }> = ({ order }) => {
  const [expanded, setExpanded] = useState(false);
  const note = order.note?.trim();
  if (!note) return null;

  const isLong = note.length > NOTE_CLAMP_CHARS;
  const shown = isLong && !expanded ? `${note.slice(0, NOTE_CLAMP_CHARS).trimEnd()}…` : note;

  return (
    <div className="pack-order-note">
      <span className="pack-order-note-label">📝 Customer note</span>
      {/* pre-wrap: the note arrives as plain text with the customer's own line
          breaks in it (htmlToText flattens Odoo's HTML to newlines), and a
          list they typed on separate lines should stay on separate lines. */}
      <span className="pack-order-note-text">{shown}</span>
      {isLong && (
        <button type="button" className="pack-order-note-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show the whole note'}
        </button>
      )}
    </div>
  );
};

const DeliveryContact: React.FC<{ order: PackOrder }> = ({ order }) => {
  if (!order.phone && !order.address) return null;
  return (
    <div className="pack-order-contact">
      {order.phone && (
        <span className="pack-order-contact-row">
          {/* A tel: link, because this is read on a phone and the alternative
              is copying a number off a screen with one hand. Stripped to
              digits and a leading +, since Odoo numbers carry spaces and
              brackets. The copy button hands over what is PRINTED, not the
              stripped form — that is what gets pasted somewhere a human
              reads it. */}
          <a className="pack-order-phone" href={`tel:${order.phone.replace(/[^0-9+]/g, '')}`}>
            📞 {order.phone}
          </a>
          <CopyButton value={order.phone} label={`phone number for ${order.orderName}`} />
        </span>
      )}
      {order.address && (
        <span className="pack-order-contact-row">
          <span className="pack-order-address">
            📍 {order.address}
            {/* Only when the drop is to a partner other than the account,
                which is exactly the order worth checking before it leaves. */}
            {order.addressName && <em className="pack-order-address-name"> — {order.addressName}</em>}
          </span>
          {/* The address alone, without the name beside it: the name is a
              flag for the packer, not part of what anyone pastes. */}
          <CopyButton value={order.address} label={`address for ${order.orderName}`} />
        </span>
      )}
    </div>
  );
};

// ---- The orders, and where each one is -----------------------------------
type OrderSort = 'priority' | 'distance' | 'time';
const ORDER_SORTS: OrderSort[] = ['priority', 'distance', 'time'];

// Priority (the default) puts customers who asked for a time first, by when the
// rider has to leave, then everyone else farthest first — see prioritiseOrders
// in packing.ts. Distance alone is farthest first: the long runs need booking
// and dispatching earliest. Orders with no distance (no address, not found,
// not looked up yet) go after the measured ones in the server's time order.
const sortOrders = (orders: PackOrder[], sortBy: OrderSort, preferences: OrderTimePreferences): PackOrder[] => {
  if (sortBy === 'time') return orders;
  if (sortBy === 'distance') return sortByDistance(orders);
  return prioritiseOrders(orders, preferences);
};

// "~4.2 km · Koramangala", or why there's no number.
const DistanceChip: React.FC<{ order: PackOrder }> = ({ order }) => {
  if (order.distanceKm != null) {
    return (
      <span className="pack-distance" title="Straight-line distance from the kitchen">
        📍 ~{order.distanceKm.toFixed(1)} km{order.locality ? ` · ${order.locality}` : ''}
      </span>
    );
  }
  if (order.distanceStatus === 'not_found') {
    return (
      <span className="pack-distance muted" title="The map couldn't place this address">
        📍 Distance unknown
      </span>
    );
  }
  return null;
};

type OrdersBoardProps = {
  orders: PackOrder[];
  sortBy: OrderSort;
  statuses: Record<string, PackingStatus>;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  isBulkBusy: boolean;
  timePreferences: OrderTimePreferences;
  onSetStatus: (order: FulfilmentOrder, status: Exclude<PackStatusValue, 'pending'>, deliveryPerson?: string) => void;
  onSaveTracking: (order: FulfilmentOrder, trackingUrl: string, advance: boolean) => Promise<boolean>;
  onBulkApply: (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => void;
  onRetryInvoice: (order: FulfilmentOrder) => void;
};

// "[PB-001] Signature Pulled Pork BBQ Burger" -> code + name, so the name
// leads and the code sits quietly beside it for whoever packs by code.
const splitItemName = (name: string): { code: string; label: string } => {
  const match = name.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
  return match ? { code: match[1], label: match[2] } : { code: '', label: name };
};

const OrdersBoard: React.FC<OrdersBoardProps> = ({
  orders,
  sortBy,
  statuses,
  busy,
  errors,
  isBulkBusy,
  timePreferences,
  onSetStatus,
  onSaveTracking,
  onBulkApply,
  onRetryInvoice,
}) => {
  const sorted = useMemo(() => sortOrders(orders, sortBy, timePreferences), [orders, sortBy, timePreferences]);
  if (orders.length === 0) return <p className="pack-slot-empty">Nothing for this slot.</p>;

  return (
    <>
      <BulkStatusBar orders={orders} statuses={statuses} busy={isBulkBusy} onApply={onBulkApply} />

      <div className="pack-order-grid">
        {sorted.map((order, index) => {
          const key = String(order.orderId);
          return (
            <div key={order.orderId} className="pack-order-card">
              <div className="pack-order-header">
                <span className="pack-order-rank">#{index + 1}</span>
                <span className="pack-order-name">{order.orderName}</span>
                {sortBy === 'priority' && hasDeadline(timePreferences[key]) && (
                  <span className="pack-priority-chip" title="The customer asked for a delivery time">
                    ⚡ Priority
                  </span>
                )}
                <FulfilmentBadge order={order} status={statuses[key]} />
              </div>

              <div className="pack-order-customer">
                <span className="pack-order-customer-name">{order.customer}</span>
                <span className="pack-order-time">🕒 {formatPackBy(order.packBy)}</span>
              </div>
              <DistanceChip order={order} />

              <DeliveryContact order={order} />

              <NoteHighlights order={order} preference={timePreferences[key]} />

              {/* Below the time-preference callout: that one is the reading to
                  act on, this is the source it was read from (and the only
                  thing shown at all for the notes that asked for something
                  other than a time). */}
              <CustomerNote order={order} />

              <div className="pack-order-section-label">
                Items · {order.itemCount}
              </div>
              <ul className="pack-order-items">
                {order.items.map((item) => {
                  const { code, label } = splitItemName(item.name);
                  return (
                    <li key={item.itemId}>
                      <span className="pack-order-item-qty">{item.qty}×</span>
                      <span className="pack-order-item-name">
                        {label}
                        {code && <span className="pack-order-item-code">{code}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <FulfilmentControl
                order={order}
                status={statuses[key]}
                busy={Boolean(busy[key])}
                error={errors[key]}
                onSetStatus={onSetStatus}
                onSaveTracking={onSaveTracking}
                onRetryInvoice={onRetryInvoice}
              />
            </div>
          );
        })}
      </div>
    </>
  );
};

const OrderManagement: React.FC<{ channel?: PackChannel }> = ({ channel = 'B2C' }) => {
  const defaultRange = channel === 'B2B' ? DEFAULT_B2B_RANGE : DEFAULT_ODOO_RANGE;
  const copy = CHANNEL_COPY[channel];

  // The range survives the tab being evicted, which on a phone in a kitchen
  // happens whenever the OS wants the memory. Both dates in one value because
  // they are one decision, and because the staleness rule below needs to see
  // them together.
  //
  // A range that has entirely finished does not come back: a board reopened
  // next Friday should open on next Friday's orders, not on last weekend's,
  // and a spent window sitting in the date boxes looks exactly like a live
  // one. Judged on the `to` end — a `from` in the past is completely normal,
  // since every weekend range starts on its Monday.
  const [range, setRange] = usePersistedState(
    `smokerings.orderBoard.${channel}.range`,
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

  // The last board fetched, kept in the browser with the range it was for.
  // Reopening the page (or the OS evicting the tab mid-service) used to redo
  // the whole Odoo fetch, the distance lookups and the Gemini note read; now
  // it draws straight from here, and "Refresh orders" is the way to pull new
  // orders in. A cache for a different range is ignored rather than shown —
  // last weekend's orders under this weekend's dates would be worse than a
  // spinner.
  const rangeKey = `${channel}|${odooFrom}|${odooTo}`;
  const [boardCache, setBoardCache] = usePersistedState<BoardCache | null>(
    `smokerings.orderBoard.${channel}.board`,
    null,
    reviveBoardCache,
  );
  const data = boardCache && boardCache.rangeKey === rangeKey ? boardCache.data : null;
  const setData = (next: PackingResponse, forRange = rangeKey) =>
    setBoardCache({ rangeKey: forRange, fetchedAt: Date.now(), data: next });

  // One group's dashboard at a time — the picker strip below chooses which.
  // Held as an id rather than an index so a re-fetch that adds or drops a B2B
  // delivery day doesn't silently slide whoever's packing onto another day;
  // an id that's gone falls back to the suggestion instead.
  //
  // Stored with the suggestion that was live when it was made, which is what
  // makes "remember my pick" and "open on the service happening now" both
  // true. Pick Sunday Dinner during Saturday lunch and it stays put for as
  // long as you are working; come back on Sunday evening and the clock has
  // moved to a different service, so the pick is spent and the board opens on
  // the new one. Without that pairing the screen would have to choose between
  // ignoring the clock and ignoring the packer.
  const [pick, setPick] = usePersistedState<{ groupId: string; forSuggestion: string } | null>(
    `smokerings.orderBoard.${channel}.pick`,
    null,
    (stored) => {
      if (!stored || typeof stored !== 'object') return undefined;
      const { groupId, forSuggestion } = stored as Record<string, unknown>;
      if (typeof groupId !== 'string' || typeof forSuggestion !== 'string' || !groupId) return undefined;
      return { groupId, forSuggestion };
    },
  );

  // Priority by default — customers who asked for a time, by when the rider
  // must leave, then farthest first. Plain distance and plain time order are
  // one tap away. A new storage key, so boards that were left on the old
  // distance default open on priority rather than keeping it.
  const [sortBy, setSortBy] = usePersistedState<OrderSort>(
    `smokerings.orderBoard.${channel}.sortBy`,
    'priority',
    (stored) => (ORDER_SORTS.includes(stored as OrderSort) ? (stored as OrderSort) : undefined),
  );

  const handleFetch = async () => {
    if (!odooFrom || !odooTo || isFetching) return;
    const forRange = rangeKey;
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
      setData(json, forRange);
      // A manual refresh re-measures anything new, which the locate pass
      // otherwise runs only once per range.
      locatedRange.current = '';
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsFetching(false);
    }
  };

  // Nobody should have to press a button to see the range's orders — the
  // fetch is part of loading the board. Runs on mount and again whenever the
  // range (or channel) changes, unless the browser already holds this range's
  // board; the ref keeps StrictMode's double-mount (and a re-render with the
  // same dates) from firing a second request. Safe to re-run because the
  // fetch replaces the board rather than adding to it.
  const autoFetchedRange = useRef(data ? rangeKey : '');
  useEffect(() => {
    if (!odooFrom || !odooTo) return;
    if (autoFetchedRange.current === rangeKey) return;
    autoFetchedRange.current = rangeKey;
    if (boardCache?.rangeKey === rangeKey) return;
    void handleFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  const groups = useMemo<PackGroup[]>(() => data?.groups || [], [data]);

  // ---- Delivery distances ------------------------------------------------
  // The fetch answers from the geocode cache. Addresses it has never seen come
  // back 'pending', and one follow-up call looks those up (a second or so
  // each — Nominatim's limit) and hands the board back with distances in.
  // Once per range: every address is cached after its first lookup, so the
  // next load of the same board sorts straight away.
  const [isLocating, setIsLocating] = useState(false);
  const [locateError, setLocateError] = useState('');
  const locatedRange = useRef('');
  const pendingDistanceCount = useMemo(
    () =>
      groups.reduce(
        (sum, g) => sum + g.orders.filter((o) => o.distanceStatus === 'pending').length,
        0,
      ),
    [groups],
  );

  useEffect(() => {
    if (!pendingDistanceCount || !data?.kitchenLocated) return;
    const key = `${channel}|${odooFrom}|${odooTo}`;
    if (locatedRange.current === key) return;
    locatedRange.current = key;
    let cancelled = false;
    setIsLocating(true);
    setLocateError('');
    fetch('/api/odoo/order-packing/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: odooFrom, to: odooTo, channel: channel.toLowerCase() }),
    })
      .then(async (resp) => {
        const json: PackingResponse & { error?: string; located?: { error?: string } } = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Could not work out delivery distances.');
        if (cancelled) return;
        setData(json);
        if (json.located?.error) setLocateError(json.located.error);
      })
      .catch((err) => {
        if (!cancelled) setLocateError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsLocating(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the count and range, not `data`: setData above must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDistanceCount, data?.kitchenLocated, channel, odooFrom, odooTo]);

  // The service the clock says is on right now — Saturday Dinner at 6pm on a
  // Saturday, the coming Saturday Lunch on a Wednesday, today's delivery day
  // on the B2B board. Recomputed whenever the groups change rather than held
  // in state, so a board left open across the 4pm Lunch/Dinner boundary is
  // right the moment anything refreshes it.
  const suggestion = useMemo(() => suggestedGroupId(groups, channel), [groups, channel]);

  // The group being worked: the packer's own pick while it is still current,
  // else whatever the clock suggests, else — when the suggestion names a slot
  // this range didn't return — the first group with orders in it, which is
  // what suggestedGroupId already falls through to.
  const activeGroupId = pick && pick.forSuggestion === suggestion ? pick.groupId : suggestion;
  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || groups.find((g) => g.orders.length > 0) || groups[0] || null,
    [groups, activeGroupId],
  );

  // A pick is stamped with the suggestion it was made against, which is what
  // lets it expire when the kitchen moves on to the next service. Clicking the
  // suggested group clears the pick rather than storing it: there is nothing
  // to remember, and a stored pick equal to the suggestion would come back as
  // a manual override on a board that was going to open there anyway.
  const chooseGroup = (groupId: string) =>
    setPick(groupId === suggestion ? null : { groupId, forSuggestion: suggestion });

  // Pipeline state is loaded for every group in range, not just the visible
  // one, so switching groups costs nothing.
  const allOrders = useMemo(() => groups.flatMap((g) => g.orders), [groups]) as PackOrder[];
  const fulfilment = useOrderFulfilment(
    useMemo(() => allOrders.map((o) => o.orderId), [allOrders]),
    channel,
  );

  // ---- What time did the customer actually ask for? ----------------------
  // Odoo carries the request as free text at the end of the order note, so
  // reading it is a Gemini pass rather than a match (see
  // server/integrations/geminiContent.js readOrderTimePreferences). Kicked off once the
  // orders have landed instead of as part of that fetch, so the board draws
  // straight away and the callouts fill in behind it; the server caches per
  // note, so re-fetching the same range re-reads nothing.
  //
  // Failing is non-fatal by design: no GEMINI_API_KEY, or a quota 503, costs
  // the highlights and nothing else. The note itself is still on the order.
  //
  // The answer is kept in the browser beside the board, tagged with the notes
  // it was read from, so reopening the page shows the callouts (and the
  // priority order that depends on them) without asking Gemini again.
  const [notesCache, setNotesCache] = usePersistedState<NotesCache | null>(
    `smokerings.orderBoard.${channel}.notes`,
    null,
    reviveNotesCache,
  );
  const [isReadingNotes, setIsReadingNotes] = useState(false);
  const [notesError, setNotesError] = useState('');

  const ordersWithNotes = useMemo(
    () =>
      allOrders
        .filter((order): order is PackOrder & { note: string } => Boolean(order.note))
        .map((order) => ({ orderId: order.orderId, note: order.note })),
    [allOrders],
  );

  // Which orders, and which notes — an order whose note was edited in Odoo
  // re-reads, one that only moved slots does not.
  const notesKey = useMemo(
    () => ordersWithNotes.map((order) => `${order.orderId}:${order.note.length}`).join('|'),
    [ordersWithNotes],
  );
  const timePreferences = useMemo<OrderTimePreferences>(
    () => (notesKey && notesCache?.notesKey === notesKey ? notesCache.preferences : {}),
    [notesKey, notesCache],
  );

  useEffect(() => {
    // Nothing to read, or already read for exactly these notes.
    if (!notesKey || notesCache?.notesKey === notesKey) return;
    let cancelled = false;
    setIsReadingNotes(true);
    setNotesError('');

    fetch('/api/orders/time-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: ordersWithNotes }),
    })
      .then(async (resp) => {
        const json: { preferences?: OrderTimePreferences; error?: string } = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Could not read the order notes.');
        if (!cancelled) setNotesCache({ notesKey, preferences: json.preferences || {} });
      })
      .catch((err) => {
        if (!cancelled) setNotesError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setIsReadingNotes(false);
      });

    return () => {
      cancelled = true;
    };
    // notesKey is the stable summary of ordersWithNotes: this re-reads when
    // the orders or their notes change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesKey]);

  const timePreferenceCount = useMemo(
    () => Object.values(timePreferences).filter((preference) => preference.hasPreference).length,
    [timePreferences],
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
        <h1>Order Management{channel === 'B2B' ? ' — B2B' : ''}</h1>
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
              <span className="prep-paste-hint">{copy.fetchHint}</span>
            </div>
            {error && <p className="chat-error">{error}</p>}
            {hasResult && !error && (
              <p className="status-message">
                Found {data!.ordersFound} order{data!.ordersFound === 1 ? '' : 's'} in that range
                {boardCache?.fetchedAt ? ` · fetched ${formatFetchedAt(boardCache.fetchedAt)}` : ''}. Refresh to
                pull in new orders.
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
              <span className="badge-soon">Nothing to manage</span>
            </div>
          )}

          {hasResult && groups.length === 0 && (
            <p className="status-message">
              No {copy.groupNoun}s in that range — nothing confirmed in Odoo for {channel} between those dates.
            </p>
          )}

          {hasResult && groups.length > 0 && (
            <>
              {/* The strip picks which group the board below is looking at.
                  Empty B2C slots stay on it — the weekend has a fixed four,
                  and an empty one is part of its shape at a glance. B2B days
                  only exist where there's something to deliver, so the strip
                  is however many the range turned up. */}
              <div className="slot-picker">
                {groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`slot-picker-btn ${activeGroup?.id === group.id ? 'active' : ''} ${
                      group.orders.length === 0 ? 'empty' : ''
                    }`}
                    onClick={() => chooseGroup(group.id)}
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

              {/* The note read is a background pass over the orders, so it
                  reports itself here rather than blocking anything. A
                  failure says so plainly instead of silently showing no
                  callouts, which would be indistinguishable from "nobody
                  asked for a time". */}
              {isReadingNotes && (
                <p className="pack-guide-note">⏰ Reading the customer notes for delivery-time requests…</p>
              )}
              {notesError && (
                <p className="chat-error">
                  ⏰ Could not read the order notes, so any time requests in them are not flagged below:{' '}
                  {notesError}
                </p>
              )}
              {!isReadingNotes && !notesError && timePreferenceCount > 0 && (
                <p className="pack-guide-note">
                  ⏰ {timePreferenceCount} order{timePreferenceCount === 1 ? '' : 's'} asked for a specific
                  {' '}delivery time — flagged on the card{timePreferenceCount === 1 ? '' : 's'} below.
                </p>
              )}

              {isLocating && (
                <p className="pack-guide-note">📍 Measuring delivery distances for {pendingDistanceCount} new address{pendingDistanceCount === 1 ? '' : 'es'}…</p>
              )}
              {locateError && <p className="chat-error">📍 Couldn't measure every distance: {locateError}</p>}
              {data && data.kitchenLocated === false && sortBy !== 'time' && (
                <p className="pack-guide-note">
                  📍 Distance sort needs the kitchen's location — set <code>KITCHEN_LAT</code> and{' '}
                  <code>KITCHEN_LON</code> in <code>.env</code> and restart the server. Showing time order until then.
                </p>
              )}

              <div className="pack-orders-toolbar">
                <h4 className="pack-orders-title">📦 Orders</h4>
                <div className="pack-sort-toggle" role="group" aria-label="Sort orders">
                  <button
                    type="button"
                    className={sortBy === 'priority' ? 'active' : ''}
                    aria-pressed={sortBy === 'priority'}
                    onClick={() => setSortBy('priority')}
                    title="Customers who asked for a time first, then farthest first"
                  >
                    ⚡ Priority
                  </button>
                  <button
                    type="button"
                    className={sortBy === 'distance' ? 'active' : ''}
                    aria-pressed={sortBy === 'distance'}
                    onClick={() => setSortBy('distance')}
                  >
                    📍 Farthest first
                  </button>
                  <button
                    type="button"
                    className={sortBy === 'time' ? 'active' : ''}
                    aria-pressed={sortBy === 'time'}
                    onClick={() => setSortBy('time')}
                  >
                    🕒 Earliest time
                  </button>
                </div>
              </div>
              <OrdersBoard
                sortBy={sortBy}
                onSaveTracking={fulfilment.saveTrackingLink}
                orders={activeGroup?.orders || []}
                statuses={fulfilment.statuses}
                busy={fulfilment.busy}
                errors={fulfilment.errors}
                isBulkBusy={isBulkBusy}
                timePreferences={timePreferences}
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

export default OrderManagement;
