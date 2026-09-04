// The tracked-link builder, and the one property that makes it worth having.
//
// A link built here is published — into a bio, a printed sticker, a Reddit
// post — and then it is out of our hands. If its utm_source is one the ROI
// screen cannot resolve to a channel, nothing fails: the clicks arrive, GA4
// records them under a source nobody recognises, and the revenue reports as
// unattributed for as long as the link is in the world. That is the failure
// this file exists to catch before a printer does.
//
// Hence the round-trip test below: every preset the screen offers is fed
// through orderAttribution's channelFromGaSource — the same function GA4
// traffic goes through on the ROI screen — and the channel presets must come
// back mapped. A source added to the preset list that GA cannot resolve
// fails here rather than a month later.
//
// The rest is the URL builder, which is pure, and the store, which is an
// upsert on the placement key.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb();

const {
  buildTrackedUrl,
  slug,
  listPresets,
  listSourceDetails,
  listLinks,
  listCampaigns,
  saveLink,
  saveLinks,
  deleteLink,
  channelFor,
} = await import('./trackedLinks.js');
const { run } = await import('../core/db.js');

beforeEach(() => {
  run('DELETE FROM marketing_link');
});

afterAll(() => removeTestDb(dir));

const DEST = 'https://smokeringsbbq.in/order';

describe('slug', () => {
  it('lowercases and hyphenates, so one campaign stays one row on the ROI screen', () => {
    expect(slug('Weekend Brisket')).toBe('weekend-brisket');
    expect(slug('weekend brisket')).toBe('weekend-brisket');
  });

  it('strips punctuation and edge hyphens rather than passing them into the URL', () => {
    expect(slug("Adarsh's  pop-up! ")).toBe('adarsh-s-pop-up');
    expect(slug('  --diwali--  ')).toBe('diwali');
  });

  it('treats nothing-at-all as empty rather than as the string "undefined"', () => {
    expect(slug(undefined)).toBe('');
    expect(slug(null)).toBe('');
  });
});

describe('buildTrackedUrl', () => {
  it('appends the parameters that were given and none that were not', () => {
    const url = buildTrackedUrl({ destination: DEST, source: 'instagram', medium: 'social', campaign: 'Weekend Brisket' });
    expect(url).toBe('https://smokeringsbbq.in/order?utm_campaign=weekend-brisket&utm_medium=social&utm_source=instagram');
    // Not utm_content= with nothing after it, which GA4 reads as a real
    // (empty) value and reports as a distinct variant.
    expect(url).not.toContain('utm_content');
  });

  it('keeps the query the destination already had', () => {
    const url = buildTrackedUrl({ destination: 'https://smokeringsbbq.in/order?item=brisket', source: 'reddit' });
    expect(url).toContain('item=brisket');
    expect(url).toContain('utm_source=reddit');
  });

  it('replaces a UTM the destination already carried instead of adding a second one', () => {
    // Someone pastes a link they had already tagged. Two utm_source keys in
    // one URL are resolved differently by different platforms, so the value
    // that wins would depend on whose parser read it.
    const url = buildTrackedUrl({ destination: `${DEST}?utm_source=old`, source: 'whatsapp' });
    expect(url).toBe('https://smokeringsbbq.in/order?utm_source=whatsapp');
    expect(url.match(/utm_source/g)).toHaveLength(1);
  });

  it('drops a UTM the destination carried when the new value is blank', () => {
    const url = buildTrackedUrl({ destination: `${DEST}?utm_campaign=stale`, source: 'flyer', campaign: '' });
    expect(url).not.toContain('utm_campaign');
  });

  it('produces the same string whether a parameter came from the destination or the form', () => {
    // The screen shows a batch of these side by side to be checked before
    // anything is printed; two identical links that render differently are
    // a review hazard.
    const a = buildTrackedUrl({ destination: `${DEST}?utm_medium=social`, source: 'instagram', medium: 'social', campaign: 'diwali' });
    const b = buildTrackedUrl({ destination: `${DEST}?utm_campaign=diwali`, source: 'instagram', medium: 'social', campaign: 'diwali' });
    expect(a).toBe(b);
  });

  it('strips a UTM the destination carried that this link does not set', () => {
    // The builder is the sole authority on the published link's tagging: a
    // destination pasted in with last month's utm_campaign still on it must
    // not leak that campaign into this month's link, where it would credit
    // revenue to a campaign that had ended.
    const url = buildTrackedUrl({ destination: `${DEST}?utm_campaign=last-month`, source: 'instagram', medium: 'social' });
    expect(url).not.toContain('last-month');
    expect(url).toBe('https://smokeringsbbq.in/order?utm_medium=social&utm_source=instagram');
  });

  it('refuses a destination that is not a URL, before it reaches a QR code', () => {
    expect(() => buildTrackedUrl({ destination: 'smokeringsbbq.in', source: 'flyer' })).toThrow(/not a URL/);
    expect(() => buildTrackedUrl({ destination: '', source: 'flyer' })).toThrow(/required/);
  });

  it('refuses a scheme that cannot carry UTM parameters at all', () => {
    expect(() => buildTrackedUrl({ destination: 'mailto:hi@smokeringsbbq.in', source: 'flyer' })).toThrow(/http/);
  });
});

