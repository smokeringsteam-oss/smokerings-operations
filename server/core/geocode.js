// Turning a customer's address into a point on the map, once.
//
// The Customer Map screen (server/marketing/customerGeography.js) is the only
// caller. Odoo knows where every customer lives as free text — "1st Main,
// HSR Layout, Bengaluru 560102" — and free text cannot be drawn. Something
// has to look it up, and this is that something.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: an address is sent outside this
// machine at most once, ever. Geocoding a customer address means handing a
// third party the place somebody lives, so:
//   * nothing here runs on a page load. The report reads the cache and says
//     how many addresses are not in it; a lookup happens only when someone
//     presses the button on the screen.
//   * every answer is written to geocode_cache, including "no match" — see
//     the note on the table in schema.sql for why a failure has to be a row.
//   * a manual pin is never overwritten by a later lookup.
//
// The provider is Nominatim, OpenStreetMap's own geocoder. No key, no
// account, and no per-request cost, which for a business with tens of
// addresses is the whole argument. What it asks for in return is the usage
// policy (https://operations.osmfoundation.org/policies/nominatim/): an
// identifying User-Agent, and at most one request a second. Both are honoured
// below, and the one-a-second is why a locate run is batched and reports
// progress rather than pretending to be instant.
//
// Set GEOCODER_EMAIL in .env to put a real contact address in the User-Agent.
// Nominatim asks for one so they can get in touch before blocking anybody,
// and a run without it is more likely to be rate-limited.
import { all, get, run } from './db.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// The usage policy's absolute limit is one request per second. 1100ms rather
// than 1000 because the clock that matters is theirs, not ours, and being
// fractionally under the limit is how a run gets a 429 halfway through.
const REQUEST_SPACING_MS = 1100;

// How many addresses one press of the button will look up. At 1.1s each this
// is about half a minute of waiting, which is as long as a screen can hold
// somebody's attention; what is left over is reported and the button can be
// pressed again.
const DEFAULT_BATCH = 25;

// Everything here is Bengaluru unless somebody says otherwise. Without a
// country the geocoder cheerfully answers "Whitefield" with a village in
// Yorkshire, and the answer looks perfectly plausible on a world map.
const COUNTRY_CODES = 'in';

// The box every result must fall inside, as [south, west, north, east].
// Roughly Karnataka and a margin — wide enough for a Mysore or Hosur address
// to be real, tight enough that a match in another state is what it almost
// always is: the geocoder finding a same-named road a thousand kilometres
// away. A result outside it is recorded as not_found rather than drawn.
const PLAUSIBLE_BOX = [11.0, 73.5, 19.5, 79.0];

const nowIso = () => new Date().toISOString();

// The cache key. Two spellings of one address must land on one row, or the
// same house is geocoded twice and shows as two pins that nearly overlap.
// Case, punctuation and runs of whitespace are all noise; digits are not,
// because a flat number and a PIN code are both digits and both matter.
function addressKey(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Odoo hands back `false` for an empty char field, and an address pasted out
// of a maps app arrives with newlines in it.
const text = (value) => (value === false || value == null ? '' : String(value).replace(/\s+/g, ' ').trim());

// Words that are in every second address here and therefore identify nothing.
// The city and the state are the important ones: a query that has been cut
// back until "Bengaluru, Karnataka, India" is all that is left will still
// match — it will match the middle of the city — and that answer is worse
// than no answer, because it looks like a customer.
// The generic name-parts are here for a subtler reason than the city is: half
// the neighbourhoods in this city end in "Nagar" or "Layout", so a match on
// that word alone would let Rajaji Nagar answer for Ashok Nagar.
const STOPWORDS = new Set([
  'bengaluru', 'bangalore', 'bengalooru', 'bangaluru', 'blr', 'karnataka', 'india', 'bharat',
  'road', 'main', 'cross', 'layout', 'sector', 'phase', 'block', 'stage', 'floor', 'flat',
  'apartment', 'apartments', 'apts', 'building', 'tower', 'towers', 'villa', 'house', 'door',
  'near', 'opposite', 'behind', 'beside', 'next', 'above', 'landmark',
  'nagar', 'colony', 'extension', 'circle', 'street', 'lane', 'avenue', 'enclave',
  'residency', 'heights', 'park', 'gardens', 'garden',
  'first', 'second', 'third', 'fourth', 'fifth', 'north', 'south', 'east', 'west',
]);

// The words in a piece of an address that could actually identify a place.
//
// Three letters, not four: half the localities here are known by an initialism
// — HSR, BTM, RMV, JP Nagar — and a four-letter floor would throw away the
// only identifying word in the address. Anything starting with a digit goes,
// which covers "4th", "2nd", "301" and the house numbers; a six-digit run is
// the exception, because a PIN code is the most identifying thing in most of
// these addresses.
function keywordsOf(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => {
      if (/^\d{6}$/.test(word)) return true;
      if (/^\d/.test(word)) return false;
      return word.length >= 3 && !STOPWORDS.has(word);
    });
}

