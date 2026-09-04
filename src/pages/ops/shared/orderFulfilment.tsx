import React, { useCallback, useEffect, useMemo, useState } from 'react';

// Per-order fulfilment pipeline — the one implementation behind everything
// that moves an order along: Order Management's per-order dropdown, its bulk
// bar, and its Step 3 smoker switches, on both the B2C and B2B boards. All of
// them write the same field to the same Odoo record, so this lives in a
// single module — two copies of a pipeline that posts to Odoo is two things
// to keep in step.
//
// Odoo's own "Fulfilment Status" selection field is the truth for which stage
// an order is at — that's the record staff and Odoo-side reporting read, so
// this board reports it rather than arguing with it (a status set in Odoo
// directly shows up here on the next fetch). Picking a stage below writes it
// there. The local CSV (server/ops/shared/orderPackingStatus.js) still owns the stage
// timestamps, delivery partner and invoice state, and stands in as the stage
// for orders Odoo has no value on. See server/integrations/odoo.js setFulfilmentStatus.

export type PackStatusValue =
  | 'pending'
  | 'in_smoker'
  | 'prepping'
  | 'packed'
  | 'finding_partner'
  | 'assigned_partner'
  | 'out_for_delivery'
  | 'delivered';

export type PackInvoice = { number: string; id: string | null; url: string | null };

export type PackingStatus = {
  status: PackStatusValue;
  deliveryPerson: string | null;
  inSmokerAt: string | null;
  preppingAt: string | null;
  packedAt: string | null;
  findingPartnerAt: string | null;
  assignedPartnerAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  invoice: PackInvoice | null;
  invoiceError: string | null;
  // Set when the local status saved fine but pushing it on to Odoo's
  // Fulfilment Status field failed — the stage change still stuck locally.
  odooError?: string | null;
  // What Odoo's Fulfilment Status field reads after the save that returned
  // this — null if that write failed or this database has no such field.
  // Only ever set on a save response; the plain status fetch reads the CSV
  // alone, so there the order's own fetched value stands in.
  odooFulfilment?: string | null;
  // Set by useOrderFulfilment on every save response: this stage was
  // written from this board AFTER the order was fetched, so the order's
  // fetch-time odooFulfilment snapshot is older than it and must not stand
  // in for a save that carried no odooFulfilment of its own (Odoo
  // unreachable, or no such field on this database).
  savedHere?: boolean;
};

export const PENDING_STATUS: PackingStatus = {
  status: 'pending',
  deliveryPerson: null,
  inSmokerAt: null,
  preppingAt: null,
  packedAt: null,
  findingPartnerAt: null,
  assignedPartnerAt: null,
  outForDeliveryAt: null,
  deliveredAt: null,
  invoice: null,
  invoiceError: null,
  odooError: null,
  odooFulfilment: null,
  savedHere: false,
};

// The pipeline, in order — badge label/emoji, which PackingStatus field holds
// its timestamp, and the Odoo selection value it writes to the sale order's
// Fulfilment Status field (server/integrations/odoo.js FULFILMENT_VALUE_BY_STATUS and
// server/ops/shared/orderPackingStatus.js STATUS_STEPS — keep all three in sync).
// 'finding_partner' has no Odoo counterpart (Odoo goes straight PACKED ->
// PARTNER_ASGN), so it maps back onto PACKED there.
export type Stage = {
  key: Exclude<PackStatusValue, 'pending'>;
  label: string;
  emoji: string;
  atKey: keyof PackingStatus;
  odooValue: string;
};

