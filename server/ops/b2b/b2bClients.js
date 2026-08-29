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
// Storage is two CSVs in the knowledge-base Data folder, created on first
// use. Deliberately NOT in knowledgeBase.js's FILES map — everything listed
// there counts toward getConfig().configured, and a knowledge-base checkout
// that predates this module would start reporting itself as unconfigured to
// the purchasing/smoking screens over two files they don't use. Same
// reasoning as server/marketing/aiSeo.js.
import fs from 'fs';
import path from 'path';
import { readCsvFile, writeCsvFile, nextSequentialId } from '../../core/csvStore.js';
import { getDataDir } from '../../core/knowledgeBase.js';
import { MEAT_CATEGORY_KEYS, MEAT_CATEGORY_LABELS } from '../../core/meatConfig.js';

// Paths relative to the knowledge-base Data folder — both files live under
// Data/B2B since the 2026-08-19 reorganisation. Same convention as the
// FILES map in server/core/knowledgeBase.js; these two aren't in it because this
// module creates them on first use rather than the repo shipping them.
const CLIENTS_FILE = 'B2B/b2b_clients.csv';
const DEMANDS_FILE = 'B2B/b2b_client_demands.csv';

const CLIENTS_HEADER = [
  'client_id',
  'name',
  'business_type',
  'stage',
  'contact_name',
  'contact_role',
  'phone',
  'email',
  'area',
  'address',
  'gstin',
  'lead_source',
  'order_day',
  'notes',
  // Sampling stage
  'sample_sent_on',
  'sample_items',
  'sample_feedback',
  'sample_outcome',
  // Onboarding stage
  'onboarding_steps',
  'price_list',
  'payment_terms',
  'odoo_partner_id',
  'onboarded_on',
  // Bookkeeping
  'lost_reason',
  'created_at',
  'updated_at',
];

// One row per client per meat category. A separate file rather than a packed
// cell on the client row so the demand table stays something you can open in
// Excel and pivot — "how much chicken does B2B want in total" is then a
// column sum, not a parsing exercise.
const DEMANDS_HEADER = ['demand_id', 'client_id', 'category', 'qty_kg', 'cadence', 'notes', 'updated_at'];

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

// Semicolons join list-valued cells (sample items, onboarding steps) for the
// same reason as aiSeo.js: commas would encode fine, but a menu item with a
// comma in it is ambiguous to anyone opening the file in Excel.
const LIST_SEP = ';';

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    const err = new Error(
      `Knowledge-base Data folder not found at ${dir}. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env if that repo lives somewhere else.`,
    );
    err.status = 503;
    throw err;
  }
  return dir;
}

function ensureFile(fileName, header) {
  const p = path.join(ensureDataDir(), fileName);
  if (!fs.existsSync(p)) {
    // fileName now names a subfolder, which a fresh knowledge-base checkout
    // may not have yet — create it rather than failing the first write.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${header.join(',')}\n`, 'utf8');
    return p;
  }
  // Migrate an older file up to the current header, same reasoning as
  // orderPackingStatus.js: writeCsvFile only writes the columns the header
  // names, so a file still carrying an older schema would silently drop
  // every column added since — on every save, with no error to show for it.
  const { header: existing, rows } = readCsvFile(p);
  if (!header.every((column) => existing.includes(column))) writeCsvFile(p, header, rows);
  return p;
}

function loadClients() {
  const p = ensureFile(CLIENTS_FILE, CLIENTS_HEADER);
  return { path: p, ...readCsvFile(p) };
}

