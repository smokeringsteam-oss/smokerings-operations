// Menu items — the dishes themselves, edited straight in Odoo.
//
// Distinct from serviceWeeks.js, which only decides *which* of these items a
// given week sells: this module edits the item records. Odoo is the source of
// truth either way, so nothing is cached locally and every write reads back
// what Odoo actually stored.
//
// A "menu item" is a product.template under the "Finished Products" category.
// That scoping matters: product.template in this database also holds raw
// materials and packaging (Cabbage, 500ml Round Container), and an editor that
// could reach those would let a menu screen silently repriced a purchase
// ingredient. Every read and every write below is fenced to that subtree, and
// writes additionally re-check the target is inside it before touching it.
//
// The category is discovered by name rather than hardcoded, matching how
// serviceWeeks.js resolves its Studio schema. Pin it with
// ODOO_SERVICE_WEEK_MENU_CATEGORY (an id or a name fragment) if the guess is
// ever wrong.
//
// Within that subtree the two sales channels are separate categories: the
// bulk wholesale products live under "Finished Products / B2B Wholesale"
// (the B2B-xxx codes), and everything else is the B2C weekend menu. Reads
// take a `channel` so the B2C dashboard's menu editor doesn't list bulk 1kg
// packs alongside burgers, and the B2B dashboard can show only those. Pin
// the wholesale category with ODOO_B2B_MENU_CATEGORY if it gets renamed.
//
// Every write that changes a field menu.csv also carries is mirrored onto
// that file afterwards (see menuCsvMirror.js) — Odoo remains the source of
// truth, but the knowledge base is what the prep planner and the content
// tools read, so the two are kept in step instead of drifting apart. The
// mirror is best-effort: its outcome rides back on the response as `csv`
// rather than failing a save Odoo already accepted.
import { execute } from '../../integrations/odoo.js';
import { mirrorMenuItemToCsv, resolveMenuIds } from './menuCsvMirror.js';

// image_128 rather than image_1920: Odoo derives the smaller variants
// automatically, and the full-size one runs ~400kb of base64 per product,
// which would make listing the menu roughly 40x heavier for a thumbnail
// nobody views at that size. Writes still go to image_1920 — it's the only
// writable image field, and Odoo regenerates the rest from it.
const MENU_ITEM_FIELDS = [
  'name',
  'default_code',
  'list_price',
  'description_sale',
  'categ_id',
  'active',
  'sale_ok',
  'available_in_pos',
  'image_128',
];

// Guards the upload before it reaches Odoo. 8mb of decoded image is far more
// than a menu photo needs and still leaves room under the 16mb body limit
// once base64 inflation is accounted for.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

// Archived records are invisible to search unless this is in the context —
// needed both to list them and to find one again in order to unarchive it.
const WITH_ARCHIVED = { active_test: false };

let menuCategoryCache;
let b2bCategoryCache;

// Nullable: read-only callers can fall back to something looser.
async function resolveMenuCategoryId() {
  if (menuCategoryCache !== undefined) return menuCategoryCache;

  const pinned = (process.env.ODOO_SERVICE_WEEK_MENU_CATEGORY || '').trim();
  if (pinned && /^\d+$/.test(pinned)) {
    menuCategoryCache = Number(pinned);
    return menuCategoryCache;
  }

  const rows = await execute('product.category', 'search_read', [
    [['complete_name', 'ilike', pinned || 'finished product']],
    ['complete_name'],
  ]);
  // Shortest complete_name is the parent ("Food / Finished Products") rather
  // than one of its children ("Food / Finished Products / Pork Tacos"), and
  // child_of on the parent covers all of them.
  menuCategoryCache = rows.length
    ? rows.sort((a, b) => (a.complete_name || '').length - (b.complete_name || '').length)[0].id
    : null;
  return menuCategoryCache;
}

