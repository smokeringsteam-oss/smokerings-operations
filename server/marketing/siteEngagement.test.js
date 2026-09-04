// buildEngagement, the join behind the Site funnel tab.
//
// Only the pure half of siteEngagement.js is exercised here. The fetching
// half needs a live GA4 property and a service account, which no test can
// stand up honestly; the arithmetic and the ordering rules are testable, and
// they are exactly where a funnel goes quietly wrong — a percentage on the
// wrong denominator reads as a finding and is not one.
//
// The cases below are the ones that would ship a lie:
//
//   * a step is measured against the top of the funnel AND against the step
//     above it, because those are different questions and swapping them
//     sends somebody to fix the wrong screen;
//   * a step that came out larger than the one above it is flagged rather
//     than clamped, because that is the only case the funnel had something
//     unusual to say about;
//   * a step GA never reported reads as untracked, not as nobody-did-it;
//   * the scroll ladder's denominator is the people who scrolled, not the
//     people who visited; and
//   * sections come back in page order, with an unknown section shown last
//     rather than dropped.
import { describe, it, expect } from 'vitest';
import { buildEngagement, ladder, PAGE_SECTIONS } from './siteEngagement.js';

// What fetchEventReach returns, shaped like the live property: view_item
// fires many times per person, purchase once.
const EVENTS = [
  { event: 'session_start', users: 220, events: 352, sessions: 352 },
  { event: 'view_item_list', users: 116, events: 210, sessions: 130 },
  { event: 'view_item', users: 116, events: 1014, sessions: 140 },
  { event: 'add_to_cart', users: 40, events: 87, sessions: 46 },
  { event: 'view_cart', users: 24, events: 35, sessions: 27 },
  { event: 'begin_checkout', users: 11, events: 16, sessions: 13 },
  { event: 'add_payment_info', users: 8, events: 12, sessions: 9 },
  { event: 'checkout_submitted', users: 8, events: 12, sessions: 9 },
  { event: 'purchase', users: 8, events: 10, sessions: 8 },
  { event: 'checkout_abandoned', users: 14, events: 18, sessions: 15 },
  { event: 'scroll', users: 200, events: 436, sessions: 210 },
];

const PAGES = [
  { path: '/order', views: 350, users: 165, sessions: 251, secondsPerUser: 58, engagementRate: 62.5, bounceRate: 37.5 },
  { path: '/', views: 262, users: 109, sessions: 181, secondsPerUser: 36, engagementRate: 65.7, bounceRate: 34.3 },
];

const SCROLL = [
  { depth: 25, users: 96, events: 203, sessions: 131 },
  { depth: 50, users: 94, events: 174, sessions: 128 },
  { depth: 75, users: 89, events: 164, sessions: 121 },
  { depth: 100, users: 69, events: 111, sessions: 91 },
];

const SECTIONS = [
  { section: 'Footer', users: 12, events: 12, sessions: 12 },
  { section: 'Hero', users: 64, events: 127, sessions: 70 },
  { section: 'Menu', users: 25, events: 25, sessions: 25 },
];

const BY_SOURCE = [
  { event: 'session_start', source: 'reddit', users: 40, events: 44, sessions: 44 },
  { event: 'add_to_cart', source: 'reddit', users: 12, events: 15, sessions: 13 },
  { event: 'purchase', source: 'reddit', users: 3, events: 3, sessions: 3 },
  { event: 'session_start', source: '(direct)', users: 161, events: 197, sessions: 197 },
  { event: 'add_to_cart', source: '(direct)', users: 27, events: 55, sessions: 32 },
  { event: 'purchase', source: '(direct)', users: 5, events: 7, sessions: 6 },
];

const build = (over = {}) =>
  buildEngagement({ events: EVENTS, scroll: SCROLL, sections: SECTIONS, pages: PAGES, ctas: [], bySource: BY_SOURCE, ...over });

