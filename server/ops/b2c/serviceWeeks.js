// Service Weeks — is a given week serviceable (kitchen open) or not?
//
// Odoo is the source of truth here, not a knowledge-base CSV: the flag lives
// on the custom "Service Weeks" model (Odoo > Point of Sale > Service Weeks,
// the OPEN/CLOSED "Kitchen" column), so this module reads and writes that
// record directly and keeps no local copy to drift out of sync. That's the
// opposite of weekendStatus.js / orderPackingStatus.js, which own their state
// locally and only mirror it into Odoo best-effort.
//
// Why the schema is discovered instead of hardcoded: Service Weeks is a
// custom (Studio) model, so unlike sale.order its technical names aren't
// stable — Studio generates x_studio_* field names that differ per database,
// and renaming a field in the Studio UI changes them again. So rather than
// guessing 'x_service_week'/'x_studio_kitchen', this introspects ir.model +
// fields_get once per process and caches what it finds. Every piece of that
// can be pinned with an env var if discovery ever picks the wrong field:
//
//   ODOO_SERVICE_WEEK_MODEL         e.g. x_service_week
//   ODOO_SERVICE_WEEK_FROM_FIELD    e.g. x_studio_from
//   ODOO_SERVICE_WEEK_TO_FIELD      e.g. x_studio_to
//   ODOO_SERVICE_WEEK_STATUS_FIELD  e.g. x_studio_kitchen
//
// GET /api/ops/service-weeks/schema reports exactly what was resolved, which
// is the fastest way to check discovery against a real database.
import { execute } from '../../integrations/odoo.js';
import { resolveMenuCategoryId } from '../menu/menuItems.js';

// Bookkeeping/system columns that exist on every Odoo model — never the
// business field we're looking for, and 'active' in particular is a boolean
// that would otherwise be a tempting false match for the open/closed flag.
const NOISE_FIELDS = new Set([
  'active',
  'id',
  'create_uid',
  'create_date',
  'write_uid',
  'write_date',
  '__last_update',
  'display_name',
  'message_is_follower',
  'message_needaction',
  'message_has_error',
  'message_has_sms_error',
  'message_needaction_counter',
  'message_has_error_counter',
  'message_attachment_count',
]);

// Finds the field best matching a set of patterns, most-specific pattern
// first. Within one pattern the human label ("Kitchen", "From") wins over the
// technical name, since on a Studio model the label is what the user actually
// chose and the name is generated noise (x_studio_char_field_a1b2c).
function pickField(fields, { types, patterns, exclude = [] }) {
  const entries = Object.entries(fields).filter(
    ([name, meta]) => types.includes(meta.type) && !NOISE_FIELDS.has(name) && !exclude.includes(name),
  );
  for (const pattern of patterns) {
    const byLabel = entries.find(([, meta]) => pattern.test(meta.string || ''));
    if (byLabel) return byLabel[0];
    const byName = entries.find(([name]) => pattern.test(name));
    if (byName) return byName[0];
  }
  return null;
}

// For a selection-typed status field, work out which option means "open for
// service" and which means "closed". Odoo hands selections over as
// [[value, label], ...]. Falls back to "the other one of exactly two" when
// only one side matches by wording, which covers OPEN/CLOSED-style pairs
// whose closed option is worded unusually (e.g. "Break", "Off week").
function resolveSelectionValues(meta) {
  const options = (meta.selection || []).map(([value, label]) => ({ value, label }));
  if (!options.length) return { openValue: null, closedValue: null, options };

  const open = options.find((o) => /open|serv|avail|yes|on\b/i.test(`${o.value} ${o.label}`));
  const closed = options.find(
    (o) => o !== open && /clos|shut|off|holiday|unavail|break|^no$/i.test(`${o.value} ${o.label}`),
  );

  const openValue = open?.value ?? (options.length === 2 && closed ? options.find((o) => o !== closed)?.value : null);
  const closedValue = closed?.value ?? (options.length === 2 && open ? options.find((o) => o !== open)?.value : null);
  return { openValue: openValue ?? null, closedValue: closedValue ?? null, options };
}

let schemaCache = null;