// The wholesale sub-category, resolved the same way. Nullable, and a null is
// not an error for reads: a database with no B2B category simply has no B2B
// items, so a 'b2c' read is then the whole menu and a 'b2b' read is empty.
async function resolveB2bCategoryId() {
  if (b2bCategoryCache !== undefined) return b2bCategoryCache;

  const pinned = (process.env.ODOO_B2B_MENU_CATEGORY || '').trim();
  if (pinned && /^\d+$/.test(pinned)) {
    b2bCategoryCache = Number(pinned);
    return b2bCategoryCache;
  }

  const rows = await execute('product.category', 'search_read', [
    [['complete_name', 'ilike', pinned || 'b2b']],
    ['complete_name'],
  ]);
  // Same shortest-name rule as above: the parent, not one of its children.
  b2bCategoryCache = rows.length
    ? rows.sort((a, b) => (a.complete_name || '').length - (b.complete_name || '').length)[0].id
    : null;
  return b2bCategoryCache;
}

// Writes refuse to guess. Without a known menu category there's no safe fence
// around which products this module may touch, so it stops rather than
// falling back to something broader.
async function requireMenuCategoryId() {
  const categoryId = await resolveMenuCategoryId();
  if (!categoryId) {
    const err = new Error(
      "Couldn't find a \"Finished Products\" product category in Odoo, so there's no safe way to tell menu items apart from raw materials. Set ODOO_SERVICE_WEEK_MENU_CATEGORY in the server's .env to that category's name or id, then restart the server.",
    );
    err.status = 502;
    throw err;
  }
  return categoryId;
}

// Odoo stores the bytes without recording a mime type, and it re-encodes
// uploads (image_128 is JPEG even when the original was a PNG), so the format
// is read back off the base64 magic prefix rather than remembered. Browsers
// sniff the bytes anyway; this just keeps the data URI honest.
function sniffImageMime(base64) {
  const head = String(base64).slice(0, 12);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  return 'image/jpeg';
}

function toMenuItem(record) {
  return {
    id: record.id,
    name: record.name || '',
    code: record.default_code || '',
    price: typeof record.list_price === 'number' ? record.list_price : 0,
    description: record.description_sale || '',
    // 'Food / Finished Products / Pork Tacos' -> 'Pork Tacos'.
    category: Array.isArray(record.categ_id) ? String(record.categ_id[1] || '').split('/').pop().trim() : '',
    isArchived: record.active === false,
    // Odoo splits "sellable" across two flags. They're kept in step on write
    // (see updateMenuItem), and sale_ok is what's reported back, so the pair
    // never presents as a third, half-on state.
    isAvailable: Boolean(record.sale_ok),
    // Odoo hands binaries over as bare base64; the browser needs a data URI to
    // put it in an <img src>. Odoo returns `false`, not null, when unset.
    image: record.image_128 ? `data:${sniffImageMime(record.image_128)};base64,${record.image_128}` : null,
  };
}

async function readMenuItem(id) {
  const [record] = await execute('product.template', 'read', [[Number(id)], MENU_ITEM_FIELDS], {
    context: WITH_ARCHIVED,
  });
  if (!record) {
    const err = new Error(`Menu item ${id} not found in Odoo.`);
    err.status = 404;
    throw err;
  }
  return toMenuItem(record);
}

// Confirms the id is a menu item before any write touches it, so a stray or
// hand-crafted id can't reprice a raw material through this route.
async function assertMenuItem(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    const err = new Error('A valid menu item id is required.');
    err.status = 400;
    throw err;
  }
  const categoryId = await requireMenuCategoryId();
  const rows = await execute(
    'product.template',
    'search_read',
    [
      [
        ['id', '=', numericId],
        ['categ_id', 'child_of', categoryId],
      ],
      ['id'],
    ],
    { context: WITH_ARCHIVED, limit: 1 },
  );
  if (!rows.length) {
    const err = new Error(`${id} isn't a menu item (nothing under Finished Products with that id), so it wasn't changed.`);
    err.status = 404;
    throw err;
  }
  return numericId;
}

