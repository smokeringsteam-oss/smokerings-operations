// Which channel, and which campaign, each Odoo order came from.
//
// This is the join key the whole Marketing ROI screen rests on, and when it
// was written it was very nearly empty: sale.order carries Odoo's native
// campaign_id / source_id / medium_id, and across the last six months of
// orders all three were unset on every single one. The one field anybody had
// actually been filling in was a Studio selection called "Order Source"
// (x_order_source) — Instagram / Reddit / WhatsApp / Website / Swiggy /
// Zomato / Friends & Family / B2B / Catering / Pop-up Event — and even that
// was blank on about four orders in ten.
//
// So this module does two jobs, and the second is the reason the first is
// worth doing at all:
//
//   * READ what attribution exists, honestly. An order with no channel is
//     reported as unattributed, never quietly bucketed into "Website"
//     because most orders are. A return on investment computed over a
//     denominator that silently absorbed the unknowns is worse than no
//     figure, because it looks like one.
//
//   * WRITE attribution back, and write it to Odoo's own fields rather than
//     to a table of our own. setOrderAttribution fills the Studio selection
//     AND campaign_id/source_id/medium_id, which means every Odoo-side
//     report, filter and group-by starts working on the same data — and it
//     means that if this app goes away the attribution does not go with it.
//
// Orders are not created here (nothing in this repo creates a sale.order —
// they arrive from the site and from Odoo's own back office), so attribution
// is applied after the fact, from the ROI screen's tagging list. That is a
// deliberate acceptance: the alternative is to leave the campaign dimension
// permanently empty while waiting for whatever creates the orders to start
// sending UTMs.
//
// Talks to Odoo through odoo.js's `execute` rather than reaching for
// credentials itself, the way server/ops/b2c/serviceWeeks.js does.
import { execute, promisedDayDomain, istDayOf } from '../integrations/odoo.js';

// The channels this business sells through, and how each one maps onto Odoo's
// UTM vocabulary and onto what Google Analytics calls the same traffic.
//
// Edit this table when a channel is added — it is the one place the three
// naming systems are reconciled, and everything downstream reads the mapping
// from here.
//
//   odoo      the x_order_source selection value, exactly as Odoo spells it
//   source    the utm.source record to point campaign_id's neighbour at
//   medium    the utm.medium record; Odoo ships Direct/Email/Phone/Social
//             Media/Website and anything else here gets created on first use
//   ga        substrings matched (case-insensitively) against GA4's
//             sessionSource, so paid and organic Instagram traffic both land
//             on the Instagram row
//   exact     whole-string matches, checked before the substrings. For
//             shorthands too short to be safe as substrings — see 'ig' below
//
// `Website` deliberately declares no utm.source. An order that came in
// through the site has a real source — a post, a search, a link somebody
// shared — and it is GA that knows which; stamping "Website" as the source
// too would assert we know something we do not.
const CHANNELS = [
  // 'ig' is a real source on the live property (17 sessions last month, from
  // links typed by hand) and it belongs to Instagram — but it goes in `exact`
  // and never in `ga`, because 'ig' as a substring is also inside 'swiggy',
  // which quietly reported every Swiggy order's traffic as Instagram until
  // the link builder's preset table made it visible.
  { odoo: 'Instagram', source: 'Instagram', medium: 'Social Media', ga: ['instagram', 'l.instagram'], exact: ['ig'] },
  { odoo: 'Reddit', source: 'Reddit', medium: 'Social Media', ga: ['reddit'] },
  // 'youtu.be' because the share sheet hands out the short domain and GA
  // reports it verbatim, and 'youtu-be' beside it for the same reason
  // Pop-up Event lists both spellings of itself: channelFor() slugs before it
  // matches, which turns the dot into a hyphen. Both are unambiguously this
  // channel. Safe as substrings — none of them appears inside another source
  // we see. 'yt' goes in `exact` on the 'ig' rule: too short to be safe as a
  // substring.
  { odoo: 'YouTube', source: 'YouTube', medium: 'Social Media', ga: ['youtube', 'youtu.be', 'youtu-be'], exact: ['yt'] },
  { odoo: 'WhatsApp', source: 'WhatsApp', medium: 'Phone', ga: ['whatsapp', 'wa.me'], exact: ['wa'] },
  { odoo: 'Website', source: '', medium: 'Website', ga: ['google', 'bing', 'direct', '(direct)', 'duckduckgo', '(none)'] },
  { odoo: 'Swiggy', source: 'Swiggy', medium: 'Marketplace', ga: ['swiggy'] },
  { odoo: 'Zomato', source: 'Zomato', medium: 'Marketplace', ga: ['zomato'] },
  { odoo: 'Friends & Family', source: 'Referral', medium: 'Direct', ga: [] },
  { odoo: 'B2B', source: 'Referral', medium: 'Phone', ga: [] },
  { odoo: 'Catering', source: 'Referral', medium: 'Direct', ga: [] },
  // 'pop-up' and 'popup' both listed because the QR codes built on the link
  // builder screen use the slug form (utm_source=popup-banner) and a hand-
  // typed link uses the hyphenated one. Both are unambiguously this channel;
  // Referral below deliberately gets no patterns, because three channels
  // share that source and a match would have to guess which.
  { odoo: 'Pop-up Event', source: 'Pop-up Event', medium: 'Event', ga: ['pop-up', 'popup'] },
];

