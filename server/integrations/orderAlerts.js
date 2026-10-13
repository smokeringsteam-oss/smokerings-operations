// A push to the phone the moment a sale order is confirmed in Odoo: who, what,
// how much, and which delivery slot it is for.
//
// Confirmed, not merely placed — a quotation is still a maybe, and the planner
// already lists those. Whichever screen does the confirming (website checkout,
// the Odoo backend, the planner's Confirm button), Odoo stamps date_order with
// that moment, so "confirmed in the last few minutes" is one domain filter.
// See fetchNewlyConfirmedOrders in odoo.js.
//
// ---- Not firing twice, and not replaying the past ------------------------
//
// The same two guards as the WhatsApp alarm (whatsappAlerts.js):
//
//   Each order id is claimed in push_delivery before anything is sent, so the
//   one-minute timer cannot announce an order sixty times, and a restart
//   cannot announce it again.
//
//   Only orders confirmed inside the grace window are looked at. That bounds
//   the cold start — a fresh database has no claims, and without the window
//   the first tick would announce every order of the last month — and it
//   means legion waking from a night asleep doesn't replay the night. An order
//   confirmed while it was down for longer than the window is on the boards
//   regardless; it just doesn't buzz.
import { claimDelivery, sendToAll, subscriptionCount } from '../core/pushNotify.js';
import { fetchNewlyConfirmedOrders, getConfig } from './odoo.js';

// Comfortably more than one tick plus a restart, so an order confirmed while
// `node server/index.js` was coming back up is still announced.
const DEFAULT_GRACE_MINUTES = 15;

// Android shows roughly this much of an expanded body; the full order is on
// the packing board.
const MAX_ITEMS_TEXT = 160;

const SLOT_EMOJI = { satLunch: '🌤️', satEvening: '🌙', sunLunch: '🌤️', sunEvening: '🌙' };

// Odoo's naive-UTC 'YYYY-MM-DD HH:mm:ss' as the kitchen reads it:
// "Sat 11 Oct, 7:30 pm" in IST.
function istWhen(value) {
  if (!value) return '';
  const at = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(at.getTime())) return '';
  const day = at.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  const time = at
    .toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
  return `${day}, ${time}`;
}

const rupees = (amount) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

// The slot line. A weekend order names its service and the promised time; a
// weekday or B2B order has no named slot, so it is just the promised time; an
// order with neither says so, because that is the order someone needs to fix
// in Odoo before the weekend.
function slotLine(order) {
  const when = istWhen(order.promised);
  if (order.slotLabel) {
    const emoji = SLOT_EMOJI[order.slotId] ? `${SLOT_EMOJI[order.slotId]} ` : '';
    return when ? `${emoji}${order.slotLabel} · ${when}` : `${emoji}${order.slotLabel}`;
  }
  return when ? `Deliver ${when}` : '⚠️ No delivery slot set in Odoo';
}

function itemsLine(items) {
  if (!items?.length) return 'No items on the order';
  const text = items.map((item) => `${item.qty} × ${item.name}`).join(', ');
  return text.length > MAX_ITEMS_TEXT ? `${text.slice(0, MAX_ITEMS_TEXT - 1)}…` : text;
}

/** The notification for one order, as sendToAll() takes it. Pure. */
function orderPayload(order) {
  return {
    title: `New order ${order.orderName} · ${order.customer}`,
    body: [slotLine(order), itemsLine(order.items), rupees(order.amountTotal)].join('\n'),
    // One per order, so a re-send could only ever replace itself in the shade.
    tag: `order-${order.orderId}`,
    url: '/',
  };
}

/**
 * One pass of the timer: ask Odoo for orders confirmed inside the grace
 * window, claim each, send the ones that were not already claimed.
 *
 * Never throws — it runs from a setInterval, where an unhandled rejection
 * takes the whole server down.
 */
async function runOrderAlertTick(now = new Date(), options = {}) {
  const { graceMinutes = DEFAULT_GRACE_MINUTES } = options;
  try {
    // A claim is a record of a delivery; with nowhere to deliver to there is
    // nothing to record, and claiming anyway would swallow the order for good.
    if (!subscriptionCount()) return { considered: 0, sent: 0, skipped: 'no subscriptions' };
    if (!getConfig().configured) return { considered: 0, sent: 0, skipped: 'odoo not configured' };

    const since = new Date(now.getTime() - graceMinutes * 60000);
    const orders = await fetchNewlyConfirmedOrders({ since });

    let announced = 0;
    let sent = 0;
    // Oldest first, so the shade reads in the order they came in.
    const ordered = [...orders].sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt)));
    for (const order of ordered) {
      if (!claimDelivery(`odoo-order:${order.orderId}`)) continue;
      announced += 1;
      const result = await sendToAll(orderPayload(order));
      sent += result.sent || 0;
    }
    return { considered: orders.length, announced, sent };
  } catch (err) {
    console.error('[order-alert] tick failed —', err.message);
    return { considered: 0, sent: 0, error: err.message };
  }
}

export { orderPayload, runOrderAlertTick, DEFAULT_GRACE_MINUTES };