describe('the ordering funnel', () => {
  it('measures each step against the top and against the step above it', () => {
    const { funnel } = build();
    const step = (key) => funnel.find((row) => row.key === key);

    // The page step, joined from the pages report rather than from an event.
    expect(step('orderPage').users).toBe(165);
    expect(step('orderPage').from).toBe('page');
    expect(step('orderPage').measure).toBe('/order');

    // 40 of 220 who arrived is 18.18%; 40 of the 116 who opened an item is
    // 34.48%. Both are printed, and reading either as the other is the
    // mistake this test exists to prevent.
    expect(step('addedToCart').shareOfTop).toBe(18.18);
    expect(step('addedToCart').shareOfPrevious).toBe(34.48);
    expect(step('addedToCart').lost).toBe(76);
    expect(step('addedToCart').previousLabel).toBe('Opened an item');

    // The first step is the denominator, so it is 100% of itself and has no
    // step above it to be a share of.
    expect(funnel[0].shareOfTop).toBe(100);
    expect(funnel[0].shareOfPrevious).toBeNull();
  });

  it('flags a step that grew rather than clamping it', () => {
    // A restored cart: somebody adds to it without opening an item first.
    // Not sequenced data, so this is legitimate and must survive.
    const { funnel } = build({
      events: EVENTS.map((row) => (row.event === 'add_to_cart' ? { ...row, users: 130 } : row)),
    });
    const carted = funnel.find((row) => row.key === 'addedToCart');

    expect(carted.users).toBe(130);
    expect(carted.grew).toBe(true);
    // Never negative — a step that grew lost nobody.
    expect(carted.lost).toBe(0);
  });

  it('separates a step GA never reported from a step nobody took', () => {
    const { funnel } = build({ events: EVENTS.filter((row) => row.event !== 'view_cart') });
    const cart = funnel.find((row) => row.key === 'openedCart');

    expect(cart.users).toBe(0);
    // The distinction: this is a tagging gap on the site, not a conversion
    // problem, and the screen sends somebody to a different place for each.
    expect(cart.tracked).toBe(false);
    expect(funnel.find((row) => row.key === 'addedToCart').tracked).toBe(true);
  });

  it('keeps event counts beside user counts without confusing the two', () => {
    const { funnel } = build();
    const item = funnel.find((row) => row.key === 'openedItem');

    // 1,014 opens from 116 people. The funnel is built on the second number;
    // the first is carried for the tooltip because it is what "browsing"
    // looks like.
    expect(item.users).toBe(116);
    expect(item.events).toBe(1014);
  });
});

describe('scroll depth', () => {
  it('is a share of the people who scrolled, not of everyone who visited', () => {
    const { scroll } = build();

    expect(scroll.tracked).toBe(true);
    // 96 people reached 25%, and they are the denominator. Dividing by the
    // 220 site visitors would report the landing page as unread when what
    // actually happened is that most of them never opened it.
    expect(scroll.steps[0].users).toBe(96);
    expect(scroll.steps[0].shareOfTop).toBe(100);
    expect(scroll.steps.at(-1).depth).toBe(100);
    expect(scroll.steps.at(-1).shareOfTop).toBe(71.88);
  });

  it("reports GA's built-in 90% scroll separately from the site's own ladder", () => {
    const { scroll } = build();
    // A different denominator — the built-in fires on every page — so it sits
    // beside the ladder as a cross-check and never inside it.
    expect(scroll.bottomReached).toBe(200);
    expect(scroll.steps.some((step) => step.users === 200)).toBe(false);
  });

  it('says so when the site fires the event without the depth parameter', () => {
    const { scroll } = build({
      scroll: [],
      events: [...EVENTS, { event: 'scroll_depth', users: 96, events: 652, sessions: 131 }],
    });

    expect(scroll.tracked).toBe(false);
    // The number that tells the reader this is a two-line fix on the site
    // rather than an absence of scrolling.
    expect(scroll.firing).toBe(96);
  });
});

