// Who else is smoking meat in this city — the Competitors view of the
// Customer Map.
//
// The customer half of that screen answers "where are our orders coming
// from". It cannot answer the question that follows it, which is the one that
// actually decides where a pop-up goes or where a flyer drop is wasted: who
// is ALREADY there. A neighbourhood with eleven of our orders and no rival
// within five kilometres is a different proposition from one with eleven
// orders and a 4.7-star brisket house on the same road, and until this file
// existed the map drew both the same way.
//
// What this is and is not
// -----------------------
// This is a HAND-KEPT ROSTER, not a feed. Nobody's API is being scraped and
// no rating updates itself: the list below is what somebody sat down and
// researched, with the date they did it, and it goes stale the way a written
// note goes stale. That is stated on the screen rather than hidden, because a
// competitor list that silently ages is worse than one that admits its age —
// it gets quoted in a decision six months later as if it were live.
//
// Ratings and review counts are Google Maps figures as read on RESEARCHED_ON.
// They are recorded because the gap between a 4.7 and a 3.4 is most of what
// you need to know about whether a competitor is a threat or a warning, but
// they are a snapshot and the screen labels them as one.
//
// Where the points come from
// --------------------------
// The same place every other point on this screen comes from: geocode_cache,
// via server/core/geocode.js, one lookup per address ever. A competitor is an
// address like any other — it goes through the same Nominatim ladder, is
// drawn with the same honesty about precision, and can be pinned by hand when
// the geocoder cannot find a restaurant that is three months old. Nothing
// here talks to a geocoder on a page load.
//
// A restaurant is easier to place than a house in one way and harder in
// another: it has a name a map has often heard of, but it also moves, closes
// and reopens under a new one. So an unplaced competitor is never guessed at
// — it is listed as unplaced and left for a pin.
//
// The arithmetic
// --------------
// Two questions, both straight-line (haversine) distance, same as the service
// board's drop distances and for the same reason — a routing API costs money
// and, inside one city, puts things in nearly the same order:
//
//   PER COMPETITOR     how much of our business sits within `radiusKm` of
//                      them. Not "how good are they" — how much of ours is in
//                      reach of them. That is the number a pop-up decision
//                      turns on.
//   PER NEIGHBOURHOOD  which competitor is nearest, and how far. This is the
//                      contested-areas table, and it is the one that reads as
//                      a warning: our third-busiest area with a rival 400m
//                      away.
//
// Both are deliberately one-directional. Nothing here claims a competitor is
// taking our orders — there is no data on this machine that could support
// that claim. It says they are close, which is a fact, and leaves the
// inference to the person reading it.
import { cacheIndex, addressKey } from '../core/geocode.js';
import { haversineKm, kitchenOrigin } from '../ops/shared/deliveryDistance.js';
import { buildCustomerMapReport } from './customerGeography.js';

// When the roster below was last checked against Google Maps by hand. Shown
// on the screen next to every rating. Update it when you update the list.
const RESEARCHED_ON = '2026-09-23';

// How far from a competitor counts as "in their reach", in kilometres.
// Three, because that is roughly the radius a Bengaluru delivery kitchen and
// its customers actually share — far enough that a rival on the next main
// road counts, near enough that half the city does not.
const DEFAULT_RADIUS_KM = 3;

// The kinds of competitor, in the order they threaten us. The screen groups
// and colours by this, and the key is what the roster stores, so a new
// category is one entry here plus rows below.
//
// `direct` is the only one populated today: places doing the same thing we
// do — American low-and-slow, smoked over hours, sold as brisket, ribs and
// pulled pork. A tandoori grill and a Korean BBQ buffet are both "barbecue"
// in a search result and neither is competing for the same Saturday order,
// which is why the category exists rather than one flat list.
const CATEGORIES = [
  {
    id: 'direct',
    label: 'Direct competitors',
    blurb: 'American-style low-and-slow — brisket, ribs, pulled pork. The same order we are selling.',
  },
];

