// Reading a Porter trip off its tracking link. Nothing here reaches porter.in
// — the fetch is stubbed with the shape the real page actually serves, taken
// from a live order and a finished one.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  estimateArrival,
  isPorterLink,
  phaseFor,
  readPorterOrderWithEta,
  resolveTrackingLink,
  sliceObject,
} from './porterTracking.js';

const PICKUP = { lat: 12.9957451, lng: 77.678655 };
const DROP = { lat: 13.0220971, lng: 77.6730522 };

// The page's flight payload, cut down to the parts this reads but kept in its
// real shape: JSON fragments inside a line-oriented format that is not itself
// JSON, with the order object nested inside another object.
function flight(orderDetails) {
  return [
    '2:I[1234,[],""]\n',
    '5:["$","$L14",null,',
    JSON.stringify({
      booking_id: orderDetails.crn,
      customer_uuid: 'a15f003e-24c1-4418-b162-3130daa01af2',
      order_details: orderDetails,
      marketing_info: { averageEta: 1200 },
    }),
    ']\n',
  ].join('');
}

function details({ status, riderAt = null, endedAt = null }) {
  return {
    status,
    crn: 'CRN996090989882',
    partner: { name: 'Manu T S', mobile: '9916197919', vehicleType: 'Scooter', vehicleNumber: 'KA-05-KV-9812' },
    pickupLocation: { landmark: 'Kitchen', location: PICKUP },
    dropLocation: { landmark: 'Sobha Eternia', location: DROP },
    partnerLocation: riderAt,
    trip_accepted_time: 1789798670,
    trip_ended_time: endedAt,
  };
}

// A fetch that answers the short link with a redirect and the tracking page
// with a flight payload, the way porter.in does.
function stubFetch(orderDetails, { shortLinkStatus = 302 } = {}) {
  return vi.fn(async (url, init = {}) => {
    if (String(url).includes('/rd/')) {
      return {
        status: shortLinkStatus,
        ok: false,
        headers: new Headers(
          shortLinkStatus === 302
            ? {
                location:
                  'https://porter.in/track_live_order_v2?booking_id=CRN996090989882&customer_uuid=a15f003e-24c1-4418-b162-3130daa01af2&utm_medium=sender',
              }
            : {},
        ),
      };
    }
    expect(init.headers?.RSC).toBe('1');
    return { status: 200, ok: true, headers: new Headers(), text: async () => flight(orderDetails) };
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('isPorterLink', () => {
  it('takes porter.in and its subdomains, and nothing else', () => {
    expect(isPorterLink('https://porter.in/rd/bb04ee9fda')).toBe(true);
    expect(isPorterLink('https://porter.in/track_live_order_v2?booking_id=CRN1')).toBe(true);
    expect(isPorterLink('https://www.porter.in/rd/x')).toBe(true);
    // The one that matters: a lookalike host must not be read as Porter's.
    expect(isPorterLink('https://porter.in.evil.example/rd/x')).toBe(false);
    expect(isPorterLink('https://dunzo.in/track/abc')).toBe(false);
    expect(isPorterLink('not a url')).toBe(false);
  });
});

describe('phaseFor', () => {
  it('maps every status Porter renders', () => {
    expect(phaseFor('open')).toBe('searching');
    expect(phaseFor('allocated')).toBe('searching');
    expect(phaseFor('accepted')).toBe('on_the_way');
    expect(phaseFor('live')).toBe('on_the_way');
    expect(phaseFor('loading')).toBe('on_the_way');
    expect(phaseFor('ended')).toBe('delivered');
    expect(phaseFor('completed')).toBe('delivered');
    expect(phaseFor('cancelled')).toBe('cancelled');
    expect(phaseFor('rescheduled')).toBe('cancelled');
  });

  it('does not call the handover delivered', () => {
    // 'unloading' is the box being handed over, not a finished trip. Calling
    // it delivered would post the invoice a few minutes early, and would post
    // it for a handover that then fails.
    expect(phaseFor('unloading')).toBe('on_the_way');
  });

  it('treats a status it has never seen as still going', () => {
    // Guessing 'delivered' on an unknown word would invoice an order that
    // never arrived; guessing 'cancelled' would abandon one that did.
    expect(phaseFor('some_new_porter_state')).toBe('on_the_way');
    expect(phaseFor('')).toBe('on_the_way');
  });
});

describe('sliceObject', () => {
  it('cuts out a nested object without stopping at the first inner brace', () => {
    const text = `junk"order_details":{"a":{"b":1},"c":"}"}tail`;
    expect(JSON.parse(sliceObject(text, 'order_details'))).toEqual({ a: { b: 1 }, c: '}' });
  });

  it('is not fooled by a brace inside an escaped string', () => {
    const text = String.raw`"order_details":{"note":"say \"}\" here","n":2}`;
    expect(JSON.parse(sliceObject(text, 'order_details'))).toEqual({ note: 'say "}" here', n: 2 });
  });

  it('gives back nothing when the key is not there', () => {
    expect(sliceObject('{"other":1}', 'order_details')).toBe(null);
  });
});

describe('resolveTrackingLink', () => {
  it('follows the short link and reads the booking id off it', async () => {
    const fetchImpl = stubFetch(details({ status: 'live' }));
    const resolved = await resolveTrackingLink('https://porter.in/rd/bb04ee9fda', { fetchImpl });
    expect(resolved.crn).toBe('CRN996090989882');
    expect(resolved.trackUrl).toContain('track_live_order_v2');
  });

  it('takes a tracking page link as it stands, without a round trip', async () => {
    const fetchImpl = vi.fn();
    const resolved = await resolveTrackingLink(
      'https://porter.in/track_live_order_v2?booking_id=CRN1&customer_uuid=u',
      { fetchImpl },
    );
    expect(resolved.crn).toBe('CRN1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a link that is not Porter’s', async () => {
    await expect(resolveTrackingLink('https://dunzo.in/track/abc')).rejects.toMatchObject({ code: 'NOT_PORTER' });
  });

  it('says so when the short link has expired', async () => {
    const fetchImpl = stubFetch(details({ status: 'live' }), { shortLinkStatus: 404 });
    await expect(resolveTrackingLink('https://porter.in/rd/gone', { fetchImpl })).rejects.toMatchObject({
      code: 'PORTER_HTTP',
    });
  });
});

describe('readPorterOrderWithEta', () => {
  it('reads a live trip, the rider and an ETA from where the rider is', async () => {
    const riderAt = { lat: 13.0014383, lng: 77.67832 };
    const fetchImpl = stubFetch(details({ status: 'live', riderAt }));
    const order = await readPorterOrderWithEta('https://porter.in/rd/bb04ee9fda', { fetchImpl });

    expect(order.status).toBe('live');
    expect(order.phase).toBe('on_the_way');
    expect(order.partner.name).toBe('Manu T S');
    expect(order.riderAt).toEqual(riderAt);
    expect(order.endedAt).toBe(null);
    expect(order.eta.basis).toBe('rider');
    expect(order.eta.etaMinutes).toBeGreaterThan(0);
  });

  it('reads a finished trip with Porter’s own delivery time, and no ETA', async () => {
    const fetchImpl = stubFetch(details({ status: 'completed', endedAt: 1789802356 }));
    const order = await readPorterOrderWithEta('https://porter.in/rd/bb04ee9fda', { fetchImpl });

    expect(order.phase).toBe('delivered');
    expect(order.endedAt).toBe(new Date(1789802356 * 1000).toISOString());
    // A delivered order has no arrival left to estimate — an ETA here would
    // read on the card as "another half hour" for a box already handed over.
    expect(order.eta).toBe(null);
  });

  it('throws rather than guessing when the page has no order on it', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/rd/')) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://porter.in/track_live_order_v2?booking_id=CRN1' }),
        };
      }
      return { status: 200, ok: true, headers: new Headers(), text: async () => '<html>maintenance</html>' };
    });
    await expect(readPorterOrderWithEta('https://porter.in/rd/x', { fetchImpl })).rejects.toMatchObject({
      code: 'NO_ORDER_DETAILS',
    });
  });
});

