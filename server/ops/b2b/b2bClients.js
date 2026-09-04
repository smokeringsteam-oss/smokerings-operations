// B2B clients — the wholesale/corporate side of the book: who the account is,
// how much meat they want and how often, and where they've got to in the
// pipeline (Lead -> Sampling -> Onboarding -> Active).
//
// Why the two middle stages exist as first-class state rather than a note on
// the account: a B2B account isn't won by taking an order, it's won by
// getting a sample tray in front of the decision maker and then wiring up
// pricing/GST/delivery day before the first real delivery. Both stages have
// their own fields (what was sampled and what came back; which onboarding
// steps are done), and both are the kind of thing that gets forgotten if it
// only lives in someone's head — so they're columns, and the dashboard
// renders a checklist off them.
//
// Meat demand is the number the kitchen actually cares about, so it's stored
// per client per meat category using the SAME category keys as
// server/core/meatConfig.js (chicken, pulledPork, ribs, ...). That's deliberate:
// a B2B demand rollup then speaks the same vocabulary as the Weekend Prep
// Planner's "meat needed" tiles, and the two can be added together later
// without a translation table.
//
// Storage is two SQLite tables, `b2b_client` and `b2b_client_demand`,
// migrated off Data/B2B/b2b_clients.csv and b2b_client_demands.csv. Both are
// flat and one-to-one with the files they replaced, so unlike the catalogue
// there is no kbViews projection in between — the column names below are the
// schema's own.
//
// Three things the CSV version could not do, and this now does:
//
//   * A client edit is an UPDATE of one row. The old version parsed every
//     client, mutated one field and wrote them all back, so two people
//     saving different accounts at the same time meant the second silently
//     erased the first's change.
//   * Replacing a client's demand set is one transaction. As two file
//     rewrites, a crash between clearing the old lines and writing the new
//     ones left an account with no demand at all — quietly dropping it out
//     of the meat rollup the kitchen plans off.
//   * The demand lines are a real child table: ON DELETE CASCADE, a
//     CHECK (qty_kg > 0), and a foreign key that makes an orphaned line
//     impossible rather than merely unlikely.
//
// The header-migration dance the CSV version did on every read is gone with
// them. A column this module knows about either exists in the schema or the
// query fails loudly, instead of a stale header quietly dropping every field
// added since the file was last written.
import { insert, nextId, remove, select, selectOne, transaction, update } from '../../core/repo.js';
import { MEAT_CATEGORY_KEYS, MEAT_CATEGORY_LABELS } from '../../core/meatConfig.js';

const CLIENTS_TABLE = 'b2b_client';
// One row per client per meat category. A child table rather than a packed
// cell on the client row, so "how much chicken does B2B want in total" stays
// a sum over a column rather than a parsing exercise.
const DEMANDS_TABLE = 'b2b_client_demand';

// The pipeline, in order.
const STAGES = [
  { key: 'lead', label: 'Lead', description: 'Enquiry in. Nothing sent yet.' },
  {
    key: 'sampling',
    label: 'Sampling',
    description: 'Sample tray sent, waiting on feedback from whoever decides.',
  },
  {
    key: 'onboarding',
    label: 'Onboarding',
    description: 'They said yes. Pricing, GST, delivery day and the first order being set up.',
  },
  { key: 'active', label: 'Active', description: 'Ordering on a regular cadence.' },
  { key: 'paused', label: 'Paused', description: 'Was active, currently not ordering.' },
  { key: 'lost', label: 'Lost', description: 'Closed out. Keep the reason — it is the useful part.' },
];
const STAGE_KEYS = STAGES.map((s) => s.key);

// Stages whose demand is still prospective rather than business on the books.
// The rollup reports these separately from Active so nobody plans a purchase
// off a lead who hasn't tasted the food yet.
const PIPELINE_STAGES = ['lead', 'sampling', 'onboarding'];

