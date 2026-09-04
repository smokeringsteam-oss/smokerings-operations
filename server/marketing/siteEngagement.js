// What happened on the site before the order: pages seen, how far down people
// scrolled, and how many of them made it to each step of ordering.
//
// The Marketing ROI screen next door answers "what did each channel cost and
// what did it bring". This answers the question that sits underneath it — of
// the people a channel sent, how many got as far as the menu, the cart, the
// checkout — because a channel with good traffic and no revenue and a channel
// with no traffic are the same row on an ROI table and completely different
// problems.
//
// Everything here comes from GA4 and nothing from Odoo. That is deliberate:
// GA knows what happened in the browser and Odoo knows what was paid for, and
// the two disagree by design — GA's `purchase` fires when the site thinks the
// order went through, Odoo's sale.order is the book of record. Putting both
// on one funnel would invite the reader to subtract one from the other, which
// is not a meaningful figure. Revenue lives on the ROI tabs; this file counts
// people.
//
// ---- The one caveat that shapes every number below ----------------------
//
// These are NOT sequenced funnel steps. GA4's Data API reports, for each
// event, how many distinct users fired it at least once in the window. It
// does not report how many users fired event B *after* event A — that is
// Explore's funnel exploration, which the Data API does not expose.
//
// So "44 people added to cart" means 44 people added to cart at some point in
// the window, not 44 of the 116 who opened an item. In practice the two are
// nearly the same on a site where you cannot reach the cart without opening
// an item, and the ordering of the steps below follows the site's actual
// flow, so the shape of the drop is real. But a step can legitimately come
// out *larger* than the one above it — somebody with a restored cart who
// never re-opened an item — and when that happens it is flagged rather than
// clamped. A funnel that quietly enforces monotonicity is lying about the
// only case where it had something to say.
import {
  describeConfig as describeGaConfig,
  isConfigured as gaConfigured,
  fetchPageEngagement,
  fetchEventReach,
  fetchEventReachBySource,
  fetchScrollDepth,
  fetchSectionViews,
  fetchCtaClicks,
} from '../integrations/googleAnalytics.js';
import { channelFromGaSource } from './orderAttribution.js';

const ratio = (value) => Math.round(value * 100) / 100;
const share = (part, whole) => (whole > 0 ? ratio((part / whole) * 100) : null);

// The path to ordering, in the order the site lays it out.
//
// Nine steps rather than the usual four, because the drops that matter on
// this site are between the middle ones: 165 people reached the order page
// and 40 added something, which is the whole story and is invisible in a
// visitors → purchasers funnel.
//
// One step is a page rather than an event. "How many saw the order page" is
// the question that gets asked, /order is the page, and there is no event
// that means exactly that — page_view fires on every page including the
// landing one. Mixing a page-scoped count into an event-scoped funnel is fine
// here because both are totalUsers over the same window and the same
// property; `from` says which kind each row is so the screen can show it.
const FUNNEL = [
  {
    key: 'arrived',
    event: 'session_start',
    label: 'Arrived on the site',
    hint: 'Started a session on any page',
  },
  {
    key: 'orderPage',
    page: '/order',
    label: 'Reached the order page',
    hint: 'Loaded /order — the page the whole funnel narrows through',
  },
  {
    key: 'sawMenu',
    event: 'view_item_list',
    label: 'Saw the menu',
    hint: 'The item list rendered for them',
  },
  {
    key: 'openedItem',
    event: 'view_item',
    label: 'Opened an item',
    hint: 'Looked at a specific dish',
  },
  {
    key: 'addedToCart',
    event: 'add_to_cart',
    label: 'Added to cart',
    hint: 'The first commitment anybody makes',
  },
  {
    key: 'openedCart',
    event: 'view_cart',
    label: 'Opened the cart',
    hint: 'Went to review what they had picked',
  },
  {
    key: 'startedCheckout',
    event: 'begin_checkout',
    label: 'Started checkout',
    hint: 'Entered the checkout flow',
  },
  {
    key: 'enteredPayment',
    event: 'add_payment_info',
    label: 'Entered payment details',
    hint: 'Got as far as paying',
  },
  {
    key: 'submitted',
    event: 'checkout_submitted',
    label: 'Submitted the order',
    hint: 'Pressed the button',
  },
  {
    key: 'paid',
    event: 'purchase',
    label: 'Paid',
    hint: "GA's count, not Odoo's — the ROI tabs hold the money",
  },
];

