// Tracked links and the QR codes that carry them: the missing top of the
// funnel.
//
// server/marketing/orderAttribution.js opens with the problem this file is
// the other half of. Across six months of orders, Odoo's campaign_id /
// source_id / medium_id were unset on every single one, and the tagging list
// on the ROI screen closes that gap by hand, after the fact, one order at a
// time. That works, and it is the only thing that can work for an order that
// arrived by WhatsApp — but for an order that arrived through a link we
// published ourselves, tagging it later is repairing damage we caused: the
// attribution was knowable at the moment somebody clicked, and we threw it
// away by publishing a bare URL.
//
// So this module builds the links instead. One destination, one campaign,
// and a utm_source per place the link is going — the Instagram bio, the
// Reddit post, the WhatsApp broadcast, the QR on a table tent — so the click
// arrives already carrying which of those it came from, and GA4 and Odoo's
// utm fields both see it without anybody typing anything.
//
// Two rules shape the code below, and both exist so this screen cannot
// quietly poison the ROI screen downstream:
//
//   * A source is a slug, and the slug must map back. Every preset's
//     utm_source is fed through orderAttribution's channelFromGaSource and
//     has to resolve to a real channel, or it is reported as unmapped rather
//     than presented as though the revenue will find its way home.
//     trackedLinks.test.js asserts that round trip for every preset, so a
//     preset added here that GA cannot resolve fails a test rather than
//     producing links that quietly report as unattributed for a month.
//
//   * UTM params are replaced, never appended. A destination that already
//     carries ?utm_source= (someone pasted a link they had already tagged)
//     gets that value overwritten rather than a second copy added —
//     duplicate query keys are resolved differently by different platforms,
//     and the one thing worse than no attribution is attribution that
//     depends on whose parser read the URL.
//
// The links are kept in SQLite rather than generated and forgotten, because
// a printed QR code cannot be edited. Once a sticker is on a box, the row in
// marketing_link is the only record of what that code points at, and
// deleting the row does not stop people scanning the sticker.
import { insert, nextId, remove, select, selectOne, transaction, update } from '../core/repo.js';
import { CHANNELS, channelFromGaSource } from './orderAttribution.js';

const TABLE = 'marketing_link';

// The five UTM parameters, in the order Google's own documentation lists
// them. Source and medium are the pair GA4 builds its channel groupings
// from; campaign is what the ROI screen's campaign table groups by; content
// and term are free.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Where a link can go beyond the online channels CHANNELS already knows
// about. These are the QR half of the screen: a code printed on something
// physical, where there is no referrer at all and utm_source is the only
// thing that will ever say where the scan came from.
//
// The medium is 'qr' throughout, deliberately. It is the one fact they have
// in common and the one that makes them separable in GA4 — "everything that
// arrived because someone pointed a camera at us" is a real question with a
// real answer, and it stops being answerable if a flyer scan and an
// Instagram tap share a medium.
const PLACEMENTS = [
  { source: 'poster', label: 'Poster', hint: 'Put up on a wall, a noticeboard, a gym, a lift lobby' },
  { source: 'table-tent', label: 'Table tent', hint: 'Card on the table at a pop-up' },
  { source: 'flyer', label: 'Flyer / leaflet', hint: 'Handed out, or left on a counter' },
  { source: 'packaging', label: 'Packaging sticker', hint: 'On the box a delivered order arrives in' },
  { source: 'menu-card', label: 'Menu card', hint: 'The printed menu at a stall' },
  { source: 'popup-banner', label: 'Pop-up banner', hint: 'The standee at an event' },
  { source: 'business-card', label: 'Business card', hint: 'Handed to a caterer or a venue' },
];