// A PIN code written into the address line rather than into Odoo's zip field,
// which is where most of them are — the checkout captures one free-text
// address and nothing splits it up afterwards.
const pinFrom = (value) => {
  const found = String(value || '').match(/\b(5[6-9]\d{4}|\d{6})\b/);
  return found ? found[1] : '';
};

// The queries to try for one address, most specific first.
//
// This ladder is the part of the file that decides whether a pin is any good,
// and it is built around how addresses are actually written here. A Bengaluru
// address is a flat number, a building name, a couple of cross roads and then
// — at the end — the locality, which is the only piece of it any map has ever
// heard of. So the ladder throws away the FRONT of the address rather than
// the back: the whole thing, then the last three pieces of it, then the last
// piece alone, then the PIN code.
//
// Pieces that identify nothing are dropped before the ladder is built, and a
// step whose remaining pieces are all like that is never asked at all. That
// is what stops the walk ending in "India, Bengaluru", which matches happily
// and puts a customer in the middle of the city they might live anywhere in.
//
// Every step is only a candidate: what a hit is worth is decided by what came
// back, not by which step found it (see precisionOf).
function queryPlan({ street, street2, city, zip }) {
  const town = text(city) || 'Bengaluru';
  const line = [text(street), text(street2)].filter(Boolean).join(', ');
  const pin = text(zip) || pinFrom(line);

  const chunks = line
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
  // The pieces worth cutting back to. A chunk that is only a number, or only
  // "Bangalore 560043", cannot be the locality.
  const named = chunks.filter((chunk) => keywordsOf(chunk).some((word) => !/^\d{6}$/.test(word)));

  const candidates = [];
  if (chunks.length) candidates.push([...chunks, town, pin]);
  if (named.length > 3) candidates.push([...named.slice(-3), town, pin]);
  // One identifying piece and the city. Worth asking even when it is the only
  // identifying piece the address had — "Flat 202, Building 198, 9th Main
  // Road, 19th A Cross Rd, 7th Sector, HSR Layout" has exactly one, and
  // asking for it is the difference between a pin in HSR Layout and a pin in
  // the middle of a PIN code that covers four neighbourhoods.
  if (named.length) candidates.push([named[named.length - 1], town]);
  if (pin) candidates.push([pin, town]);
  if (!candidates.length) candidates.push([town]);

  const plan = [];
  const seen = new Set();
  for (const parts of candidates) {
    const query = parts.filter(Boolean).join(', ');
    const isPostcode = parts.length === 2 && parts[0] === pin;
    // Everything the query is asking about, minus the city and the noise. A
    // step with nothing left to ask about is not asked.
    const keywords = keywordsOf(parts.slice(0, -1).join(' '));
    if (seen.has(query) || (!keywords.length && !isPostcode)) continue;
    seen.add(query);
    plan.push({ query, keywords, postcode: isPostcode ? pin : '' });
  }
  return plan;
}

// Place types too coarse to be a customer. A result of this kind means the
// geocoder recognised the city or the state in the query and nothing else,
// which is a match in the same sense that "Earth" is a match.
const COARSE_TYPES = new Set([
  'country', 'state', 'state_district', 'region', 'province', 'county',
  'city', 'municipality', 'administrative', 'continent',
]);

// Place types that really are a building rather than a part of town.
const EXACT_TYPES = new Set([
  'house', 'house_number', 'building', 'address', 'residential', 'apartments',
  'amenity', 'shop', 'office', 'commercial', 'place_of_worship', 'restaurant',
]);

// How much of a claim this result is allowed to be. Taken from what came back
// rather than from which step asked for it: a full address that only matched
// down to the suburb is a suburb-accurate pin, however specific the question
// was, and drawing it as a rooftop would be a lie the screen then repeats.
function precisionOf(hit, step) {
  const type = String(hit.addresstype || hit.type || '').toLowerCase();
  if (step.postcode || type === 'postcode') return 'postcode';
  return EXACT_TYPES.has(type) ? 'address' : 'locality';
}

