// Odoo integration for the Weekend Prep Planner: pulls confirmed, B2C
// (individual-customer) Sales Orders in a date range and maps them into the
// same { itemId, slotId, quantity } shape the Gemini paste extractor
// produces, so the planner's Step 1 can merge either source through the
// exact same code path (applyExtractedOrders).
//
// Talks to Odoo's JSON-RPC 2.0 API directly over fetch — no XML-RPC client
// dependency needed, same "raw API over fetch" style as githubProjects.js.
import { readMaterials, readMenu } from '../core/kbViews.js';
import { update } from '../core/repo.js';

// NOTE: includes the raw apiKey — for internal use only (authenticate/execute
// below). The /api/odoo/status route must never forward this object as-is to
// the client; it picks only the safe fields (see index.js).
function getConfig() {
  const url = (process.env.ODOO_URL || '').replace(/\/$/, '');
  const db = process.env.ODOO_DB || '';
  const username = process.env.ODOO_USERNAME || '';
  const apiKey = process.env.ODOO_API_KEY || '';
  return {
    url,
    apiKey,
    db,
    username,
    hasApiKey: Boolean(apiKey),
    configured: Boolean(url && db && username && apiKey),
  };
}

async function jsonRpc(url, service, method, args) {
  const resp = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
  });

  const rawText = await resp.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    // Odoo (or a proxy in front of it) sent back an HTML page instead of
    // JSON-RPC — happens when the database itself is unavailable (trial
    // expired/locked, under maintenance, wrong ODOO_URL, etc.), not a bug in
    // this code. Pull the <h2>/<title> out of the page so the real reason
    // shows up instead of a cryptic JSON-parse error.
    const heading = rawText.match(/<h2[^>]*>([^<]+)<\/h2>/i)?.[1]?.trim();
    const title = rawText.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    const err = new Error(`Odoo didn't return JSON — ${heading || title || 'the site returned an HTML page instead. Check ODOO_URL and that the database is active.'}`);
    err.status = 502;
    throw err;
  }

  if (json.error) {
    const message = json.error.data?.message || json.error.message || 'Odoo API error';
    const err = new Error(message);
    err.status = 502;
    throw err;
  }
  return json.result;
}

let uidCache = null;
async function authenticate() {
  if (uidCache) return uidCache;
  const { url, db, username, apiKey, configured } = getConfig();
  if (!configured) {
    const err = new Error(
      "Odoo isn't configured yet. Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY in the server's .env, then restart the server.",
    );
    err.status = 503;
    throw err;
  }
  const uid = await jsonRpc(url, 'common', 'login', [db, username, apiKey]);
  if (!uid) {
    const err = new Error('Odoo authentication failed — check ODOO_USERNAME and ODOO_API_KEY.');
    err.status = 401;
    throw err;
  }
  uidCache = uid;
  return uid;
}