export const STAGES: Stage[] = [
  { key: 'in_smoker', label: 'In the smoker', emoji: '🔥', atKey: 'inSmokerAt', odooValue: 'in_smoker' },
  { key: 'prepping', label: 'Prepping', emoji: '🍳', atKey: 'preppingAt', odooValue: 'prepping' },
  { key: 'packed', label: 'Packed', emoji: '📦', atKey: 'packedAt', odooValue: 'packed' },
  { key: 'finding_partner', label: 'Finding delivery partner', emoji: '🔎', atKey: 'findingPartnerAt', odooValue: 'packed' },
  { key: 'assigned_partner', label: 'Delivery partner assigned', emoji: '🤝', atKey: 'assignedPartnerAt', odooValue: 'partner_assigned' },
  { key: 'out_for_delivery', label: 'Out for delivery', emoji: '🛵', atKey: 'outForDeliveryAt', odooValue: 'out_for_delivery' },
  { key: 'delivered', label: 'Delivered', emoji: '✅', atKey: 'deliveredAt', odooValue: 'delivered' },
];

// From this stage on the delivery partner is either known or being chased, so
// the name field is offered and the chip shown.
const PARTNER_KNOWN_FROM_INDEX = STAGES.findIndex((s) => s.key === 'finding_partner');

// How Odoo labels each Fulfilment Status value on the sale order form, so the
// dropdown and drift warning read in Odoo's words rather than this app's.
// ORDER_CONFIRMED and INVOICED are Odoo-only — no stage here sets either; an
// order lands on the first when its quotation is confirmed (server/integrations/odoo.js
// confirmSaleOrder) and on the second off the back of the invoice posting.
export const ODOO_STATUS_LABELS: Record<string, string> = {
  order_confirmed: 'ORDER_CONFIRMED',
  in_smoker: 'IN_SMOKER',
  prepping: 'PREPPING',
  packed: 'PACKED',
  partner_assigned: 'PARTNER_ASGN',
  out_for_delivery: 'OUT_FOR_DEL',
  delivered: 'DELIVERED',
  invoiced: 'INVOICED',
};

// Status timestamps come back as proper ISO (the server writes
// new Date().toISOString()), unlike Odoo's naive-UTC 'YYYY-MM-DD HH:mm:ss'
// promised times — so no space-to-T/Z fixup is needed here.
const formatStatusTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit' });
};

// The minimum an order needs to look like for this control to drive it —
// both pages' fuller PackOrder types satisfy it structurally.
export type FulfilmentOrder = {
  orderId: number;
  orderName: string;
  // Odoo's Fulfilment Status as it stood at fetch time — the stage this board
  // displays (see effectiveStatus).
  odooFulfilment?: string | null;
};

// Odoo selection value -> the pipeline stage it means here: the inverse of
// Stage.odooValue, with a judgement call on the two values that need one.
//   'packed'   — both 'packed' and 'finding_partner' write it, so it can't be
//                inverted on its own; the local stage breaks the tie below.
//   'invoiced' — one past the end of the pipeline. The order is still
//                Delivered as far as the stages go, and the invoice itself
//                shows in the invoice box.
//   'order_confirmed' — one before the start: the order is committed to but
//                nothing has been cooked yet, which is exactly 'pending'
//                here. Mapped (rather than left out) so a freshly confirmed
//                order doesn't trip the unknown-value drift warning.
const STAGE_BY_ODOO_STATUS: Record<string, PackStatusValue> = {
  order_confirmed: 'pending',
  in_smoker: 'in_smoker',
  prepping: 'prepping',
  packed: 'packed',
  partner_assigned: 'assigned_partner',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  invoiced: 'delivered',
};

// What Odoo's Fulfilment Status reads for this order right now: whatever the
// last save pushed there (the save response echoes it), else the value the
// order carried when the board fetched it.
//
// A save that came back without an echo (savedHere, no odooFulfilment) drops
// the fetched value rather than falling back to it — it predates the save, so
// using it would re-render the stage the order was on BEFORE the change and
// read as the save having silently done nothing. The local stage stands in
// instead, and odooError says so when Odoo is the reason.
const odooValueFor = (order: FulfilmentOrder, status: PackingStatus | undefined) =>
  status?.odooFulfilment ?? (status?.savedHere ? null : order.odooFulfilment) ?? null;

