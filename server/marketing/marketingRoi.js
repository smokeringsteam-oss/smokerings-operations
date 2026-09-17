// Invested versus generated: the one screen that puts what marketing cost
// next to what it brought in.
//
// Three sources, none of which is allowed to take the others down with it:
//
//   Odoo    the revenue, per channel and per campaign, from the orders
//           themselves (server/marketing/orderAttribution.js). Required —
//           without it there is no "generated" and nothing to report.
//   SQLite  the spend (server/marketing/marketingBudget.js). Local, so it is
//           always there; a window with no spend rows reports zero invested
//           rather than failing.
//   GA4     sessions per source and campaign
//           (server/integrations/googleAnalytics.js). Entirely optional. It
//           adds traffic and conversion rate to rows that already exist; it
//           never contributes revenue, and when GA is unconfigured or down
//           the money figures are unaffected and say so.
//
// The rule that shapes everything below: revenue whose channel is unknown is
// reported as unknown. It goes in its own row, it is excluded from every
// channel's return, and the totals name it separately. This matters more than
// it sounds — on the database this was built against, four orders in ten had
// no channel on them. Spreading those across the channels that do (or
// dropping them, which flatters the same way) would turn a real number into
// a plausible one, and a plausible return on investment is what gets acted
// on. So: attributed revenue is what channels are judged by, total revenue is
// what the business actually made, and the gap between the two is printed.
//
// The second rule, which decides who gets credit when the two attribution
// fields disagree: the link wins. An order carrying utm_source=reddit is
// counted as Reddit's revenue even when somebody filed it as "Website",
// because the tag is a fact about the URL that was clicked and the Studio
// selection is a judgement made afterwards, often by whoever happened to be
// taking the order. On the database this was built against every one of the
// eight tagged orders was filed as "Website", which had Reddit reading zero
// on a screen whose whole job is to say which channel is working.
//
// It applies only where the tag resolves to a channel we know
// (channelFromGaSource). utm_source=Friend maps to nothing, so those orders
// keep whatever they were filed as rather than falling into Unattributed —
// the link is better evidence than the selection, but no evidence is not.
// Every re-credited order is listed in `recredited` and counted on the row it
// moved to, so the change is never silent.
//
// Revenue is never copied into SQLite. Odoo owns it, it changes there
// (an order gets confirmed, an amount is corrected), and a local mirror
// would be a second set of books that disagrees within a week.
import { fetchAttributedOrders, fetchChannelOptions, channelFromGaSource, UNATTRIBUTED } from './orderAttribution.js';
import { listBudgets } from './marketingBudget.js';
import { listLinks, slug } from './trackedLinks.js';
import {
  describeConfig as describeGaConfig,
  isConfigured as gaConfigured,
  fetchTrafficByCampaign,
  fetchTrafficBySource,
  fetchTrafficTotals,
} from '../integrations/googleAnalytics.js';
import { getConfig as getOdooConfig } from '../integrations/odoo.js';

// Visits that are us, not customers: the hosting control panel's "view site"
// link shows up as a referral every time somebody checks a deploy.
const IGNORED_GA_SOURCES = new Set(['hpanel.hostinger.com']);
// GA4 writes "(not set)" or "(data not available)" for the same missing value
// depending on the report and the date range.
const gaBlank = (value) => !value || value === '(not set)' || value === '(data not available)';

const round = (value) => Math.round(value);
// Two places, and only for ratios. A return of 3.47x is a real distinction
// from 3.4x; a rupee figure to two decimals is noise.
const ratio = (value) => Math.round(value * 100) / 100;

// Every derived figure a channel or campaign row carries, in one place, so
// the channel table and the campaign table cannot drift into computing "return
// on investment" two different ways.
//
// `roi` is null rather than 0 when nothing was invested. They are different
// facts — one channel returned nothing on its spend, the other had no spend —
// and a 0 would sort them together at the bottom of the table, which is
// exactly backwards for a channel that generated revenue for free.
function derive({ invested, generated, orders, sessions }) {
  return {
    invested: round(invested),
    generated: round(generated),
    net: round(generated - invested),
    roi: invested > 0 ? ratio(generated / invested) : null,
    orders,
    // Average order value, and cost to acquire one. Both null on no orders
    // for the same reason roi is null on no spend.
    aov: orders > 0 ? round(generated / orders) : null,
    cac: orders > 0 && invested > 0 ? round(invested / orders) : null,
    sessions,
    // Orders per session, as a percentage. Only meaningful where GA can see
    // the traffic at all, which is the website channels — a WhatsApp order
    // has no session behind it, and a 0% there would read as a failure rather
    // than as a question that does not apply.
    conversionRate: sessions > 0 ? ratio((orders / sessions) * 100) : null,
  };
}

