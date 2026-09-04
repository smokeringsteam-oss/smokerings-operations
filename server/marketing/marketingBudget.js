// The marketing spend ledger: what each channel and campaign cost.
//
// The store behind the marketing_budget table; the long note on that table in
// server/core/schema.sql says why the rows are hand-entered and why spend is
// held as a period rather than a date. This file is where the second of those
// turns into arithmetic.
//
// The one idea worth reading before the code: a spend row belongs to a span
// of days, and a question is asked about a different span of days. An
// Instagram budget of Rs 4,000 set for September, asked about across one
// weekend, is not Rs 4,000 of spend against that weekend's revenue and it is
// not Rs 0 either. It is the share of the month those days are — three
// thirtieths, Rs 400 — and that is what shareInRange computes. Getting this
// wrong in either direction produces a confident, wrong number: count the
// row in full and a good weekend looks like a disaster, drop it and every
// weekend looks free.
//
// Every row carries its own share alongside its full amount, and the screen
// shows both whenever they differ, so a figure that is a fraction of
// something never has to be taken on trust.
import { insert, nextId, remove, select, selectOne, update } from '../core/repo.js';

const TABLE = 'marketing_budget';

// Mirrors the CHECK in schema.sql. Duplicated deliberately: the constraint is
// what guarantees the rollup can never grow a bucket from a typo, and this is
// what lets the error say which categories exist instead of surfacing
// SQLite's "CHECK constraint failed".
const CATEGORIES = ['ads', 'commission', 'influencer', 'print', 'event', 'tooling', 'other'];

const DAY_MS = 86_400_000;

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function requireIsoDate(value, what) {
  if (!isIsoDate(value)) {
    const err = new Error(`${what} must be a date like 2026-09-03.`);
    err.status = 400;
    throw err;
  }
  return value;
}

// Whole days from `from` to `to` inclusive. Inclusive because a spend row
// covering a single day (a stall fee, one day's boosted post) has
// period_start === period_end and is one day of spend, not zero — and zero
// would divide by itself two lines later.
function dayCount(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

// The fraction of a spend row that falls inside a query window: 0 for no
// overlap, 1 for a row wholly inside it, and the day-share in between.
//
// Days, not money, because that is the only assumption available. Nobody
// records ad spend by the day, so within a period it is treated as flat —
// which is what a monthly budget actually is, and close enough for a
// weekend's share of one. A row entered for the exact days a campaign ran
// needs no assumption at all, and the screen nudges toward that by showing
// the fraction it used.
function shareInRange(row, fromDate, toDate) {
  const start = row.period_start > fromDate ? row.period_start : fromDate;
  const end = row.period_end < toDate ? row.period_end : toDate;
  if (start > end) return 0;
  const overlap = dayCount(start, end);
  const total = dayCount(row.period_start, row.period_end);
  if (total <= 0) return 0;
  return Math.min(1, overlap / total);
}

function shapeRow(row) {
  return {
    id: row.budget_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    channel: row.channel,
    campaign: row.campaign || '',
    category: row.category,
    amount: row.amount_inr,
    vendor: row.vendor || '',
    notes: row.notes || '',
    source: row.source,
    days: dayCount(row.period_start, row.period_end),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every spend row overlapping the window, each with the share of itself that
// falls inside it.
//
// Overlapping, not contained: a row is included the moment any of its days
// are in range. `amountInRange` is what the rollup adds up and `amount` is
// what somebody actually paid; `partial` says the two differ, so a screen can
// mark the row rather than quietly showing a number nobody typed.
function listBudgets({ fromDate, toDate } = {}) {
  const rows = select(TABLE, {}, { orderBy: 'period_start desc, channel, campaign' });
  if (!fromDate || !toDate) return rows.map((row) => ({ ...shapeRow(row), share: 1, amountInRange: row.amount_inr, partial: false }));

  requireIsoDate(fromDate, 'The from date');
  requireIsoDate(toDate, 'The to date');

  return rows
    .map((row) => {
      const share = shareInRange(row, fromDate, toDate);
      return {
        ...shapeRow(row),
        share,
        // Rounded to the rupee. Sub-rupee precision on a pro-rated share is
        // noise, and it is what makes a column of figures fail to add up to
        // the total printed under it.
        amountInRange: Math.round(row.amount_inr * share),
        partial: share > 0 && share < 1,
      };
    })
    .filter((row) => row.share > 0);
}

function validate({ periodStart, periodEnd, channel, category, amount }) {
  requireIsoDate(periodStart, 'The period start');
  requireIsoDate(periodEnd, 'The period end');
  if (periodEnd < periodStart) {
    const err = new Error('The period cannot end before it starts.');
    err.status = 400;
    throw err;
  }
  if (!String(channel || '').trim()) {
    const err = new Error('A channel is required — it is what the spend gets compared against.');
    err.status = 400;
    throw err;
  }
  if (category && !CATEGORIES.includes(category)) {
    const err = new Error(`"${category}" is not a spend category (${CATEGORIES.join(', ')}).`);
    err.status = 400;
    throw err;
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    const err = new Error('The amount must be a number and cannot be negative.');
    err.status = 400;
    throw err;
  }
  return value;
}

function addBudget({ periodStart, periodEnd, channel, campaign, category = 'ads', amount, vendor, notes, source = 'manual' }) {
  const value = validate({ periodStart, periodEnd, channel, category, amount });
  const id = nextId(TABLE, 'budget_id', 'MKB');

  insert(TABLE, {
    budget_id: id,
    period_start: periodStart,
    period_end: periodEnd,
    channel: String(channel).trim(),
    // Empty string and null mean the same thing here — spend with no campaign
    // behind it — and only one of them groups correctly, so it is normalised
    // on the way in rather than coalesced on the way out of four queries.
    campaign: String(campaign || '').trim() || null,
    category,
    amount_inr: value,
    vendor: String(vendor || '').trim() || null,
    notes: String(notes || '').trim() || null,
    source,
  });

  return shapeRow(selectOne(TABLE, { budget_id: id }));
}

function updateBudget({ id, periodStart, periodEnd, channel, campaign, category, amount, vendor, notes }) {
  const existing = selectOne(TABLE, { budget_id: id });
  if (!existing) {
    const err = new Error(`No spend row ${id}.`);
    err.status = 404;
    throw err;
  }

  // Validated against the row as it will be, not as it was: a patch that only
  // moves period_end has to be checked against the existing period_start, or
  // a backwards period gets past this and is caught by the CHECK instead.
  const merged = {
    periodStart: periodStart ?? existing.period_start,
    periodEnd: periodEnd ?? existing.period_end,
    channel: channel ?? existing.channel,
    category: category ?? existing.category,
    amount: amount ?? existing.amount_inr,
  };
  const value = validate(merged);

  update(
    TABLE,
    { budget_id: id },
    {
      period_start: merged.periodStart,
      period_end: merged.periodEnd,
      channel: String(merged.channel).trim(),
      campaign: campaign === undefined ? existing.campaign : String(campaign || '').trim() || null,
      category: merged.category,
      amount_inr: value,
      vendor: vendor === undefined ? existing.vendor : String(vendor || '').trim() || null,
      notes: notes === undefined ? existing.notes : String(notes || '').trim() || null,
      updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
    { required: true },
  );

  return shapeRow(selectOne(TABLE, { budget_id: id }));
}

function deleteBudget(id) {
  remove(TABLE, { budget_id: id }, { required: true });
  return { deleted: id };
}

export { CATEGORIES, listBudgets, addBudget, updateBudget, deleteBudget, shareInRange, dayCount };
