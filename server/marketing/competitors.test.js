// aggregate() — the arithmetic behind the Competitors view of the Customer
// Map.
//
// buildCompetitorReport needs a live Odoo and is not something a test can
// stand up honestly. What is below it is where a competitor map goes quietly
// wrong: a rival counted as placed when the geocoder never found them, an
// order counted twice because two rivals sit on the same service road, or a
// "nearest competitor" that is nearest only because the one actually next
// door was never looked up.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// competitors.js pulls in the geocode cache and the customer report, both of
// which reach the database at import time.
const { dir } = createTestDb();

const { aggregate, roster, addressOf } = await import('./competitors.js');

afterAll(() => removeTestDb(dir));

// A geocode cache as cacheIndex() hands it over: keyed by the normalised
// address, one row per address that has been looked up.
const cache = (rows) =>
  new Map(
    rows.map((row) => [
      row.address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      {
        address: row.address,
        latitude: row.lat ?? null,
        longitude: row.lon ?? null,
        precision: row.precision || 'address',
        locality: row.locality ?? '',
        postcode: row.postcode ?? '',
        provider: row.provider || 'nominatim',
        status: row.status || 'ok',
      },
    ]),
  );

const rival = (over = {}) => ({
  id: 'rival',
  name: 'A Rival',
  brand: 'A Rival',
  category: 'direct',
  area: 'Somewhere',
  street: 'A Rival, Somewhere',
  city: 'Bengaluru',
  address: 'A Rival, Somewhere, Bengaluru',
  rating: 4.2,
  reviews: 100,
  note: '',
  ...over,
});

// Roughly 1.1 km of latitude per 0.01 degrees, which is enough precision for
// "inside 3 km" and "well outside it" without hard-coding a haversine result.
const at = (lat, lon) => ({ latitude: lat, longitude: lon });

const point = (over = {}) => ({
  key: 'p',
  address: 'a house',
  latitude: 12.9,
  longitude: 77.6,
  precision: 'address',
  orders: 1,
  revenue: 1000,
  ...over,
});

const area = (over = {}) => ({
  key: 'a',
  name: 'Somewhere',
  locality: 'Somewhere',
  postcode: '560001',
  latitude: 12.9,
  longitude: 77.6,
  orders: 1,
  revenue: 1000,
  customers: 1,
  sharePct: 100,
  ...over,
});