async function execute(model, method, args, kwargs = {}) {
  const { url, db, apiKey } = getConfig();
  const uid = await authenticate();
  return jsonRpc(url, 'object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
}

// ---- Product name -> menu item matching -----------------------------------
// Exact Odoo product name -> our menu item id. Seeded assuming the Odoo
// catalog uses the same names as the real menu (smokerings.in) — once you
// see real unmatched lines from your Odoo data, add/correct entries here.
const PRODUCT_NAME_TO_ITEM_ID = {
  'Signature Pulled Chicken BBQ Burger': 'chicken-bbq-burger',
  'Smoke and Glaze Pulled Chicken Burger': 'chicken-glaze-burger',
  'Smoked Chicken Tacos': 'chicken-tacos',
  'Smoked Chicken Quesadilla': 'chicken-quesadilla',
  'Signature Pulled Pork BBQ Burger': 'pork-bbq-burger',
  'Smoke and Glaze Pulled Pork Burger': 'pork-glaze-burger',
  'Smoked Pork Tacos': 'pork-tacos',
  'Smoked Pork Quesadilla': 'pork-quesadilla',
  'Pork Burnt Ends (150g)': 'pork-burnt-ends',
  'Smokey BBQ Ribs (250g)': 'bbq-ribs-250g',
  'Smokey BBQ Ribs (1/2 rack, 6-7 ribs)': 'bbq-ribs-half-rack',
};

// Deterministic fallback for product names that don't exactly match —
// keyword scoring, same spirit as the Gemini paste extractor but rule-based
// instead of model-based, so it's predictable. Anything it can't confidently
// place returns null and surfaces in "unmatched" rather than guessing.
function keywordMatch(productName) {
  const n = productName.toLowerCase();
  if (/burnt\s*end/.test(n)) return 'pork-burnt-ends';
  if (/\brib/.test(n)) return /half|rack/.test(n) ? 'bbq-ribs-half-rack' : 'bbq-ribs-250g';

  const protein = /\bpork\b/.test(n) ? 'pork' : /\bchicken\b/.test(n) ? 'chicken' : null;
  if (!protein) return null;
  if (/taco/.test(n)) return `${protein}-tacos`;
  if (/quesadilla/.test(n)) return `${protein}-quesadilla`;
  if (/burger/.test(n)) return /glaze/.test(n) ? `${protein}-glaze-burger` : `${protein}-bbq-burger`;
  return null;
}

// The menu itself, as a matching source.
//
// The hardcoded map above only ever knew the eleven B2C dishes, which is what
// kept anything else — B2B wholesale SKUs above all — permanently in
// `unmatched`, i.e. invisible on the packing board. The menu table is the
// real catalog (and already carries `channel`), so it's the source that
// scales: adding a menu item there is enough, no code change here.
//
// Reads the database as of phase 1. It used to read menu.csv behind an
// mtime cache, which had to go with the file: menuCsvMirror writes a rename
// to the menu table now, so a cache keyed on a file that no longer changes
// would have gone on matching orders against the dish's old name forever.
// Nothing replaces the cache — this is twelve rows behind an indexed read,
// where the whole point of the old cache was avoiding a re-parse of a file.
function menuIndex() {
  const byOdooId = new Map();
  const byName = new Map();
  try {
    readMenu().forEach((row) => {
      if (!row.menu_id) return;
      const odooId = String(row.odoo_product_id || '').trim();
      if (odooId) byOdooId.set(odooId, row.menu_id);
      const name = String(row.item_name || '').trim().toLowerCase();
      if (name) byName.set(name, row.menu_id);
    });
  } catch {
    // No database on this checkout — fall through to the seeded map and the
    // keyword guess, exactly as a missing menu.csv used to.
    return { byOdooId: new Map(), byName: new Map() };
  }
  return { byOdooId, byName };
}

// Strongest evidence first: the odoo_product_id pin the menu row keeps (same
// column server/ops/menu/menuCsvMirror.js backfills, so a product renamed in Odoo
// still lands on its row), then an exact name — from the seeded map, then
// from the menu table — then the keyword guess. Anything left returns null and
// surfaces in `unmatched` rather than being placed wrongly.
function matchProduct(productName, productId) {
  const menu = menuIndex();
  if (productId != null && productId !== '') {
    const pinned = menu.byOdooId.get(String(productId));
    if (pinned) return pinned;
  }
  if (!productName) return null;
  return (
    PRODUCT_NAME_TO_ITEM_ID[productName] ||
    menu.byName.get(String(productName).trim().toLowerCase()) ||
    keywordMatch(productName)
  );
}

// ---- Weekend slot (Sat/Sun Lunch/Dinner) from the promised time -------------
// The real signal is commitment_date — Odoo's "Expected Date", the promised
// pickup/delivery time. NOT date_order: orders often get typed into Odoo well
// after the fact (batches entered at 2am are common here), so the order
// timestamp has no relationship to which weekend slot the order is for.
//
// The slot tags below (crm.tag: "Saturday Lunch", "Saturday Dinner", ...) are
// now only a FALLBACK, for orders whose promised time is blank or lands
// outside the weekend. Matched by tag NAME, not a hardcoded id, so a newly
// created tag (e.g. once "Sunday Lunch" exists — it doesn't yet on this
// instance) picks up automatically with no code change needed.
const TAG_NAME_TO_SLOT = {
  'Saturday Lunch': 'satLunch',
  'Saturday Dinner': 'satEvening',
  'Sunday Lunch': 'sunLunch',
  'Sunday Dinner': 'sunEvening',
};

// The weekend's four services in the order they happen, with how the packing
// board names them. Lives here rather than only in the frontend because the
// board's picker strip is now server-built (see b2cGroups) so B2C slots and
// B2B delivery days can share one shape.
const SLOT_ORDER = ['satLunch', 'satEvening', 'sunLunch', 'sunEvening'];
const SLOT_LABELS = {
  satLunch: { label: 'Saturday Lunch', sublabel: 'Sat · Lunch', emoji: '🌤️' },
  satEvening: { label: 'Saturday Dinner', sublabel: 'Sat · Dinner', emoji: '🌙' },
  sunLunch: { label: 'Sunday Lunch', sublabel: 'Sun · Lunch', emoji: '🌤️' },
  sunEvening: { label: 'Sunday Dinner', sublabel: 'Sun · Dinner', emoji: '🌙' },
};

async function getSlotTagMap() {
  const tags = await execute('crm.tag', 'search_read', [[], ['id', 'name']]);
  const map = new Map();
  for (const tag of tags) {
    const slotId = TAG_NAME_TO_SLOT[tag.name];
    if (slotId) map.set(tag.id, slotId);
  }
  return map;
}

// Odoo stores and returns datetimes as naive UTC ('YYYY-MM-DD HH:mm:ss'), but
// the kitchen thinks in IST — so every promised time is shifted into IST
// before its day-of-week and hour are read. Without the shift a Sunday 8pm
// pickup reads as 14:30 (Lunch, wrong), and anything promised before 05:30 IST
// would land on the previous day entirely.
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const LUNCH_END_HOUR_IST = 16; // before 16:00 IST is Lunch, 16:00 onwards is Dinner

function parseOdooUtc(value) {
  if (!value) return null;
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// An IST calendar day ('YYYY-MM-DD', plus an optional whole-day offset) as the
// naive-UTC string Odoo's domain compares against — so a range asked for in
// IST days filters on exactly those IST days.
function istDayStartAsOdooUtc(dateStr, dayOffset = 0) {
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  const utcMs = base + dayOffset * 86400000 - IST_OFFSET_MINUTES * 60000;
  return new Date(utcMs).toISOString().slice(0, 19).replace('T', ' ');
}

// -> 'satLunch' | 'satEvening' | 'sunLunch' | 'sunEvening', or null when
// there's no promised time or it doesn't fall on a Sat/Sun (a weekday promised
// time isn't a weekend slot, so it falls through to the tag like a blank one).
function slotFromPromisedTime(commitmentDate) {
  const utc = parseOdooUtc(commitmentDate);
  if (!utc) return null;
  const ist = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60000);
  const isLunch = ist.getUTCHours() < LUNCH_END_HOUR_IST;
  switch (ist.getUTCDay()) {
    case 6: return isLunch ? 'satLunch' : 'satEvening';
    case 0: return isLunch ? 'sunLunch' : 'sunEvening';
    default: return null;
  }
}

// The IST calendar day an order is promised for, 'YYYY-MM-DD' — how B2B
// orders are grouped on the packing board. Weekend Lunch/Dinner slots are a
// B2C consumer-service idea: a wholesale account has a delivery *day* (see
// order_day in server/ops/b2b/b2bClients.js), and several of them land on the same
// day rather than splitting across a lunch and a dinner service. Falls back
// to date_order so an order with no promised time still groups somewhere
// visible instead of dropping off the board.
function deliveryDayOf(order) {
  const utc = parseOdooUtc(order.commitment_date) || parseOdooUtc(order.date_order);
  if (!utc) return null;
  return new Date(utc.getTime() + IST_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

// Promised time first, slot tag second. Shared by fetchWeekendOrders and
// fetchOrderPackingList so the two views can never disagree about which slot
// an order belongs to.
function resolveSlots(orders, slotTagMap) {
  const slotByOrderId = new Map();
  const noSlotOrderIds = new Set();
  for (const order of orders) {
    let slotId = slotFromPromisedTime(order.commitment_date);
    if (!slotId) {
      const matchedTagId = (order.tag_ids || []).find((id) => slotTagMap.has(id));
      if (matchedTagId != null) slotId = slotTagMap.get(matchedTagId);
    }
    if (slotId) slotByOrderId.set(order.id, slotId);
    else noSlotOrderIds.add(order.id);
  }
  return { slotByOrderId, noSlotOrderIds };
}

// One message per slot-less order, not per line — the fix is on the order in
// Odoo (set its Expected Date), not a line-by-line review.
function describeMissingSlot(order) {
  const partnerName = order.partner_id ? order.partner_id[1] : 'unknown customer';
  if (!order.commitment_date) {
    return `Order ${order.name} (${partnerName}) has no promised time (Expected Date) and no Saturday/Sunday Lunch/Dinner tag in Odoo — set the Expected Date and re-fetch.`;
  }
  return `Order ${order.name} (${partnerName}) is promised for ${order.commitment_date} UTC, which isn't a Saturday or Sunday, and it has no Saturday/Sunday Lunch/Dinner tag — fix the Expected Date in Odoo and re-fetch.`;
}

// Odoo's sale.order lifecycle, split the way the kitchen thinks about it: a
// quotation is a real order the customer placed that nobody has confirmed
// yet, so it must be visible when planning a weekend — but its quantities
// don't belong in the prep totals until someone says so.
const CONFIRMED_STATES = ['sale', 'done'];
const QUOTATION_STATES = ['draft', 'sent'];

// Confirmed (sale/done), B2C orders whose PROMISED time falls in the IST day
// range — plus, so nothing silently vanishes, orders with no promised time at
// all whose date_order falls in range (those fall back to their slot tag, or
// surface in `unmatched` if they have neither).
//
// `states` widens that first clause: pass CONFIRMED_STATES.concat(
// QUOTATION_STATES) to pull unconfirmed quotations alongside, which the
// Weekend Prep Planner does so they can be reviewed and confirmed from there.
function weekendOrderDomain(fromDate, toDate, { isCompany = false, states = CONFIRMED_STATES } = {}) {
  const fromUtc = istDayStartAsOdooUtc(fromDate);
  const toUtc = istDayStartAsOdooUtc(toDate, 1); // end bound exclusive: start of the day after
  return [
    ['state', 'in', states],
    // false = B2C (individuals), true = B2B (companies). Same boolean the
    // Smoking module's order picker uses — see fetchRecentOrders.
    ['partner_id.is_company', '=', Boolean(isCompany)],
    '|',
    '&', ['commitment_date', '>=', fromUtc], ['commitment_date', '<', toUtc],
    '&', ['commitment_date', '=', false],
    '&', ['date_order', '>=', fromUtc], ['date_order', '<', toUtc],
  ];
}

function requireDateRange(fromDate, toDate) {
  if (fromDate && toDate) return;
  const err = new Error('fromDate and toDate are required (YYYY-MM-DD).');
  err.status = 400;
  throw err;
}

// fromDate/toDate are 'YYYY-MM-DD' IST days. Pulls confirmed (state:
// sale/done), B2C (partner_id.is_company = false) Sales Orders promised in
// range (see weekendOrderDomain), sums their line quantities by menu item +
// weekend slot (from the promised time, tag as fallback).
//
// NOTE: this Odoo instance's res.partner doesn't expose the "company_type"
// selection field (Individual/Company) for domain filtering — only the
// underlying "is_company" boolean, which company_type is normally derived
// from. is_company = false is the B2C (individual) side, same distinction,
// just the boolean form. Confirmed against real data on this instance.
// Quotations (state draft/sent) come back in their own `quotations` list
// instead of the tally: they are orders nobody has committed to yet, so
// counting their meat into the prep plan would over-buy. Each carries the
// same {itemId, slotId, quantity} entries the tally is made of, so confirming
// one from the planner can fold exactly that order's quantities in without a
// re-fetch (which would double-count everything already applied).
async function fetchWeekendOrders({ fromDate, toDate, includeQuotations = true }) {
  requireDateRange(fromDate, toDate);

  const states = includeQuotations ? CONFIRMED_STATES.concat(QUOTATION_STATES) : CONFIRMED_STATES;
  const domain = weekendOrderDomain(fromDate, toDate, { states });

  const [orders, slotTagMap] = await Promise.all([
    execute('sale.order', 'search_read', [
      domain,
      ['id', 'name', 'state', 'date_order', 'commitment_date', 'partner_id', 'tag_ids', 'amount_total'],
    ]),
    getSlotTagMap(),
  ]);
  if (!orders.length) {
    return { orders: [], quotations: [], unmatched: [], ordersFound: 0, quotationsFound: 0 };
  }

  const orderIds = orders.map((o) => o.id);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const isQuotation = (order) => QUOTATION_STATES.includes(order.state);

  // Resolve each order's slot once, up front — the order's own promised time
  // decides its slot, not anything per-line.
  const { slotByOrderId, noSlotOrderIds } = resolveSlots(orders, slotTagMap);

  const lines = await execute('sale.order.line', 'search_read', [
    [
      ['order_id', 'in', orderIds],
      ['display_type', '=', false], // skip section/note lines, which have no real product
    ],
    ['order_id', 'product_id', 'product_uom_qty', 'name'],
  ]);

  const tally = new Map(); // `${itemId}|${slotId}` -> quantity, confirmed orders only
  const unmatched = [];
  const quotationLines = new Map(); // orderId -> [{ itemId, name, qty }]

  for (const line of lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    const order = orderById.get(orderId);
    if (!order) continue;

    const slotId = slotByOrderId.get(orderId) || null;
    // A confirmed order with no slot is reported once per order below, not
    // per line. A quotation with no slot still gets listed (with its own
    // slot warning) — you can confirm it and then fix its Expected Date.
    if (!slotId && !isQuotation(order)) continue;

    const productName = line.product_id ? line.product_id[1] : line.name;
    const qty = Math.round(line.product_uom_qty || 0);
    if (!qty) continue;

    const itemId = matchProduct(productName, line.product_id ? line.product_id[0] : null);

    if (isQuotation(order)) {
      if (!quotationLines.has(orderId)) quotationLines.set(orderId, []);
      quotationLines.get(orderId).push({ itemId, name: productName, qty });
      continue;
    }

    if (!itemId) {
      unmatched.push(`${qty} × ${productName} (order ${order.name})`);
      continue;
    }

    const key = `${itemId}|${slotId}`;
    tally.set(key, (tally.get(key) || 0) + qty);
  }

  for (const orderId of noSlotOrderIds) {
    const order = orderById.get(orderId);
    if (isQuotation(order)) continue; // carried on the quotation card instead
    unmatched.push(describeMissingSlot(order));
  }

  const resultOrders = Array.from(tally.entries()).map(([key, quantity]) => {
    const [itemId, slotId] = key.split('|');
    return { itemId, slotId, quantity };
  });

  // Contact numbers for the quotation cards only — the planner's confirm
  // modal shows one, and there's no reason to read partners for the (far
  // more numerous) confirmed orders.
  const quotationOrders = orders.filter(isQuotation);
  const quotationPartnerIds = Array.from(
    new Set(quotationOrders.map((o) => (Array.isArray(o.partner_id) ? o.partner_id[0] : null)).filter(Boolean)),
  );
  const phoneByPartnerId = new Map();
  if (quotationPartnerIds.length) {
    // Odoo 19 dropped res.partner.mobile — the separate mobile number was
    // merged into `phone`, and asking for it now errors the whole read out.
    const partners = await execute('res.partner', 'read', [
      quotationPartnerIds,
      ['id', 'phone'],
    ]);
    for (const partner of partners) {
      phoneByPartnerId.set(partner.id, partner.phone || null);
    }
  }

  const quotations = quotationOrders
    .map((order) => {
      const slotId = slotByOrderId.get(order.id) || null;
      const items = quotationLines.get(order.id) || [];
      // Only matched items with a known slot can be folded into the plan on
      // confirm; anything else is named on the card so it's obvious what
      // won't land in the totals.
      const entries = slotId
        ? items.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, slotId, quantity: l.qty }))
        : [];
      return {
        orderId: order.id,
        orderName: order.name,
        state: order.state,
        customer: order.partner_id ? order.partner_id[1] : 'Unknown customer',
        customerPhone: order.partner_id ? phoneByPartnerId.get(order.partner_id[0]) || null : null,
        promised: order.commitment_date || order.date_order || null,
        amountTotal: order.amount_total || 0,
        slotId,
        slotLabel: slotId ? SLOT_LABELS[slotId].label : null,
        slotIssue: slotId ? null : describeMissingSlot(order),
        items: items.map((l) => ({ name: l.name, qty: l.qty, itemId: l.itemId || null })),
        unmatchedItems: items.filter((l) => !l.itemId).map((l) => `${l.qty} × ${l.name}`),
        entries,
      };
    })
    .sort((a, b) => {
      if (!a.promised) return 1;
      if (!b.promised) return -1;
      return new Date(a.promised).getTime() - new Date(b.promised).getTime();
    });

  return {
    orders: resultOrders,
    quotations,
    unmatched,
    // Confirmed orders only, so the planner's "pulled N orders" line keeps
    // meaning what it always did; quotations are counted separately.
    ordersFound: orders.length - quotations.length,
    quotationsFound: quotations.length,
  };
}