// Events that are not steps forward but explanations of a step that did not
// happen. Shown as their own list under the funnel: `begin_checkout` at 11
// people and `checkout_abandoned` at 14 is a far more useful pair than either
// number alone, and neither belongs in a column headed "progress".
const LEAKS = [
  { event: 'checkout_abandoned', label: 'Abandoned at checkout', hint: 'Reached checkout and left without submitting' },
  { event: 'remove_from_cart', label: 'Removed an item', hint: 'Changed their mind about something in the cart' },
  { event: 'checkout_validation_failed', label: 'Checkout rejected their details', hint: 'The form would not accept what they typed' },
  { event: 'payment_failed', label: 'Payment failed', hint: 'The payment was attempted and did not go through' },
  { event: 'payment_window_dismissed', label: 'Closed the payment window', hint: 'Backed out at the payment gateway' },
  { event: 'menu_load_failed', label: 'The menu failed to load', hint: 'They arrived and there was nothing to order — the worst of these' },
  { event: 'whatsapp_handoff', label: 'Left for WhatsApp', hint: 'Not a loss: the order may have completed by message' },
];

// The landing page's sections, top to bottom.
//
// Declared rather than derived, because GA cannot report DOM order — it knows
// a section was seen, not where it sits. Sorting by reach instead would look
// right most of the time and quietly mislead whenever somebody used the nav
// to jump straight to a section further down.
//
// Seeded from reach on the live property rather than from the page source,
// which is in another repo: section_view fires on scroll, so ranking the
// sections by how many people saw them recovers the page order for everything
// except a section people reach by pressing a nav link. Gallery is the one to
// check first — it reports far less reach than the sections either side of
// it, which is either its real position or a section that only renders on
// some viewports.
//
// EDIT THIS when the landing page is reordered or a section is added. A
// section GA reports that is not listed here is appended at the end rather
// than dropped, so a stale list misplaces one row instead of losing it.
const PAGE_SECTIONS = [
  'Hero',
  'How Pre-Order Works',
  'Services',
  'Menu',
  'Testimonials',
  'Contact Us',
  'B2B',
  'Gallery',
  'Footer',
];

// The funnel steps that can be split by traffic source. The page step cannot:
// pagePath and sessionSource are both available, but a page × source report is
// a second round trip for one row of one table, and the event steps either
// side of it already carry the shape.
const SOURCE_STEPS = FUNNEL.filter((step) => step.event).map((step) => step.event);

// Turns a list of steps into rows carrying the two percentages that matter,
// which are different questions and are both asked:
//
//   shareOfTop        of everybody who arrived, how many got this far. The
//                     one to quote.
//   shareOfPrevious   of the people at the step above, how many continued.
//                     The one that finds the leak — a step at 6% of the top
//                     looks terrible until you see it kept 92% of the step
//                     before it, and the real drop was two rows up.
//
// `grew` marks a step that came out larger than the one above it. See the
// caveat at the top of this file: it is a real thing that happens and it is
// surfaced, not smoothed away.
function ladder(steps) {
  const top = steps.length ? steps[0].users : 0;

  return steps.map((step, index) => {
    const previous = index > 0 ? steps[index - 1] : null;
    const lost = previous ? previous.users - step.users : 0;

    return {
      ...step,
      shareOfTop: index === 0 ? 100 : share(step.users, top),
      shareOfPrevious: previous ? share(step.users, previous.users) : null,
      // People who were at the step above and are not here. Negative would be
      // nonsense, so a step that grew reports zero lost and sets `grew`.
      lost: Math.max(lost, 0),
      grew: Boolean(previous && step.users > previous.users),
      // What the reader compares against, named, so the percentage above is
      // not a number they have to trace back up the table.
      previousLabel: previous ? previous.label : '',
    };
  });
}