// `channel` is 'b2c' (the weekend consumer menu, the default), 'b2b' (the
// bulk wholesale products) or 'all'. B2C is expressed as "in the menu subtree
// but not in the wholesale one" rather than an allow-list of categories, so a
// new dish in a brand-new category still shows up on the B2C editor instead of
// quietly going missing.
async function fetchMenuItems({ includeArchived = false, channel = 'b2c' } = {}) {
  const categoryId = await resolveMenuCategoryId();
  const domain = categoryId ? [['categ_id', 'child_of', categoryId]] : [['sale_ok', '=', true]];

  if (channel === 'b2b' || channel === 'b2c') {
    const b2bId = await resolveB2bCategoryId();
    if (b2bId) {
      if (channel === 'b2b') domain.push(['categ_id', 'child_of', b2bId]);
      // Odoo domains are prefix notation, so the '!' goes before the term it
      // negates rather than after it.
      else domain.push('!', ['categ_id', 'child_of', b2bId]);
    } else if (channel === 'b2b') {
      return { items: [], editable: false };
    }
  }

  const records = await execute('product.template', 'search_read', [domain, MENU_ITEM_FIELDS], {
    order: 'name',
    ...(includeArchived ? { context: WITH_ARCHIVED } : {}),
  });

  // Each item carries the knowledge-base menu_id its recipe hangs off, so the
  // recipe panel can open a dish's BoM without a second matching round-trip.
  // null means no menu.csv row matched — the panel says so rather than
  // showing an empty recipe that looks like "this dish has no ingredients".
  const items = records.map(toMenuItem);
  const menuIds = resolveMenuIds(items);
  items.forEach((item) => {
    item.menuId = menuIds.get(item.id) || null;
  });

  return {
    items,
    // Without a resolved category the list is a loose guess, so the editor
    // stays read-only rather than writing against an unfenced set.
    editable: Boolean(categoryId),
  };
}

async function updateMenuItem({ id, name, price, description, isAvailable }) {
  const numericId = await assertMenuItem(id);

  // Only fields actually supplied are written — the editor can send a single
  // changed field without clearing everything else on the record.
  const values = {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      const err = new Error('A menu item needs a name.');
      err.status = 400;
      throw err;
    }
    values.name = trimmed;
  }

  if (price !== undefined) {
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      const err = new Error('Price must be a number and cannot be negative.');
      err.status = 400;
      throw err;
    }
    values.list_price = numericPrice;
  }

  if (description !== undefined) values.description_sale = String(description);

  if (isAvailable !== undefined) {
    // Both flags move together so "available" stays a single idea on the
    // dashboard rather than two that can disagree.
    values.sale_ok = Boolean(isAvailable);
    values.available_in_pos = Boolean(isAvailable);
  }

  if (!Object.keys(values).length) {
    const err = new Error('Nothing to update.');
    err.status = 400;
    throw err;
  }

  await execute('product.template', 'write', [[numericId], values]);
  const item = await readMenuItem(numericId);

  // Only the fields this call actually wrote are mirrored, so saving a new
  // price can't overwrite a hand-written knowledge-base name.
  //
  // description_sale is not among them: Odoo is the one place a dish's blurb
  // lives (see menuCsvMirror.js). A description-only save still calls the
  // mirror, which changes nothing but backfills the odoo_product_id pin.
  const mirroredFields = [];
  if (values.name !== undefined) mirroredFields.push('name');
  if (values.list_price !== undefined) mirroredFields.push('price');
  if (values.sale_ok !== undefined) mirroredFields.push('available');

  return { item, csv: mirrorMenuItemToCsv(item, mirroredFields) };
}

// Replaces a menu item's picture, or clears it when `image` is null/empty.
//
// Accepts either a full data URI (what a browser's FileReader produces) or
// bare base64. Only the payload goes to Odoo — image_1920 stores raw base64,
// and passing the "data:image/png;base64," prefix through would corrupt it.
// Odoo downsizes to 1920px and regenerates image_1024/512/256/128 itself, so
// there's nothing to resize here.
async function setMenuItemImage({ id, image }) {
  const numericId = await assertMenuItem(id);

  if (image === null || image === undefined || image === '') {
    await execute('product.template', 'write', [[numericId], { image_1920: false }]);
    return { item: await readMenuItem(numericId) };
  }

  if (typeof image !== 'string') {
    const err = new Error('image must be a base64 string, a data: URI, or null to remove the picture.');
    err.status = 400;
    throw err;
  }

  let payload = image.trim();
  const match = payload.match(DATA_URI_RE);
  if (match) {
    payload = match[2];
  } else if (payload.startsWith('data:')) {
    // A data URI that isn't an image — a PDF or a text file renamed to .jpg
    // would land here rather than becoming an unreadable product image.
    const err = new Error('That file isn\'t an image. Pick a JPG, PNG or WebP.');
    err.status = 400;
    throw err;
  }

  payload = payload.replace(/\s/g, '');
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    const err = new Error("That picture couldn't be read. Try re-saving it as a JPG or PNG.");
    err.status = 400;
    throw err;
  }

  // Decoded size, not base64 length — base64 runs about a third larger, and
  // the limit users care about is the size of the file they picked.
  const decodedBytes = Math.floor((payload.length * 3) / 4);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    const err = new Error(
      `That picture is ${(decodedBytes / (1024 * 1024)).toFixed(1)}mb. Please use one under ${
        MAX_IMAGE_BYTES / (1024 * 1024)
      }mb.`,
    );
    err.status = 413;
    throw err;
  }

  await execute('product.template', 'write', [[numericId], { image_1920: payload }]);
  return { item: await readMenuItem(numericId) };
}