// The label a channel-less order rolls up under. A real bucket with a name,
// shown next to the others on the screen rather than dropped: 17 of the last
// 41 orders were in it, and a screen that hid that would be claiming a
// precision it hasn't got.
const UNATTRIBUTED = 'Unattributed';

// Only states where the money is real. A draft quotation is a hope and a
// cancelled one is nothing; counting either as revenue generated by a
// campaign would flatter every channel somebody typed a quotation into.
const REVENUE_STATES = ['sale', 'done'];

// The Studio fields this module touches, resolved once against the live
// database. undefined = not looked yet.
//
// Nothing here is hardcoded, for the reason odoo.js's resolveFulfilmentField
// gives: a Studio field's technical name changes when somebody renames it in
// the UI, and every one of these is a Studio field. Naming them in a
// search_read that has not checked would fail the whole read with Odoo's
// "Invalid field" — so the field list is built from what is actually there.
//
// The native UTM three (campaign_id / source_id / medium_id) are NOT in here.
// Those ship with Odoo's utm module, which is a dependency of sale, so they
// are always present.
let fieldsCache;

// The free-text UTM columns the website drops whatever was in the URL into.
// Checked for existence rather than assumed: they are the ones most likely to
// have been renamed or never created, and they are a convenience rather than
// something the screen depends on.
const UTM_CHAR_FIELDS = ['x_utm_source', 'x_utm_campaign', 'x_utm_content'];

async function resolveFields() {
  if (fieldsCache !== undefined) return fieldsCache;

  const pinned = (process.env.ODOO_ORDER_SOURCE_FIELD || '').trim();
  const fields = await execute('sale.order', 'fields_get', [[], ['type', 'string', 'selection']]);

  let channel = null;
  if (pinned) {
    channel = fields[pinned] ? { name: pinned, meta: fields[pinned] } : null;
    if (!channel) {
      console.error(`ODOO_ORDER_SOURCE_FIELD is set to "${pinned}" but sale.order has no such field — ignoring it.`);
    }
  } else {
    // A custom selection field reading as "order source". Matched on label as
    // well as technical name, since Studio derives one from the other and
    // either can be the one that survived a rename.
    const match = Object.entries(fields).find(
      ([name, meta]) => meta.type === 'selection' && /order.?source/i.test(`${name} ${meta.string || ''}`),
    );
    channel = match ? { name: match[0], meta: match[1] } : null;
  }

  fieldsCache = { channel, utmChars: UTM_CHAR_FIELDS.filter((name) => Boolean(fields[name])) };
  return fieldsCache;
}