// The whole tab, from data already fetched.
//
// Pure and fed its inputs, exactly as buildTrafficSources and
// buildUtmBreakdown in marketingRoi.js are, so the joining and the arithmetic
// are testable without a GA property behind them.
function buildEngagement({ events = [], scroll = [], sections = [], pages = [], ctas = [], bySource = [] }) {
  const byEvent = new Map(events.map((row) => [row.event, row]));
  const usersOf = (name) => byEvent.get(name)?.users || 0;

  const byPath = new Map(pages.map((row) => [row.path, row]));

  // ---- The ordering funnel ----------------------------------------------
  const funnel = ladder(
    FUNNEL.map((step) => {
      const row = step.page ? byPath.get(step.page) : byEvent.get(step.event);
      return {
        key: step.key,
        label: step.label,
        hint: step.hint,
        from: step.page ? 'page' : 'event',
        // The page or event this row counts, printed on the screen so a
        // figure that looks wrong can be checked against GA directly.
        measure: step.page || step.event,
        users: row?.users || 0,
        // Repetitions. Meaningful on view_item (1,014 opens from 116 people
        // is browsing) and meaningless on purchase, so the screen shows it
        // only where it differs from users by more than a little.
        events: (step.page ? row?.views : row?.events) || 0,
        // Whether GA reported this step at all. Zero users because nobody did
        // it and zero because the site never fires the event are different
        // problems — the second one is a tagging job, and a funnel that
        // cannot tell them apart sends somebody looking for a conversion
        // problem that does not exist.
        tracked: Boolean(row),
      };
    }),
  );

  // ---- Where it went wrong ----------------------------------------------
  const leaks = LEAKS.map((leak) => ({
    ...leak,
    users: usersOf(leak.event),
    events: byEvent.get(leak.event)?.events || 0,
    tracked: byEvent.has(leak.event),
  }))
    .filter((row) => row.users > 0)
    .sort((a, b) => b.users - a.users);

  // ---- How far down they scrolled ---------------------------------------
  // Its own ladder, on its own denominator: the people who scrolled at all,
  // not the people who arrived. A visitor who read the whole landing page
  // and one who bounced from /order are both in the site total, and dividing
  // scroll depth by that would report the landing page as unread when what
  // actually happened is that most people never opened it.
  const scrollSteps = ladder(
    scroll.map((row) => ({
      depth: row.depth,
      label: `${row.depth}% down`,
      users: row.users,
      events: row.events,
    })),
  );

  // GA4's built-in scroll event, which fires once at 90%. A different
  // denominator from the ladder above (it is on every page, the site's own
  // scroll_depth is on the landing page), so it is reported beside the ladder
  // as a cross-check and never inside it.
  const bottomReached = usersOf('scroll');

  // ---- How far down the page they read ----------------------------------
  const sectionOrder = new Map(PAGE_SECTIONS.map((name, index) => [name, index]));
  const seen = sections.length ? Math.max(...sections.map((row) => row.users)) : 0;

  const sectionRows = sections
    .map((row) => ({
      section: row.section,
      users: row.users,
      events: row.events,
      // Of the people who saw any section, how many saw this one. The first
      // section is the denominator in practice, and stating it as a share of
      // the best-reached section means a page whose hero is not the first
      // thing tracked still reads sensibly.
      share: share(row.users, seen),
      // Where it sits on the page, or null for a section PAGE_SECTIONS has
      // not been told about. Rendered as "position unknown" rather than
      // guessed at.
      position: sectionOrder.has(row.section) ? sectionOrder.get(row.section) : null,
    }))
    .sort((a, b) => {
      // Page order for the sections we know, then everything else by reach.
      if (a.position === null && b.position === null) return b.users - a.users;
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position;
    });

  // ---- The funnel, per traffic source ------------------------------------
  // The join back to the ROI screen: these source names are the same ones
  // the Traffic sources tab lists and the same ones channelFromGaSource
  // resolves, so a reader can carry a row straight across.
  const sources = new Map();
  bySource.forEach((row) => {
    if (!sources.has(row.source)) {
      sources.set(row.source, { source: row.source, channel: channelFromGaSource(row.source), steps: {} });
    }
    sources.get(row.source).steps[row.event] = row.users;
  });

  const sourceRows = [...sources.values()]
    .map((row) => {
      const arrived = row.steps.page_view || row.steps.session_start || 0;
      const carted = row.steps.add_to_cart || 0;
      const paid = row.steps.purchase || 0;
      return {
        source: row.source,
        channel: row.channel,
        arrived,
        sawMenu: row.steps.view_item_list || 0,
        openedItem: row.steps.view_item || 0,
        addedToCart: carted,
        startedCheckout: row.steps.begin_checkout || 0,
        paid,
        // Two rates rather than one, because they fail in different places.
        // A source with good cart rate and no purchases has a checkout
        // problem; a source with neither has an audience problem.
        cartRate: share(carted, arrived),
        purchaseRate: share(paid, arrived),
      };
    })
    // Cart rate is the ranking that answers "which traffic is worth buying
    // more of" on a window where purchases are single digits and would sort
    // almost every source into a tie at zero.
    .sort((a, b) => b.addedToCart - a.addedToCart || b.arrived - a.arrived || a.source.localeCompare(b.source));

  const arrived = funnel[0]?.users || 0;

  return {
    funnel,
    leaks,
    scroll: {
      steps: scrollSteps,
      bottomReached,
      // Whether the site sends the depth parameter at all. An empty ladder
      // with events behind it means scroll_depth is firing without
      // percent_scrolled, which is a two-line fix on the site and would
      // otherwise read as "nobody scrolls".
      tracked: scrollSteps.length > 0,
      firing: usersOf('scroll_depth'),
    },
    sections: sectionRows,
    pages,
    ctas,
    bySource: sourceRows,
    totals: {
      arrived,
      orderPageUsers: byPath.get('/order')?.users || 0,
      pageViews: pages.reduce((sum, row) => sum + row.views, 0),
      addedToCart: usersOf('add_to_cart'),
      startedCheckout: usersOf('begin_checkout'),
      paid: usersOf('purchase'),
      // The headline conversion, stated on the denominator everybody assumes:
      // of the people who turned up, how many paid.
      conversionRate: share(usersOf('purchase'), arrived),
      cartRate: share(usersOf('add_to_cart'), arrived),
      // Of the people who got as far as the cart, how many paid. The number
      // that says whether the problem is the top of the funnel or the bottom.
      cartToPaid: share(usersOf('purchase'), usersOf('add_to_cart')),
    },
  };
}