// What "done" looks like before a B2B account can start ordering. Rendered as
// a checklist on the client card; stored as a semicolon-joined list of the
// keys that are ticked.
const ONBOARDING_STEPS = [
  { key: 'pricing_agreed', label: 'Pricing agreed', hint: 'Per-kg or per-portion rate signed off on both sides.' },
  { key: 'agreement_signed', label: 'Agreement / PO in hand', hint: 'Written confirmation of the rate and volume.' },
  { key: 'gst_on_file', label: 'GST + billing details on file', hint: 'GSTIN and the invoicing contact captured.' },
  { key: 'odoo_customer', label: 'Customer created in Odoo', hint: 'So orders and invoices can be raised against them.' },
  { key: 'delivery_slot', label: 'Delivery day & slot fixed', hint: 'Which day of the week, and by what time.' },
  { key: 'first_order', label: 'First order delivered', hint: 'The one that turns them Active.' },
];
const ONBOARDING_STEP_KEYS = ONBOARDING_STEPS.map((s) => s.key);

// How a sample landed. 'needs_changes' is its own outcome rather than a soft
// no because it's the one that carries an action — spice level, cut, portion
// size — and it should stay visible on the card until a second tray goes out.
const SAMPLE_OUTCOMES = [
  { key: '', label: 'Not sent yet' },
  { key: 'awaiting', label: 'Awaiting feedback' },
  { key: 'liked', label: 'Liked it' },
  { key: 'needs_changes', label: 'Wants changes' },
  { key: 'rejected', label: 'Not interested' },
];
const SAMPLE_OUTCOME_KEYS = SAMPLE_OUTCOMES.map((s) => s.key);

// perWeek converts a client's stated quantity into a comparable weekly figure
// for the rollup. 'adhoc' is 0 on purpose: an occasional event order is real
// business but it isn't standing weekly demand, and averaging it into one
// would quietly inflate every buy figure downstream. It's reported on its own
// instead.
const CADENCES = [
  { key: 'weekly', label: 'per week', perWeek: 1 },
  { key: 'fortnightly', label: 'per fortnight', perWeek: 0.5 },
  { key: 'monthly', label: 'per month', perWeek: 12 / 52 },
  { key: 'adhoc', label: 'ad hoc / per event', perWeek: 0 },
];
const CADENCE_KEYS = CADENCES.map((c) => c.key);
const PER_WEEK_BY_CADENCE = Object.fromEntries(CADENCES.map((c) => [c.key, c.perWeek]));

const BUSINESS_TYPES = [
  'Restaurant',
  'Cafe / Bar',
  'Cloud kitchen',
  'Retail / Deli',
  'Hotel',
  'Corporate / Office',
  'Caterer',
  'Other',
];

// Semicolons join the list-valued columns (sample items, onboarding steps),
// which the schema stores as one TEXT cell each. Kept as semicolons rather
// than switched to commas now that a parser is no longer in the way: these
// rows still get exported back to CSV for the knowledge-base repo, and a
// menu item with a comma in its name is ambiguous to anyone who opens that
// in Excel.
const LIST_SEP = ';';

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// Both tables are small — tens of rows — so every read here is a plain
// ordered select through repo.js rather than SQL of its own. The one filter
// that might have wanted SQL, addClient's case-insensitive duplicate-name
// check, stays in JS so it keeps applying this module's own trim/lowercase
// rule instead of whatever collation the column happens to carry.
function loadClients() {
  return select(CLIENTS_TABLE, {}, { orderBy: 'client_id' });
}

function loadDemands() {
  return select(DEMANDS_TABLE, {}, { orderBy: 'demand_id' });
}

function loadClient(id) {
  const row = selectOne(CLIENTS_TABLE, { client_id: String(id || '').trim() });
  if (!row) {
    const err = new Error(`No B2B client with id ${id}.`);
    err.status = 404;
    throw err;
  }
  return row;
}

// Re-reads a client and its demand lines after a write, so what the endpoint
// hands back is what the database actually holds rather than what the caller
// hoped it would — a defaulted column or a value the schema rewrote shows up
// in the response instead of only on the next page load.
function readBack(clientId) {
  return { client: toClient(loadClient(clientId), groupDemands(loadDemands())) };
}