// Confirms a quotation in Odoo — the same action Odoo's own "Confirm" button
// on the quotation form runs, so whatever automations, stock moves and
// sequence changes that normally fire still do, and the order picks up its
// first fulfilment stage (ORDER_CONFIRMED). Reads the state back rather
// than assuming: a confirm can legitimately land somewhere other than 'sale'
// (an order already confirmed elsewhere, a workflow that routes it on), and
// the caller shows what actually happened.
async function confirmSaleOrder({ orderId }) {
  if (!orderId) {
    const err = new Error('orderId is required.');
    err.status = 400;
    throw err;
  }

  const id = Number(orderId);
  // Odoo's Fulfilment Status is read alongside the state so the confirm can
  // set it to ORDER_CONFIRMED without stamping over a stage the order is
  // already past (see below). Null on databases without the field.
  const fulfilmentField = await resolveFulfilmentField().catch(() => null);
  const fields = fulfilmentField ? ['name', 'state', fulfilmentField] : ['name', 'state'];
  const readFulfilment = (order) => (order && fulfilmentField && order[fulfilmentField]) || null;

  const [before] = await execute('sale.order', 'read', [[id], fields]);
  if (!before) {
    const err = new Error(`Sale order ${id} not found in Odoo.`);
    err.status = 404;
    throw err;
  }
  // Already confirmed (someone got there first in Odoo) — report it rather
  // than calling action_confirm again, which Odoo would reject.
  if (!QUOTATION_STATES.includes(before.state)) {
    return {
      orderId: id,
      orderName: before.name,
      state: before.state,
      confirmed: true,
      alreadyConfirmed: true,
      fulfilment: readFulfilment(before),
      fulfilmentError: null,
    };
  }

  await execute('sale.order', 'action_confirm', [[id]]);

  const [after] = await execute('sale.order', 'read', [[id], fields]);
  const confirmed = Boolean(after && CONFIRMED_STATES.includes(after.state));

  // The quotation is now a sales order, so the fulfilment pipeline starts:
  // ORDER_CONFIRMED. Only written when the field is still empty — an order
  // that somehow already carries a stage (confirmed and worked on elsewhere,
  // a workflow that sets one on confirm) must not be walked back to the
  // start. Best-effort like setFulfilmentStatus's other callers: the confirm
  // itself stuck, so a failure here is reported, not thrown.
  let fulfilment = readFulfilment(after);
  let fulfilmentError = null;
  if (confirmed && !fulfilment) {
    try {
      fulfilment = await setFulfilmentStatus({ orderId: id, status: 'order_confirmed' });
    } catch (err) {
      fulfilmentError = err.message || String(err);
      console.error(`Confirmed ${after ? after.name : id} but failed to set its Fulfilment Status:`, err);
    }
  }

  return {
    orderId: id,
    orderName: after ? after.name : before.name,
    state: after ? after.state : null,
    confirmed,
    alreadyConfirmed: false,
    fulfilment,
    fulfilmentError,
  };
}