async function resolveModelName() {
  const pinned = (process.env.ODOO_SERVICE_WEEK_MODEL || '').trim();
  if (pinned) return pinned;

  const candidates = await execute('ir.model', 'search_read', [
    [
      '|',
      '|',
      ['model', 'ilike', 'service_week'],
      ['model', 'ilike', 'serviceweek'],
      ['name', 'ilike', 'service week'],
    ],
    ['model', 'name'],
  ]);

  if (!candidates.length) {
    const err = new Error(
      "Couldn't find a \"Service Weeks\" model in Odoo. If it exists under a different name, set ODOO_SERVICE_WEEK_MODEL in the server's .env to its technical name (Odoo > Settings > Technical > Models), then restart the server.",
    );
    err.status = 502;
    throw err;
  }

  // Prefer an exactly-named "Service Week(s)" model over an incidental match
  // (a line/wizard model that merely mentions it); otherwise shortest
  // technical name, which is the base record rather than a related table.
  const exact = candidates.find((c) => /^service weeks?$/i.test((c.name || '').trim()));
  if (exact) return exact.model;
  return candidates.sort((a, b) => a.model.length - b.model.length)[0].model;
}

async function resolveSchema() {
  if (schemaCache) return schemaCache;

  const model = await resolveModelName();
  const fields = await execute(model, 'fields_get', [], {
    attributes: ['string', 'type', 'selection', 'relation', 'readonly', 'store'],
  });

  const envFrom = (process.env.ODOO_SERVICE_WEEK_FROM_FIELD || '').trim();
  const envTo = (process.env.ODOO_SERVICE_WEEK_TO_FIELD || '').trim();
  const envStatus = (process.env.ODOO_SERVICE_WEEK_STATUS_FIELD || '').trim();

  const fromField =
    envFrom || pickField(fields, { types: ['date', 'datetime'], patterns: [/^from$/i, /\bfrom\b/i, /start/i, /begin/i] });
  // Exclude whatever "from" resolved to, so a single date field can't end up
  // serving as both ends of the range.
  const toField =
    envTo ||
    pickField(fields, {
      types: ['date', 'datetime'],
      patterns: [/^to$/i, /\bto\b/i, /end/i, /until/i],
      exclude: [fromField].filter(Boolean),
    });
  const statusField =
    envStatus ||
    pickField(fields, {
      types: ['boolean', 'selection'],
      patterns: [/kitchen/i, /servic/i, /^open/i, /\bopen\b/i, /^status$/i, /state/i],
    });

  if (!statusField) {
    const err = new Error(
      `Found the Service Weeks model (${model}) but no open/closed field on it. Set ODOO_SERVICE_WEEK_STATUS_FIELD in the server's .env to the technical name of its Kitchen field, then restart the server.`,
    );
    err.status = 502;
    throw err;
  }

  const statusMeta = fields[statusField];
  if (!statusMeta) {
    const err = new Error(`Field "${statusField}" doesn't exist on ${model} — check ODOO_SERVICE_WEEK_STATUS_FIELD.`);
    err.status = 502;
    throw err;
  }

  const statusType = statusMeta.type;
  const { openValue, closedValue, options } = statusType === 'selection'
    ? resolveSelectionValues(statusMeta)
    : { openValue: null, closedValue: null, options: [] };

  if (statusType === 'selection' && (openValue == null || closedValue == null)) {
    const err = new Error(
      `Couldn't tell which values of ${model}.${statusField} mean open vs closed (options: ${
        options.map((o) => `${o.value}/${o.label}`).join(', ') || 'none'
      }).`,
    );
    err.status = 502;
    throw err;
  }

  // Optional extras — nice context in the panel, never worth failing over.
  const nameField = fields.x_name ? 'x_name' : fields.name ? 'name' : null;
  const menuField = pickField(fields, {
    types: ['many2many', 'one2many'],
    patterns: [/menu/i],
  });

  schemaCache = {
    model,
    nameField,
    fromField,
    toField,
    statusField,
    statusType,
    statusLabel: statusMeta.string || 'Kitchen',
    statusReadonly: Boolean(statusMeta.readonly),
    openValue,
    closedValue,
    menuField,
    menuRelation: menuField ? fields[menuField]?.relation || null : null,
  };
  return schemaCache;
}