// Whether the geocoder matched something we actually asked about.
//
// Nominatim always answers if it can find anything at all, so a query it does
// not really understand comes back as the nearest thing it does — usually the
// city. The test is therefore not "did it answer" but "is any of what I asked
// for in the answer": one distinctive word shared between the query and the
// place that came back. A postcode step is checked against the postcode
// itself, which is exact.
function matchesQuery(hit, step) {
  const type = String(hit.addresstype || hit.type || '').toLowerCase();
  if (step.postcode) {
    return String((hit.address && hit.address.postcode) || '').includes(step.postcode)
      || String(hit.display_name || '').includes(step.postcode);
  }
  if (COARSE_TYPES.has(type)) return false;
  const found = new Set(keywordsOf(hit.display_name));
  return step.keywords.some((word) => found.has(word));
}

// The neighbourhood a point is in, out of Nominatim's own breakdown of the
// address it matched. This is what the screen groups by, and it is taken from
// the geocoder rather than from what the customer typed on purpose: the
// customer's spelling of their own area varies ("HSR", "HSR Layout", "hsr
// layout sector 2") and three spellings would be three rows in a table that
// is meant to say where people are.
function localityOf(address) {
  if (!address) return '';
  return (
    text(address.suburb) ||
    text(address.neighbourhood) ||
    text(address.quarter) ||
    text(address.village) ||
    text(address.town) ||
    text(address.city_district) ||
    text(address.county) ||
    text(address.city) ||
    ''
  );
}

const inPlausibleBox = (lat, lon) =>
  lat >= PLAUSIBLE_BOX[0] && lat <= PLAUSIBLE_BOX[2] && lon >= PLAUSIBLE_BOX[1] && lon <= PLAUSIBLE_BOX[3];

function userAgent() {
  const email = (process.env.GEOCODER_EMAIL || '').trim();
  return `SmokeRingsBBQ-Automation/1.0${email ? ` (${email})` : ''}`;
}

// One step of the ladder. Returns null both for "nothing there" and for "that
// answer is not about what I asked" — see matchesQuery, which is where most
// of the bad pins are stopped. Throws only for a failure worth stopping the
// whole run over: a 429 or a dead network, where carrying on would collect
// the same error twenty-four more times.
async function askNominatim(step) {
  const query = typeof step === 'string' ? step : step.query;
  const guard = typeof step === 'string' ? { keywords: keywordsOf(step), postcode: '' } : step;
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', query);
  url.searchParams.set('countrycodes', COUNTRY_CODES);
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const resp = await fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en' } });
  if (resp.status === 429 || resp.status === 503) {
    const err = new Error('The OpenStreetMap geocoder is rate-limiting us. Wait a minute and press the button again.');
    err.status = 429;
    err.fatal = true;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`The geocoder answered ${resp.status}.`);
    err.status = 502;
    err.fatal = true;
    throw err;
  }

  const results = await resp.json();
  if (!Array.isArray(results) || !results.length) return null;

  const hit = results[0];
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inPlausibleBox(lat, lon)) return null;
  if (!matchesQuery(hit, guard)) return null;

  return {
    latitude: lat,
    longitude: lon,
    precision: precisionOf(hit, guard),
    locality: localityOf(hit.address),
    postcode: text(hit.address && hit.address.postcode) || guard.postcode,
    displayName: text(hit.display_name),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The cache ------------------------------------------------------------

function cachedRow(address) {
  const key = addressKey(address);
  if (!key) return null;
  return get('SELECT * FROM geocode_cache WHERE address_key = ?', key) || null;
}

// Every cached address, as a Map keyed the way addressKey keys them. The
// report reads the whole table once rather than a row per order — there are a
// few hundred rows at most, and a per-order lookup would be a query per
// customer on every page load.
function cacheIndex() {
  const rows = all('SELECT * FROM geocode_cache');
  return new Map(rows.map((row) => [row.address_key, row]));
}

function writeCache(address, result) {
  const key = addressKey(address);
  if (!key) return null;
  run(
    `INSERT INTO geocode_cache (address_key, address, latitude, longitude, precision, locality, postcode,
                                display_name, provider, status, looked_up_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address_key) DO UPDATE SET
       address      = excluded.address,
       latitude     = excluded.latitude,
       longitude    = excluded.longitude,
       precision    = excluded.precision,
       locality     = excluded.locality,
       postcode     = excluded.postcode,
       display_name = excluded.display_name,
       provider     = excluded.provider,
       status       = excluded.status,
       looked_up_at = excluded.looked_up_at`,
    key,
    text(address),
    result.latitude ?? null,
    result.longitude ?? null,
    result.precision ?? null,
    result.locality || null,
    result.postcode || null,
    result.displayName || null,
    result.provider || 'nominatim',
    result.status || 'ok',
    nowIso(),
  );
  return cachedRow(address);
}

// A pin somebody dropped by hand, for the address the geocoder cannot find —
// which in Bengaluru is a normal outcome, not an edge case: an apartment name
// and a landmark are how people give directions and are not on any map.
//
// Stored as provider 'manual' and precision 'address', because a human
// pointing at a building is the most precise answer there is. locateAddresses
// skips these, so a later run never moves a pin back to a guess.
function pinAddress({ address, latitude, longitude, locality, postcode }) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!text(address)) {
    const err = new Error('An address is required to pin.');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const err = new Error('A pin needs a latitude and a longitude.');
    err.status = 400;
    throw err;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    const err = new Error('That latitude/longitude is not a point on Earth.');
    err.status = 400;
    throw err;
  }
  return writeCache(address, {
    latitude: lat,
    longitude: lon,
    precision: 'address',
    locality: text(locality),
    postcode: text(postcode),
    displayName: text(address),
    provider: 'manual',
    status: 'ok',
  });
}