// The tab, fetched and built.
//
// Every GA call goes out at once and the whole thing fails together, which is
// the opposite of the ROI screen's arrangement and is right for a different
// reason: there, GA is one optional input to a report that is mostly about
// money, and it must not take the revenue down with it. Here GA *is* the
// report, so a partial answer would be a funnel with holes in it that looked
// like drop-off.
async function buildEngagementReport({ fromDate, toDate }) {
  if (!fromDate || !toDate) {
    const err = new Error('A from and to date are both required.');
    err.status = 400;
    throw err;
  }

  const ga = describeGaConfig();
  if (!gaConfigured()) {
    const err = new Error(
      ga.error ||
        'Google Analytics is not connected, so there is nothing to report here. Set GA4_PROPERTY_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in .env.',
    );
    err.status = 400;
    throw err;
  }

  const [events, scroll, sections, pages, ctas, bySource] = await Promise.all([
    fetchEventReach({ fromDate, toDate }),
    fetchScrollDepth({ fromDate, toDate }),
    fetchSectionViews({ fromDate, toDate }),
    fetchPageEngagement({ fromDate, toDate }),
    fetchCtaClicks({ fromDate, toDate }),
    fetchEventReachBySource({ fromDate, toDate, events: SOURCE_STEPS }),
  ]);

  return {
    range: { from: fromDate, to: toDate },
    ga: { configured: true, propertyId: ga.propertyId, error: '' },
    ...buildEngagement({ events, scroll, sections, pages, ctas, bySource }),
  };
}

export { buildEngagementReport, buildEngagement, ladder, FUNNEL, LEAKS, PAGE_SECTIONS, SOURCE_STEPS };