function readIsOpen(record, schema) {
  const raw = record[schema.statusField];
  if (schema.statusType === 'boolean') return Boolean(raw);
  return raw === schema.openValue;
}

// The value to write for an open/closed flag, whichever shape the field is.
function statusValueFor(schema, isOpen) {
  if (schema.statusType === 'boolean') return Boolean(isOpen);
  return isOpen ? schema.openValue : schema.closedValue;
}

function toWeek(record, schema, menuNamesById) {
  const menuIds = schema.menuField ? record[schema.menuField] || [] : [];
  return {
    id: record.id,
    name: (schema.nameField ? record[schema.nameField] : record.display_name) || `Week ${record.id}`,
    from: (schema.fromField ? record[schema.fromField] : null) || null,
    to: (schema.toField ? record[schema.toField] : null) || null,
    isOpen: readIsOpen(record, schema),
    // Ids as well as names: the menu editor needs them to pre-select what's
    // already on the week, and names alone can't be mapped back to products.
    menuIds,
    menu: menuIds.map((id) => menuNamesById?.get(id)).filter(Boolean),
  };
}

function readFields(schema) {
  return [
    ...new Set(
      ['id', 'display_name', schema.nameField, schema.fromField, schema.toField, schema.statusField, schema.menuField].filter(
        Boolean,
      ),
    ),
  ];
}

// Resolves the "Menu This Week" ids into product names in one batched read.
// Best-effort: the panel is about open/closed, so a failure here just means
// no menu chips, never a failed request.
async function loadMenuNames(records, schema) {
  if (!schema.menuField || !schema.menuRelation) return null;
  const ids = [...new Set(records.flatMap((r) => r[schema.menuField] || []))];
  if (!ids.length) return null;
  try {
    const rows = await execute(schema.menuRelation, 'read', [ids, ['display_name']]);
    return new Map(rows.map((row) => [row.id, row.display_name]));
  } catch {
    return null;
  }
}

// Everything overlapping [from, to], for the month view: a weekend card needs
// whichever record *covers* it, and that record may start before the month
// (the legacy Mon-Sun weeks) or end after it, so this is an overlap test, not
// a containment one. Both ends inclusive, matching findOverlappingWeek().
function rangeDomain(schema, from, to) {
  if (!from || !to || !schema.fromField || !schema.toField) return [];
  return [
    [schema.fromField, '<=', to],
    [schema.toField, '>=', from],
  ];
}

async function fetchServiceWeeks({ limit = 12, from = '', to = '' } = {}) {
  const schema = await resolveSchema();
  const domain = rangeDomain(schema, String(from).slice(0, 10), String(to).slice(0, 10));
  const records = await execute(schema.model, 'search_read', [domain, readFields(schema)], {
    // A date range is already bounded — a month holds at most a handful of
    // weeks — so `limit` only guards the unfiltered "latest weeks" call. It's
    // omitted rather than set to 0 for the range case: Odoo reads limit=0 as
    // "return nothing", not "no limit".
    ...(domain.length ? {} : { limit: Number(limit) || 12 }),
    // Newest first from Odoo so `limit` keeps the *current and upcoming*
    // weeks rather than ancient ones; flipped back to chronological below.
    order: schema.fromField ? `${schema.fromField} desc` : 'id desc',
  });

  const menuNamesById = await loadMenuNames(records, schema);
  const weeks = records
    .map((record) => toWeek(record, schema, menuNamesById))
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));

  return {
    weeks,
    schema: publicSchema(schema),
    editable: !schema.statusReadonly,
    // Creating a week needs somewhere to put the dates; editing a menu needs
    // the m2m. Either can be missing on a differently-built Studio model, and
    // the UI hides those controls rather than offering a button that can only
    // fail.
    creatable: Boolean(schema.fromField && schema.toField),
    menuEditable: Boolean(schema.menuField && schema.menuRelation),
  };
}