describe('the browser copy of the builder', () => {
  // src/pages/marketing/trackedUrl.ts builds the preview the screen shows,
  // because a preview that waits for a round trip lags behind the typing and
  // gets copied mid-update. That makes two implementations of one function,
  // and if they ever disagree the URL somebody copies — or prints into a QR
  // code — is not the URL the library recorded.
  //
  // So: the same cases through both, including the awkward ones. This is the
  // test that says the duplication is still safe.
  const cases = [
    { destination: DEST, source: 'instagram', medium: 'social', campaign: 'Weekend Brisket' },
    { destination: DEST, source: 'Table Tent', medium: 'qr', campaign: 'diwali', content: "Adarsh's stall!" },
    { destination: 'https://smokeringsbbq.in/order?item=brisket#menu', source: 'reddit' },
    { destination: `${DEST}?utm_source=old&utm_campaign=last-month`, source: 'whatsapp', medium: 'phone' },
    { destination: 'http://smokeringsbbq.in:8080/o?a=1&a=2', source: 'flyer', term: 'BBQ Chennai', content: '' },
    { destination: 'https://smokeringsbbq.in/order?utm_content=', source: 'menu-card', medium: 'qr' },
  ];

  it('produces exactly what the server produces', async () => {
    const browser = await import('../../src/pages/marketing/trackedUrl');
    cases.forEach((parts) => {
      expect(browser.buildTrackedUrl(parts), JSON.stringify(parts)).toBe(buildTrackedUrl(parts));
    });
  });

  it('slugs values the same way, so a campaign name means one campaign', async () => {
    const browser = await import('../../src/pages/marketing/trackedUrl');
    ['Weekend Brisket', "Adarsh's  pop-up! ", '  --diwali--  ', 'ONAM 2026', ''].forEach((value) => {
      expect(browser.slug(value), value).toBe(slug(value));
    });
  });

  it('refuses the same destinations the server refuses', async () => {
    const browser = await import('../../src/pages/marketing/trackedUrl');
    ['', 'smokeringsbbq.in', 'mailto:hi@smokeringsbbq.in'].forEach((destination) => {
      expect(() => browser.buildTrackedUrl({ destination, source: 'flyer' }), destination).toThrow();
      expect(() => buildTrackedUrl({ destination, source: 'flyer' }), destination).toThrow();
    });
  });
});