describe('landing page sections', () => {
  it('comes back in page order, not in order of reach', () => {
    const { sections } = build();

    // Hero is the most-seen AND the first; Footer is the least-seen and the
    // last. Menu between them is the case that separates the two orderings
    // from each other only when a nav link jumps past something.
    expect(sections.map((row) => row.section)).toEqual(['Hero', 'Menu', 'Footer']);
    expect(sections.map((row) => row.position)).toEqual([
      PAGE_SECTIONS.indexOf('Hero'),
      PAGE_SECTIONS.indexOf('Menu'),
      PAGE_SECTIONS.indexOf('Footer'),
    ]);
  });

  it('shows a section it has no position for last rather than dropping it', () => {
    const { sections } = build({
      sections: [...SECTIONS, { section: 'Press', users: 30, events: 30, sessions: 30 }],
    });

    const press = sections.at(-1);
    expect(press.section).toBe('Press');
    // null, not a guessed index — the screen renders this as "position
    // unknown" rather than asserting where on the page it sits.
    expect(press.position).toBeNull();
    // Reach that would have put it second if the table were sorted by users.
    expect(press.users).toBe(30);
  });

  it('shares against the best-reached section, so the first one is 100%', () => {
    const { sections } = build();
    expect(sections[0].share).toBe(100);
    expect(sections.find((row) => row.section === 'Menu').share).toBe(39.06);
  });
});

describe('the funnel per traffic source', () => {
  it('resolves each source to the channel the ROI tabs use', () => {
    const { bySource } = build();
    const reddit = bySource.find((row) => row.source === 'reddit');

    // Same resolver as the Overview table's link rule, so a reader can carry
    // a row straight across between tabs.
    expect(reddit.channel).toBe('Reddit');
    expect(bySource.find((row) => row.source === '(direct)').channel).toBe('Website');
  });

  it('rates each source on carts as well as on purchases', () => {
    const { bySource } = build();
    const reddit = bySource.find((row) => row.source === 'reddit');

    expect(reddit.arrived).toBe(40);
    expect(reddit.addedToCart).toBe(12);
    expect(reddit.cartRate).toBe(30);
    expect(reddit.purchaseRate).toBe(7.5);
  });

  it('ranks by carts, because purchases tie at zero on a short window', () => {
    const { bySource } = build();
    // (direct) has more carts than reddit and comes first, even though
    // reddit converts better — the ranking answers "where is the volume",
    // and the rate columns answer "which is worth more per visit".
    expect(bySource.map((row) => row.source)).toEqual(['(direct)', 'reddit']);
  });
});

describe('totals', () => {
  it('states the headline rates on the denominators people assume', () => {
    const { totals } = build();

    expect(totals.arrived).toBe(220);
    expect(totals.orderPageUsers).toBe(165);
    expect(totals.pageViews).toBe(612);
    // Of everybody who turned up.
    expect(totals.conversionRate).toBe(3.64);
    expect(totals.cartRate).toBe(18.18);
    // Of the people who got as far as the cart — the figure that says whether
    // the problem is the top of the funnel or the bottom of it.
    expect(totals.cartToPaid).toBe(20);
  });

  it('leaves a rate null rather than zero when there is nothing to divide by', () => {
    const { totals } = build({ events: [] });
    // No visitors is not a 0% conversion rate. A zero would sort and read as
    // a failing site rather than an empty window.
    expect(totals.conversionRate).toBeNull();
    expect(totals.cartToPaid).toBeNull();
  });
});

describe('leaks', () => {
  it('lists only what happened, ranked, and never as funnel progress', () => {
    const { leaks, funnel } = build();

    expect(leaks.map((row) => row.event)).toEqual(['checkout_abandoned']);
    expect(leaks[0].users).toBe(14);
    // 14 abandoned against 11 who started checkout is the pair worth seeing,
    // and it would be nonsense as a step in a column headed "progress".
    expect(funnel.some((step) => step.key === 'checkout_abandoned')).toBe(false);
  });
});

describe('ladder', () => {
  it('is safe on an empty list', () => {
    expect(ladder([])).toEqual([]);
  });

  it('does not divide by a zero top step', () => {
    const rows = ladder([
      { label: 'none', users: 0 },
      { label: 'also none', users: 0 },
    ]);
    expect(rows[0].shareOfTop).toBe(100);
    expect(rows[1].shareOfTop).toBeNull();
    expect(rows[1].shareOfPrevious).toBeNull();
  });
});