// What to put in utm_content, per source — the second half of the question
// the screen asks.
//
// utm_source alone answers "Instagram", and that is not the answer anybody
// actually wants: a link in the bio, a link in a story and a link pasted into
// a DM are three different pieces of work with three different costs, and
// they report as one row until something separates them. utm_content is the
// parameter for exactly that — the variant within a source — so the screen
// asks for it per source rather than as one free-text box that means
// something different depending on which source is selected.
//
// These are seeds, not a closed list. listSourceDetails merges them with the
// utm_content values already used for that source in the library, so a
// subreddit or a friend used once is offered from then on and the list grows
// into the way the business actually publishes. Anything not offered can
// still be typed.
const SOURCE_DETAILS = {
  instagram: { prompt: 'Where on Instagram?', examples: ['Link in bio', 'Story', 'DM', 'Post caption', 'Reel'] },
  reddit: { prompt: 'Which subreddit or thread?', examples: ['Indiranagar group', 'Bangalore foodies', 'r/bangalore'] },
  whatsapp: {
    prompt: 'Which group or broadcast?',
    examples: ['Whats cooking Bangalore', 'WhatsApp community', 'Broadcast list', 'One-to-one'],
  },
  // 'referral' is the source Friends & Family, B2B and Catering all share —
  // see listPresets. Who is handing the link out is the only thing that
  // separates them, and it is the thing worth knowing.
  referral: { prompt: 'Who is passing it on?', examples: ['Adarsh', 'Sowmya'] },
  poster: { prompt: 'Which poster, and where?', examples: ['Indiranagar', 'Koramangala', 'Office noticeboard'] },
  'popup-banner': { prompt: 'Which event?', examples: [] },
  flyer: { prompt: 'Handed out where?', examples: [] },
  packaging: { prompt: 'On which box?', examples: [] },
  'table-tent': { prompt: 'At which pop-up?', examples: [] },
  'menu-card': { prompt: 'At which stall?', examples: [] },
  'business-card': { prompt: 'Given to whom?', examples: [] },
};

const DEFAULT_DETAIL_PROMPT = 'Which one, specifically?';