// Archive rather than delete: Odoo blocks unlinking a product with order
// history anyway, and archiving keeps that history intact while taking the
// item off the menu and out of the pickers. Fully reversible.
async function setMenuItemArchived({ id, archived }) {
  const numericId = await assertMenuItem(id);
  await execute('product.template', 'write', [[numericId], { active: !archived }]);
  const item = await readMenuItem(numericId);
  // Archiving takes the dish off the menu, which is exactly what is_active=no
  // means in menu.csv — so the one flag that file has moves with it.
  return { item, csv: mirrorMenuItemToCsv(item, ['available']) };
}


// ---- Full product record: every writable field on the Odoo product form ---
//
// The editor above covers the four fields the menu is usually changed
// through (name, price, description, photo). This part backs the "All Odoo
// product fields" panel, which exposes the rest of the product.template
// record — internal reference, cost, unit of measure, taxes, HSN code, POS
// setup, the x_ custom fields this business added, and so on.
//
// The field list is discovered from Odoo (fields_get) rather than hardcoded,
// for the same reason the category is: a Studio field added or renamed in
// Odoo should show up here without a code change, and hardcoding would mean
// this panel silently lags the real product form. What's offered is decided
// by Odoo's own metadata — anything Odoo says is writable and of a type this
// UI can render.
//
// Everything else about the module's safety still applies: reads and writes
// both go through assertMenuItem, so this cannot be used to edit a raw
// material, and a write is checked field by field against the same
// discovered list rather than being passed through to Odoo as-is.

// Types this editor can render and coerce. Others (binary, one2many,
// reference, ...) are left off the panel rather than shown as something the
// user can't meaningfully fill in.
const DETAIL_TYPES = new Set([
  'char',
  'text',
  'html',
  'float',
  'monetary',
  'integer',
  'boolean',
  'selection',
  'many2one',
  'many2many',
  'date',
  'datetime',
]);

// Owned by the simple editor above (and the archive toggle), so they're left
// out here — one value with two drafts in flight is how a stale field
// overwrites a fresh one.
const DETAIL_OWNED_ELSEWHERE = new Set(['name', 'list_price', 'description_sale', 'active']);

// On product.template but not on the product form: Odoo hangs these off the
// model as search/context helpers, and writing them does something other
// than what the label suggests — qty_available posts an inventory
// adjustment, location_id/warehouse_id only scope a stock read, and the
// import_/serial_ pair belong to the import wizard.
const DETAIL_BLOCKED = new Set([
  'qty_available',
  'location_id',
  'warehouse_id',
  'import_attribute_values',
  'serial_prefix_format',
  // Odoo's unit of measure, and the list of extra ones a product can be sold
  // in. Odoo still keeps these on its own products and this app still reads
  // its order lines' product_uom_qty; what it no longer does is put a unit of
  // measure on a screen or in a database of its own, so these are not offered
  // for editing here either. Blocked rather than left out of DETAIL_GROUPS
  // below, since anything merely absent from that list still shows up under
  // "Other".
  'uom_id',
  'uom_ids',
]);

// Odoo's mail/website mixins bolt dozens of plumbing fields onto every
// model; none of them are product data.
const DETAIL_BLOCKED_PREFIXES = /^(image_|message_|activity_|website_message|rating_|access_|my_activity|__)/;