// Traffic by utm_source: how many people arrived from each place we
// published, before any question of what they were worth.
//
// This is deliberately a different table from the channel table above, and
// not a drill-down of it. A channel is a bucket of revenue and several
// sources can land in one (three of CHANNELS' entries share the source
// 'Referral'); a source is one place a link was published. "Instagram made
// Rs 14,000" and "820 people arrived from utm_source=instagram" are different
// facts, and the second one is answerable for sources that will never have a
// channel -- a food blog's referral, a QR on a flyer nobody has mapped yet.
//
// Pure, and fed its three inputs rather than fetching them, so the joining
// rules below are testable without GA4, Odoo or a printed sticker:
//
//   sourceRows    per-source totals from GA at source grain (see
//                 fetchTrafficBySource on why users cannot be summed up from
//                 a finer one).
//   campaignRows  the finer source/medium/campaign rows, used for the medium
//                 and campaign breakdown only, and only for sessions.
//   links         our own marketing_link rows, so a source we published to
//                 and got nothing from is visible as a zero rather than
//                 absent.
//   utmSources    orders and revenue per utm_source, from buildUtmBreakdown,
//                 so the row that says how many people arrived also says what
//                 they were worth.
//
// The links input is the reason the table can show a source with no sessions:
// a QR that went to the printer, the sticker on the boxes, and nobody
// scanning it is the failure this screen exists to surface.
//
// The revenue join is matched on slug, not on the literal string. GA reports
// 'kamanahalli_tea_shop' and a link built here writes
// 'kamanahalli-tea-shop', and those are one source — slug() collapses both to
// the same key, exactly as it already does for the links column.
function buildTrafficSources({ sourceRows = [], campaignRows = [], links = [], utmSources = [] }) {
  const rows = new Map();
  // Keyed on the slug, displayed under whatever GA calls it.
  //
  // The three inputs spell the same source three ways -- GA reports
  // 'kamanahalli_tea_shop', a link built here writes
  // 'kamanahalli-tea-shop', and somebody typing one by hand writes
  // 'Kamanahalli Tea Shop'. Keying on the raw string split those into
  // separate rows, so a source's sessions and its revenue could sit on two
  // lines that both looked half-empty. slug() is the same collapsing the
  // link builder already applies when it writes a URL, so the two meet.
  //
  // `label: true` means the caller is GA, whose spelling wins for display:
  // it is the one the reader will recognise from the GA report itself.
  const rowFor = (source, { label = false } = {}) => {
    const trimmed = String(source || '').trim();
    const raw = gaBlank(trimmed) ? '(not set)' : trimmed;
    const key = slug(raw) || raw;
    if (!rows.has(key)) {
      rows.set(key, {
        source: raw,
        sessions: 0,
        users: 0,
        newUsers: 0,
        keyEvents: 0,
        mediums: new Map(),
        campaigns: new Map(),
        links: 0,
        orders: 0,
        revenue: 0,
        // Whether any order in the window carried this utm_source. Separate
        // from `revenue` being zero, which is also what an unsold source
        // looks like.
        seenOnOrders: false,
        // Whether GA reported this source at all in the window. A row that
        // exists only because we published a link to it has no GA figures
        // behind its zeroes, and the screen says which kind of zero it is
        // rather than letting "nobody came" and "GA is not connected" print
        // identically.
        seenByGa: false,
      });
    }
    const row = rows.get(key);
    if (label) row.source = raw;
    return row;
  };

  const ignored = (row) => IGNORED_GA_SOURCES.has(String(row.source || '').trim().toLowerCase());

  sourceRows.filter((row) => !ignored(row)).forEach((row) => {
    const bucket = rowFor(row.source, { label: true });
    bucket.seenByGa = true;
    bucket.sessions += row.sessions || 0;
    bucket.users += row.users || 0;
    bucket.newUsers += row.newUsers || 0;
    bucket.keyEvents += row.keyEvents || 0;
  });

  // Mediums and campaigns, sessions only. These rows never contribute to a
  // source's totals -- those came from GA at source grain above, and adding
  // a finer report's users into them is exactly the double count
  // fetchTrafficBySource exists to avoid.
  campaignRows.filter((row) => !ignored(row)).forEach((row) => {
    const bucket = rowFor(row.source, { label: true });
    const medium = gaBlank(row.medium) ? '(not set)' : row.medium;
    bucket.mediums.set(medium, (bucket.mediums.get(medium) || 0) + (row.sessions || 0));
    if (row.campaign) {
      bucket.campaigns.set(row.campaign, (bucket.campaigns.get(row.campaign) || 0) + (row.sessions || 0));
    }
  });

  // Our own published links, matched on the slug. GA reports the utm_source
  // verbatim, and every link this app builds carries a slug (trackedLinks'
  // slug() sees to that), so the two meet exactly for anything we published.
  // A source GA invented on its own -- 'l.instagram.com', '(direct)' --
  // matches no link, which is correct: we did not publish it.
  links.forEach((link) => {
    if (!link.source) return;
    rowFor(link.source).links += 1;
  });

  // Revenue, from the orders' own utm_source. A source that sold but that GA
  // never reported still gets a row — a WhatsApp link opened in the app can
  // arrive with no session behind it, and dropping the money because the
  // visit was invisible would be the wrong way round.
  utmSources.forEach((row) => {
    if (!row.value) return;
    const bucket = rowFor(row.value);
    bucket.orders += row.orders || 0;
    bucket.revenue += row.revenue || 0;
    bucket.seenOnOrders = true;
  });

  const totalSessions = [...rows.values()].reduce((sum, row) => sum + row.sessions, 0);

  return [...rows.values()]
    .map((row) => ({
      source: row.source,
      sessions: row.sessions,
      users: row.users,
      newUsers: row.newUsers,
      keyEvents: row.keyEvents,
      // Share of the sessions in this table, not of site sessions. Every row
      // is visible here, so this is the percentage that adds to 100 -- and a
      // share column in a complete table that does not is read as a bug.
      share: totalSessions > 0 ? ratio((row.sessions / totalSessions) * 100) : null,
      // Which channel's revenue this source's traffic rolls into on the
      // table above, worked out through the same function that folded it
      // there. '' means it rolls into none: the traffic is real and counted
      // here, and any revenue behind it lands in the unattributed row.
      channel: channelFromGaSource(row.source),
      mediums: [...row.mediums.entries()]
        .map(([medium, sessions]) => ({ medium, sessions }))
        .sort((a, b) => b.sessions - a.sessions),
      campaigns: [...row.campaigns.entries()]
        .map(([campaign, sessions]) => ({ campaign, sessions }))
        .sort((a, b) => b.sessions - a.sessions),
      links: row.links,
      orders: row.orders,
      revenue: round(row.revenue),
      // What a visit from this source was worth on average. Only computable
      // where both halves are present, and null rather than 0 otherwise: a
      // source GA cannot see has no revenue per session, which is a different
      // statement from it being worth nothing.
      revenuePerSession: row.sessions > 0 && row.revenue > 0 ? ratio(row.revenue / row.sessions) : null,
      seenOnOrders: row.seenOnOrders,
      seenByGa: row.seenByGa,
    }))
    // Revenue first, because the question the tab is opened with is what the
    // traffic was worth; sessions break the ties among the sources that sold
    // nothing.
    .sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions || a.source.localeCompare(b.source));
}