describe('the roster itself', () => {
  it('gives every competitor the address it will be looked up by', () => {
    for (const row of roster()) {
      expect(row.address).toBe(addressOf(row));
      expect(row.address).toContain(row.city);
      expect(row.address.length).toBeGreaterThan(row.city.length);
    }
  });

  it('keys every competitor uniquely, so two branches never collapse into one', () => {
    const ids = roster().map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const addresses = roster().map((row) => row.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('groups a chain under one brand', () => {
    const brands = roster().filter((row) => row.brand === 'Brisket & Chops');
    expect(brands.length).toBe(3);
    expect(new Set(brands.map((row) => row.name)).size).toBe(3);
  });
});

describe('placing them', () => {
  it('draws only the ones the cache actually found', () => {
    const competitors = [
      rival({ id: 'found', address: 'found' }),
      rival({ id: 'missing', address: 'missing' }),
      rival({ id: 'never', address: 'never' }),
    ];
    const result = aggregate({
      competitors,
      located: cache([
        { address: 'found', lat: 12.9, lon: 77.6 },
        { address: 'missing', status: 'not_found' },
      ]),
    });

    expect(result.competitors.map((row) => row.id)).toEqual(['found']);
    expect(result.unplaced.map((row) => row.id).sort()).toEqual(['missing', 'never']);
    expect(result.totals.placed).toBe(1);
    expect(result.totals.notFound).toBe(1);
    expect(result.totals.pending).toBe(1);
  });

  it('carries the precision through, so an approximate point can be drawn as one', () => {
    const result = aggregate({
      competitors: [rival({ address: 'vague' })],
      located: cache([{ address: 'vague', lat: 12.9, lon: 77.6, precision: 'locality' }]),
    });
    expect(result.competitors[0].precision).toBe('locality');
  });
});

describe('how much of ours is in reach', () => {
  it('counts our orders inside the radius and leaves the far ones out', () => {
    const result = aggregate({
      competitors: [rival({ address: 'here' })],
      located: cache([{ address: 'here', lat: 12.9, lon: 77.6 }]),
      points: [
        point({ key: 'near', latitude: 12.905, longitude: 77.6, orders: 4, revenue: 4000 }),
        point({ key: 'far', latitude: 13.2, longitude: 77.6, orders: 9, revenue: 9000 }),
      ],
      radiusKm: 3,
    });

    const [only] = result.competitors;
    expect(only.ordersNearby).toBe(4);
    expect(only.revenueNearby).toBe(4000);
    expect(only.addressesNearby).toBe(1);
  });

  it('counts an order once even when two competitors are on the same road', () => {
    const result = aggregate({
      competitors: [rival({ id: 'one', address: 'one' }), rival({ id: 'two', address: 'two' })],
      located: cache([
        { address: 'one', lat: 12.9, lon: 77.6 },
        { address: 'two', lat: 12.901, lon: 77.601 },
      ]),
      points: [point({ orders: 5, revenue: 5000 })],
      radiusKm: 3,
    });

    // Both of them have it in reach...
    expect(result.competitors.map((row) => row.ordersNearby)).toEqual([5, 5]);
    // ...and the total still says five, not ten.
    expect(result.totals.ordersInReach).toBe(5);
  });

  it('respects a wider radius', () => {
    const far = { points: [point({ latitude: 12.96, longitude: 77.6, orders: 2 })] };
    const tight = aggregate({
      competitors: [rival({ address: 'here' })],
      located: cache([{ address: 'here', lat: 12.9, lon: 77.6 }]),
      radiusKm: 3,
      ...far,
    });
    const wide = aggregate({
      competitors: [rival({ address: 'here' })],
      located: cache([{ address: 'here', lat: 12.9, lon: 77.6 }]),
      radiusKm: 10,
      ...far,
    });
    expect(tight.totals.ordersInReach).toBe(0);
    expect(wide.totals.ordersInReach).toBe(2);
  });
});

describe('the contested table', () => {
  it('names the nearest PLACED competitor, never an unplaced one', () => {
    const result = aggregate({
      competitors: [
        // The nearer of the two, but nobody ever looked it up.
        rival({ id: 'next-door', name: 'Next Door', address: 'next-door' }),
        rival({ id: 'across-town', name: 'Across Town', address: 'across-town' }),
      ],
      located: cache([{ address: 'across-town', lat: 13.0, lon: 77.6 }]),
      areas: [area()],
      radiusKm: 3,
    });

    expect(result.contested).toHaveLength(1);
    expect(result.contested[0].competitor).toBe('Across Town');
    expect(result.contested[0].withinRadius).toBe(false);
  });

  it('flags an area with one inside the radius, and sorts by our orders', () => {
    const result = aggregate({
      competitors: [rival({ address: 'here' })],
      located: cache([{ address: 'here', lat: 12.9, lon: 77.6 }]),
      areas: [
        area({ key: 'quiet', name: 'Quiet', latitude: 12.902, longitude: 77.6, orders: 2 }),
        area({ key: 'busy', name: 'Busy', latitude: 13.3, longitude: 77.6, orders: 20 }),
      ],
      radiusKm: 3,
    });

    expect(result.contested.map((row) => row.name)).toEqual(['Busy', 'Quiet']);
    expect(result.contested.find((row) => row.name === 'Quiet').withinRadius).toBe(true);
    expect(result.contested.find((row) => row.name === 'Busy').withinRadius).toBe(false);
    expect(result.totals.areasContested).toBe(1);
  });

  it('leaves the competitor blank when none of them is placed', () => {
    const result = aggregate({
      competitors: [rival({ address: 'nowhere' })],
      located: cache([]),
      areas: [area()],
    });
    expect(result.contested[0].competitor).toBe('');
    expect(result.contested[0].distanceKm).toBeNull();
    expect(result.contested[0].withinRadius).toBe(false);
  });
});

describe('ratings', () => {
  it('leaves an unrecorded rating out of the average rather than counting it as zero', () => {
    const result = aggregate({
      competitors: [
        rival({ id: 'a', address: 'a', rating: 4.0 }),
        rival({ id: 'b', address: 'b', rating: 5.0 }),
        rival({ id: 'c', address: 'c', rating: null, reviews: null }),
      ],
      located: cache([
        { address: 'a', lat: 12.9, lon: 77.6 },
        { address: 'b', lat: 12.9, lon: 77.6 },
        { address: 'c', lat: 12.9, lon: 77.6 },
      ]),
    });
    expect(result.totals.avgRating).toBe(4.5);
  });

  it('reports no average at all when nothing is rated', () => {
    const result = aggregate({
      competitors: [rival({ address: 'a', rating: null })],
      located: cache([{ address: 'a', lat: 12.9, lon: 77.6 }]),
    });
    expect(result.totals.avgRating).toBeNull();
  });
});

describe('distance from the kitchen', () => {
  it('is null without an origin, rather than a confident zero', () => {
    const result = aggregate({
      competitors: [rival({ address: 'a' })],
      located: cache([{ address: 'a', lat: 12.9, lon: 77.6 }]),
      origin: null,
    });
    expect(result.competitors[0].distanceFromKitchenKm).toBeNull();
  });

  it('is measured from the origin when there is one', () => {
    const result = aggregate({
      competitors: [rival({ address: 'a' })],
      located: cache([{ address: 'a', lat: 12.9, lon: 77.6 }]),
      origin: at(12.9, 77.6),
    });
    expect(result.competitors[0].distanceFromKitchenKm).toBe(0);
  });
});