// Roughly the pages of Odoo's product form, so the panel reads like the
// screen it mirrors instead of one 60-row alphabetical list. Fields Odoo has
// that aren't named here still show up — under "Smoke Rings custom" if
// they're Studio fields (x_), otherwise "Other" — which is what keeps a
// newly added field from going missing.
const DETAIL_GROUPS = [
  [
    'General',
    ['default_code', 'type', 'categ_id', 'barcode', 'l10n_in_hsn_code', 'product_tag_ids', 'responsible_id', 'company_id', 'sequence', 'color', 'is_favorite'],
  ],
  [
    'Sales',
    ['sale_ok', 'taxes_id', 'invoice_policy', 'sale_delay', 'public_description', 'description', 'optional_product_ids', 'sale_line_warn_msg', 'reinvoice_policy', 'service_type', 'service_tracking'],
  ],
  [
    'Point of Sale',
    ['available_in_pos', 'pos_categ_ids', 'pos_sequence', 'self_order_available', 'to_weight', 'combo_ids', 'pos_optional_product_ids', 'base_unit_id', 'base_unit_count'],
  ],
  [
    'Purchase',
    ['purchase_ok', 'purchase_method', 'supplier_taxes_id', 'description_purchase', 'purchase_line_warn_msg'],
  ],
  [
    'Inventory',
    ['is_storable', 'tracking', 'route_ids', 'weight', 'volume', 'lot_valuated', 'lot_sequence_id', 'description_picking', 'description_pickingin', 'description_pickingout', 'property_stock_inventory', 'property_stock_production'],
  ],
  [
    'Accounting',
    ['standard_price', 'property_account_income_id', 'property_account_expense_id', 'property_price_difference_account_id', 'account_tag_ids'],
  ],
];

const DETAIL_GROUP_BY_FIELD = new Map(
  DETAIL_GROUPS.flatMap(([group, names]) => names.map((name, index) => [name, { group, index }])),
);
const DETAIL_GROUP_ORDER = DETAIL_GROUPS.map(([group]) => group).concat(['Smoke Rings custom', 'Other']);

// fields_get on product.template is a ~160-field payload that never changes
// between restarts, so it's fetched once and reused. A Studio change picks up
// on the next server restart, same as the category and Fulfilment Status
// discovery elsewhere.
let detailFieldsCache;

async function resolveDetailFields() {
  if (detailFieldsCache) return detailFieldsCache;

  const meta = await execute('product.template', 'fields_get', [
    [],
    ['type', 'string', 'readonly', 'required', 'relation', 'selection', 'help', 'store'],
  ]);

  const fields = new Map();
  Object.entries(meta).forEach(([name, info]) => {
    // `readonly` is Odoo's own word on whether a write would stick: computed
    // fields without an inverse carry it, which is exactly what should be
    // left off an editor. Non-stored fields are kept — cost and barcode are
    // both non-stored but perfectly writable.
    if (info.readonly) return;
    if (!DETAIL_TYPES.has(info.type)) return;
    if (DETAIL_OWNED_ELSEWHERE.has(name) || DETAIL_BLOCKED.has(name)) return;
    if (DETAIL_BLOCKED_PREFIXES.test(name)) return;

    const placement = DETAIL_GROUP_BY_FIELD.get(name);
    fields.set(name, {
      name,
      label: info.string || name,
      type: info.type,
      help: info.help || null,
      required: Boolean(info.required),
      relation: info.relation || null,
      selection: Array.isArray(info.selection) ? info.selection.map(([value, label]) => ({ value, label })) : null,
      group: placement ? placement.group : name.startsWith('x_') ? 'Smoke Rings custom' : 'Other',
      order: placement ? placement.index : null,
    });
  });

  detailFieldsCache = fields;
  return fields;
}

// Group order first, then the order the group lists them in, then by label —
// so the named fields sit in form order and anything discovered lands after
// them alphabetically instead of at a random spot.
function sortDetailFields(fields) {
  return [...fields].sort((a, b) => {
    const groupDiff = DETAIL_GROUP_ORDER.indexOf(a.group) - DETAIL_GROUP_ORDER.indexOf(b.group);
    if (groupDiff !== 0) return groupDiff;
    if (a.order !== b.order) {
      if (a.order === null) return 1;
      if (b.order === null) return -1;
      return a.order - b.order;
    }
    return a.label.localeCompare(b.label);
  });
}

