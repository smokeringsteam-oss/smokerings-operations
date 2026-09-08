// Where our customers are — the report behind Marketing > Customer Map.
//
// Every other screen on this dashboard answers a question about time or about
// money. This one answers a question about place: which parts of the city the
// orders actually come from, how far apart they are, and where there is a
// cluster worth putting a flyer, a pop-up or a delivery run into. A business
// that delivers has a geography whether or not anybody has looked at it, and
// until this screen existed nobody had — the addresses were in Odoo one order
// at a time and nowhere all at once.
//
// Where the numbers come from
// ---------------------------
//   Odoo sale.order        confirmed orders (sale/done) in the range, dated
//                          by date_order, with the address each was delivered
//                          to. See fetchCustomerLocations in
//                          server/integrations/odoo.js.
//   geocode_cache          where each of those addresses is, looked up once
//                          and kept. See server/core/geocode.js.
//
// The two are joined here and nowhere else. Nothing in this file talks to a
// geocoder: the report reads only what has already been looked up and reports
// the rest as "not on the map yet", which is what makes it safe to build on
// every page load. Sending an address out is a separate, deliberate act (the
// locate endpoint), for the reason set out at the top of geocode.js.
//
// The three counting rules
// ------------------------
// 1. A CUSTOMER IS AN ACCOUNT, not an address and not an order. A website
//    checkout creates a fresh child partner for each delivery, so counting
//    addresses would report one regular as four new faces. partner_id is the
//    identity; the address is where their food went.
// 2. A PIN IS AN ADDRESS. Four orders to one house are one pin sized four,
//    not four pins stacked on the same roof and drawn as one.
// 3. AN AREA IS WHAT THE GEOCODER CALLS IT, not what the customer typed.
//    "HSR", "HSR Layout" and "hsr layout sector 2" are one neighbourhood and
//    three spellings; grouping on the customer's text would split one real
//    cluster into three small ones and hide it.
//
// Both sides of the business are on one map, tagged B2C or B2B, and every
// figure is carried per side so the screen can filter without a round trip.
// Unlike Sales by Item — where a portion and a kilo could not share an axis —
// an order is an order here and a rupee is a rupee, so the two really do add
// up. What they do not share is meaning: three wholesale accounts in an
// industrial area is a different fact from thirty weekend customers in a
// residential one, which is why the split is always visible rather than
// pooled into one total and left there.
import { cacheIndex, addressKey } from '../core/geocode.js';
import { fetchCustomerLocations, getConfig as getOdooConfig } from '../integrations/odoo.js';

// How far back the screen opens on. Twelve weeks, the same quarter the two
// money screens open on — long enough that a neighbourhood with one order a
// month shows up as a neighbourhood rather than as noise.
const DEFAULT_DAYS = 84;

const pad = (n) => String(n).padStart(2, '0');
// Local-calendar dates, never toISOString() — UTC hands back yesterday for
// the first five and a half hours of every IST day.
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const today = () => isoOf(new Date());

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function cleanDate(value, what) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) badRequest(`${what} must be a date (YYYY-MM-DD).`);
  return text;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(new Date(y, m - 1, d + days));
}

const round = (value, places = 6) => Number(value.toFixed(places));

// An empty per-side tally. Written once because a point, an area and the
// totals all keep the same shape, and three hand-rolled copies would drift.
const emptyTally = () => ({
  orders: 0,
  revenue: 0,
  b2cOrders: 0,
  b2bOrders: 0,
  b2cRevenue: 0,
  b2bRevenue: 0,
});

function addToTally(tally, order) {
  tally.orders += 1;
  tally.revenue += order.revenue;
  if (order.channel === 'B2B') {
    tally.b2bOrders += 1;
    tally.b2bRevenue += order.revenue;
  } else {
    tally.b2cOrders += 1;
    tally.b2cRevenue += order.revenue;
  }
}

const finishTally = (tally) => ({
  ...tally,
  revenue: Math.round(tally.revenue),
  b2cRevenue: Math.round(tally.b2cRevenue),
  b2bRevenue: Math.round(tally.b2bRevenue),
});

// What an area is called, in the order of what is most useful to read on a
// row. The geocoder's locality wins (rule 3 above); the PIN code is the
// fallback for the outskirts, where a delivery lands somewhere the map has no
// neighbourhood name for at all.
function areaLabel({ locality, postcode }) {
  if (locality && postcode) return `${locality} · ${postcode}`;
  return locality || (postcode ? `PIN ${postcode}` : 'Bengaluru (area unknown)');
}