async function resolveChannelField() {
  return (await resolveFields()).channel;
}

// The channels Odoo itself offers, read live rather than taken from CHANNELS
// above. The two must not drift, and only one of them is the source of
// truth: someone adding "Food Truck" to the Studio selection must be able to
// tag an order with it and see it on the ROI screen the same day, without
// waiting for this file to be edited. CHANNELS then supplies the UTM and GA
// mapping for the ones it knows, and a new channel simply has none yet.
async function fetchChannelOptions() {
  const field = await resolveChannelField();
  if (!field) return { field: '', channels: [] };

  const declared = (field.meta.selection || []).map(([value, label]) => ({ value, label: label || value }));
  return {
    field: field.name,
    channels: declared.map((option) => {
      const mapped = CHANNELS.find((c) => c.odoo === option.value);
      return { ...option, mapped: Boolean(mapped), medium: mapped?.medium || '', source: mapped?.source || '' };
    }),
  };
}

// GA4 says "instagram", Odoo says "Instagram", and a paid click says
// "l.instagram.com". Resolves any of them to the channel name the rest of
// the app uses; unrecognised traffic comes back as '' so the caller can show
// it as its own row rather than fold it into a channel by guesswork.
function channelFromGaSource(gaSource) {
  const needle = String(gaSource || '').toLowerCase().trim();
  if (!needle) return '';
  // Exact matches first, and they are a separate list from `ga` for a
  // specific reason: the shorthands people actually type into a link are too
  // short to match as substrings. GA reports a real source called 'ig' (17
  // sessions on the live property), and 'ig' as a substring pattern would
  // also claim every 'swiggy' session. Whole-string equality claims 'ig' and
  // nothing else.
  const alias = CHANNELS.find((channel) => (channel.exact || []).includes(needle));
  if (alias) return alias.odoo;
  const hit = CHANNELS.find((channel) => channel.ga.some((pattern) => needle.includes(pattern)));
  return hit ? hit.odoo : '';
}

// One order, as the ROI screen and the tagging list both want it.
//
// `campaign` prefers Odoo's real campaign_id over the free-text
// x_utm_campaign: the many2one is the one Odoo's own reporting groups by, and
// the char field is where a website hand-off drops whatever was in the URL.
// Taking the structured value first means an order tagged from this app
// reads back identically to one tagged in Odoo, and the char field remains a
// usable fallback for orders the site stamped before anybody tagged them.
function shapeOrder(order, channelField) {
  const channel = (channelField && order[channelField]) || '';
  const campaign = (order.campaign_id && order.campaign_id[1]) || order.x_utm_campaign || '';

  return {
    id: order.id,
    name: order.name,
    orderedOn: order.date_order || '',
    // The IST day of the weekend slot the order is for (Expected Date), or the
    // ordering day when none was set. Spending vs Sales buckets by this.
    promisedDay: istDayOf(order.commitment_date || order.date_order) || '',
    state: order.state,
    // Whether this order's money counts toward a channel's return. Carried
    // per-order rather than filtered out here, because the tagging list wants
    // to show a draft quotation too — it is about to become revenue, and
    // tagging it now is cheaper than remembering to come back.
    countsAsRevenue: REVENUE_STATES.includes(order.state),
    amount: order.amount_total || 0,
    customer: (order.partner_id && order.partner_id[1]) || '',
    channel,
    campaign,
    utmSource: (order.source_id && order.source_id[1]) || order.x_utm_source || '',
    utmMedium: (order.medium_id && order.medium_id[1]) || '',
    // The raw URL tags, exactly as the site stamped them and with no
    // many2one preferred over them. `campaign` and `utmSource` above are
    // best-available values for the channel tables; this is the separate
    // question of what the link itself said, which is the only thing the UTM
    // breakdown is entitled to count. Keeping them apart means a hand-tagged
    // order cannot appear in that breakdown as though a link had brought it.
    utm: {
      source: order.x_utm_source || '',
      campaign: order.x_utm_campaign || '',
      content: order.x_utm_content || '',
    },
    // True when Odoo's native UTM fields are filled in, as opposed to only
    // the Studio selection. Shown on the tagging list so it is visible which
    // orders are legible to Odoo's own reporting and which are ours alone.
    utmWired: Boolean(order.campaign_id || order.source_id || order.medium_id),
  };
}