// The stage to show and drive the controls from. Odoo wins whenever it holds
// a value this board understands — including one set in Odoo directly, which
// is the point. The local stage stands in when Odoo has nothing on the order
// (or holds a value with no stage here, flagged in FulfilmentControl).
export const effectiveStatus = (order: FulfilmentOrder, status: PackingStatus | undefined): PackStatusValue => {
  const local = status?.status || 'pending';
  const odooValue = odooValueFor(order, status);
  const fromOdoo = odooValue ? STAGE_BY_ODOO_STATUS[odooValue] : undefined;
  if (!fromOdoo) return local;
  // PACKED covers both, so a partner hunt already under way isn't walked back
  // to plain Packed every render.
  if (fromOdoo === 'packed' && local === 'finding_partner') return 'finding_partner';
  return fromOdoo;
};

// Loads the pipeline state for a set of orders and hands back the two actions
// that change it. orderIds drives a single fetch for the whole board rather
// than one per card.
// `channel` is stamped on the order's row in Kitchen/order_lifecycle_log.csv,
// so the file can be read back per side of the business — the pipeline itself
// is identical for both and keyed only by Odoo order id.
export function useOrderFulfilment(orderIds: number[], channel: 'B2C' | 'B2B' = 'B2C') {
  const [statuses, setStatuses] = useState<Record<string, PackingStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idsKey = useMemo(() => orderIds.join(','), [orderIds]);

  useEffect(() => {
    if (!idsKey) {
      setStatuses({});
      return;
    }
    let cancelled = false;
    fetch(`/api/order-packing/status?orderIds=${idsKey}`)
      .then((resp) => resp.json())
      .then((json: Record<string, PackingStatus>) => {
        if (!cancelled) setStatuses(json || {});
      })
      .catch(() => {}); // non-fatal — cards just read "not started" until it loads
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const setStatus = useCallback(
    async (order: FulfilmentOrder, status: Exclude<PackStatusValue, 'pending'>, deliveryPerson?: string) => {
      const key = String(order.orderId);
      setBusy((prev) => ({ ...prev, [key]: true }));
      setErrors((prev) => ({ ...prev, [key]: '' }));
      try {
        const resp = await fetch('/api/order-packing/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.orderId, orderName: order.orderName, status, deliveryPerson, channel }),
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || 'Failed to update status.');
        setStatuses((prev) => ({ ...prev, [key]: { ...json, savedHere: true } }));
      } catch (err) {
        setErrors((prev) => ({ ...prev, [key]: String((err as Error).message || err) }));
      } finally {
        setBusy((prev) => ({ ...prev, [key]: false }));
      }
    },
    [channel],
  );

  const retryInvoice = useCallback(async (order: FulfilmentOrder) => {
    const key = String(order.orderId);
    setBusy((prev) => ({ ...prev, [key]: true }));
    setErrors((prev) => ({ ...prev, [key]: '' }));
    try {
      const resp = await fetch('/api/order-packing/retry-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.orderId, orderName: order.orderName, channel }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Failed to retry invoice.');
      setStatuses((prev) => ({ ...prev, [key]: { ...json, savedHere: true } }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: String((err as Error).message || err) }));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  }, [channel]);

  // Bulk apply — "start every order in this slot" and the like.
  //
  // Deliberately sequential, not Promise.all. Each call tags the order in
  // Odoo and can create an invoice, which is not work to fire off in parallel
  // — and firing a slot's worth of them at once would have Odoo rate-limiting
  // us rather than going faster.
  const setStatusBulk = useCallback(
    async (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => {
      for (const order of orders) {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
        await setStatus(order, status);
      }
    },
    [setStatus],
  );

  return { statuses, busy, errors, setStatus, setStatusBulk, retryInvoice };
}

// The current stage as a badge — lives in the order card's header row so the
// card reads "S00010 ............ 🍳 Prepping" at a glance, with the picker
// below. Split out from FulfilmentControl for exactly that reason: the two
// halves sit in different parts of the card.
export const FulfilmentBadge: React.FC<{ order: FulfilmentOrder; status: PackingStatus | undefined }> = ({
  order,
  status,
}) => {
  const st = status || PENDING_STATUS;
  const current = effectiveStatus(order, st);
  const stage = STAGES.find((s) => s.key === current) || null;
  // Nothing is under way yet, but Odoo says the order itself is confirmed —
  // worth distinguishing from an order that hasn't been committed to at all.
  const confirmedOnly = !stage && odooValueFor(order, st) === 'order_confirmed';
  // Timestamps are this board's own, so they're only shown for a stage this
  // board set — a stage Odoo moved to on its own was never stamped here.
  const atTime = stage && st.status === current ? (st[stage.atKey] as string | null) : null;
  return (
    <span className={`pack-status-badge pack-status-${current}`}>
      {stage
        ? `${stage.emoji} ${stage.label}${atTime ? ` · ${formatStatusTime(atTime)}` : ''}`
        : confirmedOnly
          ? '🧾 Order confirmed'
          : '⏳ Not started'}
    </span>
  );
};

export type BulkStatusBarProps = {
  orders: FulfilmentOrder[];
  statuses: Record<string, PackingStatus>;
  busy: boolean;
  onApply: (orders: FulfilmentOrder[], status: Exclude<PackStatusValue, 'pending'>) => void;
};

// Whole-slot actions. "Start all" is the one-click common case (everything
// not yet started goes into the smoker); the picker beside it does the same
// for any other stage, applied to every order in the slot rather than only
// the un-started ones.
export const BulkStatusBar: React.FC<BulkStatusBarProps> = ({ orders, statuses, busy, onApply }) => {
  const [bulkStage, setBulkStage] = useState<Exclude<PackStatusValue, 'pending'>>('packed');
  if (!orders.length) return null;

  const notStarted = orders.filter((o) => effectiveStatus(o, statuses[String(o.orderId)]) === 'pending');

  return (
    <div className="pack-bulk-bar">
      {notStarted.length > 0 && (
        <button
          type="button"
          className="primary-button small"
          disabled={busy}
          onClick={() => onApply(notStarted, 'in_smoker')}
        >
          {busy ? 'Working…' : `🔥 Start all (${notStarted.length})`}
        </button>
      )}
      <span className="pack-bulk-sep">or set all {orders.length} to</span>
      <select
        value={bulkStage}
        disabled={busy}
        onChange={(e) => setBulkStage(e.target.value as Exclude<PackStatusValue, 'pending'>)}
      >
        {STAGES.map((stage) => (
          <option key={stage.key} value={stage.key}>
            {stage.emoji} {stage.label} · {ODOO_STATUS_LABELS[stage.odooValue]}
          </option>
        ))}
      </select>
      <button type="button" className="secondary-button small" disabled={busy} onClick={() => onApply(orders, bulkStage)}>
        Apply
      </button>
    </div>
  );
};

export type FulfilmentControlProps = {
  order: FulfilmentOrder;
  status: PackingStatus | undefined;
  busy: boolean;
  error?: string;
  onSetStatus: (order: FulfilmentOrder, status: Exclude<PackStatusValue, 'pending'>, deliveryPerson?: string) => void;
  onRetryInvoice: (order: FulfilmentOrder) => void;
};

// Badge + Odoo status dropdown + delivery-partner field + invoice state for
// one order.
export const FulfilmentControl: React.FC<FulfilmentControlProps> = ({
  order,
  status,
  busy,
  error,
  onSetStatus,
  onRetryInvoice,
}) => {
  const st = status || PENDING_STATUS;
  const [partnerDraft, setPartnerDraft] = useState<string | null>(null);

  // Odoo's word on where this order is, falling back to the local stage.
  const current = effectiveStatus(order, st);
  const stageIndex = STAGES.findIndex((s) => s.key === current);
  const showsPartner = stageIndex >= PARTNER_KNOWN_FROM_INDEX;
  const partnerValue = partnerDraft ?? st.deliveryPerson ?? '';

  // Odoo holds a value with no stage on this board — a selection option added
  // or renamed in Odoo since. Worth saying out loud, because the stage shown
  // below is then the local fallback rather than Odoo's word.
  const odooRaw = odooValueFor(order, st);
  const odooUnknown = odooRaw && !STAGE_BY_ODOO_STATUS[odooRaw] ? odooRaw : null;

  return (
    <div className="pack-status-block">
      {/* One dropdown drives everything: it saves the stage locally (the
          source of truth), swaps the Odoo status tag, and writes Odoo's own
          Fulfilment Status field. Every stage is selectable rather than just
          the next one, so a mis-click can be walked back without needing a
          separate path for it. */}
      <label className="pack-status-select">
        <span className="pack-status-select-label">Fulfilment status (Odoo)</span>
        <select
          value={current === 'pending' ? '' : current}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as Exclude<PackStatusValue, 'pending'>;
            if (!next) return;
            onSetStatus(order, next, partnerDraft ?? undefined);
          }}
        >
          <option value="" disabled>
            {busy ? 'Updating…' : 'Not started'}
          </option>
          {STAGES.map((stage) => (
            <option key={stage.key} value={stage.key}>
              {stage.emoji} {stage.label} · {ODOO_STATUS_LABELS[stage.odooValue]}
            </option>
          ))}
        </select>
      </label>

      {odooUnknown && (
        <p className="pack-odoo-drift">
          ⚠️ Odoo reads <strong>{odooUnknown}</strong>, which isn't a stage on this board — showing the last stage set
          here instead. Pick one above to push it over.
        </p>
      )}

      {/* Who's delivering — offered from "finding partner" onwards, and still
          editable after that so a swapped partner can be corrected without
          walking the stage back just to re-capture the name. */}
      {showsPartner && (
        <div className="pack-dispatch-form">
          <input
            type="text"
            placeholder="Delivery partner name"
            value={partnerValue}
            onChange={(e) => setPartnerDraft(e.target.value)}
          />
          <button
            type="button"
            className="secondary-button small"
            disabled={busy || !partnerValue.trim()}
            onClick={() => onSetStatus(order, current as Exclude<PackStatusValue, 'pending'>, partnerValue)}
          >
            {busy ? 'Saving…' : 'Save partner'}
          </button>
        </div>
      )}

      {current === 'delivered' && (
        <div className="pack-invoice-box">
          {st.invoice ? (
            <span>
              🧾 <strong>{st.invoice.number}</strong>
              {st.invoice.url && (
                <>
                  {' · '}
                  <a href={st.invoice.url} target="_blank" rel="noreferrer">
                    View in Odoo
                  </a>
                </>
              )}
            </span>
          ) : st.invoiceError ? (
            <span className="pack-invoice-error">
              ⚠️ Invoice failed: {st.invoiceError}
              <button type="button" className="secondary-button small" disabled={busy} onClick={() => onRetryInvoice(order)}>
                {busy ? 'Retrying…' : 'Retry invoice'}
              </button>
            </span>
          ) : st.status === 'delivered' ? (
            <span>Generating invoice…</span>
          ) : (
            // Odoo was moved to DELIVERED somewhere else, so the invoice step
            // never ran from here — re-picking Delivered above runs it.
            <span>No invoice raised from here — pick Delivered above to raise one.</span>
          )}
        </div>
      )}

      {st.odooError && <p className="pack-odoo-drift">⚠️ Saved here, but Odoo didn't take it: {st.odooError}</p>}
      {error && <p className="chat-error pack-status-error">{error}</p>}
    </div>
  );
};