// The core of the report, kept free of Odoo and of the database so it can be
// tested against fixtures: orders in, geography out.
//
// `located` is the geocode cache as a Map of address_key -> row, which is
// exactly what cacheIndex() returns.
function aggregate({ orders, located }) {
  const points = new Map();
  const areas = new Map();
  const unlocated = new Map();
  const noAddress = new Map();

  // Order counts per customer for the whole range, so "repeat" can be decided
  // once and read per area — a customer with orders in two areas (home and
  // office, say) is a repeat customer in both, which is the truth.
  const ordersPerCustomer = new Map();
  for (const order of orders) {
    const id = order.customerId ?? `name:${order.customer}`;
    ordersPerCustomer.set(id, (ordersPerCustomer.get(id) || 0) + 1);
  }
  const isRepeat = (order) => (ordersPerCustomer.get(order.customerId ?? `name:${order.customer}`) || 0) > 1;

  const totals = emptyTally();
  const locatedTotals = emptyTally();
  const allCustomers = new Set();
  const locatedCustomers = new Set();

  for (const order of orders) {
    const customerKey = order.customerId ?? `name:${order.customer}`;
    addToTally(totals, order);
    allCustomers.add(customerKey);

    // No address at all. Not a geocoding failure and must not be reported as
    // one — nothing was ever going to find it, and the fix is in Odoo, not
    // here. A pop-up sale or a counter pickup lands in this bucket too.
    if (!order.address) {
      const row = noAddress.get(customerKey) || { customer: order.customer, ...emptyTally() };
      addToTally(row, order);
      row.customer = order.customer;
      noAddress.set(customerKey, row);
      continue;
    }

    const key = addressKey(order.address);
    const hit = located.get(key);

    if (!hit || hit.status !== 'ok') {
      const row = unlocated.get(key) || {
        address: order.address,
        street: order.street,
        street2: order.street2,
        city: order.city,
        zip: order.zip,
        // 'pending' has never been sent anywhere; 'not_found' was looked up
        // and the geocoder had nothing. The screen offers a different action
        // for each — one is a button, the other is a pin dropped by hand.
        status: hit ? 'not_found' : 'pending',
        customers: new Set(),
        ...emptyTally(),
      };
      addToTally(row, order);
      row.customers.add(customerKey);
      unlocated.set(key, row);
      continue;
    }

    addToTally(locatedTotals, order);
    locatedCustomers.add(customerKey);

    const point = points.get(key) || {
      key,
      address: order.address,
      latitude: hit.latitude,
      longitude: hit.longitude,
      precision: hit.precision || 'address',
      provider: hit.provider,
      locality: hit.locality || order.city || '',
      postcode: hit.postcode || order.zip || '',
      customers: new Set(),
      names: new Set(),
      lastOrder: '',
      ...emptyTally(),
    };
    addToTally(point, order);
    point.customers.add(customerKey);
    point.names.add(order.customer);
    if (order.day > point.lastOrder) point.lastOrder = order.day;
    points.set(key, point);

    const areaKey = `${(hit.locality || '').toLowerCase()}|${hit.postcode || ''}`;
    const area = areas.get(areaKey) || {
      key: areaKey,
      name: areaLabel({ locality: hit.locality, postcode: hit.postcode }),
      locality: hit.locality || '',
      postcode: hit.postcode || '',
      customers: new Set(),
      repeatCustomers: new Set(),
      addresses: new Set(),
      latSum: 0,
      lonSum: 0,
      ...emptyTally(),
    };
    addToTally(area, order);
    area.customers.add(customerKey);
    if (isRepeat(order)) area.repeatCustomers.add(customerKey);
    area.addresses.add(key);
    // The centroid is the mean of the ORDERS, not of the addresses: an area's
    // dot should sit where its business is, so ten orders from one street
    // pull it there rather than being outvoted by two one-off addresses on
    // the far edge.
    area.latSum += hit.latitude;
    area.lonSum += hit.longitude;
    areas.set(areaKey, area);
  }

  const orderTotal = totals.orders || 1;

  return {
    totals: {
      ...finishTally(totals),
      customers: allCustomers.size,
      areas: areas.size,
      addresses: points.size + unlocated.size,
      located: { ...finishTally(locatedTotals), customers: locatedCustomers.size, addresses: points.size },
      unlocated: {
        addresses: unlocated.size,
        orders: Array.from(unlocated.values()).reduce((sum, row) => sum + row.orders, 0),
        // Never looked up yet — the number the button on the screen acts on.
        pending: Array.from(unlocated.values()).filter((row) => row.status === 'pending').length,
        notFound: Array.from(unlocated.values()).filter((row) => row.status === 'not_found').length,
      },
      noAddress: {
        customers: noAddress.size,
        orders: Array.from(noAddress.values()).reduce((sum, row) => sum + row.orders, 0),
      },
    },

    points: Array.from(points.values())
      .map((point) => ({
        ...finishTally(point),
        key: point.key,
        address: point.address,
        latitude: point.latitude,
        longitude: point.longitude,
        precision: point.precision,
        provider: point.provider,
        area: areaLabel({ locality: point.locality, postcode: point.postcode }),
        customers: point.customers.size,
        // At most three names on a pin's tooltip. One address is nearly
        // always one household; the exceptions are an office and a block of
        // flats, and the useful thing there is "and 4 others", not a list.
        names: Array.from(point.names).slice(0, 3),
        otherNames: Math.max(0, point.names.size - 3),
        lastOrder: point.lastOrder,
      }))
      .sort((a, b) => b.orders - a.orders),

    areas: Array.from(areas.values())
      .map((area) => ({
        ...finishTally(area),
        key: area.key,
        name: area.name,
        locality: area.locality,
        postcode: area.postcode,
        customers: area.customers.size,
        repeatCustomers: area.repeatCustomers.size,
        addresses: area.addresses.size,
        latitude: round(area.latSum / area.orders),
        longitude: round(area.lonSum / area.orders),
        // Share of every order in the range, located or not — an area that is
        // 30% of what we can draw but 12% of what we sold is worth knowing
        // about before anybody plans a delivery route around it.
        sharePct: round((area.orders / orderTotal) * 100, 1),
      }))
      .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue),

    unlocated: Array.from(unlocated.values())
      .map((row) => ({
        ...finishTally(row),
        address: row.address,
        street: row.street,
        street2: row.street2,
        city: row.city,
        zip: row.zip,
        status: row.status,
        customers: row.customers.size,
      }))
      .sort((a, b) => b.orders - a.orders),

    noAddress: Array.from(noAddress.values())
      .map((row) => ({ ...finishTally(row), customer: row.customer }))
      .sort((a, b) => b.orders - a.orders),
  };
}

