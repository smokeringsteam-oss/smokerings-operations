// Odoo integration for the Weekend Prep Planner: pulls confirmed, B2C
// (individual-customer) Sales Orders in a date range and maps them into the
// same { itemId, slotId, quantity } shape the Gemini paste extractor
// produces, so the planner's Step 1 can merge either source through the
// exact same code path (applyExtractedOrders).
//
// Talks to Odoo's JSON-RPC 2.0 API directly over fetch — no XML-RPC client
// dependency needed, same "raw API over fetch" style as githubProjects.js.

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
  const json = await resp.json();
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

function matchProduct(productName) {
  if (!productName) return null;
  return PRODUCT_NAME_TO_ITEM_ID[productName] || keywordMatch(productName);
}

// ---- Weekend slot (Sat/Sun Lunch/Dinner) via Odoo tags ---------------------
// The kitchen tags each order with its intended slot (crm.tag records:
// "Saturday Lunch", "Saturday Dinner", "Sunday Dinner", ...) — this is the
// real signal, NOT date_order's time-of-day. Orders often get typed into
// Odoo well after the fact (batches entered at 2am are common here), so the
// timestamp has no relationship to which weekend slot the order is actually
// for. Matched by tag NAME, not a hardcoded id, so a newly created tag (e.g.
// once "Sunday Lunch" exists — it doesn't yet on this instance) picks up
// automatically with no code change needed.
const TAG_NAME_TO_SLOT = {
  'Saturday Lunch': 'satLunch',
  'Saturday Dinner': 'satEvening',
  'Sunday Lunch': 'sunLunch',
  'Sunday Dinner': 'sunEvening',
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

// fromDate/toDate are 'YYYY-MM-DD'. Pulls confirmed (state: sale/done), B2C
// (partner_id.is_company = false) Sales Orders whose date_order falls in
// range, sums their line quantities by menu item + weekend slot (from tags).
//
// NOTE: this Odoo instance's res.partner doesn't expose the "company_type"
// selection field (Individual/Company) for domain filtering — only the
// underlying "is_company" boolean, which company_type is normally derived
// from. is_company = false is the B2C (individual) side, same distinction,
// just the boolean form. Confirmed against real data on this instance.
async function fetchWeekendOrders({ fromDate, toDate }) {
  if (!fromDate || !toDate) {
    const err = new Error('fromDate and toDate are required (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }

  // date_order carries a time component, so make the end bound exclusive on
  // the day after `toDate` to fully include that whole day.
  const toExclusive = new Date(`${toDate}T00:00:00Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const toBoundStr = toExclusive.toISOString().slice(0, 10);

  const domain = [
    ['date_order', '>=', `${fromDate} 00:00:00`],
    ['date_order', '<', `${toBoundStr} 00:00:00`],
    ['state', 'in', ['sale', 'done']],
    ['partner_id.is_company', '=', false], // B2C only — B2B/corporate orders are excluded
  ];

  const [orders, slotTagMap] = await Promise.all([
    execute('sale.order', 'search_read', [domain, ['id', 'name', 'date_order', 'partner_id', 'tag_ids']]),
    getSlotTagMap(),
  ]);
  if (!orders.length) {
    return { orders: [], unmatched: [], ordersFound: 0 };
  }

  const orderIds = orders.map((o) => o.id);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // Resolve each order's slot once, up front — an order's own tags decide
  // its slot, not anything per-line.
  const slotByOrderId = new Map();
  for (const order of orders) {
    const matchedTagId = (order.tag_ids || []).find((id) => slotTagMap.has(id));
    if (matchedTagId != null) slotByOrderId.set(order.id, slotTagMap.get(matchedTagId));
  }

  const lines = await execute('sale.order.line', 'search_read', [
    [
      ['order_id', 'in', orderIds],
      ['display_type', '=', false], // skip section/note lines, which have no real product
    ],
    ['order_id', 'product_id', 'product_uom_qty', 'name'],
  ]);

  const tally = new Map(); // `${itemId}|${slotId}` -> quantity
  const unmatched = [];
  const untaggedOrderIds = new Set();

  for (const line of lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    const order = orderById.get(orderId);
    if (!order) continue;

    const slotId = slotByOrderId.get(orderId);
    if (!slotId) {
      untaggedOrderIds.add(orderId);
      continue;
    }

    const productName = line.product_id ? line.product_id[1] : line.name;
    const qty = Math.round(line.product_uom_qty || 0);
    if (!qty) continue;

    const itemId = matchProduct(productName);
    if (!itemId) {
      unmatched.push(`${qty} × ${productName} (order ${order.name})`);
      continue;
    }

    const key = `${itemId}|${slotId}`;
    tally.set(key, (tally.get(key) || 0) + qty);
  }

  // One message per untagged order, not per line — an order missing its
  // slot tag needs fixing in Odoo (add the tag), not a line-by-line review.
  for (const orderId of untaggedOrderIds) {
    const order = orderById.get(orderId);
    const partnerName = order.partner_id ? order.partner_id[1] : 'unknown customer';
    unmatched.push(`Order ${order.name} (${partnerName}) has no Saturday/Sunday Lunch/Dinner tag in Odoo — tag it and re-fetch.`);
  }

  const resultOrders = Array.from(tally.entries()).map(([key, quantity]) => {
    const [itemId, slotId] = key.split('|');
    return { itemId, slotId, quantity };
  });

  return { orders: resultOrders, unmatched, ordersFound: orders.length };
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
  if (found.length) return found[0].id;
  const templateId = await execute('product.template', 'create', [
    { name: itemName, type: 'consu', purchase_ok: true, sale_ok: false },
  ]);
  const variants = await execute('product.product', 'search_read', [
    [['product_tmpl_id', '=', templateId]],
    ['id'],
  ]);
  return variants[0]?.id;
}

// lines: [{ itemName, quantity, unit, unitPrice }]
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
    const productId = await findOrCreateProduct(line.itemName);
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
  // a per-line link in purchases.csv — that's what lets a later "delete this
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

export { getConfig, fetchWeekendOrders, createPurchaseOrder, removePurchaseOrderLine, createVendorInOdoo };