describe('estimateArrival', () => {
  const now = new Date('2026-09-19T08:00:00.000Z');

  it('measures from the rider when Porter is showing one', () => {
    const eta = estimateArrival(
      { phase: 'on_the_way', riderAt: { lat: 13.0014383, lng: 77.67832 }, pickupAt: PICKUP, dropAt: DROP },
      now,
    );
    expect(eta.basis).toBe('rider');
    expect(eta.distanceKm).toBeCloseTo(2.4, 0);
    expect(new Date(eta.etaAt).getTime()).toBe(now.getTime() + eta.etaMinutes * 60000);
  });

  it('falls back to the kitchen before a rider has a position', () => {
    const eta = estimateArrival({ phase: 'on_the_way', riderAt: null, pickupAt: PICKUP, dropAt: DROP }, now);
    expect(eta.basis).toBe('pickup');
  });

  it('adds the allocation wait while Porter is still finding a rider', () => {
    const searching = estimateArrival({ phase: 'searching', pickupAt: PICKUP, dropAt: DROP }, now);
    const moving = estimateArrival({ phase: 'on_the_way', pickupAt: PICKUP, dropAt: DROP }, now);
    expect(searching.etaMinutes).toBeGreaterThan(moving.etaMinutes);
  });

  it('still gives a time to check when there are no coordinates at all', () => {
    const eta = estimateArrival({ phase: 'on_the_way' }, now);
    expect(eta.basis).toBe('default');
    expect(eta.etaMinutes).toBe(30);
  });

  it('stays inside the floor and the ceiling', () => {
    const next_door = estimateArrival({ phase: 'on_the_way', riderAt: DROP, dropAt: DROP }, now);
    expect(next_door.etaMinutes).toBeGreaterThanOrEqual(3);
    const far = estimateArrival(
      { phase: 'on_the_way', riderAt: { lat: 19.076, lng: 72.8777 }, dropAt: DROP },
      now,
    );
    expect(far.etaMinutes).toBeLessThanOrEqual(180);
  });

  it('takes the speed and detour model from the environment', () => {
    vi.stubEnv('PORTER_SPEED_KMPH', '9');
    const slow = estimateArrival({ phase: 'on_the_way', pickupAt: PICKUP, dropAt: DROP }, now);
    vi.stubEnv('PORTER_SPEED_KMPH', '36');
    const fast = estimateArrival({ phase: 'on_the_way', pickupAt: PICKUP, dropAt: DROP }, now);
    expect(slow.etaMinutes).toBeGreaterThan(fast.etaMinutes);
  });
});
