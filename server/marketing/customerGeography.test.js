// aggregate() — the three counting rules the Customer Map is built on.
//
// buildCustomerMapReport needs a live Odoo and is not something a test can
// stand up honestly. What is below it is where a map goes quietly wrong: a
// regular counted as four new faces because their checkout made four partner
// records, one street drawn as four overlapping pins, or a neighbourhood
// split into three because three customers spelled it three ways.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// customerGeography.js pulls in the Odoo client and the geocode cache, both
// of which reach the database at import time.
const { dir } = createTestDb();

const { aggregate, areaLabel } = await import('./customerGeography.js');

afterAll(() => removeTestDb(dir));

// A geocode cache as cacheIndex() hands it over: keyed by the normalised
// address, one row per address that has been looked up.
const cache = (rows) =>
  new Map(
    rows.map((row) => [
      row.address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      {
        address: row.address,
        latitude: row.lat,
        longitude: row.lon,
        precision: row.precision || 'address',
        locality: row.locality ?? '',
        postcode: row.postcode ?? '',
        provider: row.provider || 'nominatim',
        status: row.status || 'ok',
      },
    ]),
  );

const order = (over = {}) => ({
  orderId: 1,
  orderName: 'S00001',
  day: '2026-09-01',
  customerId: 10,
  customer: 'Asha',
  channel: 'B2C',
  revenue: 1200,
  address: '27th Main, HSR Layout, Bengaluru 560102',
  street: '27th Main',
  street2: '',
  city: 'Bengaluru',
  zip: '560102',
  ...over,
});

const HSR = { address: '27th Main, HSR Layout, Bengaluru 560102', lat: 12.91, lon: 77.64, locality: 'HSR Layout', postcode: '560102' };
const KORAMANGALA = { address: '5th Block, Koramangala, Bengaluru 560095', lat: 12.93, lon: 77.62, locality: 'Koramangala', postcode: '560095' };

