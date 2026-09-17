// The service board's two delivery additions: distance from the kitchen, read
// off the geocode cache, and the Porter tracking link pulled out of whatever
// was pasted. Nothing here reaches Nominatim or Odoo.
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

const { dir, dbPath } = createTestDb();
const { DatabaseSync, closeDb } = await import('../../core/db.js');
const seed = new DatabaseSync(dbPath);
seed.exec(`
  CREATE TABLE geocode_cache (
      address_key TEXT PRIMARY KEY, address TEXT NOT NULL, latitude REAL, longitude REAL,
      precision TEXT, locality TEXT, postcode TEXT, display_name TEXT,
      provider TEXT NOT NULL DEFAULT 'nominatim', status TEXT NOT NULL DEFAULT 'ok',
      looked_up_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
seed.close();

const { run } = await import('../../core/db.js');
const { pinAddress } = await import('../../core/geocode.js');
const { attachDistances, haversineKm } = await import('./deliveryDistance.js');
const { cleanTrackingUrl, odooTrackingValue } = await import('./orderPackingStatus.js');

const board = (orders) => ({ groups: [{ id: 'satLunch', orders }] });

beforeEach(() => {
  run('DELETE FROM geocode_cache');
  vi.stubEnv('KITCHEN_LAT', '12.9352');
  vi.stubEnv('KITCHEN_LON', '77.6245');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  closeDb();
  removeTestDb(dir);
});

describe('attachDistances', () => {
  it('measures cached addresses and says why the rest have no number', () => {
    pinAddress({ address: 'HSR Layout Sector 2', latitude: 12.915, longitude: 77.641, locality: 'HSR Layout' });
    run(
      `INSERT INTO geocode_cache (address_key, address, status) VALUES ('somewhere nowhere', 'Somewhere nowhere', 'not_found')`,
    );
    const result = attachDistances(
      board([
        { orderId: 1, address: 'HSR Layout Sector 2' },
        { orderId: 2, address: 'Somewhere, nowhere' },
        { orderId: 3, address: 'Never looked up 560001' },
        { orderId: 4, address: '' },
      ]),
    );
    const [hsr, notFound, pending, none] = result.groups[0].orders;
    expect(result.kitchenLocated).toBe(true);
    expect(hsr).toMatchObject({ distanceStatus: 'ok', locality: 'HSR Layout' });
    expect(hsr.distanceKm).toBeCloseTo(2.8, 0);
    expect(notFound).toMatchObject({ distanceStatus: 'not_found', distanceKm: null });
    expect(pending).toMatchObject({ distanceStatus: 'pending', distanceKm: null });
    expect(none).toMatchObject({ distanceStatus: 'no_address', distanceKm: null });
  });

  it('refuses to guess a kitchen it was not told about', () => {
    vi.stubEnv('KITCHEN_LAT', '');
    pinAddress({ address: 'HSR Layout Sector 2', latitude: 12.915, longitude: 77.641 });
    const result = attachDistances(board([{ orderId: 1, address: 'HSR Layout Sector 2' }]));
    expect(result.kitchenLocated).toBe(false);
    expect(result.groups[0].orders[0]).toMatchObject({ distanceStatus: 'no_origin', distanceKm: null });
  });

  it('is a real great-circle distance', () => {
    // MG Road to Whitefield is about 15.5 km as the crow flies.
    expect(haversineKm({ latitude: 12.9756, longitude: 77.6066 }, { latitude: 12.9698, longitude: 77.75 })).toBeCloseTo(
      15.5,
      0,
    );
  });
});

describe('cleanTrackingUrl', () => {
  it("takes the link out of Porter's share sentence", () => {
    expect(cleanTrackingUrl('Track your order: https://porter.in/track_live_order?booking_id=CRN1.')).toBe(
      'https://porter.in/track_live_order?booking_id=CRN1',
    );
  });

  it('takes a Porter link pasted without https://', () => {
    expect(cleanTrackingUrl('porter.in/rd/b98a3b5ba4')).toBe('https://porter.in/rd/b98a3b5ba4');
  });

  it('rejects text with no link in it', () => {
    expect(cleanTrackingUrl('Ravi, KA01 AB 1234')).toBeNull();
    expect(cleanTrackingUrl('javascript:alert(1)')).toBeNull();
    expect(cleanTrackingUrl('Leave at the gate, e.g. with security')).toBeNull();
  });
});

describe('odooTrackingValue', () => {
  it('sends Odoo only the part after porter.in', () => {
    expect(odooTrackingValue('https://porter.in/rd/b98a3b5ba4')).toBe('rd/b98a3b5ba4');
    expect(odooTrackingValue('https://porter.in/track_live_order?booking_id=CRN1')).toBe(
      'track_live_order?booking_id=CRN1',
    );
  });

  it("sends another courier's link whole", () => {
    expect(odooTrackingValue('https://dunzo.com/t/abc')).toBe('https://dunzo.com/t/abc');
    expect(odooTrackingValue('https://notporter.in/abc')).toBe('https://notporter.in/abc');
  });
});