// Odoo hands relational values back as bare ids on many2many and an
// [id, name] pair on many2one, so the many2many names are looked up in one
// read per relation (only for fields that actually hold something) rather
// than leaving the UI to render "42, 57" at the user.
async function labelManyToMany(fields, record) {
  const wanted = new Map(); // relation -> Set of ids
  fields.forEach((field) => {
    if (field.type !== 'many2many' || !field.relation) return;
    const ids = Array.isArray(record[field.name]) ? record[field.name] : [];
    if (!ids.length) return;
    if (!wanted.has(field.relation)) wanted.set(field.relation, new Set());
    ids.forEach((id) => wanted.get(field.relation).add(id));
  });

  const names = new Map(); // `relation:id` -> display name
  await Promise.all(
    [...wanted.entries()].map(async ([relation, ids]) => {
      try {
        const rows = await execute(relation, 'read', [[...ids], ['display_name']]);
        rows.forEach((row) => names.set(`${relation}:${row.id}`, row.display_name || String(row.id)));
      } catch (err) {
        // A relation this login can't read shouldn't sink the whole panel —
        // the ids still render, just without their names.
        console.error(`Couldn't read names from ${relation} for the product detail panel:`, err);
      }
    }),
  );
  return names;
}

// Odoo returns `false` for every empty value regardless of the field's type,
// so each type gets turned into something the UI can bind an input to.
function toDetailValue(field, raw, m2mNames) {
  switch (field.type) {
    case 'many2one':
      return Array.isArray(raw) ? { id: raw[0], name: raw[1] || String(raw[0]) } : null;
    case 'many2many':
      return (Array.isArray(raw) ? raw : []).map((id) => ({
        id,
        name: m2mNames.get(`${field.relation}:${id}`) || String(id),
      }));
    case 'boolean':
      return Boolean(raw);
    case 'float':
    case 'monetary':
    case 'integer':
      return typeof raw === 'number' ? raw : 0;
    default:
      return raw === false || raw === null || raw === undefined ? '' : String(raw);
  }
}

// The whole editable product record, field metadata included, so the client
// renders Odoo's own labels, help text and selection options rather than
// keeping a second copy of them that can drift.
async function fetchMenuItemDetails({ id }) {
  const numericId = await assertMenuItem(id);
  const fields = sortDetailFields((await resolveDetailFields()).values());

  const [record] = await execute('product.template', 'read', [[numericId], ['name', ...fields.map((f) => f.name)]], {
    context: WITH_ARCHIVED,
  });
  if (!record) {
    const err = new Error(`Menu item ${id} not found in Odoo.`);
    err.status = 404;
    throw err;
  }

  const m2mNames = await labelManyToMany(fields, record);

  return {
    id: numericId,
    name: record.name || '',
    fields: fields.map((field) => ({ ...field, value: toDetailValue(field, record[field.name], m2mNames) })),
    groups: DETAIL_GROUP_ORDER.filter((group) => fields.some((field) => field.group === group)),
  };
}

// One submitted value -> what Odoo's write expects, or a 400 explaining why
// it can't be. Deliberately strict: this is the only thing between a typed
// form and a write onto a live product, so a value that isn't clearly valid
// is refused rather than coerced into whatever Number() happens to return.
function toOdooValue(field, value) {
  const reject = (message) => {
    const err = new Error(`${field.label}: ${message}`);
    err.status = 400;
    throw err;
  };
  const isBlank = value === null || value === undefined || value === '';

  switch (field.type) {
    case 'integer':
    case 'float':
    case 'monetary': {
      if (isBlank) return 0;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) reject('must be a number.');
      return field.type === 'integer' ? Math.trunc(numeric) : numeric;
    }
    case 'boolean':
      return Boolean(value);
    case 'selection': {
      if (isBlank) {
        if (field.required) reject('is required, so it needs one of the listed options.');
        return false;
      }
      const allowed = (field.selection || []).some((option) => option.value === value);
      if (!allowed) reject(`"${value}" isn't one of the options Odoo offers.`);
      return value;
    }
    case 'many2one': {
      if (isBlank) {
        if (field.required) reject('is required, so it needs a value.');
        return false;
      }
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric <= 0) reject('needs a record picked from the list.');
      return numeric;
    }
    case 'many2many': {
      const ids = (Array.isArray(value) ? value : []).map(Number);
      if (ids.some((entry) => !Number.isInteger(entry) || entry <= 0)) reject('needs records picked from the list.');
      // 6 = replace the whole set, which is what a form submission means.
      return [[6, 0, ids]];
    }
    case 'date':
    case 'datetime':
      return isBlank ? false : String(value);
    default: {
      const text = isBlank ? '' : String(value);
      if (!text && field.required) reject('is required, so it cannot be left blank.');
      return text || false;
    }
  }
}