describe('aggregate', () => {
  it('makes one pin per address, sized by orders, not one per order', () => {
    const report = aggregate({
      orders: [
        order({ orderId: 1, revenue: 1000 }),
        order({ orderId: 2, revenue: 500, day: '2026-09-08' }),
        order({ orderId: 3, revenue: 700, day: '2026-09-15' }),
      ],
      located: cache([HSR]),
    });

    expect(report.points).toHaveLength(1);
    expect(report.points[0]).toMatchObject({ orders: 3, revenue: 2200, customers: 1, latitude: 12.91 });
    // The most recent order at that address, not the first one seen.
    expect(report.points[0].lastOrder).toBe('2026-09-15');
  });

  it('counts a customer as the account, however many delivery contacts they have', () => {
    // The website case: one account, a fresh shipping partner per checkout,
    // and two spellings of the same street. Two pins is right (they are two
    // address strings); one customer is the point.
    const report = aggregate({
      orders: [
        order({ orderId: 1, customerId: 10 }),
        order({ orderId: 2, customerId: 10, address: KORAMANGALA.address }),
      ],
      located: cache([HSR, KORAMANGALA]),
    });

    expect(report.points).toHaveLength(2);
    expect(report.totals.customers).toBe(1);
    // And they are a repeat customer in both areas, because they are.
    expect(report.areas.every((area) => area.repeatCustomers === 1)).toBe(true);
  });

  it('groups an area on what the geocoder calls it, not on what the customer typed', () => {
    const report = aggregate({
      orders: [
        order({ orderId: 1, customerId: 10, address: 'A, hsr, blr', city: 'blr' }),
        order({ orderId: 2, customerId: 11, address: 'B, HSR Layout Sector 2, Bengaluru', city: 'Bengaluru' }),
      ],
      located: cache([
        { address: 'A, hsr, blr', lat: 12.91, lon: 77.64, locality: 'HSR Layout', postcode: '560102' },
        { address: 'B, HSR Layout Sector 2, Bengaluru', lat: 12.915, lon: 77.641, locality: 'HSR Layout', postcode: '560102' },
      ]),
    });

    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]).toMatchObject({ name: 'HSR Layout · 560102', orders: 2, customers: 2, addresses: 2 });
  });

  it('keeps each side of the business countable on its own', () => {
    const report = aggregate({
      orders: [
        order({ orderId: 1, customerId: 10, revenue: 1000 }),
        order({ orderId: 2, customerId: 20, customer: 'Jango', channel: 'B2B', revenue: 16000 }),
      ],
      located: cache([HSR]),
    });

    expect(report.points[0]).toMatchObject({
      orders: 2,
      revenue: 17000,
      b2cOrders: 1,
      b2bOrders: 1,
      b2cRevenue: 1000,
      b2bRevenue: 16000,
    });
    expect(report.totals).toMatchObject({ b2cOrders: 1, b2bOrders: 1, customers: 2 });
  });

  it('separates an address nobody has looked up from one the geocoder could not find', () => {
    const report = aggregate({
      orders: [
        order({ orderId: 1, customerId: 10, address: 'Never asked, Bengaluru' }),
        order({ orderId: 2, customerId: 11, address: 'Sai Krupa Nilaya, near the water tank' }),
      ],
      located: cache([
        { address: 'Sai Krupa Nilaya, near the water tank', lat: null, lon: null, status: 'not_found', precision: null },
      ]),
    });

    expect(report.points).toHaveLength(0);
    expect(report.totals.unlocated).toMatchObject({ addresses: 2, orders: 2, pending: 1, notFound: 1 });
    expect(report.unlocated.map((row) => row.status).sort()).toEqual(['not_found', 'pending']);
  });

  it('files an order with no address at all apart from a failed lookup', () => {
    // A counter pickup. Nothing was ever going to find it, and reporting it
    // as a geocoding failure would send somebody looking for a fix here
    // rather than in Odoo.
    const report = aggregate({
      orders: [order({ orderId: 1, address: '', street: '', city: '', zip: '', customer: 'Walk-in' })],
      located: cache([]),
    });

    expect(report.totals.unlocated.addresses).toBe(0);
    expect(report.totals.noAddress).toEqual({ customers: 1, orders: 1 });
    expect(report.noAddress[0]).toMatchObject({ customer: 'Walk-in', orders: 1 });
  });

  it('shares an area against every order in the range, not just the placed ones', () => {
    // Three orders, one of them unplaceable. The one located area is a third
    // of the business, not all of it — a share computed over located orders
    // alone would say 100% and be read as "everyone is in HSR".
    const report = aggregate({
      orders: [
        order({ orderId: 1, customerId: 10 }),
        order({ orderId: 2, customerId: 11, address: 'Somewhere unfindable' }),
        order({ orderId: 3, customerId: 12, address: '', street: '', city: '', zip: '' }),
      ],
      located: cache([HSR]),
    });

    expect(report.totals.orders).toBe(3);
    expect(report.areas[0].sharePct).toBeCloseTo(33.3, 1);
  });

  it('puts an area dot where its orders are, not in the middle of its addresses', () => {
    // Ten orders from one street and one from the far edge: the dot belongs
    // near the ten.
    const orders = [
      ...Array.from({ length: 10 }, (unused, index) =>
        order({ orderId: index + 1, customerId: 10 + index, address: 'Busy street', city: 'Bengaluru' }),
      ),
      order({ orderId: 99, customerId: 99, address: 'Far edge', city: 'Bengaluru' }),
    ];
    const report = aggregate({
      orders,
      located: cache([
        { address: 'Busy street', lat: 12.90, lon: 77.60, locality: 'HSR Layout', postcode: '560102' },
        { address: 'Far edge', lat: 13.00, lon: 77.60, locality: 'HSR Layout', postcode: '560102' },
      ]),
    });

    expect(report.areas[0].latitude).toBeCloseTo(12.909, 2);
  });
});

describe('areaLabel', () => {
  it('names an area by its locality, keeping the PIN as the qualifier', () => {
    expect(areaLabel({ locality: 'HSR Layout', postcode: '560102' })).toBe('HSR Layout · 560102');
  });

  it('falls back to the PIN code where the map has no name for the place', () => {
    expect(areaLabel({ locality: '', postcode: '562110' })).toBe('PIN 562110');
    expect(areaLabel({ locality: '', postcode: '' })).toBe('Bengaluru (area unknown)');
  });
});