// Toggling a weekend that has no Service Week record yet creates one, so the
// month view can list every weekend up front and the pitmaster never has to
// fill in a form before flipping a switch. `id` is still honoured when the
// caller already knows the record; otherwise from/to identify the weekend and
// an existing record *covering* it wins over creating a second, overlapping
// one — that's how the legacy Mon-Sun weeks keep working under weekend cards.
async function setServiceWeekOpen({ id, from, to, isOpen }) {
  const schema = await resolveSchema();

  if (!id) {
    if (!from || !to) {
      const err = new Error('id, or a from/to date range, is required.');
      err.status = 400;
      throw err;
    }
    const covering = await findOverlappingWeek(schema, normalizeDate(from, 'from'), normalizeDate(to, 'to'));
    if (covering) id = covering.id;
    else return createServiceWeek({ from, to, isOpen });
  }

  await execute(schema.model, 'write', [[Number(id)], { [schema.statusField]: statusValueFor(schema, isOpen) }]);

  return { week: await readWeek(id, schema) };
}

// Read back rather than echoing what was requested — Odoo is the source of
// truth, and an automation/compute on the model could legitimately land on
// something other than what was asked for. Every write below returns through
// here so the client always renders what Odoo actually stored.
async function readWeek(id, schema) {
  const [record] = await execute(schema.model, 'read', [[Number(id)], readFields(schema)]);
  if (!record) {
    const err = new Error(`Service Week ${id} not found in Odoo.`);
    err.status = 404;
    throw err;
  }
  const menuNamesById = await loadMenuNames([record], schema);
  return toWeek(record, schema, menuNamesById);
}

// ---- Creating a week ------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeDate(value, label) {
  // Odoo date fields are plain 'YYYY-MM-DD'; accept a datetime too and keep
  // the date half, which is what an <input type="date"> or a copied Odoo
  // value will hand over.
  const text = String(value || '').slice(0, 10);
  if (!DATE_RE.test(text)) {
    const err = new Error(`"${label}" must be a date in YYYY-MM-DD format.`);
    err.status = 400;
    throw err;
  }
  return text;
}

// A Sat-Sun pair is the unit the kitchen actually trades in, so those records
// read as "Weekend of ..."; anything else keeps the "Week of 24-31 Aug 2026"
// wording the weeks already in this database use, so an auto-named record is
// indistinguishable from a hand-made one either way.
function isWeekendPair(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  return new Date(fy, fm - 1, fd).getDay() === 6 && addDays(from, 1) === to;
}

function defaultWeekName(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const unit = isWeekendPair(from, to) ? 'Weekend' : 'Week';
  if (fy === ty && fm === tm) return `${unit} of ${fd}-${td} ${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty) return `${unit} of ${fd} ${MONTHS[fm - 1]}-${td} ${MONTHS[tm - 1]} ${fy}`;
  return `${unit} of ${fd} ${MONTHS[fm - 1]} ${fy}-${td} ${MONTHS[tm - 1]} ${ty}`;
}

// Local-calendar date arithmetic on a 'YYYY-MM-DD' string — never UTC, so a
// day can't shift backwards for IST.
function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// Two service weeks covering the same day would make "is this week open?"
// ambiguous for every consumer of this data, so overlaps are rejected rather
// than silently created. Ranges are inclusive on both ends, matching how
// isCurrentWeek() reads them in the UI.
async function findOverlappingWeek(schema, from, to) {
  if (!schema.fromField || !schema.toField) return null;
  const [row] = await execute(
    schema.model,
    'search_read',
    [
      [
        [schema.fromField, '<=', to],
        [schema.toField, '>=', from],
      ],
      readFields(schema),
    ],
    { limit: 1 },
  );
  return row || null;
}

async function createServiceWeek({ name, from, to, isOpen = true, menuIds = [] }) {
  const schema = await resolveSchema();
  if (!schema.fromField || !schema.toField) {
    const err = new Error(
      `Found the Service Weeks model (${schema.model}) but no From/To date fields to write, so a week can't be created from here. Set ODOO_SERVICE_WEEK_FROM_FIELD and ODOO_SERVICE_WEEK_TO_FIELD in the server's .env, then restart the server.`,
    );
    err.status = 502;
    throw err;
  }

  const fromDate = normalizeDate(from, 'from');
  const toDate = normalizeDate(to, 'to');
  if (fromDate > toDate) {
    const err = new Error('The "to" date can\'t be before the "from" date.');
    err.status = 400;
    throw err;
  }

  const clash = await findOverlappingWeek(schema, fromDate, toDate);
  if (clash) {
    const clashWeek = toWeek(clash, schema, null);
    const err = new Error(
      `That range overlaps an existing service week (${clashWeek.name}: ${clashWeek.from} to ${clashWeek.to}). Edit that week instead, or pick dates outside it.`,
    );
    err.status = 409;
    throw err;
  }

  const values = {
    [schema.fromField]: fromDate,
    [schema.toField]: toDate,
    [schema.statusField]: statusValueFor(schema, isOpen),
  };
  if (schema.nameField) values[schema.nameField] = String(name || '').trim() || defaultWeekName(fromDate, toDate);

  const productIds = toIdList(menuIds);
  // Odoo many2many write command 6 = "replace the whole set with these ids".
  if (productIds.length && schema.menuField) values[schema.menuField] = [[6, 0, productIds]];

  const id = await execute(schema.model, 'create', [values]);
  return { week: await readWeek(id, schema) };
}

// ---- This week's menu -----------------------------------------------------

async function setServiceWeekMenu({ id, productIds }) {
  if (!id) {
    const err = new Error('id is required.');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(productIds)) {
    const err = new Error('productIds must be an array of Odoo product ids.');
    err.status = 400;
    throw err;
  }

  const schema = await resolveSchema();
  if (!schema.menuField) {
    const err = new Error(
      `Found the Service Weeks model (${schema.model}) but no "Menu This Week" field on it, so the menu can't be edited from here.`,
    );
    err.status = 502;
    throw err;
  }

  await execute(schema.model, 'write', [[Number(id)], { [schema.menuField]: [[6, 0, toIdList(productIds)]] }]);
  return { week: await readWeek(id, schema) };
}