// What the link itself said: the utm_source / utm_campaign / utm_content the
// website copied onto the order, counted as its own dimension.
//
// This is not a drill-down of the channel table and must not be read as one.
// The channel is what somebody decided the order was; a UTM tag is what the
// URL the customer actually clicked carried, and the two disagree in useful
// ways — the first order to arrive with tags was marked "Website" by the
// Studio selection while its link said utm_source=whatsapp, which is not an
// error in either field. One says how the order was taken, the other says
// what brought it. `mismatched` below surfaces exactly that pair rather than
// picking a winner.
//
// Only the char fields feed this. An order tagged by hand from the
// Attribution tab gets campaign_id and source_id, not x_utm_*, and counting
// those here would report a link that was never clicked.
//
// Pure and fed its orders, like buildTrafficSources above.
//
// Written for a window where one order in thirty-eight carries tags, because
// the site has only just started sending them. Every count is therefore
// stated against a denominator — `tagged` out of `orders` — so a table with
// two rows in it reads as the beginning of a data set rather than as the
// whole picture.
function buildUtmBreakdown({ orders = [], fields = [] }) {
  const dimension = () => new Map();
  const dims = { source: dimension(), campaign: dimension(), content: dimension() };
  const combos = new Map();

  const bump = (map, key, order) => {
    if (!key) return;
    const row = map.get(key) || { value: key, orders: 0, revenue: 0, channels: new Set() };
    row.orders += 1;
    row.revenue += order.amount;
    if (order.channel) row.channels.add(order.channel);
    map.set(key, row);
  };

  let tagged = 0;
  let taggedRevenue = 0;
  let counted = 0;
  let countedRevenue = 0;
  const mismatched = [];

  orders.forEach((order) => {
    // Same revenue rule as everywhere else on this screen: a draft quotation
    // is not money, whatever tags it carries.
    if (!order.countsAsRevenue) return;
    counted += 1;
    countedRevenue += order.amount;

    const utm = order.utm || {};
    if (!utm.source && !utm.campaign && !utm.content) return;

    tagged += 1;
    taggedRevenue += order.amount;

    bump(dims.source, utm.source, order);
    bump(dims.campaign, utm.campaign, order);
    bump(dims.content, utm.content, order);

    // The full tag, which is the grain a link is actually published at: the
    // same campaign runs on three sources and the same source carries four
    // pieces of content, and it is the combination that identifies which
    // sticker or which message did the work.
    const key = `${utm.source} ${utm.campaign} ${utm.content}`;
    const combo = combos.get(key) || {
      source: utm.source,
      campaign: utm.campaign,
      content: utm.content,
      orders: 0,
      revenue: 0,
      channels: new Set(),
      lastOrderedOn: '',
      orderNames: [],
    };
    combo.orders += 1;
    combo.revenue += order.amount;
    if (order.channel) combo.channels.add(order.channel);
    if (order.orderedOn > combo.lastOrderedOn) combo.lastOrderedOn = order.orderedOn;
    // Capped: this is a "which orders were these" convenience for a table
    // that currently has single-digit rows, not an order list.
    if (combo.orderNames.length < 12) combo.orderNames.push(order.name);
    combos.set(key, combo);

    // The channel a link's source implies, against the channel the order was
    // filed under. channelFromGaSource is the right resolver here: a
    // utm_source is written in the same vocabulary GA reports, which is what
    // its patterns were built to read.
    const implied = channelFromGaSource(utm.source);
    if (implied && order.channel && implied !== order.channel) {
      mismatched.push({ order: order.name, channel: order.channel, utmSource: utm.source, implied });
    }
  });

  const shape = (map) =>
    [...map.values()]
      .map((row) => ({
        value: row.value,
        orders: row.orders,
        revenue: round(row.revenue),
        channels: [...row.channels].sort(),
      }))
      .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || a.value.localeCompare(b.value));

  return {
    // '' when Studio has no x_utm_* columns at all, which is a different
    // problem from having them and receiving nothing.
    fields,
    orders: counted,
    revenue: round(countedRevenue),
    tagged,
    taggedRevenue: round(taggedRevenue),
    taggedShare: counted > 0 ? ratio((tagged / counted) * 100) : null,
    sources: shape(dims.source),
    campaigns: shape(dims.campaign),
    contents: shape(dims.content),
    combos: [...combos.values()]
      .map((row) => ({ ...row, revenue: round(row.revenue), channels: [...row.channels].sort() }))
      .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders),
    mismatched,
  };
}

