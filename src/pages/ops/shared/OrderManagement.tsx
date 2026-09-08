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
  formatDateInput,
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

// Wording that differs per channel — the board itself is identical.
const CHANNEL_COPY: Record<
  PackChannel,
  { groupNoun: string; fetchHint: string; intro: string }
> = {
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
const TimePreferenceCallout: React.FC<{ preference: OrderTimePreference | undefined }> = ({ preference }) => {
  if (!preference?.hasPreference) return null;
  return (
    <div className={`pack-time-pref pack-time-pref-${preference.confidence}`}>
      <span className="pack-time-pref-label">⏰ {preference.label || 'Time preference'}</span>
      {preference.quote && <span className="pack-time-pref-quote">“{preference.quote}”</span>}
      {preference.confidence !== 'high' && (
        <span className="pack-time-pref-hint">Read from a vague note — worth a look before you promise it.</span>
      )}
    </div>
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

// ---- Step 1: the orders, and where each one is ---------------------------
type OrdersBoardProps = {
  orders: PackOrder[];
  statuses: Record<string, PackingStatus>;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  isBulkBusy: boolean;
  timePreferences: OrderTimePreferences;
  onSetStatus: (order: FulfilmentOrder, status: Exclude<PackStatusValue, 'pending'>, deliveryPerson?: string) => void;
  onBulkApply: (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => void;
  onRetryInvoice: (order: FulfilmentOrder) => void;
};

const OrdersBoard: React.FC<OrdersBoardProps> = ({
  orders,
  statuses,
  busy,
  errors,
  isBulkBusy,
  timePreferences,
  onSetStatus,
  onBulkApply,
  onRetryInvoice,
}) => {
  if (orders.length === 0) return <p className="pack-slot-empty">Nothing for this slot.</p>;

  return (
    <>
      <BulkStatusBar orders={orders} statuses={statuses} busy={isBulkBusy} onApply={onBulkApply} />

      <div className="pack-order-grid">
        {orders.map((order, index) => {
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

              <DeliveryContact order={order} />

              <TimePreferenceCallout preference={timePreferences[key]} />

              {/* Below the time-preference callout: that one is the reading to
                  act on, this is the source it was read from (and the only
                  thing shown at all for the notes that asked for something
                  other than a time). */}
              <CustomerNote order={order} />

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
  const [data, setData] = useState<PackingResponse | null>(null);

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

  // Nobody should have to press a button to see the range's orders — the
  // fetch is part of loading the board. Runs on mount and again whenever the
  // range (or channel) changes; the ref keeps StrictMode's double-mount (and
  // a re-render with the same dates) from firing a second request. Safe to
  // re-run because the fetch replaces the board rather than adding to it.
  const autoFetchedRange = useRef('');
  useEffect(() => {
    if (!odooFrom || !odooTo) return;
    const key = `${channel}|${odooFrom}|${odooTo}`;
    if (autoFetchedRange.current === key) return;
    autoFetchedRange.current = key;
    void handleFetch();
  }, [channel, odooFrom, odooTo]);

  const groups = useMemo<PackGroup[]>(() => data?.groups || [], [data]);

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
  const [timePreferences, setTimePreferences] = useState<OrderTimePreferences>({});
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

  useEffect(() => {
    if (!notesKey) {
      setTimePreferences({});
      return;
    }
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
        if (!cancelled) setTimePreferences(json.preferences || {});
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
        <p>
          {copy.intro} — every order with its Odoo Fulfilment Status dropdown (IN_SMOKER → PREPPING → PACKED →
          PARTNER_ASGN → OUT_FOR_DEL → DELIVERED), written straight to the sale order and logged with its
          timestamp. Marking Delivered also creates and posts the invoice, moving Odoo on to INVOICED.
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

              <h4 className="pack-orders-title">📦 Orders — earliest promised time first</h4>
              <OrdersBoard
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