describe('presets', () => {
  const presets = listPresets();

  it('offers the online channels the business actually sells through', () => {
    const sources = presets.filter((p) => p.kind === 'channel').map((p) => p.source);
    expect(sources).toContain('instagram');
    expect(sources).toContain('reddit');
    expect(sources).toContain('whatsapp');
  });

  it('maps every channel a source can be resolved to, and says so per preset', () => {
    // The property this whole file is for. Each preset's declared channel is
    // the one GA4 traffic on that source will actually resolve to on the ROI
    // screen — so a source added here that GA cannot resolve shows up as
    // unmapped on the screen instead of publishing clicks that quietly
    // report as unattributed revenue for as long as the link exists.
    presets.forEach((preset) => {
      expect(channelFor(preset.source), `${preset.source} declares a channel it does not resolve to`).toBe(preset.channel);
    });

    const mapped = Object.fromEntries(presets.map((preset) => [preset.source, preset.channel]));
    expect(mapped.instagram).toBe('Instagram');
    expect(mapped.reddit).toBe('Reddit');
    expect(mapped.whatsapp).toBe('WhatsApp');
    // Swiggy, specifically. GA sources are matched as substrings, and while
    // Instagram's pattern list contained a bare 'ig' every Swiggy source
    // matched it — sw-IG-gy — and reported as Instagram, on this screen and
    // in the ROI channel rollup.
    expect(mapped.swiggy).toBe('Swiggy');
    expect(mapped.zomato).toBe('Zomato');
    // A QR on the standee at an event is a pop-up order, and orderAttribution
    // matches the slug for exactly that reason.
    expect(mapped['popup-banner']).toBe('Pop-up Event');
  });

  it('offers one button per source, not one per channel that shares it', () => {
    // Friends & Family, B2B and Catering all declare the source 'Referral'.
    // Three buttons producing an identical link would be a choice that makes
    // no difference.
    const sources = presets.map((preset) => preset.source);
    expect(new Set(sources).size).toBe(sources.length);

    const referral = presets.find((preset) => preset.source === 'referral');
    expect(referral.hint).toMatch(/Friends & Family/);
    // And it maps to no channel, because no rule can say which of the three
    // a referral click was.
    expect(referral.channel).toBe('');
  });

  it('does not offer Website, which declares no source of its own', () => {
    expect(presets.map((p) => p.source)).not.toContain('website');
  });

  it('offers a poster, which is where most of the printed codes go', () => {
    const poster = presets.find((preset) => preset.source === 'poster');
    expect(poster).toBeTruthy();
    expect(poster.medium).toBe('qr');
  });

  it('files every printed placement under the qr medium', () => {
    const placements = presets.filter((preset) => preset.kind === 'placement');
    expect(placements.length).toBeGreaterThan(0);
    placements.forEach((placement) => expect(placement.medium).toBe('qr'));
  });
});

describe('the placement suggestions', () => {
  // The screen asks a second question once a source is picked — which bit of
  // Instagram, which subreddit, which friend — and these are the answers it
  // offers. The question is per source on purpose: one shared free-text box
  // means something different depending on what is selected, which is what
  // this replaced.
  it('asks a different question of each source', () => {
    const details = listSourceDetails();
    expect(details.instagram.prompt).toMatch(/Instagram/);
    expect(details.reddit.prompt).toMatch(/subreddit/i);
    expect(details.whatsapp.prompt).toMatch(/group|broadcast/i);
    expect(details.referral.prompt).toMatch(/passing it on/i);
  });

  it('seeds the places this business actually publishes', () => {
    const details = listSourceDetails();
    expect(details.instagram.options).toContain('Link in bio');
    expect(details.instagram.options).toContain('Story');
    expect(details.referral.options).toEqual(expect.arrayContaining(['Adarsh', 'Sowmya']));
  });

  it('offers every source a preset exists for, so no tile opens an empty question', () => {
    const details = listSourceDetails();
    listPresets().forEach((preset) => {
      expect(details[preset.source]?.prompt, `${preset.source} has no placement question`).toBeTruthy();
    });
  });

  it('learns the placements that have actually been used', () => {
    // A subreddit or a friend used once should be offered from then on —
    // otherwise the same value gets retyped slightly differently, which is
    // the split-campaign problem again one level down.
    saveLink({ destination: DEST, source: 'reddit', campaign: 'diwali', content: 'Koramangala eats' });
    expect(listSourceDetails().reddit.options).toContain('koramangala-eats');
  });

  it('does not offer a seeded placement twice because it has also been used', () => {
    saveLink({ destination: DEST, source: 'instagram', campaign: 'diwali', content: 'Link in bio' });
    const options = listSourceDetails().instagram.options;
    // The seed is the readable spelling and the stored value is its slug;
    // both build the identical link, so only one of them is offered.
    expect(options.filter((option) => slug(option) === 'link-in-bio')).toHaveLength(1);
    expect(options).toContain('Link in bio');
  });
});

