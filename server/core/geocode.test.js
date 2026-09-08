// The geocoder's two rules that are not about geocoding: what gets sent, and
// what gets sent only once.
//
// askNominatim is not exercised here — a test that hits OpenStreetMap would
// be slow, flaky, and would send made-up addresses to somebody else's server
// on every run. What is testable is everything around it: the key two
// spellings of one address collapse onto, the fallback chain that decides how
// precise a claim a pin is allowed to make, and the promise that a manual pin
// is never quietly replaced.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from './testDb.js';

const { dir, dbPath } = createTestDb();

const { DatabaseSync, closeDb } = await import('./db.js');
// The cache table is not in the test fixture's schema (it is not a table any
// other module touches), so it is created here the same way the migration
// creates it in a real database.
const seed = new DatabaseSync(dbPath);
seed.exec(`
  CREATE TABLE geocode_cache (
      address_key  TEXT PRIMARY KEY,
      address      TEXT NOT NULL,
      latitude     REAL,
      longitude    REAL,
      precision    TEXT,
      locality     TEXT,
      postcode     TEXT,
      display_name TEXT,
      provider     TEXT NOT NULL DEFAULT 'nominatim',
      status       TEXT NOT NULL DEFAULT 'ok',
      looked_up_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
seed.close();

const { addressKey, queryPlan, matchesQuery, precisionOf, pinAddress, cachedRow, cacheIndex, forgetAddress, locateAddresses } =
  await import('./geocode.js');

const { run } = await import('./db.js');

beforeEach(() => run('DELETE FROM geocode_cache'));

afterAll(() => {
  closeDb();
  removeTestDb(dir);
});

describe('addressKey', () => {
  it('collapses the ways one address gets written into one key', () => {
    expect(addressKey('27th Main, HSR Layout, Bengaluru 560102')).toBe(
      addressKey('27TH MAIN  hsr layout - bengaluru, 560102'),
    );
  });

  it('keeps digits, because a flat number and a PIN code are both digits', () => {
    expect(addressKey('Flat 301, Acacia, 560102')).not.toBe(addressKey('Flat 302, Acacia, 560102'));
  });
});

describe('queryPlan', () => {
  it('asks for the whole address first and cuts back from the front, then the PIN', () => {
    const plan = queryPlan({ street: 'Flat 301, Acacia Apartments, HSR Layout', city: 'Bengaluru', zip: '560102' });
    expect(plan.map((step) => step.query)).toEqual([
      'Flat 301, Acacia Apartments, HSR Layout, Bengaluru, 560102',
      // The locality is at the END of an address written the way people write
      // them here, so it is the front that gets thrown away.
      'HSR Layout, Bengaluru',
      '560102, Bengaluru',
    ]);
  });

  it('never asks a question that is only the city, however far it has cut back', () => {
    // The step that would be left is "Karnataka, India, Bengaluru", which
    // Nominatim answers with the middle of Bengaluru — a pin that looks like
    // a customer and is not one.
    const plan = queryPlan({ street: 'B-204, Sai Satyam, Horamavu, Bangalore 560043, Karnataka, India' });
    expect(plan.some((step) => /^(Karnataka|India)/.test(step.query))).toBe(false);
    // It reaches the locality instead, and finds the PIN in the address line
    // even though Odoo's zip field is empty.
    expect(plan.map((step) => step.query)).toContain('Horamavu, Bengaluru');
    expect(plan.map((step) => step.query)).toContain('560043, Bengaluru');
  });

  it('asks for the one identifying piece even when the address has only one', () => {
    // Every other piece of this is a flat number, a building number or a
    // cross road. Without this step the address falls straight through to its
    // PIN code, which here covers four neighbourhoods.
    const plan = queryPlan({
      street: 'Flat 202, Building 198, 9th Main Road',
      street2: '19th A Cross Rd, 7th Sector, HSR Layout',
      city: 'Bengaluru',
      zip: '560102',
    });
    expect(plan.map((step) => step.query)).toContain('HSR Layout, Bengaluru');
  });

  it('assumes Bengaluru when nobody said which city', () => {
    expect(queryPlan({ street: 'Koramangala 5th Block' })[0].query).toBe('Koramangala 5th Block, Bengaluru');
  });

  it('has something to ask even for an address that is only a PIN code', () => {
    expect(queryPlan({ zip: '560102' })).toEqual([
      { query: '560102, Bengaluru', keywords: ['560102'], postcode: '560102' },
    ]);
  });
});

describe('matchesQuery', () => {
  const step = (query) => queryPlan({ street: query })[0];

  it('rejects an answer that is only the city the query happened to mention', () => {
    const hit = { addresstype: 'city', display_name: 'Bengaluru, Bangalore North, Karnataka, India' };
    expect(matchesQuery(hit, step('Sai Satyam Apartments, Horamavu'))).toBe(false);
  });

  it('rejects an answer with none of the words that were asked about', () => {
    // The right shape of place, in the wrong part of town: Nominatim answers
    // with the nearest thing it does understand rather than nothing at all.
    const hit = { addresstype: 'suburb', display_name: 'Ashok Nagar, Bengaluru, Karnataka, 560025, India' };
    expect(matchesQuery(hit, step('KBR Elite Apartment, Kempapura'))).toBe(false);
  });

  it('accepts an answer that names what was asked for', () => {
    const hit = { addresstype: 'suburb', display_name: 'Horamavu, Bengaluru East, Karnataka, 560043, India' };
    expect(matchesQuery(hit, step('Sai Satyam Apartments, Horamavu'))).toBe(true);
  });

  it('checks a PIN-code query against the PIN code itself', () => {
    const postcodeStep = queryPlan({ zip: '560043' })[0];
    expect(matchesQuery({ addresstype: 'postcode', display_name: '560043, Bengaluru' }, postcodeStep)).toBe(true);
    expect(matchesQuery({ addresstype: 'postcode', display_name: '560102, Bengaluru' }, postcodeStep)).toBe(false);
  });
});

describe('precisionOf', () => {
  const anyStep = { keywords: ['horamavu'], postcode: '' };

  it('calls a building a building and a neighbourhood a neighbourhood', () => {
    expect(precisionOf({ addresstype: 'house' }, anyStep)).toBe('address');
    expect(precisionOf({ addresstype: 'suburb' }, anyStep)).toBe('locality');
  });

  it('rates a hit by what came back, not by how specific the question was', () => {
    // The whole address was asked for and the geocoder only recognised the
    // suburb in it. That is a suburb-accurate pin, and the screen draws it as
    // one rather than as a rooftop.
    expect(precisionOf({ addresstype: 'neighbourhood' }, { keywords: ['acacia', 'flat'], postcode: '' })).toBe('locality');
  });

  it('never calls a PIN-code centroid anything better than a PIN code', () => {
    expect(precisionOf({ addresstype: 'building' }, { keywords: [], postcode: '560043' })).toBe('postcode');
  });
});

describe('pinAddress', () => {
  it('records a hand-dropped pin as the most precise answer there is', () => {
    pinAddress({ address: 'Sai Krupa Nilaya, near the water tank', latitude: 12.9, longitude: 77.6, postcode: '560102' });
    expect(cachedRow('sai krupa nilaya near the water tank')).toMatchObject({
      latitude: 12.9,
      longitude: 77.6,
      precision: 'address',
      provider: 'manual',
      status: 'ok',
    });
  });

  it('refuses a pin that is not a point on Earth', () => {
    expect(() => pinAddress({ address: 'Somewhere', latitude: 91, longitude: 0 })).toThrow(/point on Earth/);
    expect(() => pinAddress({ address: 'Somewhere', latitude: 'x', longitude: 0 })).toThrow(/latitude and a longitude/);
  });
});

describe('locateAddresses', () => {
  it('never sends an address that is already in the cache — a manual pin included', () => {
    pinAddress({ address: 'Sai Krupa Nilaya', latitude: 12.9, longitude: 77.6 });
    run(
      `INSERT INTO geocode_cache (address_key, address, status, provider) VALUES (?, ?, 'not_found', 'nominatim')`,
      addressKey('Unfindable Lane'),
      'Unfindable Lane',
    );

    // Nothing is left to look up, so this resolves without ever reaching the
    // network — which is the assertion. A pending address here would try to
    // fetch and the test would fail on the attempt.
    return locateAddresses([
      { address: 'Sai Krupa Nilaya' },
      { address: 'sai krupa nilaya' },
      { address: 'Unfindable Lane' },
    ]).then((summary) => {
      expect(summary).toMatchObject({ attempted: 0, located: 0, notFound: 0, remaining: 0 });
      // And the manual pin is untouched.
      expect(cachedRow('Sai Krupa Nilaya').provider).toBe('manual');
    });
  });
});

describe('forgetAddress', () => {
  it('drops a row so a corrected address can be looked up again', () => {
    pinAddress({ address: 'Old spelling', latitude: 12.9, longitude: 77.6 });
    expect(cacheIndex().size).toBe(1);
    expect(forgetAddress('Old spelling')).toBe(true);
    expect(cacheIndex().size).toBe(0);
    expect(forgetAddress('Old spelling')).toBe(false);
  });
});