// `dateBy: 'promised'` ranges on the weekend slot the order is for instead of
// the day it was placed — what Spending vs Sales wants, now that orders are
// taken upfront for later weekends. Marketing ROI keeps the default: a
// campaign is judged by the orders it prompted that week, whenever they eat.
async function fetchAttributedOrders({ fromDate, toDate, dateBy = 'ordered' }) {
  if (!fromDate || !toDate) {
    const err = new Error('A from and to date are both required.');
    err.status = 400;
    throw err;
  }

  const { channel: field, utmChars } = await resolveFields();
  const channelField = field?.name || '';

  const fields = [
    'name',
    'date_order',
    'commitment_date',
    'state',
    'amount_total',
    'partner_id',
    'campaign_id',
    'source_id',
    'medium_id',
    ...utmChars,
    ...(channelField ? [channelField] : []),
  ];

  // `< toDate + 1 day` rather than `<= toDate`, because date_order is a
  // datetime: an order placed at 19:00 on the last day of the range is
  // greater than "2026-09-03" as a string and would drop out. Same boundary
  // handling as fetchWeekendOrders in odoo.js.
  const toBound = new Date(`${toDate}T00:00:00Z`);
  toBound.setUTCDate(toBound.getUTCDate() + 1);

  const orders = await execute('sale.order', 'search_read', [
    dateBy === 'promised'
      ? [['state', '!=', 'cancel'], ...promisedDayDomain(fromDate, toDate)]
      : [
          ['date_order', '>=', `${fromDate} 00:00:00`],
          ['date_order', '<', `${toBound.toISOString().slice(0, 10)} 00:00:00`],
          ['state', '!=', 'cancel'],
        ],
    fields,
  ]);

  return {
    channelField,
    // Which of the x_utm_* columns actually exist on this database. Reported
    // rather than assumed so the UTM breakdown can tell "no order carried a
    // tag" apart from "the column the site writes into isn't there" — two
    // empty tables that need opposite things done about them.
    utmFields: utmChars,
    orders: orders.map((order) => shapeOrder(order, channelField)).sort((a, b) => b.orderedOn.localeCompare(a.orderedOn)),
  };
}

// Find-or-create against one of Odoo's UTM models. Sequential by nature —
// two of these in flight for the same name would both miss and both create,
// which is why setOrderAttribution below awaits them one at a time rather
// than Promise.all-ing the three.
async function findOrCreateUtm(model, name) {
  if (!name) return null;
  const found = await execute(model, 'search_read', [[['name', '=', name]], ['id']], { limit: 1 });
  if (found.length) return found[0].id;
  return execute(model, 'create', [{ name }]);
}