// Writes any subset of the detail fields. Only the keys actually sent are
// written, so the panel can save one changed field without restating the
// other sixty.
async function updateMenuItemDetails({ id, values }) {
  const numericId = await assertMenuItem(id);

  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    const err = new Error('values must be an object of field name -> new value.');
    err.status = 400;
    throw err;
  }

  const fields = await resolveDetailFields();
  const payload = {};
  Object.entries(values).forEach(([name, value]) => {
    const field = fields.get(name);
    // Not a discovered editable field: either it doesn't exist, Odoo says
    // it's read-only, or it's one of the fields another control owns. Named
    // outright, because a silent drop would look like a save that worked.
    if (!field) {
      const err = new Error(`"${name}" isn't an editable field on the product record, so nothing was saved.`);
      err.status = 400;
      throw err;
    }
    payload[name] = toOdooValue(field, value);
  });

  if (!Object.keys(payload).length) {
    const err = new Error('Nothing to update.');
    err.status = 400;
    throw err;
  }

  // Moving the product out of Finished Products would take it off this
  // editor (and out of every menu read) the moment it saved — the item would
  // simply vanish, with no way back from this screen. Refused up front
  // instead; Odoo itself is the place to reclassify a product as something
  // other than a menu item.
  if (payload.categ_id !== undefined) {
    const menuCategoryId = await requireMenuCategoryId();
    const inSubtree = await execute('product.category', 'search_count', [
      [
        ['id', '=', payload.categ_id],
        ['id', 'child_of', menuCategoryId],
      ],
    ]);
    if (!inSubtree) {
      const err = new Error(
        "That category is outside Finished Products, which would take the item off the menu entirely. Move it in Odoo if that's really the intent.",
      );
      err.status = 400;
      throw err;
    }
  }

  await execute('product.template', 'write', [[numericId], payload]);

  // Both come back: the panel re-renders from Odoo's version of the record,
  // and the list row above it picks up anything the write changed there too
  // (a new internal reference, a category move between B2C and wholesale).
  return { item: await readMenuItem(numericId), details: await fetchMenuItemDetails({ id: numericId }) };
}

// Options for one relational field, for its picker. Fenced by the field
// rather than by the model name: the client says which product field it's
// filling in, and the relation is taken from Odoo's metadata for that field,
// so this can't be turned into a general "read any model" endpoint.
async function fetchMenuItemFieldOptions({ field: fieldName, query = '', limit = 30 }) {
  const field = (await resolveDetailFields()).get(fieldName);
  if (!field || !field.relation) {
    const err = new Error(`"${fieldName}" isn't a relational field on the product record.`);
    err.status = 400;
    throw err;
  }

  // Kwargs only, and only the three every Odoo version has taken: the
  // signature picked up a domain argument along the way (`args` in older
  // releases, `domain` since 18), and naming it either way breaks on the
  // other.
  const rows = await execute(field.relation, 'name_search', [], {
    name: String(query || ''),
    operator: 'ilike',
    limit: Math.min(Number(limit) || 30, 100),
  });

  // name_search hands back [[id, label], ...].
  return {
    field: fieldName,
    relation: field.relation,
    options: (rows || []).map(([optionId, label]) => ({ id: optionId, name: label })),
  };
}

export {
  fetchMenuItems,
  updateMenuItem,
  setMenuItemImage,
  setMenuItemArchived,
  fetchMenuItemDetails,
  updateMenuItemDetails,
  fetchMenuItemFieldOptions,
  resolveMenuCategoryId,
  resolveB2bCategoryId,
};

