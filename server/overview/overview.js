// The Overview — the screen the app opens on. One page that answers the four
// questions asked before anything else in the day: what is on Adarsh's and
// Sowmya's plate, what sold (and so what meat went out), where the money
// stands, and how many people found the site.
//
// Nothing here is a number of its own. Every section is read through the
// module that already owns it — the cadence tables Daily View reads, Sales by
// Item's Odoo feed, Spending vs Sales' ledger, the GA4 client Marketing ROI
// uses — so a figure on the Overview and the same figure on its home screen
// can never disagree. What this file adds is only the period (a Monday-to-
// Sunday week or a calendar month) and the cut each section is shown at.
//
// Each section fails on its own. Odoo down empties the orders card, GA down
// empties the traffic card, and the tasks and the money still render — the
// same "half a report that says which half is missing" rule the finance
// screens follow.
import { select } from '../core/repo.js';
import { all, get } from '../core/db.js';
import { getIsoWeekKey } from '../sprint/taskReminders.js';
import { displayTime } from '../sprint/recurringSchedule.js';
import { buildWeeklyReport, MAX_WEEKS } from '../finance/weeklyLedger.js';
import { buildItemSalesReport } from '../finance/itemSales.js';
import { getMeatByItem } from '../ops/b2c/recipes.js';
import {
  describeConfig as describeGaConfig,
  isConfigured as gaConfigured,
  fetchTrafficTotals,
  fetchTrafficBySource,
  runReport,
} from '../integrations/googleAnalytics.js';
import { channelFromGaSource } from '../marketing/orderAttribution.js';

// The two people the cadence is split between. Named here rather than read off
// whoever happens to be assigned something, so a week where Sowmya has nothing
// still shows her column — empty is an answer, a missing column is not.
const PEOPLE = ['Adarsh', 'Sowmya'];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VIEWS = ['week', 'month'];

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// ---- Dates ------------------------------------------------------------------
// Local calendar days throughout, as strings. toISOString() is UTC and would
// file anything after 18:30 IST under the next day.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!match) return null;
  const day = new Date(+match[1], +match[2] - 1, +match[3]);
  return ymd(day) === text ? day : null;
}

function addDays(day, n) {
  const next = new Date(day);
  next.setDate(next.getDate() + n);
  return next;
}