// Stamps a channel and (optionally) a campaign onto one order.
//
// The write covers both vocabularies at once, which is the whole point:
//
//   x_order_source   the Studio selection, which is what the kitchen sees on
//                    the order form and what this app groups revenue by
//   campaign_id      Odoo's utm.campaign, created on first use by name
//   source_id        utm.source, derived from the channel via CHANNELS
//   medium_id        utm.medium, likewise
//   x_utm_campaign   the char field, kept in step so the two never disagree
//
// Passing an empty campaign clears campaign_id rather than leaving a stale
// one behind — retagging an order off a campaign has to actually remove it
// from that campaign's return, or the number only ever grows.
async function setOrderAttribution({ orderId, channel, campaign }) {
  const id = Number(orderId);
  if (!id) {
    const err = new Error('An order id is required.');
    err.status = 400;
    throw err;
  }

  const { channel: field, utmChars } = await resolveFields();
  const wanted = String(channel || '').trim();
  const campaignName = String(campaign || '').trim();

  // Validated against Odoo's own selection, not against CHANNELS: the
  // selection is the source of truth (see fetchChannelOptions), and a write
  // of a value outside it would be rejected by Odoo anyway — with a message
  // about a field nobody on this screen has heard of.
  if (wanted && field) {
    const allowed = (field.meta.selection || []).map(([value]) => value);
    if (!allowed.includes(wanted)) {
      const err = new Error(`"${wanted}" is not one of Odoo's order sources (${allowed.join(', ')}).`);
      err.status = 400;
      throw err;
    }
  }

  const patch = {};
  if (field) patch[field.name] = wanted || false;

  const mapped = CHANNELS.find((c) => c.odoo === wanted);
  // Sequentially, and only for the ids that are actually needed — see the
  // note on findOrCreateUtm.
  patch.campaign_id = campaignName ? await findOrCreateUtm('utm.campaign', campaignName) : false;
  patch.source_id = mapped?.source ? await findOrCreateUtm('utm.source', mapped.source) : false;
  patch.medium_id = mapped?.medium ? await findOrCreateUtm('utm.medium', mapped.medium) : false;
  // Only if this database actually has the char field — see resolveFields.
  if (utmChars.includes('x_utm_campaign')) patch.x_utm_campaign = campaignName || false;

  await execute('sale.order', 'write', [[id], patch]);

  const [after] = await execute('sale.order', 'read', [
    [id],
    [
      'name',
      'date_order',
      'state',
      'amount_total',
      'partner_id',
      'campaign_id',
      'source_id',
      'medium_id',
      ...utmChars,
      ...(field ? [field.name] : []),
    ],
  ]);

  return shapeOrder(after, field?.name || '');
}

// Fills in Odoo's native UTM fields for orders that already carry a channel
// on the Studio selection but nothing Odoo's own reporting can group by —
// which, on the database this was written against, was all of them.
//
// Idempotent and additive: an order whose campaign_id is already set is left
// alone entirely, so running this twice changes nothing the second time and
// it can never overwrite a campaign somebody chose deliberately. It also
// never invents a campaign — there is no campaign to infer from a channel —
// so it fills source and medium only, and campaign stays a decision a person
// makes on the tagging list.
async function backfillUtmFromChannel({ fromDate, toDate }) {
  const { orders, channelField } = await fetchAttributedOrders({ fromDate, toDate });
  if (!channelField) {
    return { field: '', updated: 0, skipped: orders.length, reason: 'This Odoo database has no Order Source field.' };
  }

  const todo = orders.filter((order) => order.channel && !order.utmWired);
  let updated = 0;
  const unmapped = new Set();

  for (const order of todo) {
    const mapped = CHANNELS.find((c) => c.odoo === order.channel);
    // A channel added to Odoo's selection but not yet to CHANNELS has no UTM
    // vocabulary to write. Named in the result rather than skipped in
    // silence, since the fix is a two-line edit to the table above.
    if (!mapped || (!mapped.source && !mapped.medium)) {
      if (!mapped) unmapped.add(order.channel);
      continue;
    }
    const patch = {};
    if (mapped.source) patch.source_id = await findOrCreateUtm('utm.source', mapped.source);
    if (mapped.medium) patch.medium_id = await findOrCreateUtm('utm.medium', mapped.medium);
    await execute('sale.order', 'write', [[order.id], patch]);
    updated += 1;
  }

  return {
    field: channelField,
    updated,
    considered: todo.length,
    // Orders with no channel at all, which no backfill can help — they need
    // a person on the tagging list.
    unattributed: orders.filter((order) => !order.channel).length,
    unmappedChannels: [...unmapped],
  };
}

export {
  CHANNELS,
  resolveFields,
  UNATTRIBUTED,
  REVENUE_STATES,
  resolveChannelField,
  fetchChannelOptions,
  channelFromGaSource,
  fetchAttributedOrders,
  setOrderAttribution,
  backfillUtmFromChannel,
};