// The report the screen reads. Everything above is arithmetic; this is the
// part that talks to Odoo and to the cache.
async function buildCustomerMapReport({ fromDate, toDate } = {}) {
  const to = toDate ? cleanDate(toDate, 'The end of the range') : today();
  const from = fromDate ? cleanDate(fromDate, 'The start of the range') : addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) badRequest('The start of the range is after its end.');

  const odoo = getOdooConfig();
  // Odoo failing empties this screen — unlike the money screens, there is no
  // local half to fall back on, because every address lives in Odoo. So it
  // degrades to an empty map that says why rather than to an error page,
  // which at least still shows the cache's own state.
  const source = odoo.configured
    ? await fetchCustomerLocations({ fromDate: from, toDate: to })
        .then((result) => ({ ...result, error: '' }))
        .catch((err) => ({ orders: [], ordersFound: 0, error: err.message || String(err) }))
    : { orders: [], ordersFound: 0, error: '' };

  return {
    range: { from, to, days: Math.round((new Date(to) - new Date(from)) / 86400000) + 1 },
    sources: {
      odoo: {
        configured: odoo.configured,
        url: odoo.url,
        error: source.error || '',
        reachable: odoo.configured && !source.error,
        ordersRead: source.ordersFound,
      },
      geocoder: { provider: 'OpenStreetMap Nominatim', cached: cacheIndex().size },
    },
    ...aggregate({ orders: source.orders, located: cacheIndex() }),
  };
}

// The addresses a locate run would act on: every one in the range that has
// never been sent anywhere. Returned in most-orders-first order so a batch
// that only covers part of them covers the part that matters most.
//
// Deliberately derived from the report rather than passed up from the screen:
// the list of addresses about to leave this machine is decided by the server,
// not by whatever a client posts.
async function pendingAddresses({ fromDate, toDate } = {}) {
  const report = await buildCustomerMapReport({ fromDate, toDate });
  return report.unlocated.filter((row) => row.status === 'pending');
}

export { buildCustomerMapReport, pendingAddresses, aggregate, areaLabel, DEFAULT_DAYS };