// Odoo stores the sale order note as an HTML field and hands back `false`
// rather than '' when it's empty. The website checkout writes its whole order
// dump into it as a single <p> with real newlines inside, so flattening the
// block tags to newlines and decoding the few entities Odoo emits is enough to
// get readable text back out — nothing downstream wants the markup.
function htmlToText(value) {
  if (!value || value === true) return null;
  const text = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

// ---- Order Packing: per-order breakdown for the Ops Dashboard's Order
// Packing tile ----------------------------------------------------------
// Same confirmed/B2C/promised-time fetch as fetchWeekendOrders above, but
// kept at per-order granularity instead of tallying into one number per
// item+slot — the packing view needs to show each individual order (so
// staff know which box to pack first and which orders share items worth
// batching), not just the aggregate total.
//
// Pack-first ordering within a slot uses the same commitment_date the slot
// itself came from, falling back to date_order for orders that only had a
// slot tag, earliest first.
async function fetchOrderPackingList({ fromDate, toDate, channel }) {
  requireDateRange(fromDate, toDate);

  const isB2B = String(channel || 'b2c').toLowerCase() === 'b2b';
  const domain = weekendOrderDomain(fromDate, toDate, { isCompany: isB2B });

  // Odoo's own Fulfilment Status field, read alongside the rest so each card
  // can show what the order actually says in Odoo right now — which is what
  // catches drift when someone changed it in Odoo directly rather than here.
  // Resolved first (not in the Promise.all) because its answer decides which
  // columns the search_read may ask for. Null on databases without the field.
  const fulfilmentField = await resolveFulfilmentField().catch(() => null);
  // 'note' is Odoo's "Terms and conditions" HTML field, which is where the
  // website checkout dumps its whole order summary — including the free-text
  // "Customer note:" line, the only place a customer can ask for something the
  // structured fields have no room for (a delivery time, a doorbell
  // instruction). Read here so the boards can show it; making sense of it is a
  // separate, optional Gemini pass (server/integrations/geminiContent.js
  // readOrderTimePreferences) rather than something this fetch waits on.
  const orderFields = ['id', 'name', 'date_order', 'commitment_date', 'partner_id', 'tag_ids', 'note'];
  if (fulfilmentField) orderFields.push(fulfilmentField);

  const [orders, slotTagMap] = await Promise.all([
    execute('sale.order', 'search_read', [domain, orderFields]),
    getSlotTagMap(),
  ]);

  // B2C keeps the weekend's four fixed slots — they exist as empty columns
  // even with no orders, because "Sunday Dinner has nothing in it" is itself
  // information on a service board. B2B groups are discovered from the
  // orders' own delivery days, so they only exist where there's something to
  // deliver.
  const slots = {};
  if (!isB2B) {
    Object.values(TAG_NAME_TO_SLOT).forEach((slotId) => {
      slots[slotId] = [];
    });
  }

  if (!orders.length) {
    return { slots, groups: isB2B ? [] : b2cGroups(slots), unmatched: [], ordersFound: 0 };
  }

  const orderIds = orders.map((o) => o.id);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // B2B orders carry no weekend slot tags and aren't promised for a Sat/Sun
  // service, so resolveSlots would send every one of them to `unmatched`.
  // Their delivery day is the grouping key instead — always derivable, so
  // there is no slot-less bucket to report.
  const { slotByOrderId, noSlotOrderIds } = isB2B
    ? {
        slotByOrderId: new Map(orders.map((o) => [o.id, deliveryDayOf(o) || 'undated'])),
        noSlotOrderIds: [],
      }
    : resolveSlots(orders, slotTagMap);
  if (isB2B) {
    new Set(slotByOrderId.values()).forEach((day) => {
      slots[day] = [];
    });
  }

  const lines = await execute('sale.order.line', 'search_read', [
    [
      ['order_id', 'in', orderIds],
      ['display_type', '=', false],
    ],
    ['order_id', 'product_id', 'product_uom_qty', 'name'],
  ]);

  const itemsByOrderId = new Map(); // orderId -> [{ itemId, name, qty }]
  const unmatched = [];

  for (const line of lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    const order = orderById.get(orderId);
    if (!order) continue;

    const slotId = slotByOrderId.get(orderId);
    if (!slotId) continue; // reported once per order below, not per line

    const productName = line.product_id ? line.product_id[1] : line.name;
    const qty = Math.round(line.product_uom_qty || 0);
    if (!qty) continue;

    const itemId = matchProduct(productName, line.product_id ? line.product_id[0] : null);
    if (!itemId) {
      unmatched.push(`${qty} × ${productName} (order ${order.name})`);
      continue;
    }

    if (!itemsByOrderId.has(orderId)) itemsByOrderId.set(orderId, []);
    itemsByOrderId.get(orderId).push({ itemId, name: productName, qty });
  }

  for (const orderId of noSlotOrderIds) {
    unmatched.push(describeMissingSlot(orderById.get(orderId)));
  }

  for (const [orderId, lineItems] of itemsByOrderId.entries()) {
    const order = orderById.get(orderId);
    const slotId = slotByOrderId.get(orderId);
    if (!slotId) continue;

    // Merge duplicate lines for the same product within one order.
    const merged = new Map();
    for (const line of lineItems) {
      if (!merged.has(line.itemId)) merged.set(line.itemId, { itemId: line.itemId, name: line.name, qty: 0 });
      merged.get(line.itemId).qty += line.qty;
    }
    const items = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

    slots[slotId].push({
      orderId,
      orderName: order.name,
      customer: order.partner_id ? order.partner_id[1] : 'Unknown customer',
      packBy: order.commitment_date || order.date_order || null,
      // Odoo's selection value ('prepping', 'partner_assigned', ...) or null
      // when unset / the field doesn't exist on this database.
      odooFulfilment: (fulfilmentField && order[fulfilmentField]) || null,
      // The order note as plain text (see htmlToText), null when there is none.
      note: htmlToText(order.note),
      itemCount: items.reduce((sum, l) => sum + l.qty, 0),
      items,
    });
  }

  // Earliest promised pack/pickup time first — that's the order to pack first.
  // Orders with no time on file (shouldn't normally happen) sort to the end.
  Object.keys(slots).forEach((slotId) => {
    slots[slotId].sort((a, b) => {
      if (!a.packBy) return 1;
      if (!b.packBy) return -1;
      return new Date(a.packBy).getTime() - new Date(b.packBy).getTime();
    });
  });

  return {
    slots,
    groups: isB2B ? b2bGroups(slots) : b2cGroups(slots),
    unmatched,
    ordersFound: orders.length,
  };
}

// The board's picker strip, as an ordered list rather than a keyed object —
// one shape both channels' boards can render, since B2C's groups are four
// fixed services and B2B's are however many delivery days the range turned
// up. `slots` is still returned alongside for anything reading it by key.
function b2cGroups(slots) {
  return SLOT_ORDER.map((slotId) => ({
    id: slotId,
    label: SLOT_LABELS[slotId].label,
    sublabel: SLOT_LABELS[slotId].sublabel,
    emoji: SLOT_LABELS[slotId].emoji,
    orders: slots[slotId] || [],
  }));
}

// One group per delivery day, earliest first. 'undated' (no promised time and
// no order date, which shouldn't normally happen) sorts last and says so
// rather than being hidden.
function b2bGroups(slots) {
  return Object.keys(slots)
    .sort((a, b) => (a === 'undated' ? 1 : b === 'undated' ? -1 : a < b ? -1 : 1))
    .map((day) => ({
      id: day,
      label: day === 'undated' ? 'No delivery date' : formatIstDayLabel(day),
      sublabel: day === 'undated' ? 'No promised time in Odoo' : day,
      emoji: day === 'undated' ? '❓' : '🚚',
      orders: slots[day] || [],
    }));
}

// '2026-08-21' -> 'Fri 21 Aug'. Built off a UTC-parsed date and read back in
// UTC so it can't slide a day either way in the server's local timezone.
function formatIstDayLabel(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

// ---- Recent orders — for linking a smoking session to what it fed ---------
// Generic confirmed-order fetch, no weekend slot-tag requirement (B2B orders
// don't carry those tags) — used by the Smoking Session module's "Fed to
// these orders" picker once a batch is far enough along to know. isCompany
// mirrors the session's own channel (B2B -> true, B2C -> false) so the
// picker only offers orders of the same kind the session was started for.
async function fetchRecentOrders({ fromDate, toDate, isCompany }) {
  if (!fromDate || !toDate) {
    const err = new Error('fromDate and toDate are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }

  const toExclusive = new Date(`${toDate}T00:00:00Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const toBoundStr = toExclusive.toISOString().slice(0, 10);

  const domain = [
    ['date_order', '>=', `${fromDate} 00:00:00`],
    ['date_order', '<', `${toBoundStr} 00:00:00`],
    ['state', 'in', ['sale', 'done']],
    ['partner_id.is_company', '=', Boolean(isCompany)],
  ];

  const orders = await execute('sale.order', 'search_read', [domain, ['id', 'name', 'date_order', 'partner_id']]);
  if (!orders.length) return { orders: [], ordersFound: 0 };

  const orderIds = orders.map((o) => o.id);
  const lines = await execute('sale.order.line', 'search_read', [
    [
      ['order_id', 'in', orderIds],
      ['display_type', '=', false], // skip section/note lines, which have no real product
    ],
    ['order_id', 'product_id', 'product_uom_qty', 'name'],
  ]);

  const linesByOrderId = new Map();
  lines.forEach((line) => {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    if (!linesByOrderId.has(orderId)) linesByOrderId.set(orderId, []);
    const productName = line.product_id ? line.product_id[1] : line.name;
    const qty = Math.round(line.product_uom_qty || 0);
    if (qty) linesByOrderId.get(orderId).push(`${qty}× ${productName}`);
  });

  const resultOrders = orders
    .map((order) => ({
      id: order.id,
      name: order.name,
      customer: order.partner_id ? order.partner_id[1] : 'Unknown customer',
      dateOrder: order.date_order,
      itemsSummary: (linesByOrderId.get(order.id) || []).join(', ') || '—',
    }))
    .sort((a, b) => (a.dateOrder < b.dateOrder ? 1 : a.dateOrder > b.dateOrder ? -1 : 0));

  return { orders: resultOrders, ordersFound: orders.length };
}

// ---- Order Packing: status tags + invoice sync -----------------------------
// The In Smoker -> ... -> Delivered pipeline is tracked locally
// (server/ops/shared/orderPackingStatus.js) as the source of truth — these two helpers
// are its best-effort mirror into Odoo: a visible tag on the order, and
// (once Delivered) a real invoice.

const STATUS_TAG_NAMES = {
  in_smoker: 'In Smoker',
  prepping: 'Prepping',
  packed: 'Packed',
  finding_partner: 'Finding Delivery Partner',
  assigned_partner: 'Delivery Partner Assigned',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
};

async function findOrCreateTag(tagName) {
  const found = await execute('crm.tag', 'search_read', [[['name', '=', tagName]], ['id']], { limit: 1 });
  if (found.length) return found[0].id;
  return execute('crm.tag', 'create', [{ name: tagName }]);
}

// Swaps whichever packing-status tag the order currently carries for the new
// one — done sequentially (not Promise.all) so two calls in flight can't both
// miss-find and double-create the same tag name. Only ever touches the
// pipeline's status tags (STATUS_TAG_NAMES); the order's weekend-slot tag
// (see TAG_NAME_TO_SLOT) and any other existing tags are left alone via
// (3, id) unlink / (4, id) link commands instead of overwriting tag_ids
// outright.
async function tagSaleOrderStatus({ orderId, status }) {
  const targetName = STATUS_TAG_NAMES[status];
  if (!targetName || !orderId) return;

  const statusTagIds = [];
  let targetTagId = null;
  for (const [key, name] of Object.entries(STATUS_TAG_NAMES)) {
    const id = await findOrCreateTag(name);
    statusTagIds.push(id);
    if (key === status) targetTagId = id;
  }

  const commands = statusTagIds
    .filter((id) => id !== targetTagId)
    .map((id) => [3, id, 0])
    .concat([[4, targetTagId, 0]]);
  await execute('sale.order', 'write', [[Number(orderId)], { tag_ids: commands }]);
}

// ---- Order Packing: Odoo's own "Fulfilment Status" field ------------------
// Separate from the crm.tag mirror above: Odoo carries a real selection field
// on sale.order (Studio-added "Fulfilment Status" — ORDER_CONFIRMED /
// IN_SMOKER / PREPPING / PACKED / PARTNER_ASGN / OUT_FOR_DEL / DELIVERED /
// INVOICED) which is what
// shows on the order form and what Odoo-side reporting filters on. The
// packing board writes this alongside the tag so both stay in step.
//
// The technical field name is discovered rather than hardcoded, for the same
// reason server/ops/b2c/serviceWeeks.js discovers its schema: a Studio field can be
// renamed in the UI, which changes its technical name. Pin it with
// ODOO_FULFILMENT_FIELD in .env if discovery ever picks the wrong one.

// Local pipeline status -> Odoo selection value. 'finding_partner' has no
// Odoo counterpart (Odoo jumps straight from PACKED to PARTNER_ASGN), so it
// maps back onto 'packed' — the order genuinely is still packed and waiting,
// and that's truer than leaving a stale earlier value on the record.
const FULFILMENT_VALUE_BY_STATUS = {
  order_confirmed: 'order_confirmed', // not a local pipeline stage — set when a quotation is confirmed
  in_smoker: 'in_smoker',
  prepping: 'prepping',
  packed: 'packed',
  finding_partner: 'packed',
  assigned_partner: 'partner_assigned',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  invoiced: 'invoiced', // not a local pipeline stage — set once the invoice posts
};

// null = looked and there's no such field on this database (so callers skip
// the write instead of retrying every time); undefined = not looked yet.
let fulfilmentFieldCache;

async function resolveFulfilmentField() {
  if (fulfilmentFieldCache !== undefined) return fulfilmentFieldCache;

  const pinned = (process.env.ODOO_FULFILMENT_FIELD || '').trim();
  const fields = await execute('sale.order', 'fields_get', [[], ['type', 'string', 'selection']]);

  if (pinned) {
    fulfilmentFieldCache = fields[pinned] ? pinned : null;
    if (!fulfilmentFieldCache) {
      console.error(`ODOO_FULFILMENT_FIELD is set to "${pinned}" but sale.order has no such field — ignoring it.`);
    }
    return fulfilmentFieldCache;
  }

  // A custom selection field whose label or technical name reads as
  // "fulfilment/fulfillment status". Both spellings, since Odoo Studio just
  // takes whatever the user typed.
  const match = Object.entries(fields).find(
    ([name, meta]) => meta.type === 'selection' && /fulfil?lment/i.test(`${name} ${meta.string || ''}`),
  );
  fulfilmentFieldCache = match ? match[0] : null;
  return fulfilmentFieldCache;
}

// Writes the pipeline stage onto Odoo's Fulfilment Status field. Best-effort
// like tagSaleOrderStatus — callers log and carry on, since the local CSV
// (server/ops/shared/orderPackingStatus.js) is the source of truth.
async function setFulfilmentStatus({ orderId, status }) {
  const value = FULFILMENT_VALUE_BY_STATUS[status];
  if (!value || !orderId) return null;
  const field = await resolveFulfilmentField();
  if (!field) return null;
  await execute('sale.order', 'write', [[Number(orderId)], { [field]: value }]);
  return value;
}

// Creates (if one doesn't already exist for this order) and posts a customer
// invoice via Odoo's own sale.order._create_invoices — the same call Odoo's
// "Create Invoice" button makes, so it respects whatever invoicing policy,
// taxes and pricing the order already carries rather than this app
// reconstructing them. If the order already has an invoice (e.g. this is a
// retry after a earlier failure, or Delivered got set twice), that invoice is
// reused/posted instead of creating a second one.
//
// ASSUMPTION: _create_invoices is the modern (Odoo 15+) method name. If this
// Odoo instance is older and uses action_invoice_create instead, this will
// surface Odoo's real error message rather than silently doing nothing — fix
// the method name here once you see that error.
async function createAndPostInvoice({ orderId }) {
  if (!orderId) {
    const err = new Error('orderId is required.');
    err.status = 400;
    throw err;
  }
  const { url } = getConfig();
  const [order] = await execute('sale.order', 'read', [[Number(orderId)], ['name', 'invoice_ids']]);
  if (!order) {
    const err = new Error(`Sales Order ${orderId} not found in Odoo.`);
    err.status = 404;
    throw err;
  }

  let invoiceId;
  const existingInvoiceIds = order.invoice_ids || [];
  if (existingInvoiceIds.length) {
    invoiceId = Math.max(...existingInvoiceIds); // most recently created
  } else {
    const created = await execute('sale.order', '_create_invoices', [[Number(orderId)]]);
    invoiceId = Array.isArray(created) ? created[0] : created;
    if (!invoiceId) {
      const err = new Error(
        `Odoo didn't create an invoice for ${order.name} — check its Invoicing Status in Odoo (nothing may be marked "To Invoice" yet).`,
      );
      err.status = 502;
      throw err;
    }
  }

  const [move] = await execute('account.move', 'read', [[invoiceId], ['name', 'state', 'amount_total']]);
  if (move.state === 'draft') {
    await execute('account.move', 'action_post', [[invoiceId]]);
  }
  const [posted] = await execute('account.move', 'read', [[invoiceId], ['name', 'amount_total']]);

  return {
    invoiceId,
    invoiceNumber: posted.name,
    amountTotal: posted.amount_total,
    // Classic anchor-based backend URL — unlike the /odoo/purchase/<id>
    // shorthand used for POs below, this form is honoured by every Odoo
    // version (11+), so it's the safe choice for a record type (invoices)
    // this codebase hasn't linked to before.
    invoiceUrl: url ? `${url}/web#id=${invoiceId}&model=account.move&view_type=form` : null,
  };
}

// ---- Purchasing: create a draft Purchase Order (RFQ) from logged lines ----
// Used by the Weekly Purchasing module's "Send PO to Odoo" button. Creates a
// DRAFT purchase order only (Odoo state 'draft', i.e. an RFQ) — it never
// auto-confirms, so nothing is committed to a vendor until someone reviews
// and sends it from inside Odoo.
//
// Vendors and products are matched by exact name against res.partner /
// product.template; when a vendor's Odoo account has none set up yet
// (expected until the catalog is built out there), this creates them on the
// fly rather than failing the PO — same "match, or fall back" spirit as
// fetchWeekendOrders' product matching above. Newly-created products use
// Odoo's default UOM (Units) rather than trying to map our kg/g/ml/pcs units
// onto Odoo UOM records — the real unit is folded into the line description
// instead, since matching custom UOM ids reliably needs the actual Odoo DB.
// extraFields (e.g. phone/email/street) are only applied when creating a
// brand new partner — ignored when one already exists under that name, same
// "match, or fall back" spirit as findOrCreateProduct below.
async function findOrCreatePartner(vendorName, extraFields = {}) {
  const found = await execute('res.partner', 'search_read', [[['name', '=', vendorName]], ['id', 'name']], { limit: 1 });
  if (found.length) return { id: found[0].id, created: false };
  const id = await execute('res.partner', 'create', [{ name: vendorName, supplier_rank: 1, ...extraFields }]);
  return { id, created: true };
}

async function findOrCreateProduct(itemName) {
  const found = await execute('product.product', 'search_read', [[['name', '=', itemName]], ['id', 'name']], {
    limit: 1,
  });
  if (found.length) return { id: found[0].id, created: false };
  const templateId = await execute('product.template', 'create', [
    { name: itemName, type: 'consu', purchase_ok: true, sale_ok: false },
  ]);
  const variants = await execute('product.product', 'search_read', [
    [['product_tmpl_id', '=', templateId]],
    ['id'],
  ]);
  return { id: variants[0]?.id, created: true };
}

// The materials catalogue, keyed item_id (v1 raw_materials.csv called it
// material_id) and carrying the IP-xxx intermediate products too — hence the
// item_type guard in syncRawMaterialsToOdoo below.
//
// Reads the database rather than materials.csv as of phase 1. This matters
// more here than anywhere else in the migration: odoo_product_id is written
// back by both functions below, and materials.csv stopped being read the
// moment inventoryStore moved. Left on the CSV, the backfill
// syncRawMaterialsToOdoo exists to perform would have written every id it
// resolved into a file nothing loads — reporting hundreds of successful
// matches while resolveProductId went on missing the cache for all of them.
function loadRawMaterials() {
  return readMaterials();
}

// Resolves the Odoo product.product id for one PO line. Prefers the cached
// odoo_product_id on the matching materials.csv row (no Odoo roundtrip,
// and guarantees the PO references the exact product syncRawMaterialsToOdoo
// backfilled) — only falls back to a by-name find-or-create for lines with no
// materialId (ad hoc items not in the catalog) or a materialId that hasn't
// been synced yet, in which case the found/created id is written back so the
// next PO for that material is a cache hit too.
async function resolveProductId({ materialId, itemName }) {
  if (!materialId) {
    const { id } = await findOrCreateProduct(itemName);
    return id;
  }
  const row = loadRawMaterials().find((r) => r.item_id === materialId);
  if (row?.odoo_product_id) return Number(row.odoo_product_id);

  const { id } = await findOrCreateProduct(itemName);
  if (row && id) {
    // One column on one row, rather than the whole-catalogue rewrite this
    // used to be — so a PO built while someone else is logging a purchase
    // can't hand back a stale copy of every other material's stock count.
    update('material', { item_id: materialId }, { odoo_product_id: id });
  }
  return id;
}

// One-time (or re-run-as-needed) backfill: finds-or-creates an Odoo
// product.product for every active raw material that doesn't have an
// odoo_product_id yet, and writes the id back to materials.csv. This is
// what lets resolveProductId above serve PO lines from the cache instead of
// re-matching by name every time. Skips inactive materials (is_active !==
// 'yes') since those aren't purchasable. Safe to re-run — already-synced and
// inactive rows are reported in `skipped`, not touched again.
async function syncRawMaterialsToOdoo() {
  const rows = loadRawMaterials();
  const results = { matched: [], created: [], skipped: [], errors: [] };

  for (const row of rows) {
    // materials.csv also holds the IP-xxx smoked outputs — things we make,
    // not things we buy, so there's nothing to purchase them against in Odoo.
    if ((row.item_type || 'raw_material') !== 'raw_material') continue;
    if (row.odoo_product_id) {
      results.skipped.push({ materialId: row.item_id, itemName: row.item_name, reason: 'already synced' });
      continue;
    }
    if ((row.is_active || '').toLowerCase() !== 'yes') {
      results.skipped.push({ materialId: row.item_id, itemName: row.item_name, reason: 'inactive' });
      continue;
    }
    try {
      const { id, created } = await findOrCreateProduct(row.item_name);
      // Written per row as it is resolved, not batched to the end. This loop
      // makes a network call per material and can run for a while; if it
      // fails or is interrupted halfway, the ids already resolved are saved
      // and a re-run skips them as "already synced" — which is the
      // resumability the function's own doc comment promises. The old
      // single writeCsvFile after the loop lost the lot on a crash.
      update('material', { item_id: row.item_id }, { odoo_product_id: id });
      (created ? results.created : results.matched).push({
        materialId: row.item_id,
        itemName: row.item_name,
        odooProductId: id,
      });
    } catch (err) {
      results.errors.push({ materialId: row.item_id, itemName: row.item_name, error: err.message || String(err) });
    }
  }

  return results;
}

// lines: [{ materialId, itemName, quantity, unit, unitPrice }]
async function createPurchaseOrder({ vendorName, lines }) {
  if (!vendorName || !Array.isArray(lines) || !lines.length) {
    const err = new Error('vendorName and at least one line item are required.');
    err.status = 400;
    throw err;
  }

  const { url } = getConfig();
  const { id: partnerId } = await findOrCreatePartner(vendorName);

  const orderLines = [];
  for (const line of lines) {
    const productId = await resolveProductId({ materialId: line.materialId, itemName: line.itemName });
    const unitSuffix = line.unit ? ` (${line.unit})` : '';
    orderLines.push([
      0,
      0,
      {
        product_id: productId,
        name: `${line.itemName}${unitSuffix}`,
        product_qty: Number(line.quantity) || 0,
        price_unit: line.unitPrice != null && line.unitPrice !== '' ? Number(line.unitPrice) : 0,
      },
    ]);
  }

  const poId = await execute('purchase.order', 'create', [{ partner_id: partnerId, order_line: orderLines }]);
  // Read back the created line ids so the caller (purchasing.js) can record
  // a per-line link in purchase_log.csv — that's what lets a later "delete this
  // purchase" remove the exact matching line from Odoo instead of the whole
  // PO. CAVEAT: this assumes order_line comes back in the same order the
  // lines were created in, which holds in practice for a fresh one2many
  // create but isn't a contractual guarantee from Odoo.
  const [po] = await execute('purchase.order', 'read', [[poId], ['name', 'order_line']]);

  return {
    id: poId,
    name: po?.name || `PO${poId}`,
    url: url ? `${url}/odoo/purchase/${poId}` : null,
    lineIds: po?.order_line || [],
  };
}

// Removes a single line from a (draft) Purchase Order — used when a logged
// purchase linked to that line gets deleted from the Weekly Purchasing UI.
// Only works on draft/RFQ POs, same ones this module ever creates; if the PO
// was confirmed by hand in Odoo since, this will fail and the caller should
// treat it as a non-fatal warning (the CSV-side delete still happened).
async function removePurchaseOrderLine({ poId, lineId }) {
  if (!poId || !lineId) {
    return { removed: false, reason: 'no linked Odoo PO line' };
  }
  await execute('purchase.order.line', 'unlink', [[Number(lineId)]]);
  return { removed: true, poId, lineId };
}

// Used by the Weekly Purchasing "Add vendor" flow to mirror a new
// vendors.csv row into Odoo as a res.partner. Same find-or-create as
// createPurchaseOrder's partner lookup, just called directly (and with
// whatever contact fields the vendor form collected) instead of as a side
// effect of creating a PO.
async function createVendorInOdoo({ vendorName, phone, email, address }) {
  if (!vendorName) {
    const err = new Error('vendorName is required.');
    err.status = 400;
    throw err;
  }
  const extraFields = {};
  if (phone) extraFields.phone = phone;
  if (email) extraFields.email = email;
  if (address) extraFields.street = address;
  return findOrCreatePartner(vendorName, extraFields);
}

// ---- Manual stock on-hand sync (Weekly Purchasing "Add inventory") --------
// This business runs a single warehouse (Smokerings / WH/Stock), so its
// stock location is resolved once and cached rather than picked per call —
// same one-warehouse assumption the rest of this integration makes.
let stockLocationCache = null;
async function resolveStockLocationId() {
  if (stockLocationCache) return stockLocationCache;
  const warehouses = await execute('stock.warehouse', 'search_read', [[], ['lot_stock_id']], { limit: 1 });
  const locationId = warehouses[0]?.lot_stock_id?.[0];
  if (!locationId) {
    const err = new Error("Could not find the Odoo warehouse's stock location — check the Inventory app is set up.");
    err.status = 502;
    throw err;
  }
  stockLocationCache = locationId;
  return locationId;
}

// Odoo has no direct "add N units" endpoint — the same mechanism its own
// Inventory app uses for a manual count is to set stock.quant's
// inventory_quantity (the *counted total*, not a delta) on the product's
// quant at the warehouse location, then call action_apply_inventory(), which
// reconciles it against live on-hand with a real stock move (so it shows up
// in Odoo's stock history/valuation, not a silently edited number). Called
// as a best-effort mirror of a manual inventory_adjustments.csv addition —
// see server/core/inventoryStore.js addInventoryAdjustment / index.js's
// POST /api/purchasing/inventory/adjustments, which never blocks the CSV
// write on this succeeding.
async function addStockOnHand({ materialId, itemName, quantity }) {
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    const err = new Error('quantity must be greater than 0.');
    err.status = 400;
    throw err;
  }

  const productId = await resolveProductId({ materialId, itemName });
  if (!productId) {
    const err = new Error(`No matching Odoo product for ${itemName}.`);
    err.status = 502;
    throw err;
  }

  const locationId = await resolveStockLocationId();
  const existing = await execute(
    'stock.quant',
    'search_read',
    [[['product_id', '=', productId], ['location_id', '=', locationId]], ['id', 'quantity']],
    { limit: 1 },
  );

  let quantId;
  let currentQty = 0;
  if (existing.length) {
    quantId = existing[0].id;
    currentQty = existing[0].quantity || 0;
  } else {
    quantId = await execute('stock.quant', 'create', [{ product_id: productId, location_id: locationId }]);
  }

  const newQty = Math.round((currentQty + qty) * 1000) / 1000;
  await execute('stock.quant', 'write', [[quantId], { inventory_quantity: newQty }]);
  await execute('stock.quant', 'action_apply_inventory', [[quantId]]);

  return { productId, locationId, newQuantity: newQty };
}

export {
  // Raw model-level call, for Odoo-backed features that live in their own
  // module rather than here (see server/ops/b2c/serviceWeeks.js). Everything to do
  // with credentials/auth still stays inside this file — callers only ever
  // get the already-authenticated execute_kw wrapper.
  execute,
  // Odoo product name -> our menu_id, shared with menuCsvMirror.js so a
  // renamed product can still find its knowledge-base row.
  matchProduct,
  getConfig,
  fetchWeekendOrders,
  confirmSaleOrder,
  fetchOrderPackingList,
  fetchRecentOrders,
  createPurchaseOrder,
  removePurchaseOrderLine,
  createVendorInOdoo,
  syncRawMaterialsToOdoo,
  tagSaleOrderStatus,
  setFulfilmentStatus,
  resolveFulfilmentField,
  createAndPostInvoice,
  addStockOnHand,
};