describe('the link library', () => {
  const link = (over) => saveLink({ destination: DEST, source: 'instagram', medium: 'social', campaign: 'diwali', ...over });

  it('saves a link and reads its URL back built, not stored', () => {
    const saved = link({ label: 'IG bio' });
    expect(saved.url).toContain('utm_source=instagram');
    expect(saved.channel).toBe('Instagram');
    expect(listLinks()).toHaveLength(1);
  });

  it('treats the same placement saved twice as one row', () => {
    link({ label: 'first go' });
    const again = link({ label: 'after fixing the typo' });
    expect(listLinks()).toHaveLength(1);
    expect(again.label).toBe('after fixing the typo');
  });

  it('treats a different source as a different link', () => {
    link();
    link({ source: 'reddit' });
    expect(listLinks()).toHaveLength(2);
  });

  it('does not collapse two untagged links into one by accident', () => {
    // Both have no campaign and no content. SQLite counts NULLs as distinct
    // in a plain unique index, which is why the real one is over ifnull().
    saveLink({ destination: DEST, source: 'flyer' });
    saveLink({ destination: DEST, source: 'flyer' });
    expect(listLinks()).toHaveLength(1);
  });

  it('reports a source with no channel behind it as unmapped rather than guessing', () => {
    const saved = saveLink({ destination: DEST, source: 'table-tent', medium: 'qr' });
    expect(saved.channel).toBe('');
  });

  it('requires a source, because a link without one carries nothing', () => {
    expect(() => saveLink({ destination: DEST, source: '' })).toThrow(/utm_source/);
  });

  it('filters by campaign and counts the links each campaign has', () => {
    link();
    link({ source: 'reddit' });
    link({ campaign: 'weekend-brisket', source: 'whatsapp' });

    expect(listLinks({ campaign: 'Diwali' })).toHaveLength(2);
    expect(listCampaigns()).toEqual(
      expect.arrayContaining([
        { campaign: 'diwali', links: 2 },
        { campaign: 'weekend-brisket', links: 1 },
      ]),
    );
  });

  it('saves a batch whole, or not at all', () => {
    // A half-saved batch is worse than a failed one: the sources that landed
    // are then indistinguishable from the sources somebody chose not to
    // publish, and the library stops being a record of what went out.
    expect(() =>
      saveLinks([
        { destination: DEST, source: 'instagram', campaign: 'diwali' },
        { destination: 'not-a-url', source: 'reddit', campaign: 'diwali' },
      ]),
    ).toThrow(/not a URL/);
    expect(listLinks()).toHaveLength(0);

    expect(
      saveLinks([
        { destination: DEST, source: 'instagram', campaign: 'diwali' },
        { destination: DEST, source: 'reddit', campaign: 'diwali' },
      ]),
    ).toHaveLength(2);
  });

  it('deletes a link, without pretending that unprints anything', () => {
    const saved = link();
    expect(deleteLink(saved.id)).toEqual({ deleted: saved.id });
    expect(listLinks()).toHaveLength(0);
  });
});