function loadDemands() {
  const p = ensureFile(DEMANDS_FILE, DEMANDS_HEADER);
  return { path: p, ...readCsvFile(p) };
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
// either the CSV or the tiles.
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
    odooPartnerId: row.odoo_partner_id || '',
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
  const { rows } = loadClients();
  const { rows: demandRows } = loadDemands();
  const demandsByClient = groupDemands(demandRows);
  const clients = rows
    .filter((row) => row.client_id)
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

// JSON key -> CSV column for the generic update path. Everything a caller is
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

function findRow(rows, id) {
  const row = rows.find((r) => r.client_id === String(id || '').trim());
  if (!row) {
    const err = new Error(`No B2B client with id ${id}.`);
    err.status = 404;
    throw err;
  }
  return row;
}

function addClient({ name, businessType, stage, contactName, phone, email, area, notes } = {}) {
  const clean = String(name || '').trim();
  if (!clean) badRequest('A client name is required.');

  const { path: p, rows } = loadClients();
  if (rows.some((r) => (r.name || '').trim().toLowerCase() === clean.toLowerCase())) {
    const err = new Error(`"${clean}" is already on the B2B client list.`);
    err.status = 409;
    throw err;
  }

  const now = new Date().toISOString();
  const row = {};
  CLIENTS_HEADER.forEach((column) => {
    row[column] = '';
  });
  Object.assign(row, {
    client_id: nextSequentialId(rows, 'client_id', 'B2B'),
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
  });

  writeCsvFile(p, CLIENTS_HEADER, [...rows, row]);
  return { client: toClient(row, new Map()) };
}

function updateClient({ id, ...fields } = {}) {
  const { path: p, rows } = loadClients();
  const row = findRow(rows, id);

  Object.entries(EDITABLE_FIELDS).forEach(([key, column]) => {
    if (fields[key] === undefined) return;
    row[column] = String(fields[key] ?? '').trim();
  });

  if (fields.sampleItems !== undefined) {
    const items = Array.isArray(fields.sampleItems) ? fields.sampleItems : splitList(fields.sampleItems);
    row.sample_items = items
      .map((s) => String(s).trim())
      .filter(Boolean)
      .join(LIST_SEP);
  }
  if (fields.sampleOutcome !== undefined) {
    const outcome = String(fields.sampleOutcome || '').trim();
    if (!SAMPLE_OUTCOME_KEYS.includes(outcome)) badRequest(`"${outcome}" is not a sample outcome.`);
    row.sample_outcome = outcome;
  }
  if (fields.onboardingSteps !== undefined) {
    const steps = (Array.isArray(fields.onboardingSteps) ? fields.onboardingSteps : splitList(fields.onboardingSteps))
      .map((s) => String(s).trim())
      .filter(Boolean);
    const unknown = steps.find((s) => !ONBOARDING_STEP_KEYS.includes(s));
    if (unknown) badRequest(`"${unknown}" is not an onboarding step.`);
    // Stored in checklist order rather than click order, so the cell reads
    // the same as the list on screen.
    row.onboarding_steps = ONBOARDING_STEP_KEYS.filter((key) => steps.includes(key)).join(LIST_SEP);
  }
  if (!String(row.name || '').trim()) badRequest('A client name is required.');

  row.updated_at = new Date().toISOString();
  writeCsvFile(p, CLIENTS_HEADER, rows);

  const { rows: demandRows } = loadDemands();
  return { client: toClient(row, groupDemands(demandRows)) };
}

function setStage({ id, stage, lostReason } = {}) {
  if (!STAGE_KEYS.includes(stage)) badRequest(`"${stage}" is not a pipeline stage.`);

  const { path: p, rows } = loadClients();
  const row = findRow(rows, id);
  row.stage = stage;
  // Stamped the first time an account goes live and left alone after that —
  // a pause and a restart shouldn't rewrite when they were actually won.
  if (stage === 'active' && !row.onboarded_on) row.onboarded_on = new Date().toISOString().slice(0, 10);
  if (stage === 'lost' && lostReason !== undefined) row.lost_reason = String(lostReason || '').trim();
  row.updated_at = new Date().toISOString();
  writeCsvFile(p, CLIENTS_HEADER, rows);

  const { rows: demandRows } = loadDemands();
  return { client: toClient(row, groupDemands(demandRows)) };
}

// Replaces a client's whole demand list in one call. Replace rather than
// per-line edits because the UI edits the table as a block, and a partial
// save is the one way to end up with a demand row nobody meant to keep.
function setDemands({ id, demands } = {}) {
  if (!Array.isArray(demands)) badRequest('demands must be an array.');

  const { rows: clientRows } = loadClients();
  const clientRow = findRow(clientRows, id);
  const clientId = clientRow.client_id;

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

  const { path: p, rows } = loadDemands();
  const working = rows.filter((r) => r.client_id !== clientId);
  cleaned.forEach((d) => {
    working.push({
      demand_id: nextSequentialId(working, 'demand_id', 'B2BD'),
      client_id: clientId,
      category: d.category,
      qty_kg: String(d.qtyKg),
      cadence: d.cadence,
      notes: d.notes,
      updated_at: now,
    });
  });

  writeCsvFile(p, DEMANDS_HEADER, working);
  return { client: toClient(clientRow, groupDemands(working)) };
}

function deleteClient({ id } = {}) {
  const { path: p, rows } = loadClients();
  const row = findRow(rows, id);
  writeCsvFile(
    p,
    CLIENTS_HEADER,
    rows.filter((r) => r !== row),
  );

  // Demand lines are meaningless without their client, so they go too —
  // otherwise the next client to take that id would inherit them.
  const { path: demandPath, rows: demandRows } = loadDemands();
  const kept = demandRows.filter((r) => r.client_id !== row.client_id);
  if (kept.length !== demandRows.length) writeCsvFile(demandPath, DEMANDS_HEADER, kept);

  return { deleted: row.client_id };
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