// Everything that may legitimately go on a week's menu, for the picker. The
// menu field points at product.template, which in this database also holds raw
// materials and packaging (Cabbage, 500ml Round Container, ...) — none of which
// belong on a customer-facing menu — so the picker is scoped to the same
// "Finished Products" category menuItems.js edits, resolved by that module.
async function fetchMenuOptions() {
  const schema = await resolveSchema();
  if (!schema.menuField || !schema.menuRelation) return { options: [], menuEditable: false };

  const categoryId = await resolveMenuCategoryId();
  const domain = categoryId ? [['categ_id', 'child_of', categoryId]] : [['sale_ok', '=', true]];

  let rows;
  try {
    rows = await execute(schema.menuRelation, 'search_read', [domain, ['display_name', 'categ_id']], { order: 'name' });
  } catch {
    // A relation without categ_id/sale_ok isn't a product model at all — fall
    // back to listing it unfiltered rather than failing the whole picker.
    rows = await execute(schema.menuRelation, 'search_read', [[], ['display_name']], { limit: 200 });
  }

  return {
    menuEditable: true,
    options: rows.map((row) => ({
      id: row.id,
      name: row.display_name,
      // 'Food / Finished Products / Pork Tacos' -> 'Pork Tacos', which is what
      // reads well as a group heading in the picker.
      category: Array.isArray(row.categ_id) ? String(row.categ_id[1] || '').split('/').pop().trim() : '',
    })),
  };
}

// What discovery resolved, for the /schema debug route. No secrets involved —
// this is model/field metadata only.
function publicSchema(schema) {
  return {
    model: schema.model,
    fromField: schema.fromField,
    toField: schema.toField,
    statusField: schema.statusField,
    statusType: schema.statusType,
    statusLabel: schema.statusLabel,
    statusReadonly: schema.statusReadonly,
    openValue: schema.openValue,
    closedValue: schema.closedValue,
    nameField: schema.nameField,
    menuField: schema.menuField,
    menuRelation: schema.menuRelation,
  };
}

async function describeServiceWeekSchema() {
  return publicSchema(await resolveSchema());
}

export {
  fetchServiceWeeks,
  setServiceWeekOpen,
  createServiceWeek,
  setServiceWeekMenu,
  fetchMenuOptions,
  describeServiceWeekSchema,
};