// Sorted so the answer to "what worked" is the top of the list.
//
// By net rupees generated, not by return multiple: a Rs 300 spend that
// returned Rs 1,200 is a 4x and a Rs 8,000 spend that returned Rs 24,000 is a
// 3x, and it is the second one paying the rent. The multiple is in the row for
// whoever wants it.
const byNet = (a, b) => b.net - a.net || b.generated - a.generated;

// The whole screen, in one call.
//
// GA is fetched alongside Odoo rather than after it, and its failure is
// caught and reported instead of thrown: a service account whose key expired
// must not blank out the revenue figures, which is the half of this screen
// that pays for itself.
async function buildRoiReport({ fromDate, toDate }) {
  const odoo = getOdooConfig();
  if (!odoo.configured) {
    const err = new Error('Odoo is not configured, so there is no revenue to report against. Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY.');
    err.status = 400;
    throw err;
  }

  const wantGa = gaConfigured();
  const [{ orders, channelField, utmFields }, channelOptions, traffic] = await Promise.all([
    fetchAttributedOrders({ fromDate, toDate }),
    fetchChannelOptions().catch(() => ({ field: '', channels: [] })),
    wantGa
      ? Promise.all([
          fetchTrafficByCampaign({ fromDate, toDate }),
          fetchTrafficTotals({ fromDate, toDate }),
          fetchTrafficBySource({ fromDate, toDate }),
        ])
          .then(([rows, totals, sourceRows]) => ({ rows, totals, sourceRows, error: '' }))
          .catch((err) => ({ rows: [], totals: null, sourceRows: [], error: err.message || String(err) }))
      : Promise.resolve({ rows: [], totals: null, sourceRows: [], error: '' }),
  ]);

  const spend = listBudgets({ fromDate, toDate });

  // ---- Buckets -----------------------------------------------------------
  // Keyed by channel name, seeded from three independent lists so a row
  // appears for anything that exists in any of them: a channel Odoo offers
  // but nobody used, spend on a channel that produced no orders (the row that
  // most needs to be seen), and orders on a channel somebody removed from the
  // selection after the fact.
  const channels = new Map();
  const channelOf = (name) => {
    const key = name || UNATTRIBUTED;
    if (!channels.has(key)) {
      channels.set(key, {
        channel: key,
        invested: 0,
        generated: 0,
        orders: 0,
        sessions: 0,
        users: 0,
        keyEvents: 0,
        spendRows: 0,
        partialSpend: false,
        campaigns: new Set(),
        // Of this channel's orders, how many were credited to it by a
        // utm_source rather than by the Studio selection — and what they were
        // worth. Printed on the row, because a channel whose revenue is
        // entirely re-credited is a channel nobody is filing correctly, and
        // that is worth knowing separately from how it performed.
        fromLink: 0,
        linkRevenue: 0,
        // Whether this channel is one CHANNELS knows how to map onto UTM and
        // GA names, so the screen can say why a channel shows no sessions.
        mapped: false,
      });
    }
    return channels.get(key);
  };

  channelOptions.channels.forEach((option) => {
    channelOf(option.value).mapped = option.mapped;
  });

  // Campaign rows are keyed by campaign name alone, not by channel+campaign.
  // A campaign that ran on two channels is one campaign, and its return is
  // the whole of what it cost against the whole of what it made; splitting it
  // by channel would answer a question nobody asked and hide the one they
  // did.
  const campaigns = new Map();
  const campaignOf = (name) => {
    if (!campaigns.has(name)) {
      campaigns.set(name, {
        campaign: name,
        channels: new Set(),
        invested: 0,
        generated: 0,
        orders: 0,
        sessions: 0,
      });
    }
    return campaigns.get(name);
  };

  // ---- Revenue -----------------------------------------------------------
  let totalRevenue = 0;
  let attributedRevenue = 0;
  let unattributedRevenue = 0;
  let unattributedOrders = 0;
  let pendingRevenue = 0;
  let pendingOrders = 0;
  // Orders the link moved off the channel they were filed under, listed so
  // the screen can show exactly which ones and let somebody correct the
  // filing if the link was the wrong one.
  const recredited = [];
  let recreditedRevenue = 0;
  // Orders that had no channel at all and got one from their link. Not a
  // disagreement — a gap the link closed — so counted apart from the above.
  let linkOnlyOrders = 0;
  let linkOnlyRevenue = 0;

  orders.forEach((order) => {
    if (!order.countsAsRevenue) {
      // Draft quotations, kept as a separate figure. They are not revenue and
      // are not counted as any channel's return, but a window with a lot of
      // them is about to look very different, and the screen says so rather
      // than appearing to have missed them.
      pendingRevenue += order.amount;
      pendingOrders += 1;
      return;
    }

    totalRevenue += order.amount;

    // The link wins where it says anything — see the second rule at the top
    // of this file. channelFromGaSource is the right resolver: a utm_source
    // is written in the same vocabulary GA reports, which is what its
    // patterns were built to read, and it returns '' for a tag that maps to
    // no channel of ours rather than guessing at one.
    const linkChannel = channelFromGaSource(order.utm?.source || '');
    const channel = linkChannel || order.channel;

    if (!channel) {
      unattributedRevenue += order.amount;
      unattributedOrders += 1;
      const bucket = channelOf(UNATTRIBUTED);
      bucket.generated += order.amount;
      bucket.orders += 1;
      return;
    }

    attributedRevenue += order.amount;
    const bucket = channelOf(channel);
    bucket.generated += order.amount;
    bucket.orders += 1;

    if (linkChannel) {
      bucket.fromLink += 1;
      bucket.linkRevenue += order.amount;
      if (!order.channel) {
        linkOnlyOrders += 1;
        linkOnlyRevenue += order.amount;
      } else if (order.channel !== linkChannel) {
        recreditedRevenue += order.amount;
        recredited.push({
          order: order.name,
          orderedOn: order.orderedOn,
          amount: round(order.amount),
          filedAs: order.channel,
          utmSource: order.utm.source,
          creditedTo: linkChannel,
        });
      }
    }

    if (order.campaign) {
      bucket.campaigns.add(order.campaign);
      const row = campaignOf(order.campaign);
      row.generated += order.amount;
      row.orders += 1;
      row.channels.add(channel);
    }
  });

  // ---- Spend -------------------------------------------------------------
  let totalInvested = 0;
  const byCategory = new Map();

  spend.forEach((row) => {
    totalInvested += row.amountInRange;

    const bucket = channelOf(row.channel);
    bucket.invested += row.amountInRange;
    bucket.spendRows += 1;
    if (row.partial) bucket.partialSpend = true;

    byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.amountInRange);

    if (row.campaign) {
      bucket.campaigns.add(row.campaign);
      const campaign = campaignOf(row.campaign);
      campaign.invested += row.amountInRange;
      campaign.channels.add(row.channel);
    }
  });

  // ---- Traffic -----------------------------------------------------------
  // GA sources that resolve to one of our channels fold into that channel's
  // row. The rest are listed on their own: a referral from a food blog nobody
  // has mapped is real traffic and worth seeing, and inventing a channel for
  // it would put sessions against revenue that has nothing to do with it.
  const gaOnly = new Map();

  traffic.rows.forEach((row) => {
    const channel = channelFromGaSource(row.source);
    if (channel) {
      const bucket = channelOf(channel);
      bucket.sessions += row.sessions;
      bucket.users += row.users;
      bucket.keyEvents += row.keyEvents;
    } else if (!IGNORED_GA_SOURCES.has(String(row.source || '').toLowerCase())) {
      // One row per source, whatever the medium: tea_shop / offline and
      // tea_shop / qr_code are the same poster, and GA's two spellings of
      // "unknown" are the same nothing.
      const source = gaBlank(row.source) ? '(not set)' : row.source;
      const medium = gaBlank(row.medium) ? '(not set)' : row.medium;
      const existing = gaOnly.get(source) || { source, mediums: new Set(), sessions: 0, users: 0, keyEvents: 0 };
      existing.mediums.add(medium);
      existing.sessions += row.sessions;
      existing.users += row.users;
      existing.keyEvents += row.keyEvents;
      gaOnly.set(source, existing);
    }

    // A GA campaign name only joins onto a campaign row that already exists
    // from spend or from a tagged order. It never creates one: GA sees
    // utm_campaign values that were never budgeted and may be somebody
    // else's link, and a campaign row with sessions, no spend and no revenue
    // would be three empty columns and a mystery.
    if (row.campaign && campaigns.has(row.campaign)) {
      campaigns.get(row.campaign).sessions += row.sessions;
    }
  });

  // ---- Shape -------------------------------------------------------------
  // Before the tables, because the traffic-sources table joins onto it.
  const utm = buildUtmBreakdown({ orders, fields: utmFields || [] });

  const channelRows = [...channels.values()]
    // A channel Odoo offers that nobody spent on or sold through in this
    // window is dropped here rather than shown as a row of zeroes. It was
    // seeded above only so that a channel with spend and no orders survives.
    .filter((row) => row.invested || row.generated || row.orders || row.sessions)
    .map((row) => ({
      channel: row.channel,
      ...derive(row),
      users: row.users,
      keyEvents: row.keyEvents,
      spendRows: row.spendRows,
      partialSpend: row.partialSpend,
      fromLink: row.fromLink,
      linkRevenue: round(row.linkRevenue),
      campaigns: [...row.campaigns].sort(),
      mapped: row.mapped,
      // The one row that is not a channel and must not be read as one.
      unattributed: row.channel === UNATTRIBUTED,
    }))
    .sort((a, b) => {
      // Unattributed always last, whatever its size — it is a measurement
      // gap, not a winner, and sorting it to the top of a table headed "what
      // worked" would be actively misleading.
      if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
      return byNet(a, b);
    });

  const campaignRows = [...campaigns.values()]
    .map((row) => ({
      campaign: row.campaign,
      channels: [...row.channels].sort(),
      ...derive(row),
    }))
    .sort(byNet);

  return {
    range: { from: fromDate, to: toDate },
    sources: {
      odoo: { configured: true, url: odoo.url, channelField },
      ga: {
        ...describeGaConfig(),
        // Configured but failing is its own state, and the screen has to be
        // able to say "GA is set up and refused us" rather than "GA is off".
        error: traffic.error || describeGaConfig().error,
        reachable: wantGa && !traffic.error,
      },
    },
    totals: {
      invested: round(totalInvested),
      generated: round(totalRevenue),
      net: round(totalRevenue - totalInvested),
      roi: totalInvested > 0 ? ratio(totalRevenue / totalInvested) : null,
      orders: orders.filter((order) => order.countsAsRevenue).length,
      // The honesty pair. `attributedRevenue` is the denominator every
      // channel's return is really computed over; the difference from
      // `generated` is how much of the answer is unknown.
      attributedRevenue: round(attributedRevenue),
      unattributedRevenue: round(unattributedRevenue),
      unattributedOrders,
      attributedShare: totalRevenue > 0 ? ratio((attributedRevenue / totalRevenue) * 100) : null,
      // Return computed on attributed revenue alone — the conservative
      // figure, and the one that is defensible.
      attributedRoi: totalInvested > 0 ? ratio(attributedRevenue / totalInvested) : null,
      pendingRevenue: round(pendingRevenue),
      pendingOrders,
      // What the link rule did to the figures above, so the reader can see
      // its size before trusting it. Two separate counts: orders it moved
      // from one channel to another, and orders it rescued from
      // Unattributed.
      recreditedOrders: recredited.length,
      recreditedRevenue: round(recreditedRevenue),
      linkOnlyOrders,
      linkOnlyRevenue: round(linkOnlyRevenue),
      sessions: traffic.totals?.sessions ?? null,
      users: traffic.totals?.users ?? null,
      newUsers: traffic.totals?.newUsers ?? null,
    },
    channels: channelRows,
    campaigns: campaignRows,
    categories: [...byCategory.entries()]
      .map(([category, invested]) => ({ category, invested: round(invested) }))
      .sort((a, b) => b.invested - a.invested),
    gaOnly: [...gaOnly.values()]
      .map(({ mediums, ...row }) => ({ ...row, medium: [...mediums].sort().join(', ') }))
      .sort((a, b) => b.sessions - a.sessions),
    // The traffic-sources tab. Built from the links table as well as from
    // GA, so it is present even when GA is not: a list of the sources we
    // publish to, all reading zero, is a truthful answer to "who arrived
    // from where" on a property that is not connected, and a more useful one
    // than an empty screen.
    // What the links themselves said, kept as its own dimension rather than
    // folded into the channel rows. See buildUtmBreakdown.
    utm,
    trafficSources: buildTrafficSources({
      sourceRows: traffic.sourceRows,
      campaignRows: traffic.rows,
      links: listLinks(),
      utmSources: utm.sources,
    }),
    // The orders the link rule moved, named. The Overview table says a
    // channel's revenue includes re-credited orders; this says which ones, so
    // a wrong link can be found rather than merely suspected.
    recredited: recredited.sort((a, b) => b.amount - a.amount),
    spend,
    // Everything the tagging list needs, so the screen that shows the gap is
    // also the screen that closes it.
    //
    // An order with no Studio channel but a link that resolves to one is no
    // longer part of this gap: it is attributed, it appears under a real
    // channel above, and badging it as untagged would send somebody to file
    // something that is already known. The gap is orders with neither.
    untagged: orders.filter(
      (order) => !order.channel && !channelFromGaSource(order.utm?.source || ''),
    ).length,
    // Orders with no Studio selection at all, however they were attributed.
    // Still worth filing — Odoo's own back-office reports read that field and
    // not our link rule — so the Attribution tab says so without the badge
    // overstating the measurement gap.
    unfiled: orders.filter((order) => !order.channel).length,
    channelOptions: channelOptions.channels,
  };
}

export { buildRoiReport, buildTrafficSources, buildUtmBreakdown, derive, byNet };
