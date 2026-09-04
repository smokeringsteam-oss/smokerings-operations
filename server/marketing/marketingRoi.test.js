// buildTrafficSources, the join behind the Traffic sources tab.
//
// Only the pure half of marketingRoi.js is exercised here. buildRoiReport
// needs a live Odoo and a GA4 service account and is not something a test can
// stand up honestly; the joining rules are, and they are where this can go
// quietly wrong — a users column that double counts, or a printed QR whose
// row vanishes because nobody scanned it.
//
// The three cases below are the three that matter:
//
//   * users are taken from the source-grain report and never summed out of
//     the finer one, because a person who arrived twice is one person;
//   * a source we published a link to survives with zero sessions, because
//     that is the finding, not an empty row; and
//   * a source resolves to the same channel here as it does on the Overview
//     tab, because two tables disagreeing about what 'instagram' is would be
//     worse than either of them being absent.
import { describe, it, expect, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

// marketingRoi.js pulls in the budget store and the links store, both of
// which open the database at import time.
const { dir } = createTestDb();

const { buildTrafficSources, buildUtmBreakdown } = await import('./marketingRoi.js');

afterAll(() => removeTestDb(dir));

// GA at source grain: what fetchTrafficBySource returns.
const SOURCE_ROWS = [
  { source: 'instagram', sessions: 120, users: 90, newUsers: 70, keyEvents: 8 },
  { source: 'table-tent', sessions: 12, users: 12, newUsers: 11, keyEvents: 1 },
  { source: '(direct)', sessions: 40, users: 33, newUsers: 20, keyEvents: 2 },
];

// The same window at source/medium/campaign grain: what
// fetchTrafficByCampaign returns. Note instagram's two rows add to 120
// sessions but 100 users — the sum a naive join would print.
const CAMPAIGN_ROWS = [
  { source: 'instagram', medium: 'social', campaign: 'weekend-brisket', sessions: 80, users: 60, keyEvents: 6 },
  { source: 'instagram', medium: 'social', campaign: '', sessions: 40, users: 40, keyEvents: 2 },
  { source: 'table-tent', medium: 'qr', campaign: 'weekend-brisket', sessions: 12, users: 12, keyEvents: 1 },
  { source: '(direct)', medium: '(none)', campaign: '', sessions: 40, users: 33, keyEvents: 2 },
];

const LINKS = [
  { source: 'instagram' },
  { source: 'table-tent' },
  { source: 'flyer' },
  { source: 'flyer' },
];

const bySource = (rows) => Object.fromEntries(rows.map((row) => [row.source, row]));

describe('buildTrafficSources', () => {
  it('takes users from the source-grain report rather than summing the finer one', () => {
    const rows = bySource(buildTrafficSources({ sourceRows: SOURCE_ROWS, campaignRows: CAMPAIGN_ROWS, links: [] }));

    expect(rows.instagram.sessions).toBe(120);
    // 90, not the 100 the two campaign rows add to: a person who came back
    // during a campaign and again outside it is one person.
    expect(rows.instagram.users).toBe(90);
    expect(rows.instagram.newUsers).toBe(70);
  });

  it('breaks a source down by medium and campaign on sessions, which do add up', () => {
    const rows = bySource(buildTrafficSources({ sourceRows: SOURCE_ROWS, campaignRows: CAMPAIGN_ROWS, links: [] }));

    expect(rows.instagram.mediums).toEqual([{ medium: 'social', sessions: 120 }]);
    // The uncampaigned 40 sessions are not invented into a campaign row.
    expect(rows.instagram.campaigns).toEqual([{ campaign: 'weekend-brisket', sessions: 80 }]);
  });

  it('keeps a source we published a link to even when nobody clicked it', () => {
    const rows = bySource(buildTrafficSources({ sourceRows: SOURCE_ROWS, campaignRows: CAMPAIGN_ROWS, links: LINKS }));

    // The whole reason the links table is joined in: two flyer QR codes are
    // in the world and no scan has come back.
    expect(rows.flyer).toBeDefined();
    expect(rows.flyer.sessions).toBe(0);
    expect(rows.flyer.links).toBe(2);
    // Zero because GA never mentioned it, not because GA said zero.
    expect(rows.flyer.seenByGa).toBe(false);
    expect(rows.instagram.seenByGa).toBe(true);
    expect(rows.instagram.links).toBe(1);
  });

  it('resolves a source to the same channel the Overview tab folds it into', () => {
    const rows = bySource(buildTrafficSources({ sourceRows: SOURCE_ROWS, campaignRows: CAMPAIGN_ROWS, links: LINKS }));

    expect(rows.instagram.channel).toBe('Instagram');
    expect(rows['(direct)'].channel).toBe('Website');
    // A physical placement GA can see but CHANNELS does not map. Real
    // traffic, no channel — reported as such rather than guessed at.
    expect(rows['table-tent'].channel).toBe('');
  });

  it('shares out sessions over the rows shown, so the column adds to 100%', () => {
    const rows = buildTrafficSources({ sourceRows: SOURCE_ROWS, campaignRows: CAMPAIGN_ROWS, links: LINKS });
    const total = rows.reduce((sum, row) => sum + (row.share || 0), 0);

    expect(Math.round(total)).toBe(100);
    // Ranked, so the top of the list is the answer to "where did people come
    // from".
    expect(rows.map((row) => row.source).slice(0, 3)).toEqual(['instagram', '(direct)', 'table-tent']);
  });

  it('reports nothing rather than dividing by zero when there is no traffic at all', () => {
    const rows = buildTrafficSources({ sourceRows: [], campaignRows: [], links: LINKS });

    // One row per distinct source we publish to: instagram, table-tent and
    // flyer, the last of which has two links.
    expect(rows.map((row) => row.source).sort()).toEqual(['flyer', 'instagram', 'table-tent']);
    expect(rows.every((row) => row.share === null)).toBe(true);
    expect(rows.every((row) => row.sessions === 0)).toBe(true);
  });
});

// buildUtmBreakdown, the UTM tags tab.
//
// The three rules worth pinning, all of which are ways this could quietly
// overstate what the links did:
//
//   * a draft quotation carrying tags is not revenue, here as everywhere;
//   * only the x_utm_* chars count, so an order tagged by hand from the
//     Attribution tab never appears as a link that was clicked; and
//   * a utm_source that implies a different channel from the one the order
//     was filed under is reported as a disagreement, not resolved.
const utmOrder = (name, amount, channel, utm, { revenue = true } = {}) => ({
  name,
  amount,
  channel,
  countsAsRevenue: revenue,
  orderedOn: `2026-09-0${name.slice(-1)} 12:00:00`,
  utm: { source: '', campaign: '', content: '', ...utm },
});

describe('buildUtmBreakdown', () => {
  const orders = [
    // The real first one: filed as Website, link said whatsapp.
    utmOrder('S1', 1698, 'Website', { source: 'whatsapp', campaign: 'launch-2026-09', content: 'group' }),
    utmOrder('S2', 900, 'Instagram', { source: 'instagram', campaign: 'launch-2026-09', content: 'bio' }),
    utmOrder('S3', 500, 'Instagram', { source: 'instagram', campaign: 'launch-2026-09', content: 'bio' }),
    // Tagged by hand, no URL tags. Revenue, but not a click.
    utmOrder('S4', 300, 'Instagram', {}),
    // Tagged, but still a quotation.
    utmOrder('S5', 9999, 'Website', { source: 'whatsapp', campaign: 'launch-2026-09', content: 'group' }, { revenue: false }),
  ];

  const report = buildUtmBreakdown({ orders, fields: ['x_utm_source', 'x_utm_campaign', 'x_utm_content'] });

  it('counts tagged orders against every confirmed order, not against each other', () => {
    expect(report.orders).toBe(4);
    expect(report.revenue).toBe(3398);
    expect(report.tagged).toBe(3);
    expect(report.taggedRevenue).toBe(3098);
    expect(report.taggedShare).toBe(75);
  });

  it('leaves the draft out of every row', () => {
    const whatsapp = report.sources.find((row) => row.value === 'whatsapp');
    expect(whatsapp).toMatchObject({ orders: 1, revenue: 1698 });
    expect(report.combos.flatMap((row) => row.orderNames)).not.toContain('S5');
  });

  it('groups the full tag, not just the source', () => {
    expect(report.combos).toHaveLength(2);
    expect(report.combos[0]).toMatchObject({
      source: 'whatsapp',
      campaign: 'launch-2026-09',
      content: 'group',
      orders: 1,
      revenue: 1698,
    });
    const ig = report.combos.find((row) => row.source === 'instagram');
    expect(ig).toMatchObject({ orders: 2, revenue: 1400, orderNames: ['S2', 'S3'] });
  });

  it('rolls a campaign up across the sources it ran on', () => {
    expect(report.campaigns).toHaveLength(1);
    expect(report.campaigns[0]).toMatchObject({
      value: 'launch-2026-09',
      orders: 3,
      revenue: 3098,
      channels: ['Instagram', 'Website'],
    });
  });

  it('reports a channel that disagrees with the link rather than picking one', () => {
    expect(report.mismatched).toEqual([
      { order: 'S1', channel: 'Website', utmSource: 'whatsapp', implied: 'WhatsApp' },
    ]);
  });

  it('says nothing is tagged without pretending the columns are missing', () => {
    const empty = buildUtmBreakdown({ orders: [utmOrder('S9', 100, 'Website', {})], fields: ['x_utm_source'] });
    expect(empty.tagged).toBe(0);
    expect(empty.taggedShare).toBe(0);
    expect(empty.fields).toEqual(['x_utm_source']);
    expect(empty.combos).toEqual([]);
  });
});

// The revenue join onto the traffic table. Two rules, both of which are ways
// a source's worth could be quietly misstated:
//
//   * GA writes 'kamanahalli_tea_shop' and a link built here writes
//     'kamanahalli-tea-shop'. Those are one source, and matching them
//     literally would print the sessions and the revenue on two rows; and
//   * a source that sold with no session behind it keeps its revenue. A
//     WhatsApp link opened in the app often has no session, and dropping the
//     money because the visit was invisible is the wrong way round.
describe('buildTrafficSources revenue join', () => {
  const rows = buildTrafficSources({
    sourceRows: [
      { source: 'kamanahalli_tea_shop', sessions: 8, users: 6, newUsers: 6, keyEvents: 1 },
      { source: 'poster', sessions: 12, users: 10, newUsers: 9, keyEvents: 0 },
    ],
    utmSources: [
      { value: 'kamanahalli-tea-shop', orders: 2, revenue: 2400, channels: [] },
      // Sold, never seen by GA.
      { value: 'whatsapp', orders: 1, revenue: 1698, channels: ['Website'] },
    ],
  });

  const find = (source) => rows.find((row) => row.source === source);

  it('matches GA and our own spelling of the same source', () => {
    expect(rows.filter((row) => row.source.includes('tea')).length).toBe(1);
    expect(find('kamanahalli_tea_shop')).toMatchObject({ sessions: 8, orders: 2, revenue: 2400 });
    expect(find('kamanahalli_tea_shop').revenuePerSession).toBe(300);
  });

  it('keeps revenue from a source GA never reported', () => {
    expect(find('whatsapp')).toMatchObject({ orders: 1, revenue: 1698, sessions: 0, seenByGa: false });
    // No sessions means no per-session figure, rather than a division that
    // reports the whole order as the value of a visit that never happened.
    expect(find('whatsapp').revenuePerSession).toBeNull();
  });

  it('leaves a source with visits and no orders at null rather than zero value', () => {
    expect(find('poster')).toMatchObject({ sessions: 12, orders: 0, revenue: 0, revenuePerSession: null });
  });

  it('ranks by revenue, so the top of the table is what the traffic was worth', () => {
    expect(rows.map((row) => row.source)).toEqual(['kamanahalli_tea_shop', 'whatsapp', 'poster']);
  });
});

// 'ig' is a real source on the live property and belongs to Instagram, but it
// cannot be a substring pattern: 'swiggy' contains it.
describe('channelFromGaSource shorthands', () => {
  it('resolves the shorthand without claiming swiggy', async () => {
    const { channelFromGaSource } = await import('./orderAttribution.js');
    expect(channelFromGaSource('ig')).toBe('Instagram');
    expect(channelFromGaSource('IG')).toBe('Instagram');
    expect(channelFromGaSource('swiggy')).toBe('Swiggy');
    expect(channelFromGaSource('instagram')).toBe('Instagram');
    expect(channelFromGaSource('kamanahalli_tea_shop')).toBe('');
  });
});
