// The Traffic sources tab, rendered.
//
// The arithmetic behind it is tested server-side in
// server/marketing/marketingRoi.test.js. What is left to get wrong is here:
// a count printed where a share belongs, a zero-session row silently
// filtered out of the table it is the whole point of, and the two states GA
// can be in reading identically on the screen.
//
// So this file feeds the component one fixed report and asserts what a
// person reads off the page — not what the props contain.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import MarketingROI from './MarketingROI';

const report = (overrides: Record<string, unknown> = {}) => ({
  range: { from: '2026-08-01', to: '2026-08-31' },
  sources: {
    odoo: { configured: true, url: 'https://example.odoo.com', channelField: 'x_studio_channel' },
    ga: { configured: true, propertyId: '550057156', serviceAccount: 'ga@example.iam', error: '', reachable: true },
  },
  totals: {
    invested: 0,
    generated: 0,
    net: 0,
    roi: null,
    orders: 0,
    attributedRevenue: 0,
    unattributedRevenue: 0,
    unattributedOrders: 0,
    attributedShare: 100,
    attributedRoi: null,
    pendingRevenue: 0,
    pendingOrders: 0,
    sessions: 172,
    users: 135,
    newUsers: 101,
  },
  channels: [],
  campaigns: [],
  categories: [],
  gaOnly: [],
  spend: [],
  untagged: 0,
  channelOptions: [],
  trafficSources: [
    {
      source: 'instagram',
      sessions: 120,
      users: 90,
      newUsers: 70,
      keyEvents: 8,
      share: 69.77,
      channel: 'Instagram',
      mediums: [{ medium: 'social', sessions: 120 }],
      campaigns: [{ campaign: 'weekend-brisket', sessions: 80 }],
      links: 1,
      orders: 3,
      revenue: 4500,
      revenuePerSession: 37.5,
      seenOnOrders: true,
      seenByGa: true,
    },
    {
      source: 'table-tent',
      sessions: 52,
      users: 45,
      newUsers: 44,
      keyEvents: 3,
      share: 30.23,
      channel: '',
      mediums: [{ medium: 'qr', sessions: 52 }],
      campaigns: [],
      links: 2,
      orders: 0,
      revenue: 0,
      revenuePerSession: null,
      seenOnOrders: false,
      seenByGa: true,
    },
    {
      source: 'flyer',
      sessions: 0,
      users: 0,
      newUsers: 0,
      keyEvents: 0,
      share: 0,
      channel: '',
      mediums: [],
      campaigns: [],
      links: 3,
      orders: 0,
      revenue: 0,
      revenuePerSession: null,
      seenOnOrders: false,
      seenByGa: false,
    },
  ],
  utm: {
    fields: ['x_utm_source', 'x_utm_campaign', 'x_utm_content'],
    orders: 38,
    revenue: 41200,
    tagged: 2,
    taggedRevenue: 2598,
    taggedShare: 5.26,
    sources: [
      { value: 'whatsapp', orders: 1, revenue: 1698, channels: ['Website'] },
      { value: 'instagram', orders: 1, revenue: 900, channels: ['Instagram'] },
    ],
    campaigns: [{ value: 'launch-2026-09', orders: 2, revenue: 2598, channels: ['Instagram', 'Website'] }],
    contents: [
      { value: 'group', orders: 1, revenue: 1698, channels: ['Website'] },
      { value: 'bio', orders: 1, revenue: 900, channels: ['Instagram'] },
    ],
    combos: [
      {
        source: 'whatsapp',
        campaign: 'launch-2026-09',
        content: 'group',
        orders: 1,
        revenue: 1698,
        channels: ['Website'],
        lastOrderedOn: '2026-09-03 12:33:02',
        orderNames: ['S00070'],
      },
    ],
    mismatched: [{ order: 'S00070', channel: 'Website', utmSource: 'whatsapp', implied: 'WhatsApp' }],
  },
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => report() })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openTrafficTab = async () => {
  render(<MarketingROI />);
  await screen.findByRole('button', { name: /traffic sources/i });
  fireEvent.click(screen.getByRole('button', { name: /traffic sources/i }));
};

test('lists every utm_source with its visits, its people and its share', async () => {
  await openTrafficTab();

  const table = await screen.findByRole('table');
  const instagram = within(table).getByRole('row', { name: /instagram/i });

  expect(within(instagram).getByText('120')).toBeInTheDocument();
  expect(within(instagram).getByText('90')).toBeInTheDocument();
  expect(within(instagram).getByText('70%')).toBeInTheDocument();
  // The channel its revenue rolls into on the Overview tab, so the two
  // tables can be read against each other.
  expect(within(instagram).getByText('Instagram')).toBeInTheDocument();
});

test('puts what each source was worth beside how many people it sent', async () => {
  await openTrafficTab();

  const table = await screen.findByRole('table');
  const instagram = within(table).getByRole('row', { name: /instagram/i });

  expect(within(instagram).getByText('₹4,500')).toBeInTheDocument();
  expect(within(instagram).getByText('₹38')).toBeInTheDocument();

  // A source with visits and no orders reads blank, not ₹0 — the two are
  // different facts and only one of them is "worth nothing".
  const tent = within(table).getByRole('row', { name: /table-tent/i });
  expect(within(tent).queryByText('₹0')).not.toBeInTheDocument();
});

test('keeps a source we published links to but got no visits from', async () => {
  await openTrafficTab();

  // In the table, as a real zero rather than dropped...
  const table = await screen.findByRole('table');
  expect(within(table).getByRole('row', { name: /flyer/i })).toBeInTheDocument();

  // ...and called out on its own, because a printed QR nobody has scanned is
  // the finding, not a blank row.
  expect(screen.getByText(/published, but nobody came/i)).toBeInTheDocument();
  expect(screen.getByText(/3 links/i)).toBeInTheDocument();
});

test('says Google Analytics is not answering rather than printing zeroes as fact', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () =>
        report({
          sources: {
            odoo: { configured: true, url: 'https://example.odoo.com', channelField: 'x_studio_channel' },
            ga: {
              configured: true,
              propertyId: '550057156',
              serviceAccount: 'ga@example.iam',
              error: 'GA4 refused the request.',
              reachable: false,
            },
          },
        }),
    })) as unknown as typeof fetch,
  );

  await openTrafficTab();

  await waitFor(() => expect(screen.getByText(/session counts come from google analytics/i)).toBeInTheDocument());
  // Twice: once in the connection banner at the top of every tab, once in
  // the warning that explains why the counts below are all zero.
  expect(screen.getAllByText(/GA4 refused the request\./)).toHaveLength(2);
});