function splitList(value) {
  return String(value || '')
    .split(LIST_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

// Round to 2dp without dragging float noise ("1.7999999999999998 kg") into
// either the stored quantity or the tiles.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function toDemand(row) {
  const qtyKg = round2(toNumber(row.qty_kg));
  const cadence = CADENCE_KEYS.includes(row.cadence) ? row.cadence : 'weekly';
  return {
    id: row.demand_id,
    clientId: row.client_id,
    category: row.category,
    categoryLabel: MEAT_CATEGORY_LABELS[row.category] || row.category,
    qtyKg,
    cadence,
    kgPerWeek: round2(qtyKg * (PER_WEEK_BY_CADENCE[cadence] ?? 0)),
    notes: row.notes || '',
  };
}

function toClient(row, demandsByClient) {
  const demands = demandsByClient.get(row.client_id) || [];
  const steps = splitList(row.onboarding_steps).filter((key) => ONBOARDING_STEP_KEYS.includes(key));
  return {
    id: row.client_id,
    name: row.name,
    businessType: row.business_type || '',
    stage: STAGE_KEYS.includes(row.stage) ? row.stage : 'lead',
    contactName: row.contact_name || '',
    contactRole: row.contact_role || '',
    phone: row.phone || '',
    email: row.email || '',
    area: row.area || '',
    address: row.address || '',
    gstin: row.gstin || '',
    leadSource: row.lead_source || '',
    orderDay: row.order_day || '',
    notes: row.notes || '',
    sampleSentOn: row.sample_sent_on || '',
    sampleItems: splitList(row.sample_items),
    sampleFeedback: row.sample_feedback || '',
    sampleOutcome: SAMPLE_OUTCOME_KEYS.includes(row.sample_outcome) ? row.sample_outcome : '',
    onboardingSteps: steps,
    // Rendered as "3/6 done" on the card — cheaper here than recomputing it
    // in three places in the UI.
    onboardingDone: steps.length,
    onboardingTotal: ONBOARDING_STEP_KEYS.length,
    priceList: row.price_list || '',
    paymentTerms: row.payment_terms || '',
    // The numeric half of the payment terms — how many days after delivery an
    // invoice for this account falls due. server/ops/b2b/b2bSales.js computes
    // every due date off it; `paymentTerms` above stays the free-text note
    // beside it ("Net 15, NEFT to the current account").
    paymentTermsDays: row.payment_terms_days == null ? 15 : Number(row.payment_terms_days),
    // The Odoo pricelist that decides this account's rates. Held as a
    // string above this line for the same reason odooPartnerId is: the
    // detail form posts it back as the value of a <select>.
    odooPricelistId: row.odoo_pricelist_id == null ? '' : String(row.odoo_pricelist_id),
    odooPricelistName: row.odoo_pricelist_name || '',
    // INTEGER in the schema, a string everywhere above this line — the
    // detail form posts it back as typed text and the UI compares it as one.
    odooPartnerId: row.odoo_partner_id == null ? '' : String(row.odoo_partner_id),
    onboardedOn: row.onboarded_on || '',
    lostReason: row.lost_reason || '',
    demands,
    kgPerWeek: round2(demands.reduce((sum, d) => sum + d.kgPerWeek, 0)),
    // Ad-hoc demand doesn't roll into the weekly figure (see CADENCES), but
    // it shouldn't vanish off the card either.
    adhocKg: round2(demands.filter((d) => d.cadence === 'adhoc').reduce((sum, d) => sum + d.qtyKg, 0)),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function groupDemands(rows) {
  const byClient = new Map();
  rows.forEach((row) => {
    if (!row.client_id) return;
    const list = byClient.get(row.client_id) || [];
    list.push(toDemand(row));
    byClient.set(row.client_id, list);
  });
  // Meat-config order, so every client's demand list reads in the same order
  // as the prep planner's tiles.
  byClient.forEach((list) =>
    list.sort((a, b) => MEAT_CATEGORY_KEYS.indexOf(a.category) - MEAT_CATEGORY_KEYS.indexOf(b.category)),
  );
  return byClient;
}

// Per-category weekly demand, split into what's committed (Active accounts)
// and what's still in the pipeline (Lead/Sampling/Onboarding). Two numbers
// rather than one because they answer different questions: the first is what
// to buy for, the second is what the kitchen would have to absorb if
// everything currently being courted lands.
function summarize(clients) {
  const active = clients.filter((c) => c.stage === 'active');
  const pipeline = clients.filter((c) => PIPELINE_STAGES.includes(c.stage));
  const linesFor = (list, category) => list.flatMap((c) => c.demands.filter((d) => d.category === category));
  const sumWeekly = (lines) => round2(lines.reduce((sum, d) => sum + d.kgPerWeek, 0));

  const byCategory = MEAT_CATEGORY_KEYS.map((key) => {
    const activeLines = linesFor(active, key);
    const pipelineLines = linesFor(pipeline, key);
    return {
      category: key,
      label: MEAT_CATEGORY_LABELS[key] || key,
      committedKgPerWeek: sumWeekly(activeLines),
      pipelineKgPerWeek: sumWeekly(pipelineLines),
      adhocKg: round2(
        [...activeLines, ...pipelineLines].filter((d) => d.cadence === 'adhoc').reduce((sum, d) => sum + d.qtyKg, 0),
      ),
      clients: activeLines.length,
    };
  }).filter((c) => c.committedKgPerWeek || c.pipelineKgPerWeek || c.adhocKg);

  return {
    byCategory,
    committedKgPerWeek: round2(byCategory.reduce((sum, c) => sum + c.committedKgPerWeek, 0)),
    pipelineKgPerWeek: round2(byCategory.reduce((sum, c) => sum + c.pipelineKgPerWeek, 0)),
    byStage: Object.fromEntries(STAGE_KEYS.map((key) => [key, clients.filter((c) => c.stage === key).length])),
  };
}

function listClients() {
  const demandsByClient = groupDemands(loadDemands());
  const clients = loadClients()
    .map((row) => toClient(row, demandsByClient))
    // Pipeline order first, then biggest demand — so whoever opens the tab
    // sees the accounts needing a push before the ones already running.
    .sort((a, b) => STAGE_KEYS.indexOf(a.stage) - STAGE_KEYS.indexOf(b.stage) || b.kgPerWeek - a.kgPerWeek);

  return {
    clients,
    summary: summarize(clients),
    // Vocabulary the UI renders from, so a new stage/step/cadence only has to
    // be added here.
    stages: STAGES,
    onboardingSteps: ONBOARDING_STEPS,
    sampleOutcomes: SAMPLE_OUTCOMES,
    cadences: CADENCES,
    businessTypes: BUSINESS_TYPES,
    categories: MEAT_CATEGORY_KEYS.map((key) => ({ key, label: MEAT_CATEGORY_LABELS[key] })),
  };
}

// JSON key -> table column for the generic update path. Everything a caller is
// allowed to write is in here; anything else in the body is ignored rather
// than rejected, so the UI can post a whole client object back.
const EDITABLE_FIELDS = {
  name: 'name',
  businessType: 'business_type',
  contactName: 'contact_name',
  contactRole: 'contact_role',
  phone: 'phone',
  email: 'email',
  area: 'area',
  address: 'address',
  gstin: 'gstin',
  leadSource: 'lead_source',
  orderDay: 'order_day',
  notes: 'notes',
  sampleSentOn: 'sample_sent_on',
  sampleFeedback: 'sample_feedback',
  priceList: 'price_list',
  paymentTerms: 'payment_terms',
  odooPartnerId: 'odoo_partner_id',
  lostReason: 'lost_reason',
};

function addClient({ name, businessType, stage, contactName, phone, email, area, notes } = {}) {
  const clean = String(name || '').trim();
  if (!clean) badRequest('A client name is required.');

  if (loadClients().some((r) => (r.name || '').trim().toLowerCase() === clean.toLowerCase())) {
    const err = new Error(`"${clean}" is already on the B2B client list.`);
    err.status = 409;
    throw err;
  }

  const now = new Date().toISOString();
  // Only the columns this call has something to say about. The rest are left
  // to the schema, which stores them as NULL — and every reader above treats
  // a NULL the way it treated the CSV's empty cell.
  const row = {
    client_id: nextId(CLIENTS_TABLE, 'client_id', 'B2B'),
    name: clean,
    business_type: String(businessType || '').trim(),
    // New accounts start as leads unless the caller says otherwise — an
    // account added mid-pipeline (someone already sampled before this screen
    // existed) is a real case, so the stage is accepted here rather than
    // forcing a second call.
    stage: STAGE_KEYS.includes(stage) ? stage : 'lead',
    contact_name: String(contactName || '').trim(),
    phone: String(phone || '').trim(),
    email: String(email || '').trim(),
    area: String(area || '').trim(),
    notes: String(notes || '').trim(),
    created_at: now,
    updated_at: now,
  };

  insert(CLIENTS_TABLE, row);
  return readBack(row.client_id);
}

function updateClient({ id, ...fields } = {}) {
  const row = loadClient(id);
  // Collected as a patch of just the columns this call touches rather than by
  // mutating the row and writing it back whole: an UPDATE that names only
  // what changed cannot undo a field someone else edited between the read and
  // the write.
  const patch = {};

  Object.entries(EDITABLE_FIELDS).forEach(([key, column]) => {
    if (fields[key] === undefined) return;
    patch[column] = String(fields[key] ?? '').trim();
  });

  if (fields.sampleItems !== undefined) {
    const items = Array.isArray(fields.sampleItems) ? fields.sampleItems : splitList(fields.sampleItems);
    patch.sample_items = items
      .map((s) => String(s).trim())
      .filter(Boolean)
      .join(LIST_SEP);
  }
  // Not in EDITABLE_FIELDS because that path stringifies and trims, and this
  // column is an INTEGER with a CHECK behind it — a blank or a negative here
  // would fail at the database with a message nobody can act on.
  // Two columns from one field: the id is the link, the name is cached
  // beside it so a screen can say which pricelist is attached without an Odoo
  // round trip. Clearing the id clears the name with it — a stale name next
  // to no pricelist reads as though one is still set.
  if (fields.odooPricelistId !== undefined) {
    const raw = String(fields.odooPricelistId ?? '').trim();
    if (!raw) {
      patch.odoo_pricelist_id = null;
      patch.odoo_pricelist_name = null;
    } else {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) badRequest('That is not an Odoo pricelist id.');
      patch.odoo_pricelist_id = id;
      patch.odoo_pricelist_name = String(fields.odooPricelistName ?? '').trim();
    }
  }
  if (fields.paymentTermsDays !== undefined) {
    const days = Number(String(fields.paymentTermsDays ?? '').trim());
    if (!Number.isFinite(days) || days < 0) badRequest('The payment cycle must be a number of days.');
    patch.payment_terms_days = Math.round(days);
  }
  if (fields.sampleOutcome !== undefined) {
    const outcome = String(fields.sampleOutcome || '').trim();
    if (!SAMPLE_OUTCOME_KEYS.includes(outcome)) badRequest(`"${outcome}" is not a sample outcome.`);
    patch.sample_outcome = outcome;
  }
  if (fields.onboardingSteps !== undefined) {
    const steps = (Array.isArray(fields.onboardingSteps) ? fields.onboardingSteps : splitList(fields.onboardingSteps))
      .map((s) => String(s).trim())
      .filter(Boolean);
    const unknown = steps.find((s) => !ONBOARDING_STEP_KEYS.includes(s));
    if (unknown) badRequest(`"${unknown}" is not an onboarding step.`);
    // Stored in checklist order rather than click order, so the cell reads
    // the same as the list on screen.
    patch.onboarding_steps = ONBOARDING_STEP_KEYS.filter((key) => steps.includes(key)).join(LIST_SEP);
  }
  // The column is NOT NULL, but '' satisfies that — and the name is what
  // every screen identifies the account by, so a blank one is refused here.
  if (!String(patch.name ?? row.name ?? '').trim()) badRequest('A client name is required.');

  patch.updated_at = new Date().toISOString();
  update(CLIENTS_TABLE, { client_id: row.client_id }, patch);
  return readBack(row.client_id);
}

function setStage({ id, stage, lostReason } = {}) {
  if (!STAGE_KEYS.includes(stage)) badRequest(`"${stage}" is not a pipeline stage.`);

  const row = loadClient(id);
  const patch = { stage, updated_at: new Date().toISOString() };
  // Stamped the first time an account goes live and left alone after that —
  // a pause and a restart shouldn't rewrite when they were actually won.
  if (stage === 'active' && !row.onboarded_on) patch.onboarded_on = new Date().toISOString().slice(0, 10);
  if (stage === 'lost' && lostReason !== undefined) patch.lost_reason = String(lostReason || '').trim();
  update(CLIENTS_TABLE, { client_id: row.client_id }, patch);
  return readBack(row.client_id);
}

// Replaces a client's whole demand list in one call. Replace rather than
// per-line edits because the UI edits the table as a block, and a partial
// save is the one way to end up with a demand row nobody meant to keep.
function setDemands({ id, demands } = {}) {
  if (!Array.isArray(demands)) badRequest('demands must be an array.');

  const clientId = loadClient(id).client_id;

  const now = new Date().toISOString();
  const seen = new Set();
  const cleaned = demands
    .map((d) => {
      const category = String(d?.category || '').trim();
      if (!MEAT_CATEGORY_KEYS.includes(category)) badRequest(`"${category}" is not a meat category.`);
      if (seen.has(category)) {
        badRequest(`${MEAT_CATEGORY_LABELS[category]} is listed twice — put the whole amount on one line.`);
      }
      seen.add(category);

      const qtyKg = Number(d?.qtyKg);
      if (!Number.isFinite(qtyKg) || qtyKg < 0) {
        badRequest(`Quantity for ${MEAT_CATEGORY_LABELS[category]} must be a number of kg.`);
      }

      const cadence = String(d?.cadence || 'weekly').trim();
      if (!CADENCE_KEYS.includes(cadence)) badRequest(`"${cadence}" is not a cadence.`);

      return { category, qtyKg: round2(qtyKg), cadence, notes: String(d?.notes || '').trim() };
    })
    // A zeroed line is how the UI says "drop this meat", so it's a delete
    // rather than a 0 kg row that would clutter every rollup.
    .filter((d) => d.qtyKg > 0);

  // Clear-then-insert in one transaction. Split across two writes the way
  // the CSV version was, a failure in between is an account whose demand
  // silently reads as zero — which downstream is not "unknown", it is "does
  // not need any meat this week".
  transaction(() => {
    // No demand lines yet is the normal case for a new account, so a delete
    // that matches nothing is expected here rather than a 404.
    remove(DEMANDS_TABLE, { client_id: clientId }, { required: false });
    cleaned.forEach((d) => {
      insert(DEMANDS_TABLE, {
        demand_id: nextId(DEMANDS_TABLE, 'demand_id', 'B2BD'),
        client_id: clientId,
        category: d.category,
        // A real number now, not the CSV's stringified one — the column is
        // REAL and carries a CHECK (qty_kg > 0), which the zero-line filter
        // above already satisfies.
        qty_kg: d.qtyKg,
        cadence: d.cadence,
        notes: d.notes,
        updated_at: now,
      });
    });
  });

  return readBack(clientId);
}

function deleteClient({ id } = {}) {
  const { client_id: clientId } = loadClient(id);

  // Demand lines are meaningless without their client, so they go too —
  // otherwise the next account to take that id would inherit them. The
  // schema's ON DELETE CASCADE would do this on its own, but it is spelled
  // out here so the behaviour doesn't quietly depend on foreign keys being
  // switched on for whichever connection is in play.
  transaction(() => {
    remove(DEMANDS_TABLE, { client_id: clientId }, { required: false });
    remove(CLIENTS_TABLE, { client_id: clientId });
  });

  return { deleted: clientId };
}

export {
  STAGES,
  ONBOARDING_STEPS,
  SAMPLE_OUTCOMES,
  CADENCES,
  listClients,
  addClient,
  updateClient,
  setStage,
  setDemands,
  deleteClient,
};