// The detail suggestions the screen offers, per source: the seeds above plus
// every utm_content already published under that source, newest first.
//
// Every source the screen can offer gets an entry, including the ones with no
// seeds — Swiggy, Zomato, anything added later to CHANNELS. A source with an
// entry and no options still asks its question and still takes a typed
// answer; a source with no entry at all would need the screen to invent a
// fallback, which is one more place for the two to disagree.
//
// The stored values are slugs, so a seed and a used value can be the same
// thing written two ways ('Link in bio' and 'link-in-bio'). They are matched
// on the slug and the seed wins, because the seed is the readable one and
// both produce an identical link.
function listSourceDetails() {
  const used = new Map();
  select(TABLE, {}, { orderBy: 'created_at desc' }).forEach((row) => {
    if (!row.utm_content) return;
    const list = used.get(row.utm_source) || [];
    if (!list.includes(row.utm_content)) list.push(row.utm_content);
    used.set(row.utm_source, list);
  });

  const details = {};
  new Set([
    ...listPresets().map((preset) => preset.source),
    ...Object.keys(SOURCE_DETAILS),
    ...used.keys(),
  ]).forEach((source) => {
    const seen = new Set();
    const options = [];
    [...(SOURCE_DETAILS[source]?.examples || []), ...(used.get(source) || [])].forEach((value) => {
      const key = slug(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      options.push(value);
    });
    details[source] = { prompt: SOURCE_DETAILS[source]?.prompt || DEFAULT_DETAIL_PROMPT, options };
  });
  return details;
}

// The mediums the screen suggests. Not a CHECK in the schema and not
// validated against: GA4 accepts any string, and a medium we have not
// thought of is a worse failure than a medium we have not blessed.
const MEDIUMS = ['social', 'qr', 'referral', 'email', 'cpc', 'organic', 'affiliate', 'print'];

// UTM values are lowercase-hyphen by convention, and the convention is worth
// enforcing rather than trusting: GA4 treats Instagram and instagram as two
// different sources, and a campaign typed "Weekend Brisket" once and
// "weekend brisket" the next week splits its own revenue across two rows on
// the ROI screen. Normalising here means that cannot happen, at the cost of
// a value that does not read back exactly as it was typed.
function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The destination, checked to the extent that a bad one is caught here
// rather than by whoever scans the QR code.
//
// http(s) only: a QR containing a mailto: or a tel: is a legitimate thing to
// want, but it cannot carry UTM parameters, so it is not a tracked link and
// this screen would be lying to offer one.
function parseDestination(destination) {
  const raw = String(destination || '').trim();
  if (!raw) throw badRequest('A destination URL is required — the link has to point somewhere.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`"${raw}" is not a URL. It needs the https:// on the front.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badRequest('The destination has to be an http or https URL — UTM parameters cannot ride on anything else.');
  }
  return url;
}

// destination + the UTM parameters = the link that actually gets published.
//
// Exported and pure, because it is the one piece of this file the screen,
// the store and the tests all have to agree on: what the preview shows has
// to be byte-for-byte what gets saved and what gets drawn into the QR code,
// or the printed sticker points somewhere the ROI screen is not counting.
//
// An absent or empty value deletes its parameter rather than writing an
// empty one, and deletes it from the destination too. Two things follow, both
// wanted: `utm_content=` never appears (in GA4's eyes the empty string is a
// real value, and a link with no content would report differently from a link
// with none), and this function is the sole authority on what UTM parameters
// the published link carries — whatever was already on the destination is
// replaced wholesale rather than partly inherited. A destination that arrives
// with a stale utm_campaign from last month's post cannot leak it into this
// month's link.
function buildTrackedUrl({ destination, source, medium, campaign, content, term }) {
  const url = parseDestination(destination);
  const values = {
    utm_source: slug(source),
    utm_medium: slug(medium),
    utm_campaign: slug(campaign),
    utm_content: slug(content),
    utm_term: slug(term),
  };

  UTM_KEYS.forEach((key) => {
    if (values[key]) url.searchParams.set(key, values[key]);
    else url.searchParams.delete(key);
  });

  // Sorted, so the same inputs always produce the same string. Without it
  // the order depends on which params the destination already carried, and
  // two links that are the same link stop looking the same — which matters
  // when the screen is showing eight of them side by side to be checked
  // before anything goes to a printer.
  url.searchParams.sort();
  return url.toString();
}

// What this link's traffic will roll up to on the ROI screen, worked out the
// same way GA4 traffic is: through channelFromGaSource. '' means the source
// resolves to no channel, and the screen says so — the link still works and
// the clicks are still tracked, but revenue from it lands in the
// unattributed row until someone tags those orders by hand or adds the
// source to CHANNELS.
function channelFor(source) {
  return channelFromGaSource(slug(source));
}

// The source buttons the screen offers: the online channels we actually sell
// through, then the physical places a QR code goes.
//
// The online half is generated from CHANNELS rather than listed again here.
// That is the point — a channel added to orderAttribution.js shows up on
// this screen the same day, already mapped, and a source offered here can
// never be one the ROI screen has never heard of.
//
// Website is skipped: it declares no utm.source, for the reason given in
// CHANNELS (an order through the site has a real source and it is GA that
// knows which), so a link tagged utm_source=website would assert exactly
// what that comment refuses to assert.
// One preset per utm_source, not one per channel. Three of CHANNELS'
// entries — Friends & Family, B2B and Catering — all declare the source
// 'Referral', and offering the same source three times under three names
// would present a choice that makes no difference to the link. They collapse
// into one button whose hint names the channels behind it.
//
// A collapsed source also, necessarily, maps to no channel: channelFromGaSource
// cannot say which of the three a referral click was, so it says nothing.
// That is reported rather than resolved — see the `channel: ''` case on the
// screen — because picking one would be inventing attribution, which is the
// failure mode the ROI screen was built to avoid.
function listPresets() {
  const bySource = new Map();
  CHANNELS.filter((channel) => channel.source).forEach((channel) => {
    const source = slug(channel.source);
    const seen = bySource.get(source);
    if (seen) {
      seen.sharedBy.push(channel.odoo);
      // Two channels behind one source: the button stops being named after
      // either of them.
      seen.label = channel.source;
      seen.hint = `Used by ${seen.sharedBy.join(', ')}`;
      return;
    }
    bySource.set(source, {
      kind: 'channel',
      source,
      label: channel.odoo,
      // The medium Odoo files this channel under, lowered into UTM
      // vocabulary: 'Social Media' is what utm.medium calls it and 'social'
      // is what GA4 calls the same thing.
      medium: slug(channel.medium) === 'social-media' ? 'social' : slug(channel.medium),
      channel: channelFor(source),
      hint: '',
      sharedBy: [channel.odoo],
    });
  });

  const channels = [...bySource.values()].map(({ sharedBy, ...preset }) => preset);

  const placements = PLACEMENTS.map((placement) => ({
    kind: 'placement',
    source: placement.source,
    label: placement.label,
    medium: 'qr',
    channel: channelFor(placement.source),
    hint: placement.hint,
  }));

  return [...channels, ...placements];
}

function shapeRow(row) {
  const link = {
    id: row.link_id,
    label: row.label || '',
    destination: row.destination,
    source: row.utm_source,
    medium: row.utm_medium || '',
    campaign: row.utm_campaign || '',
    content: row.utm_content || '',
    term: row.utm_term || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return {
    ...link,
    // Rebuilt on every read rather than stored beside the parts. The URL is
    // derived data, and a stored copy is the version that goes wrong after
    // any fix to buildTrackedUrl — silently, and on exactly the rows old
    // enough to have been printed.
    url: buildTrackedUrl(link),
    channel: channelFor(row.utm_source),
  };
}

function listLinks({ campaign } = {}) {
  const where = {};
  const wanted = slug(campaign);
  if (wanted) where.utm_campaign = wanted;
  return select(TABLE, where, { orderBy: 'created_at desc, utm_source' }).map(shapeRow);
}

// The campaigns this screen has built links for, with how many each has.
// Offered back as suggestions so the second link for a campaign is picked
// from a list rather than retyped — the ROI screen groups by campaign name,
// and a name that differs by one character is a second campaign there.
function listCampaigns() {
  const counts = new Map();
  select(TABLE, {}, { orderBy: 'created_at desc' }).forEach((row) => {
    if (!row.utm_campaign) return;
    counts.set(row.utm_campaign, (counts.get(row.utm_campaign) || 0) + 1);
  });
  return [...counts.entries()].map(([campaign, links]) => ({ campaign, links }));
}

function validate({ destination, source }) {
  parseDestination(destination);
  if (!slug(source)) {
    throw badRequest('A utm_source is required — it is the only part of the link that says where the click came from.');
  }
}

function saveLink({ label, destination, source, medium, campaign, content, term, notes }) {
  validate({ destination, source });

  const row = {
    label: String(label || '').trim() || null,
    destination: String(destination).trim(),
    utm_source: slug(source),
    utm_medium: slug(medium) || null,
    utm_campaign: slug(campaign) || null,
    utm_content: slug(content) || null,
    utm_term: slug(term) || null,
    notes: String(notes || '').trim() || null,
  };

  // The same link saved twice is the same row, not two. The screen builds a
  // link per source in one batch, and saving that batch again after fixing a
  // typo in one of them is the normal way this gets used — without this the
  // library fills with near-duplicates and the campaign counts above stop
  // meaning anything. Matched on the four parts that identify a placement;
  // the label, term and notes are then refreshed onto the existing row.
  const existing = selectOne(TABLE, {
    destination: row.destination,
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_content: row.utm_content,
  });

  if (existing) {
    update(
      TABLE,
      { link_id: existing.link_id },
      {
        label: row.label,
        utm_term: row.utm_term,
        notes: row.notes,
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      },
      { required: true },
    );
    return shapeRow(selectOne(TABLE, { link_id: existing.link_id }));
  }

  const id = nextId(TABLE, 'link_id', 'MKL');
  insert(TABLE, { link_id: id, ...row });
  return shapeRow(selectOne(TABLE, { link_id: id }));
}

// A whole batch, or none of it.
//
// The screen builds one link per source for a campaign and saves them
// together, and a batch that half-lands is worse than one that fails: the
// sources that saved are indistinguishable from the sources somebody chose
// not to publish, so the library stops being a record of what went out. One
// transaction, and every row validated before any of them is written, so the
// failure is reported against the row that caused it with nothing changed.
function saveLinks(links) {
  const batch = Array.isArray(links) ? links : [links];
  if (!batch.length) return [];
  batch.forEach(validate);
  return transaction(() => batch.map(saveLink));
}

function deleteLink(id) {
  remove(TABLE, { link_id: id }, { required: true });
  return { deleted: id };
}

export {
  UTM_KEYS,
  MEDIUMS,
  PLACEMENTS,
  SOURCE_DETAILS,
  listSourceDetails,
  slug,
  buildTrackedUrl,
  channelFor,
  listPresets,
  listLinks,
  listCampaigns,
  saveLink,
  saveLinks,
  deleteLink,
};