// The period `date` falls in, and the one before it for the comparison.
// A week is Monday to Sunday, for the reason weeklyLedger.js gives: Friday's
// buying and the weekend it fed have to land in the same bucket.
function periodFor({ view = 'week', date, now = new Date() } = {}) {
  if (!VIEWS.includes(view)) bad(`"${view}" is not a view — use week or month.`);
  const anchor = date ? parseDay(date) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!anchor) bad('The date has to be a real day, as YYYY-MM-DD.');

  if (view === 'week') {
    const start = addDays(anchor, -((anchor.getDay() + 6) % 7));
    const end = addDays(start, 6);
    const prevStart = addDays(start, -7);
    return {
      view,
      from: ymd(start),
      to: ymd(end),
      prevFrom: ymd(prevStart),
      prevTo: ymd(addDays(prevStart, 6)),
      label: `${start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    };
  }

  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const prevStart = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
  return {
    view,
    from: ymd(start),
    to: ymd(end),
    prevFrom: ymd(prevStart),
    prevTo: ymd(new Date(anchor.getFullYear(), anchor.getMonth(), 0)),
    label: start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  };
}

// Runs one section, and turns a failure into that section's own error rather
// than the whole page's.
async function section(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ---- Tasks ------------------------------------------------------------------
// Always "now", whatever period is on screen: the question is what is on
// someone's plate, and last month's cadence is not on anyone's plate. The
// precedence is todayTasks.js's — a completion row's assignee beats the
// cadence default — so a task handed over in Daily View is shown under the
// person it was handed to.

const samePerson = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function buildTasks(now = new Date()) {
  const weekday = WEEKDAYS[now.getDay()];
  const todayKey = ymd(now);

  const logged = new Map();
  select('task_completion', { week_key: getIsoWeekKey(now) }).forEach((row) => logged.set(row.task_id, row));

  const tasks = select('scheduled_task', {}, { orderBy: 'sort_order, rowid' })
    .filter((row) => row.task_id && (row.task || '').trim())
    .map((row) => {
      const log = logged.get(row.task_id);
      return {
        id: row.task_id,
        day: row.day,
        label: row.task.trim(),
        category: (row.category || '').trim(),
        assignedTo: (log?.assigned_to ?? row.assigned_to) || '',
        time: log?.time_of_day || displayTime(row.time_of_day),
        done: !!log?.done,
      };
    });

  // Open to-dos off the shared note board. Dated ones first, soonest first,
  // then the "whenever" ones newest first. The ones with nobody's name on them
  // are only the ones a push alert filed (core/alertTasks.js) — a typed note
  // with no name is a remark, not a job waiting for an owner.
  const todos = all(
    `SELECT note_id, body, due_date, assigned_to, source, created_at FROM shared_note
      WHERE done = 0 AND (ifnull(assigned_to, '') <> '' OR source IS NOT NULL)
      ORDER BY CASE WHEN ifnull(due_date, '') = '' THEN 1 ELSE 0 END, due_date, note_id DESC`,
  ).map((row) => ({
    id: row.note_id,
    body: row.body,
    dueDate: row.due_date || '',
    assignedTo: row.assigned_to || '',
    fromAlert: Boolean(row.source),
    overdue: Boolean(row.due_date && row.due_date < todayKey),
  }));

  return {
    weekday,
    today: todayKey,
    people: PEOPLE.map((name) => {
      const mine = tasks.filter((task) => samePerson(task.assignedTo, name));
      const today = mine.filter((task) => task.day === weekday);
      return {
        name,
        today,
        todayDone: today.filter((task) => task.done).length,
        week: { done: mine.filter((task) => task.done).length, total: mine.length },
        todos: todos.filter((todo) => samePerson(todo.assignedTo, name)),
      };
    }),
    unassigned: todos.filter((todo) => !todo.assignedTo),
  };
}

// ---- Orders and meat --------------------------------------------------------
// Out of Sales by Item, so the counts are that screen's counts. The meat for a
// dish comes from its recipe (getMeatByItem — the walk Order Management uses
// for the "pork is in the smoker" switch); wholesale lines and anything the
// recipes do not know are classified by name, which for "Smoked Pork Belly
// (Bulk 1kg)" is not a guess.

const ANIMAL_BY_CATEGORY = {
  chicken: 'Chicken',
  pulledPork: 'Pork',
  ribs: 'Pork',
  porkBelly: 'Pork',
  wings: 'Chicken',
  cajunLegs: 'Chicken',
  cajunBirds: 'Chicken',
  brisket: 'Beef',
  beefRibs: 'Beef',
  jackfruit: 'Jackfruit (veg)',
};

function meatFromName(name) {
  const text = String(name || '').toLowerCase();
  if (/chicken/.test(text)) return { animal: 'Chicken', cut: /pulled|shred/.test(text) ? 'Shredded Chicken' : 'Chicken (other cuts)' };
  if (/beef/.test(text)) return { animal: 'Beef', cut: 'Beef' };
  if (/jackfruit/.test(text)) return { animal: 'Jackfruit (veg)', cut: 'Pulled Jackfruit' };
  if (/rib/.test(text)) return { animal: 'Pork', cut: 'Pork Ribs' };
  if (/belly|burnt end/.test(text)) return { animal: 'Pork', cut: 'Pork Belly' };
  if (/pulled pork/.test(text)) return { animal: 'Pork', cut: 'Pulled Pork' };
  if (/pork/.test(text)) return { animal: 'Pork', cut: 'Pork (other cuts)' };
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;

// The meat rollup, pure so it can be tested without Odoo. A dish with two
// meats in it counts once under each — the question is "how many dishes went
// out with chicken in them", not a share of the plate.
function rollUpMeat(items, meatByItem) {
  const animals = new Map();
  const animalRow = (animal) => {
    if (!animals.has(animal)) animals.set(animal, { animal, portions: 0, wholesale: {}, cuts: new Map(), dishes: [] });
    return animals.get(animal);
  };
  let meatless = 0;

  items.forEach((item) => {
    const mapped = (item.itemId && meatByItem[item.itemId]) || [];
    const meats = mapped.length
      ? mapped.map((m) => ({ animal: ANIMAL_BY_CATEGORY[m.category] || m.label, cut: m.label }))
      : [meatFromName(item.name)].filter(Boolean);
    if (!meats.length) {
      meatless += 1;
      return;
    }
    // Wholesale is billed by weight or pack, so it is kept by its own unit and
    // never added to a count of portions.
    const isWholesale = item.channel === 'B2B';
    const unit = item.unitLabel || 'units';
    const seenAnimals = new Set();
    meats.forEach(({ animal, cut }) => {
      const row = animalRow(animal);
      if (!row.cuts.has(cut)) row.cuts.set(cut, { cut, portions: 0, wholesale: {} });
      const cutRow = row.cuts.get(cut);
      if (isWholesale) {
        cutRow.wholesale[unit] = (cutRow.wholesale[unit] || 0) + item.units;
      } else {
        cutRow.portions += item.units;
      }
      if (seenAnimals.has(animal)) return;
      seenAnimals.add(animal);
      if (isWholesale) row.wholesale[unit] = (row.wholesale[unit] || 0) + item.units;
      else row.portions += item.units;
      row.dishes.push({ name: item.name, channel: item.channel, units: round2(item.units), unitLabel: item.unitLabel || '' });
    });
  });

  const tidy = (wholesale) => Object.fromEntries(Object.entries(wholesale).map(([unit, qty]) => [unit, round2(qty)]));
  return {
    meats: [...animals.values()]
      .map((row) => ({
        animal: row.animal,
        portions: round2(row.portions),
        wholesale: tidy(row.wholesale),
        cuts: [...row.cuts.values()]
          .map((cut) => ({ cut: cut.cut, portions: round2(cut.portions), wholesale: tidy(cut.wholesale) }))
          .sort((a, b) => b.portions - a.portions),
        dishes: row.dishes.sort((a, b) => b.units - a.units),
      }))
      .sort((a, b) => b.portions - a.portions),
    meatlessItems: meatless,
  };
}

async function buildOrders(period) {
  const report = await buildItemSalesReport({
    fromDate: period.from,
    toDate: period.to,
    granularity: period.view,
  });
  const { meats, meatlessItems } = rollUpMeat(report.items || [], getMeatByItem());
  return {
    error: report.sources?.odoo?.error || '',
    odooConfigured: report.sources?.odoo?.configured ?? false,
    orders: report.totals.orders,
    b2cOrders: report.totals.b2cOrders,
    b2bOrders: report.totals.b2bOrders,
    b2cPortions: report.totals.b2cUnits,
    revenue: report.totals.revenue,
    b2cRevenue: report.totals.b2cRevenue,
    b2bRevenue: report.totals.b2bRevenue,
    meats,
    meatlessItems,
    topDishes: (report.items || [])
      .filter((item) => item.channel === 'B2C')
      .sort((a, b) => b.units - a.units)
      .slice(0, 6)
      .map((item) => ({ name: item.name, units: item.units, revenue: item.revenue })),
  };
}

// ---- Money ------------------------------------------------------------------
// Two figures from Spending vs Sales' ledger: the period, and everything since
// the first rupee was logged. "Invested" is the ledger's own `investment` —
// spend plus practice cooks plus equipment, i.e. everything that went out —
// so it is the same figure that screen prints as Total investment.

// The first day anything was recorded, on either side of the ledger.
function firstRecordedDay() {
  const row = get(
    `SELECT min(day) AS first FROM (
       SELECT min(purchase_date) AS day FROM purchase
       UNION ALL SELECT min(delivered_on) FROM b2b_sale
       UNION ALL SELECT min(period_start) FROM marketing_budget
     ) WHERE day IS NOT NULL`,
  );
  return row?.first ? String(row.first).slice(0, 10) : '';
}

function moneyFigures(totals) {
  return {
    spend: totals.spend,
    sales: totals.sales,
    net: totals.net,
    investment: totals.investment,
    investmentBuys: totals.investmentBuys,
    practice: totals.practice,
    materials: totals.materials,
    marketing: totals.marketing,
    labour: totals.labour,
    misc: totals.misc,
    services: totals.services,
    uncategorised: totals.uncategorised,
  };
}

async function buildMoney(period, now = new Date()) {
  const todayKey = ymd(now);
  const first = firstRecordedDay();
  // The ledger caps a report at MAX_WEEKS; a business older than two years
  // would be read from its most recent two, and says so.
  const earliestAllowed = ymd(addDays(now, -7 * (MAX_WEEKS - 1)));
  const sinceFrom = first && first > earliestAllowed ? first : earliestAllowed;

  const [current, sinceLaunch] = await Promise.all([
    buildWeeklyReport({ fromDate: period.from, toDate: period.to }),
    first && first <= todayKey ? buildWeeklyReport({ fromDate: sinceFrom, toDate: todayKey }) : null,
  ]);

  return {
    error: current.sources?.odoo?.error || '',
    // The ledger counts in whole Monday-to-Sunday weeks, so a month is read
    // over the weeks that touch it. Said on screen, so October's figure is
    // not mistaken for exactly the 1st to the 31st.
    covered: { from: current.range.from, to: current.range.to },
    period: moneyFigures(current.totals),
    weeks: current.weeks.map((week) => ({
      weekStart: week.weekStart,
      label: week.label,
      spend: week.spend.total,
      sales: week.sales.total,
    })),
    sinceLaunch: sinceLaunch
      ? {
          from: sinceLaunch.range.from,
          truncated: Boolean(first && first < earliestAllowed),
          ...moneyFigures(sinceLaunch.totals),
        }
      : null,
  };
}

// ---- Site traffic -----------------------------------------------------------
// GA4, through the client Marketing ROI uses. People (totalUsers), not
// sessions, as the headline: "how many people landed" is the question.

// "ig", "l.instagram.com" and "instagram.com" are one place to the reader, so
// GA's sources are folded under the channel the ROI screen files them under.
// Not for direct or search traffic: channelFromGaSource files both under
// "Website" (the Odoo channel an order from them lands in), which would merge
// "typed the address" with "found us on Google" — two different answers to
// "from where".
//
// Merged by sessions only. A session has one source, so sessions add up; a
// person can arrive from two sources, so users do not — see
// fetchTrafficBySource.
function sourceLabel(source) {
  const raw = String(source || '').trim();
  if (raw === '(direct)') return 'Direct (typed or bookmarked)';
  if (!raw || raw === '(not set)') return 'Unknown';
  const channel = channelFromGaSource(raw);
  if (channel && channel !== 'Website') return channel;
  if (/google/i.test(raw)) return 'Google';
  return raw;
}

function groupSources(rows) {
  const merged = new Map();
  rows.forEach((row) => {
    const label = sourceLabel(row.source);
    if (!merged.has(label)) merged.set(label, { label, sessions: 0, rawSources: [] });
    const entry = merged.get(label);
    entry.sessions += row.sessions;
    entry.rawSources.push(row.source);
  });
  return [...merged.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 10);
}

async function buildTraffic(period, now = new Date()) {
  if (!gaConfigured()) return { configured: false, error: describeGaConfig().error };

  // GA has nothing for days that have not happened; asking for them is
  // harmless but the daily chart would print a run of zeroes for the rest of
  // the month that read like the site going dark.
  const todayKey = ymd(now);
  const toDate = period.to > todayKey ? todayKey : period.to;
  if (period.from > todayKey) return { configured: true, future: true };
  // Like for like: a month four days old is compared with the first four
  // days of last month, not all thirty of them.
  const elapsed = Math.round((parseDay(toDate) - parseDay(period.from)) / 86400000);
  const prevEnd = ymd(addDays(parseDay(period.prevFrom), elapsed));
  const prevSpan = { fromDate: period.prevFrom, toDate: prevEnd < period.prevTo ? prevEnd : period.prevTo };
  const span = { fromDate: period.from, toDate };

  const [totals, previous, sources, places, days, landing] = await Promise.all([
    fetchTrafficTotals(span),
    fetchTrafficTotals(prevSpan),
    fetchTrafficBySource(span),
    runReport({ ...span, dimensions: ['city', 'country'], metrics: ['totalUsers', 'sessions'], orderByMetric: 'totalUsers', limit: 12 }),
    runReport({ ...span, dimensions: ['date'], metrics: ['totalUsers', 'sessions'], orderByDimension: 'date', limit: 40 }),
    runReport({ ...span, dimensions: ['landingPage'], metrics: ['totalUsers', 'sessions'], orderByMetric: 'totalUsers', limit: 6 }),
  ]);

  return {
    configured: true,
    through: toDate,
    totals,
    previous,
    previousSpan: { from: prevSpan.fromDate, to: prevSpan.toDate },
    sources: groupSources(sources),
    // A city GA could not place comes back once per country; to the reader
    // they are all "somewhere we don't know", so they are one row.
    places: [
      ...places
        .reduce((rows, row) => {
          const known = row.city && row.city !== '(not set)';
          const city = known ? row.city : 'Unknown city';
          const country = known && row.country !== '(not set)' ? row.country || '' : '';
          const key = `${city}|${country}`;
          const entry = rows.get(key) || { city, country, users: 0, sessions: 0 };
          entry.users += row.totalUsers;
          entry.sessions += row.sessions;
          return rows.set(key, entry);
        }, new Map())
        .values(),
    ].sort((a, b) => b.users - a.users),
    daily: days.map((row) => ({
      date: `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`,
      users: row.totalUsers,
      sessions: row.sessions,
    })),
    // GA can return the same page twice (an empty path and "(not set)" both
    // read as unknown), so rows are merged by what the reader will see.
    landingPages: [
      ...landing
        .reduce((pages, row) => {
          const page = row.landingPage && row.landingPage !== '(not set)' ? row.landingPage : 'Unknown page';
          const entry = pages.get(page) || { page, users: 0, sessions: 0 };
          entry.users += row.totalUsers;
          entry.sessions += row.sessions;
          return pages.set(page, entry);
        }, new Map())
        .values(),
    ].sort((a, b) => b.users - a.users),
  };
}

// ---- The page ---------------------------------------------------------------

async function buildOverview({ view, date, now = new Date() } = {}) {
  const period = periodFor({ view, date, now });
  const [tasks, orders, money, traffic] = await Promise.all([
    section(() => buildTasks(now)),
    section(() => buildOrders(period)),
    section(() => buildMoney(period, now)),
    section(() => buildTraffic(period, now)),
  ]);
  return { period, tasks, orders, money, traffic, fetchedAt: new Date().toISOString() };
}

export { buildOverview, periodFor, buildTasks, rollUpMeat, meatFromName, groupSources, PEOPLE };