// The roster.
//
// `street` is what gets sent to the geocoder (the name first, because a
// restaurant name is the most identifying thing in the query); `address` is
// the cache key and what the screen prints. `brand` groups the branches of
// one chain, so three Brisket & Chops rows read as one chain with three
// kitchens rather than as three separate rivals.
//
// rating/reviews null means "not recorded", not "unrated" — see BOB'Z below,
// where the source figure was cut off and a guess would have been worse than
// a blank.
const ROSTER = [
  {
    id: 'smoke-meister',
    name: 'The Smoke Meister',
    brand: 'The Smoke Meister',
    category: 'direct',
    area: 'Geddalahalli, Kothanur',
    street: 'The Smoke Meister, Geddalahalli, Kothanur',
    city: 'Bengaluru',
    rating: 4.7,
    reviews: 872,
    note: '',
  },
  {
    id: 'char-and-co',
    name: 'Char and Co',
    brand: 'Char and Co',
    category: 'direct',
    area: 'HRBR Layout 2nd Block, Kalyan Nagar',
    street: 'Char and Co, HRBR Layout 2nd Block, Kalyan Nagar',
    city: 'Bengaluru',
    rating: 4.7,
    reviews: 168,
    note: '',
  },
  {
    id: 'brisket-chops-100ft',
    name: 'Brisket & Chops — 100 Ft Rd',
    brand: 'Brisket & Chops',
    category: 'direct',
    area: 'HRBR Layout / 100 Ft Road',
    street: 'Brisket and Chops, 100 Feet Road, HRBR Layout',
    city: 'Bengaluru',
    rating: 4.0,
    reviews: 597,
    note: '',
  },
  {
    id: 'brisket-chops-basavanagudi',
    name: 'Brisket & Chops — Basavanagudi',
    brand: 'Brisket & Chops',
    category: 'direct',
    area: 'Rashtriya Vidyalaya Road, Basavanagudi',
    street: 'Brisket and Chops, Rashtriya Vidyalaya Road, Basavanagudi',
    city: 'Bengaluru',
    rating: 3.5,
    reviews: 39,
    note: '',
  },
  {
    id: 'brisket-chops-mm-road',
    name: 'Brisket & Chops — MM Road',
    brand: 'Brisket & Chops',
    category: 'direct',
    area: 'MM Road, Frazer Town',
    street: 'Brisket and Chops, MM Road, Frazer Town',
    city: 'Bengaluru',
    rating: 3.4,
    reviews: 49,
    note: '',
  },
  {
    id: 'porkeys',
    name: "Porkey's Grill and Barbeque",
    brand: "Porkey's",
    category: 'direct',
    area: 'Service Road, Kammanahalli',
    street: "Porkey's Grill and Barbeque, Service Road, Kammanahalli",
    city: 'Bengaluru',
    rating: 4.5,
    reviews: 352,
    note: '',
  },
  {
    id: 'bobz',
    name: "BOB'Z Barbecue",
    brand: "BOB'Z Barbecue",
    category: 'direct',
    area: 'Service Road, Kammanahalli',
    street: "BOB'Z Barbecue, Service Road, Kammanahalli",
    city: 'Bengaluru',
    // Left blank on purpose: the source figure for this one was incomplete
    // ("4.") and a rating rounded from half a digit would be read off this
    // screen as fact. The area is from a directory listing rather than a
    // confirmed sighting, which is what the note says.
    rating: null,
    reviews: null,
    note: 'Rating and area unconfirmed — check before this one is used in a decision.',
  },
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

const round1 = (value) => Math.round(value * 10) / 10;

// The full address string for one roster row — the cache key, the thing the
// screen prints, and what a hand-dropped pin is stored against. One function,
// because a competitor geocoded under one spelling and looked up under
// another is a competitor that never appears.
const addressOf = (row) => [row.street, row.city].filter(Boolean).join(', ');

// The roster as the rest of the app sees it: every row with the address it
// will be looked up by, whether or not anything has looked it up yet.
const roster = () => ROSTER.map((row) => ({ ...row, address: addressOf(row) }));

// The arithmetic, kept free of the database and of Odoo so it can be tested
// against fixtures. `located` is cacheIndex()'s Map; `points` and `areas` are
// the customer report's own arrays, so the two halves of the screen can never
// disagree about where our orders are.
function aggregate({ competitors, located, points = [], areas = [], origin = null, radiusKm = DEFAULT_RADIUS_KM }) {
  const radius = Number(radiusKm) > 0 ? Number(radiusKm) : DEFAULT_RADIUS_KM;

  const placed = [];
  const unplaced = [];

  for (const row of competitors) {
    const hit = located.get(addressKey(row.address));
    const base = {
      ...row,
      latitude: null,
      longitude: null,
      precision: null,
      provider: '',
      status: hit ? hit.status : 'pending',
      locality: hit ? hit.locality || '' : '',
      postcode: hit ? hit.postcode || '' : '',
      distanceFromKitchenKm: null,
      ordersNearby: 0,
      revenueNearby: 0,
      addressesNearby: 0,
      nearestArea: '',
      nearestAreaKm: null,
    };

    if (!hit || hit.status !== 'ok' || hit.latitude == null || hit.longitude == null) {
      unplaced.push(base);
      continue;
    }

    const here = { latitude: hit.latitude, longitude: hit.longitude };
    const entry = {
      ...base,
      latitude: hit.latitude,
      longitude: hit.longitude,
      precision: hit.precision || 'locality',
      provider: hit.provider || '',
      status: 'ok',
      distanceFromKitchenKm: origin ? round1(haversineKm(origin, here)) : null,
    };

    // How much of ours is within reach of them. Address points rather than
    // area circles: an area circle sits at the middle of a neighbourhood and
    // would count a whole suburb as near or far on the strength of where its
    // centre happens to be.
    for (const point of points) {
      if (haversineKm(here, point) > radius) continue;
      entry.ordersNearby += point.orders;
      entry.revenueNearby += point.revenue;
      entry.addressesNearby += 1;
    }

    // The nearest of OUR neighbourhoods, whatever the radius — an isolated
    // competitor still has a closest thing of ours, and "9 km from the
    // nearest of ours" is as much of an answer as "400 m".
    for (const area of areas) {
      const km = haversineKm(here, area);
      if (entry.nearestAreaKm === null || km < entry.nearestAreaKm) {
        entry.nearestAreaKm = km;
        entry.nearestArea = area.name;
      }
    }
    if (entry.nearestAreaKm !== null) entry.nearestAreaKm = round1(entry.nearestAreaKm);

    placed.push(entry);
  }

  // The contested-areas table, read from our side: every neighbourhood we
  // sell into, with whoever is nearest to it. Sorted by our own order count,
  // not by how close the rival is — the point of the table is "here is our
  // business, and here is who is standing next to it", and sorting it by
  // proximity would put an area with one order at the top for having a rival
  // across the street.
  const contested = areas
    .map((area) => {
      let nearest = null;
      let km = null;
      for (const rival of placed) {
        const d = haversineKm(area, rival);
        if (km === null || d < km) {
          km = d;
          nearest = rival;
        }
      }
      return {
        key: area.key,
        name: area.name,
        locality: area.locality,
        postcode: area.postcode,
        latitude: area.latitude,
        longitude: area.longitude,
        orders: area.orders,
        revenue: area.revenue,
        customers: area.customers,
        sharePct: area.sharePct,
        competitor: nearest ? nearest.name : '',
        competitorId: nearest ? nearest.id : '',
        competitorRating: nearest ? nearest.rating : null,
        distanceKm: km === null ? null : round1(km),
        withinRadius: km !== null && km <= radius,
      };
    })
    .sort((a, b) => b.orders - a.orders);

  const rated = placed.concat(unplaced).filter((row) => typeof row.rating === 'number');

  return {
    radiusKm: radius,
    researchedOn: RESEARCHED_ON,
    categories: CATEGORIES,
    competitors: placed
      .map((row) => ({ ...row, revenueNearby: Math.round(row.revenueNearby) }))
      .sort((a, b) => b.ordersNearby - a.ordersNearby || (b.rating || 0) - (a.rating || 0)),
    unplaced,
    contested,
    totals: {
      listed: competitors.length,
      placed: placed.length,
      unplaced: unplaced.length,
      pending: unplaced.filter((row) => row.status === 'pending').length,
      notFound: unplaced.filter((row) => row.status === 'not_found').length,
      brands: new Set(competitors.map((row) => row.brand || row.name)).size,
      // Our own orders that sit within the radius of at least one of them.
      // Counted over the points rather than summed over the competitors,
      // because two rivals on the same road would otherwise count the same
      // order twice and report more contested business than exists.
      ordersInReach: points.reduce(
        (sum, point) => sum + (placed.some((rival) => haversineKm(rival, point) <= radius) ? point.orders : 0),
        0,
      ),
      areasContested: contested.filter((row) => row.withinRadius).length,
      avgRating: rated.length
        ? Math.round((rated.reduce((sum, row) => sum + row.rating, 0) / rated.length) * 10) / 10
        : null,
    },
  };
}

// The report the screen reads. Everything above is arithmetic; this is the
// part that reaches the cache and the customer report.
//
// The customer half is fetched with the same range the screen is showing, so
// "orders within 3 km of them" means orders in the range on screen and not
// some other window the user cannot see.
async function buildCompetitorReport({ fromDate, toDate, radiusKm } = {}) {
  if (radiusKm != null && !(Number(radiusKm) > 0)) badRequest('The radius must be a positive number of kilometres.');
  const customers = await buildCustomerMapReport({ fromDate, toDate });
  return {
    range: customers.range,
    sources: customers.sources,
    // The customer side is carried through so the competitor view can draw
    // our circles underneath theirs without a second round trip — and so the
    // two views cannot disagree about what is in the range.
    ours: {
      points: customers.points,
      areas: customers.areas,
      totals: customers.totals,
    },
    ...aggregate({
      competitors: roster(),
      located: cacheIndex(),
      points: customers.points,
      areas: customers.areas,
      origin: kitchenOrigin(),
      radiusKm,
    }),
  };
}

// The competitor addresses a locate run would act on: the ones nothing has
// ever looked up. Derived here rather than posted by the client, the same way
// the customer side does it — what leaves this machine is decided by the
// server.
function pendingCompetitorAddresses() {
  const cache = cacheIndex();
  return roster().filter((row) => !cache.has(addressKey(row.address)));
}

export {
  buildCompetitorReport,
  pendingCompetitorAddresses,
  aggregate,
  roster,
  addressOf,
  CATEGORIES,
  RESEARCHED_ON,
  DEFAULT_RADIUS_KM,
};