// Drops what we know about an address so the next run asks again. The one
// thing it is for: an address that was mistyped in Odoo, fixed there, and now
// deserves a fresh lookup — the key changes with the text, but a not_found
// row for the old spelling would otherwise sit there forever.
function forgetAddress(address) {
  const key = addressKey(address);
  if (!key) return false;
  const result = run('DELETE FROM geocode_cache WHERE address_key = ?', key);
  return (result.changes || 0) > 0;
}

// ---- The run --------------------------------------------------------------

// Looks up as many of `addresses` as are not already known, oldest-unknown
// first, up to `limit`. Returns what it did rather than the located rows: the
// caller reloads the report, which reads the cache the same way it always
// does, so there is one path from a cached row to a pin on the map.
//
// A fatal provider error (rate limit, network gone) stops the run and is
// reported alongside whatever was already looked up and written — those rows
// are kept, because throwing away twenty successful lookups over the
// twenty-first would mean sending those addresses out a second time.
async function locateAddresses(addresses, { limit = DEFAULT_BATCH } = {}) {
  const cache = cacheIndex();
  const seen = new Set();
  const pending = [];

  for (const entry of addresses || []) {
    const address = typeof entry === 'string' ? entry : text(entry && entry.address);
    const key = addressKey(address);
    if (!key || seen.has(key) || cache.has(key)) continue;
    seen.add(key);
    pending.push(typeof entry === 'string' ? { address } : entry);
  }

  const batch = pending.slice(0, Math.max(1, Number(limit) || DEFAULT_BATCH));
  const summary = { attempted: 0, located: 0, notFound: 0, remaining: pending.length, error: '' };

  for (let index = 0; index < batch.length; index += 1) {
    const entry = batch[index];
    const address = text(entry.address);
    // Every request after the first waits, whether or not the previous one
    // found anything — the limit is on requests, not on hits.
    if (index > 0) await sleep(REQUEST_SPACING_MS);

    let found = null;
    try {
      for (const step of queryPlan(entry)) {
        const hit = await askNominatim(step);
        if (hit) {
          found = hit;
          break;
        }
        await sleep(REQUEST_SPACING_MS);
      }
    } catch (err) {
      summary.error = err.message || String(err);
      break;
    }

    summary.attempted += 1;
    if (found) {
      writeCache(address, { ...found, provider: 'nominatim', status: 'ok' });
      summary.located += 1;
    } else {
      writeCache(address, { precision: null, provider: 'nominatim', status: 'not_found' });
      summary.notFound += 1;
    }
    summary.remaining -= 1;
  }

  return summary;
}

export {
  addressKey,
  cacheIndex,
  cachedRow,
  forgetAddress,
  locateAddresses,
  pinAddress,
  queryPlan,
  keywordsOf,
  matchesQuery,
  precisionOf,
  DEFAULT_BATCH,
};
