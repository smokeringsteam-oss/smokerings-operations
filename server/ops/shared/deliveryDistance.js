// How far each order on the service board is from the kitchen — so the board
// can put the nearest drops first and a rider's run can be batched by area.
//
// Built on the Customer Map's geocode cache (server/core/geocode.js) rather
// than a second lookup of its own: one table of "this address is here", one
// rule that an address is only ever sent to the geocoder once.
//
// The distance is straight-line (haversine), not road distance. Road distance
// needs a routing API with a key and a per-call cost; for ranking drops that
// are all inside one city, as-the-crow-flies puts them in nearly the same order
// and costs nothing. The card says "~" so nobody quotes it to a customer.
//
// The kitchen itself is KITCHEN_LAT / KITCHEN_LON in .env. Without them every
// order comes back with distanceStatus 'no_origin' and the board keeps its
// time order — a guessed origin would sort the run confidently wrong.
import { cacheIndex, addressKey, locateAddresses } from '../../core/geocode.js';

function kitchenOrigin() {
  const lat = Number(process.env.KITCHEN_LAT);
  const lon = Number(process.env.KITCHEN_LON);
  if (!process.env.KITCHEN_LAT || !process.env.KITCHEN_LON) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Stamps every order in a fetchOrderPackingList result with:
//   distanceKm      — one decimal, or null
//   distanceStatus  — 'ok' | 'pending' (never looked up) | 'not_found'
//                     | 'no_address' | 'no_origin'
//   locality        — the neighbourhood the geocoder placed it in, '' if none
// Reads the cache only; nothing leaves the machine here.
function attachDistances(result) {
  const origin = kitchenOrigin();
  const cache = cacheIndex();
  for (const group of result.groups || []) {
    for (const order of group.orders || []) {
      order.distanceKm = null;
      order.locality = '';
      if (!order.address) {
        order.distanceStatus = 'no_address';
        continue;
      }
      const hit = cache.get(addressKey(order.address));
      if (hit && hit.status === 'ok') order.locality = hit.locality || '';
      if (!hit) order.distanceStatus = 'pending';
      else if (hit.status !== 'ok') order.distanceStatus = 'not_found';
      else if (!origin) order.distanceStatus = 'no_origin';
      else {
        order.distanceStatus = 'ok';
        order.distanceKm = Math.round(haversineKm(origin, hit) * 10) / 10;
      }
    }
  }
  result.kitchenLocated = Boolean(origin);
  return result;
}

// Looks up the board's addresses that have never been looked up. Takes the
// packing result itself, not a list from the client, so only an address
// already on a confirmed Odoo order can reach the geocoder this way.
async function locateBoardAddresses(result) {
  const pending = [];
  for (const group of result.groups || []) {
    for (const order of group.orders || []) {
      // The whole address as the street: queryPlan splits it on commas and
      // pulls the PIN code out itself, which is all the parts it needs.
      if (order.address) pending.push({ address: order.address, street: order.address });
    }
  }
  return locateAddresses(pending);
}

export { attachDistances, locateBoardAddresses, haversineKm, kitchenOrigin };
