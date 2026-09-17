// Weekly Purchasing module — the vendor book and the purchase log.
//
// Migrated off Purchase/vendors.csv and Purchase/purchase_log.csv onto the
// `vendor` and `purchase` tables. The columns callers see are unchanged:
// server/core/kbViews.js re-flattens both back into the shape the CSVs had,
// so the Weekly Purchasing screen and server/ops/shared/smoking.js still read
// vendor_name, quantity_purchased and the rest exactly as before.
//
// What changed underneath is worth knowing:
//
//   * vendor_name is joined, not stored. The log used to carry its own copy
//     of it, which went stale the moment a vendor was renamed; now last
//     month's spend follows the rename.
//   * A purchase must name a vendor that exists. vendor_id is a real foreign
//     key, so the old "fall back to just the name" path is gone — the screen
//     picks vendors from a dropdown and has an Add Vendor button, so the only
//     way to hit this is a name that was never in the book.
//   * Recording a buy is a transaction. Five lines either all land or none
//     do; the CSV append could leave three of them behind.
//   * Stock still moves through inventoryStore.adjustInventory, which owns
//     the one running on-hand number. It opens its own transaction and SQLite
//     has no nested BEGIN, so the purchase rows are written first and the
//     stock move follows — the same ordering, and for the same reason, as
//     addInventoryAdjustment.
//   * Labour, logistics and miscellaneous spend live here too (see
//     recordExpense), as service lines under a vendor of the same name. Every
//     rupee going out of the kitchen is one row in this one table.
//   * Both tables are mirrored back out to Purchase/purchase_log.csv and
//     Purchase/vendors.csv after every write — a mirror, never an input. See
//     server/core/csvMirror.js.
import { all, getDbConfig } from '../../core/db.js';
import { insert, nextId, remove, selectOne, transaction, update } from '../../core/repo.js';
import { readPurchases, readVendors } from '../../core/kbViews.js';
import { mirrorCsv } from '../../core/csvMirror.js';
import {
  DEFAULT_MATERIAL_CATEGORY,
  INVESTMENT_CATEGORY,
  LABOUR_CATEGORY,
  LOGISTICS_CATEGORY,
  MISC_CATEGORY,
  normaliseExpenseCategory,
} from '../../core/expenseCategories.js';
import {
  getRawMaterials,
  addRawMaterial,
  getInventory,
  getLowStock,
  adjustInventory,
  getInventoryAdjustments,
  addInventoryAdjustment,
} from '../../core/inventoryStore.js';

// Which side of the business a buy was made for. Purchases are otherwise
// channel-agnostic — the same vendors, the same materials catalogue, and
// crucially the same inventory pool: 20kg of pork bought "for B2B" still
// lands in one stock count that any smoking session draws from. The column
// records intent (whose money/plan this buy was against), which is what
// makes cost attribution per side of the book possible; it is deliberately
// NOT a separate stock bucket.
const PURCHASE_CHANNELS = ['B2C', 'B2B'];

// Whether a line was bought for a real order on that channel or for a
// practice cook. Per line, like the client tag: one butcher run can cover both.
const PURCHASE_PURPOSES = ['Order', 'Practice'];

// What each of the attribution columns records:
//   client_id / client_name  — which B2B account this spend is FOR, so the
//     money side of the book can be totalled per account. Set on the buy
//     itself for things that never reach a smoker (packaging, bread), or
//     inherited from the session when a line is tagged to a cook.
//   expense_category         — what the money was FOR, as against which side
//     of the business it was for. A dimension inside the channel, not an
//     alternative to it: B2B + Equipment and B2C + Marketing collateral are
//     both ordinary answers. The vocabulary and the reasoning live in
//     server/core/expenseCategories.js.
//   smoking_session_id       — which cook this line was bought for. Written
//     at Start Smoking (see tagPurchasesToSession), NOT here: at buying time
//     the session usually doesn't exist yet, since a session row is only
//     created once brining starts.
//
// This is deliberately independent of smoking_session.source_purchase_id.
// That column says which lot a session's raw weight was actually drawn from
// (it drives the FIFO "remaining" maths); this one says which cook a line of
// spend belongs to, which can cover the rub spices and the packaging too. A
// session normally has both and they normally agree, but they answer
// different questions and neither is derived from the other.
//
// Neither is a foreign key. Deleting a client, or a mis-logged session, must
// not be blocked by — or quietly take with it — the record that money was
// actually spent. See the note on this in server/core/migrations.js.

// The database's own setup check, in place of the old "are all the CSVs
// where I expect them" one. Same job: tell the dashboard whether this machine
// is set up before a screen fails with a 503.
function getConfig() {
  const { dbPath, exists, tables, rows } = getDbConfig();
  return { dbPath, dbPresent: exists, tables, rows, configured: exists && tables > 0 };
}

function getVendors() {
  return readVendors();
}

const PURCHASE_CSV_PATH = 'Purchase/purchase_log.csv';
const PURCHASE_CSV_HEADER = [
  'purchase_id',
  'purchase_date',
  'channel',
  'purpose',
  'client_id',
  'client_name',
  'smoking_session_id',
  'vendor_id',
  'vendor_name',
  'item_type',
  'material_id',
  'item_name',
  'quantity_purchased',
  'weight_per_unit_kg',
  'total_weight_kg',
  'unit_price',
  'total_cost',
  'currency',
  'expense_category',
  'odoo_po_id',
  'odoo_po_line_id',
  'notes',
];
const VENDOR_CSV_PATH = 'Purchase/vendors.csv';
const VENDOR_CSV_HEADER = [
  'vendor_id',
  'vendor_name',
  'vendor_type',
  'supplies_category',
  'contact_person',
  'phone',
  'email',
  'address',
  'lead_time_days',
  'payment_terms',
  'account_owner',
  'is_active',
  'notes',
];

// Both files, whole, after any write to either table. Oldest purchase first so
// the file reads as a log. Returns the purchase log's result, which is the one
// the screen reports on.
function mirrorPurchasingCsv() {
  mirrorCsv(VENDOR_CSV_PATH, VENDOR_CSV_HEADER, readVendors());
  return mirrorCsv(PURCHASE_CSV_PATH, PURCHASE_CSV_HEADER, readPurchases().reverse());
}

// Adds a vendor to the book. Rejects an exact case-insensitive name match
// rather than creating a near-duplicate — two rows called "Karnataka Pork
// Shop" would split that vendor's spend in half for every report that groups
// by it.
function addVendor({ vendorName, vendorType, suppliesCategory, contactPerson, phone, email, address, notes }) {
  const name = (vendorName || '').trim();
  if (!name) {
    const err = new Error('vendorName is required.');
    err.status = 400;
    throw err;
  }

  const existing = getVendors().find((v) => v.vendor_name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    const err = new Error(`Vendor "${name}" already exists (${existing.vendor_id}).`);
    err.status = 409;
    throw err;
  }

  const row = {
    vendor_id: nextId('vendor', 'vendor_id', 'VEN'),
    vendor_name: name,
    vendor_type: vendorType || null,
    supplies_category: suppliesCategory || null,
    contact_person: contactPerson || null,
    phone: phone || null,
    email: email || null,
    address: address || null,
    notes: notes || null,
  };
  insert('vendor', row);
  mirrorPurchasingCsv();

  // Read back through the projection rather than returning the row as
  // written: the caller gets the same blank-not-null shape every other read
  // hands it, including the is_active the schema defaulted in.
  return { vendor: getVendors().find((v) => v.vendor_id === row.vendor_id) };
}

// ---- Labour, logistics and miscellaneous ----------------------------------
//
// The spend that comes off no vendor bill, logged into the purchase table like
// everything else rather than into a ledger of its own. Each kind gets a
// vendor of the same name, created on first use, so the foreign key holds and
// every vendor rollup shows "Labour" as one line instead of one line per
// helper. vendor_type 'Expense' is what keeps them out of the purchase form's
// vendor dropdown.
const EXPENSE_KINDS = [LABOUR_CATEGORY, LOGISTICS_CATEGORY, INVESTMENT_CATEGORY, MISC_CATEGORY];
const EXPENSE_VENDOR_TYPE = 'Expense';

function ensureExpenseVendor(kind) {
  const existing = getVendors().find((v) => v.vendor_name.trim().toLowerCase() === kind.toLowerCase());
  if (existing) return existing;
  return addVendor({
    vendorName: kind,
    vendorType: EXPENSE_VENDOR_TYPE,
    notes: 'Weekly Purchasing labour / logistics / investment / misc spend.',
  })
    .vendor;
}

// One labour, logistics or miscellaneous line: a service, quantity 1, priced
// at the amount paid. A miscellaneous entry has to say what it was — "₹600,
// misc" is a figure nobody can check a month later; labour and logistics can
// stand on their own.
//
// Investment is the one kind with line detail: an item, a quantity and a unit
// price, because "2 × chest freezer at ₹18,000" is what a later reader needs
// and an amount alone would not say. It takes `quantity` and `unitPrice`
// instead of `amount`.
function recordExpense({ kind, purchaseDate, channel, description, amount, quantity, unitPrice, notes }) {
  if (!EXPENSE_KINDS.includes(kind)) {
    const err = new Error(`kind must be one of: ${EXPENSE_KINDS.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  const text = typeof description === 'string' ? description.trim().slice(0, 200) : '';
  const isInvestment = kind === INVESTMENT_CATEGORY;
  if (isInvestment && !text) {
    const err = new Error('Say what the investment item was.');
    err.status = 400;
    throw err;
  }
  const qty = isInvestment ? Number(quantity) : 1;
  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error('Enter a quantity greater than 0.');
    err.status = 400;
    throw err;
  }
  const value = Number(isInvestment ? unitPrice : amount);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error(isInvestment ? 'Enter a unit price greater than 0.' : 'Enter an amount greater than 0.');
    err.status = 400;
    throw err;
  }
  if (kind === MISC_CATEGORY && !text) {
    const err = new Error('Say what the miscellaneous expense was for.');
    err.status = 400;
    throw err;
  }

  const vendor = ensureExpenseVendor(kind);
  return recordPurchases({
    vendorName: vendor.vendor_name,
    purchaseDate,
    channel,
    expenseCategory: kind,
    lines: [
      {
        itemType: 'service',
        itemName: text || kind,
        quantity: qty,
        unitPrice: Math.round(value * 100) / 100,
        notes,
      },
    ],
  });
}

// Newest first, which is how the screen lists them. `from`/`to` bound the
// purchase date; `channel` narrows to one side of the business.
function getPurchases({ from, to, channel } = {}) {
  return readPurchases().filter((row) => {
    if (channel && row.channel !== channel) return false;
    if (!row.purchase_date) return true;
    if (from && row.purchase_date < from) return false;
    if (to && row.purchase_date > to) return false;
    return true;
  });
}

// lines: [{ materialId, itemName, quantity, unit, unitPrice, weightPerUnitKg, clientId, clientName }]
// Writes one purchase row per line, then bumps quantity_on_hand for any line
// naming a catalogue material (lines without a materialId — an ad hoc item
// not in the catalogue — are logged but skipped for the stock update).
//
// The client tag is per line, not per purchase, because one trip to the
// butcher routinely covers two accounts, and one cart routinely mixes a
// client's meat with packaging bought for nobody in particular. Tagging the
// whole cart would force a lie on at least one of those lines. It is always
// optional — an untagged line is general overhead, which is a real answer,
// not a missing one.
//
// `weightPerUnitKg` is the other optional per-line field, and it is there for
// the buys priced by the piece and used by the weight — whole chicken above
// all. Four birds at ₹450 each is what the butcher charges; 6.4 kg is what
// the cook, the client's kg/week demand and the meat plan are all in. The
// quantity stays the count, because that is what the vendor invoices and what
// moves stock, so the weight rides alongside. Total weight is derived on read — see kbViews' PURCHASE_SQL —
// rather than stored, so it cannot drift from the piece weight beside it.
function recordPurchases({ vendorName, purchaseDate, channel, expenseCategory, lines }) {
  if (!vendorName) {
    const err = new Error('vendorName is required.');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(lines) || !lines.length) {
    const err = new Error('At least one line item is required.');
    err.status = 400;
    throw err;
  }

  const buyingFor = channel || 'B2C';
  if (!PURCHASE_CHANNELS.includes(buyingFor)) {
    const err = new Error(`channel must be one of: ${PURCHASE_CHANNELS.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const vendor = getVendors().find(
    (v) => v.vendor_name.trim().toLowerCase() === vendorName.trim().toLowerCase(),
  );
  if (!vendor) {
    const err = new Error(`No vendor called "${vendorName}" — add it under Vendors first.`);
    err.status = 400;
    throw err;
  }

  const date = purchaseDate || new Date().toISOString().slice(0, 10);
  const usable = lines.filter((line) => line.itemName && line.quantity);
  if (!usable.length) {
    const err = new Error('No valid line items (each needs an item name and a quantity).');
    err.status = 400;
    throw err;
  }

  // Rejected here rather than left to the CHECK, which would come back as a
  // bare constraint failure naming a column the screen never shows. A blank
  // is fine and means unweighed; a 0 is someone who typed into the wrong box.
  const badWeight = usable.find(
    (line) =>
      line.weightPerUnitKg != null &&
      line.weightPerUnitKg !== '' &&
      !(Number(line.weightPerUnitKg) > 0),
  );
  if (badWeight) {
    const err = new Error(
      `Weight of one ${badWeight.itemName} must be greater than 0 kg — leave it blank if it hasn't been weighed.`,
    );
    err.status = 400;
    throw err;
  }

  const badPurpose = usable.find((line) => line.purpose && !PURCHASE_PURPOSES.includes(line.purpose));
  if (badPurpose) {
    const err = new Error(`purpose must be one of: ${PURCHASE_PURPOSES.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  // What each line was FOR. Validated here, before anything is written, for
  // the same reason the weight is: a typo on line three must not leave lines
  // one and two behind under a category nobody meant. The rollback would
  // catch it, but the message a CHECK-less TEXT column gives is no message
  // at all — normaliseExpenseCategory names the twelve it will accept.
  //
  // Three places a category can come from, most specific first:
  //   line.expenseCategory  — the mixed cart, where the charcoal and the pork
  //                           on one bill are two different kinds of cost.
  //   expenseCategory       — the whole cart, which is how the Purchase
  //                           Logger sends it: one trip, one purpose.
  //   the material fallback — a catalogue line logged from Weekly Purchasing
  //                           with nobody saying anything is raw materials,
  //                           because that is what that screen is for.
  //
  // An ad hoc line with no category stays null on purpose. It is the one case
  // where a guess would be wrong often enough to matter — the off-catalogue
  // buying is exactly where the posters and the gas refills live — so it goes
  // uncategorised into the Purchase Logger's queue instead.
  const cartCategory = normaliseExpenseCategory(expenseCategory);
  const lineCategories = usable.map(
    (line) =>
      normaliseExpenseCategory(line.expenseCategory) ||
      cartCategory ||
      (line.materialId ? DEFAULT_MATERIAL_CATEGORY : null),
  );

  const created = transaction(() =>
    usable.map((line, index) => {
      const quantity = Number(line.quantity) || 0;
      const unitPrice = line.unitPrice != null && line.unitPrice !== '' ? Number(line.unitPrice) : null;
      const totalCost = unitPrice != null ? Math.round(quantity * unitPrice * 100) / 100 : null;
      // Blank means "nobody weighed these", which the column is nullable to
      // be able to say. A zero or a negative would be the CHECK's problem
      // rather than a message, so it is caught here with one — see the
      // validation loop above.
      const weightPerUnitKg =
        line.weightPerUnitKg != null && line.weightPerUnitKg !== '' ? Number(line.weightPerUnitKg) : null;
      // Allocated inside the transaction and one at a time, so each id is
      // taken against the rows already written in this batch.
      const purchaseId = nextId('purchase', 'purchase_id', 'PUR');

      insert('purchase', {
        purchase_id: purchaseId,
        purchase_date: date,
        channel: buyingFor,
        purpose: line.purpose || 'Order',
        // B2C has no account book to attribute to, so the tag is ignored
        // there rather than quietly stored on a row nothing will ever total
        // by client.
        client_id: buyingFor === 'B2B' ? line.clientId || null : null,
        client_name: buyingFor === 'B2B' && line.clientId ? line.clientName || null : null,
        // Always null here — filled later at Start Smoking, see
        // tagPurchasesToSession.
        smoking_session_id: null,
        vendor_id: vendor.vendor_id,
        item_type: line.materialId ? 'material' : line.itemType === 'service' ? 'service' : null,
        material_id: line.materialId || null,
        item_name: line.itemName,
        quantity_purchased: quantity,
        unit_price: unitPrice,
        total_cost: totalCost,
        currency: 'INR',
        weight_per_unit_kg: weightPerUnitKg,
        expense_category: lineCategories[index],
        // Free text, and the only record of why this particular buy happened
        // — "A3, Diwali menu, 50 off" is not derivable from the category or
        // the item name.
        notes: line.notes ? String(line.notes).trim() || null : null,
      });
      return purchaseId;
    }),
  );

  // Read back in the order the lines were given, not the order the log shows
  // them in: the caller sends this list straight on to Odoo as a purchase
  // order, and it pairs each returned purchase_id with the line at the same
  // index (see POST /api/purchasing/send-po and linkPurchasesToOdoo). Sorted
  // any other way, every Odoo PO line would be linked to the wrong buy.
  const byId = new Map(readPurchases().map((row) => [row.purchase_id, row]));
  const purchases = created.map((id) => byId.get(id));

  const adjustments = purchases
    .filter((row) => row.material_id)
    .map((row) => ({ materialId: row.material_id, deltaQty: row.quantity_purchased, itemName: row.item_name }));
  const { applied: inventoryUpdated, skipped } = adjustInventory(adjustments, date);

  // The lines that were logged but moved no stock, reported rather than left
  // silent. A buy landing in one table and not the other is the one failure
  // this module can produce that looks exactly like success from the screen:
  // the purchase log fills in, the money is right, and the walk-in count
  // quietly doesn't match what's on the shelf.
  //
  // Almost always this is the ad hoc line — an item typed in by name because
  // it isn't in the catalogue, which has no material row to move. That is a
  // legitimate thing to buy, so it isn't rejected; it comes back here as
  // something to finish, and catalogPurchaseItem below is how it's finished.
  // A service — labour, a subscription — has no stock to move, so it is
  // not something left unfinished and is left off this list.
  const inventorySkipped = [
    ...purchases
      .filter((row) => !row.material_id && row.item_type !== 'service')
      .map((row) => ({
        purchase_id: row.purchase_id,
        item_name: row.item_name,
        quantity: row.quantity_purchased,
        reason: 'not in the materials catalogue',
      })),
    // A materialId that no longer resolves — rarer, and not something the
    // screen can fix by adding a catalogue entry, but it belongs in the same
    // list because it has the same consequence.
    ...skipped.map((row) => ({
      purchase_id: purchases.find((p) => p.material_id === row.materialId)?.purchase_id || null,
      item_name: row.itemName,
      quantity: null,
      reason: row.reason,
    })),
  ];

  const csv = mirrorPurchasingCsv();
  return { purchases, inventoryUpdated, inventorySkipped, csv };
}

// Gives an ad hoc purchase line the catalogue row it never had, and then
// lets the buy do what it couldn't at logging time: move stock.
//
// Three steps, in this order and for these reasons:
//   1. Create the material (inventoryStore owns that table).
//   2. Point the purchase row at it, so the log stops reading as ad hoc and
//      a later delete reverses the stock the same way any other line's does.
//   3. Apply this line's quantity, dated to the purchase, not to today.
//
// Only the one line named is stocked, even when the log holds several buys of
// the same untyped name. Linking the others would be a guess about which of
// them were already counted by hand, and a wrong guess is stock claimed that
// isn't on the shelf — the worst direction for this number to be wrong in.
// They keep their own prompt, and adding the material a second time is
// refused by name, so the second one is a link rather than a duplicate.
function catalogPurchaseItem({ purchaseId, category, reorderLevel, standardCostInr }) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }

  const purchase = readPurchases().find((row) => row.purchase_id === purchaseId);
  if (!purchase) {
    const err = new Error(`No purchase found with id ${purchaseId}.`);
    err.status = 404;
    throw err;
  }
  if (purchase.material_id) {
    const err = new Error(
      `${purchaseId} is already linked to ${purchase.material_id} — its stock was updated when it was logged.`,
    );
    err.status = 409;
    throw err;
  }

  // The unit price paid is the best standing cost estimate available for
  // something nobody has ever costed, and it is only a default — an explicit
  // one passed in wins.
  const cost =
    standardCostInr != null && standardCostInr !== ''
      ? standardCostInr
      : purchase.unit_price !== '' && purchase.unit_price != null
        ? purchase.unit_price
        : null;

  const { material } = addRawMaterial({
    itemName: purchase.item_name,
    category,
    reorderLevel,
    standardCostInr: cost,
    // Whoever it was bought from is the obvious first guess at who to reorder
    // it from, and it is the only vendor this row has ever been associated
    // with.
    defaultVendorId: purchase.vendor_id || null,
    notes: `Added to the catalogue from purchase ${purchaseId}.`,
  });

  update('purchase', { purchase_id: purchaseId }, { material_id: material.material_id, item_type: 'material' });

  // Dated to the buy rather than to now: last_updated is meant to say when
  // this count last moved in the real world, and it moved on the day the
  // thing was carried in.
  const { applied } = adjustInventory(
    [
      {
        materialId: material.material_id,
        deltaQty: Number(purchase.quantity_purchased) || 0,
        itemName: purchase.item_name,
      },
    ],
    purchase.purchase_date || new Date().toISOString().slice(0, 10),
  );
  mirrorPurchasingCsv();

  return {
    material,
    purchase: readPurchases().find((row) => row.purchase_id === purchaseId),
    inventoryUpdated: applied[0] || null,
  };
}

// The other way to finish an ad hoc line: point it at a catalogue item that
// already exists, instead of creating a new one for it.
//
// This is the commoner case by a distance. "PORK SHLDR B/L", "amul butter
// 500g" and "coriander 100g" are not three ingredients the kitchen has never
// bought before — they are three items already in the catalogue, typed at the
// counter the way the bill spelt them. Cataloguing each of those as a NEW
// material is the expensive mistake: it splits one ingredient's stock across
// two rows, so neither reads true and the reorder level on the original stops
// firing. Which is why the screen offers this first and suggests candidates
// (see ./materialMatch.js) rather than making someone find the row by eye.
//
// Same three effects as catalogPurchaseItem, minus the creation: link, rename
// to the catalogue's wording, apply the quantity dated to the buy. Renaming
// is deliberate — the log, the cart and the stock count should all call the
// item the same thing — and the wording it was logged under goes into the
// purchase's notes rather than being lost, since that string is the only
// record of what the bill actually said.
//
// It does NOT touch the material's standard cost or default vendor. Those are
// this item's own settled facts across every buy ever made of it, and one ad
// hoc line is not the reason to overwrite them (catalogPurchaseItem seeds them
// only because the row it creates has nothing at all).
function linkPurchaseToMaterial({ purchaseId, materialId }) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }
  const wantedId = (materialId || '').trim();
  if (!wantedId) {
    const err = new Error('materialId is required.');
    err.status = 400;
    throw err;
  }

  const purchase = readPurchases().find((row) => row.purchase_id === purchaseId);
  if (!purchase) {
    const err = new Error(`No purchase found with id ${purchaseId}.`);
    err.status = 404;
    throw err;
  }
  if (purchase.material_id) {
    const err = new Error(
      `${purchaseId} is already linked to ${purchase.material_id} — its stock was updated when it was logged.`,
    );
    err.status = 409;
    throw err;
  }

  // The buyable catalogue only: the IP-xxx intermediate products carry stock
  // too, but nobody buys a batch of smoked pork from a vendor, and linking a
  // purchase to one would add raw weight to a cooked count.
  const material = getRawMaterials().find((m) => m.material_id === wantedId);
  if (!material) {
    const err = new Error(`No catalogue item found with id ${wantedId}.`);
    err.status = 404;
    throw err;
  }

  const loggedAs = purchase.item_name;
  const renamed = loggedAs.trim().toLowerCase() !== material.item_name.trim().toLowerCase();
  const trail = renamed
    ? `Mapped to ${material.material_id}; logged at the counter as "${loggedAs}".`
    : `Mapped to ${material.material_id}.`;

  update(
    'purchase',
    { purchase_id: purchaseId },
    {
      material_id: material.material_id,
      item_type: 'material',
      item_name: material.item_name,
      notes: [purchase.notes, trail].filter(Boolean).join(' '),
    },
  );

  // Dated to the buy, not to now — same reasoning as catalogPurchaseItem:
  // last_updated says when this count moved in the real world.
  const { applied } = adjustInventory(
    [
      {
        materialId: material.material_id,
        deltaQty: Number(purchase.quantity_purchased) || 0,
        itemName: material.item_name,
      },
    ],
    purchase.purchase_date || new Date().toISOString().slice(0, 10),
  );
  mirrorPurchasingCsv();

  return {
    material: getRawMaterials().find((m) => m.material_id === material.material_id),
    purchase: readPurchases().find((row) => row.purchase_id === purchaseId),
    inventoryUpdated: applied[0] || null,
    // Non-null only when the line was actually re-worded, so the screen can
    // say "logged as X, now counted as Y" instead of a confusing no-op.
    renamedFrom: renamed ? loggedAs : null,
  };
}

// Writes the Odoo draft-PO id + line id back onto the purchase rows created
// by a prior recordPurchases() call, once send-po succeeds — this is what
// lets deletePurchase() later remove the exact matching Odoo line instead of
// the whole PO. purchaseIds and lineIds are parallel arrays (same order as
// the `lines` sent to createPurchaseOrder).
function linkPurchasesToOdoo({ purchaseIds, poId, lineIds }) {
  if (!Array.isArray(purchaseIds) || !purchaseIds.length || !poId) return { linked: [] };

  const result = transaction(() => {
    const linked = [];
    purchaseIds.forEach((purchaseId, idx) => {
      // required: false — a purchase id that no longer resolves is a stale
      // request, not a reason to fail the PO that has already been created in
      // Odoo. The caller treats this whole step as best-effort.
      const changes = update(
        'purchase',
        { purchase_id: purchaseId },
        { odoo_po_id: poId, odoo_po_line_id: lineIds?.[idx] ?? null },
        { required: false },
      );
      if (changes) linked.push(purchaseId);
    });
    return { linked };
  });
  mirrorPurchasingCsv();
  return result;
}

// Removes a purchase row entirely and reverses its effect on stock (the
// opposite of recordPurchases' adjustInventory call). Does NOT touch Odoo
// itself — the caller (index.js) uses the returned odoo_po_id/odoo_po_line_id
// to remove the matching PO line separately, so a failed Odoo call doesn't
// block the delete here.
function deletePurchase(purchaseId) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }

  const deleted = readPurchases().find((row) => row.purchase_id === purchaseId);
  if (!deleted) {
    const err = new Error(`No purchase found with id ${purchaseId}.`);
    err.status = 404;
    throw err;
  }
  // A session that recorded this lot as the source of its raw weight would be
  // left pointing at nothing. The foreign key would refuse the delete with a
  // constraint error; this says which cook is in the way instead.
  const sourcedBy = selectOne('smoking_session', { source_purchase_id: purchaseId });
  if (sourcedBy) {
    const err = new Error(
      `${purchaseId} is recorded as the source of ${sourcedBy.session_id}'s raw weight — delete or re-source that session first.`,
    );
    err.status = 409;
    throw err;
  }

  remove('purchase', { purchase_id: purchaseId });

  let inventoryReversal = null;
  if (deleted.material_id) {
    const { applied } = adjustInventory(
      [
        {
          materialId: deleted.material_id,
          deltaQty: -Number(deleted.quantity_purchased || 0),
          itemName: deleted.item_name,
        },
      ],
      new Date().toISOString().slice(0, 10),
    );
    inventoryReversal = applied[0] || null;
  }

  const csv = mirrorPurchasingCsv();
  return { deleted, inventoryReversal, csv };
}

// Records which cook a set of purchase lines was bought for. Called at Start
// Smoking (see startSmoking in server/ops/shared/smoking.js), which is the
// first moment the session actually exists to point at — you buy the meat on
// Thursday and the SMK-xxx row is only created when it goes into the brine.
//
// `purchaseIds` is the complete set for this session, not a delta: anything
// currently tagged to it and absent from the list gets untagged, so the
// pitmaster unticking a line in the UI actually removes the tag. Lines
// already tagged to a DIFFERENT session are skipped rather than stolen —
// two cooks can't both have been the reason for the same buy, and silently
// re-pointing one would corrupt the earlier cook's cost with no trace.
//
// Untagging deliberately leaves client_id alone. Which account the money was
// for is a fact about the purchase that outlives any particular cook, and a
// line bought for a client stays bought for that client even if it ends up
// feeding a different session.
function tagPurchasesToSession({ sessionId, purchaseIds, clientId, clientName }) {
  if (!sessionId) {
    const err = new Error('sessionId is required.');
    err.status = 400;
    throw err;
  }

  const wanted = new Set(Array.isArray(purchaseIds) ? purchaseIds.filter(Boolean) : []);
  const tagged = [];
  const untagged = [];
  const skipped = [];

  // Only the rows this call could possibly change: the ones asked for, plus
  // the ones already pointing at this session (the untag half). Everything
  // else in the log is untouched by definition, so there is no reason to read
  // it — and no chance of writing it by accident.
  const ids = [...wanted];
  const candidates = all(
    `SELECT purchase_id, client_id, smoking_session_id
       FROM purchase
      WHERE smoking_session_id = ?${ids.length ? ` OR purchase_id IN (${ids.map(() => '?').join(', ')})` : ''}`,
    sessionId,
    ...ids,
  );

  transaction(() => {
    candidates.forEach((row) => {
      const alreadyMine = row.smoking_session_id === sessionId;
      if (wanted.has(row.purchase_id)) {
        if (row.smoking_session_id && !alreadyMine) {
          skipped.push({ purchase_id: row.purchase_id, taggedTo: row.smoking_session_id });
          return;
        }
        const patch = { smoking_session_id: sessionId };
        // A client set on the buy itself wins over the session's: whoever
        // logged the purchase said outright who it was for, which beats
        // inheriting it from whichever cook happened to consume the line.
        if (clientId && !row.client_id) {
          patch.client_id = clientId;
          patch.client_name = clientName || null;
        }
        update('purchase', { purchase_id: row.purchase_id }, patch);
        tagged.push(row.purchase_id);
      } else if (alreadyMine) {
        update('purchase', { purchase_id: row.purchase_id }, { smoking_session_id: null });
        untagged.push(row.purchase_id);
      }
    });
  });
  if (tagged.length || untagged.length) mirrorPurchasingCsv();

  return { tagged, untagged, skipped };
}

// Drops every purchase tag pointing at a session — used when the session row
// itself is deleted, so the spend goes back to being untagged rather than
// pointing at an SMK id that no longer resolves.
function clearSessionPurchaseTags(sessionId) {
  if (!sessionId) return { tagged: [], untagged: [], skipped: [] };
  return tagPurchasesToSession({ sessionId, purchaseIds: [] });
}

export {
  PURCHASE_CHANNELS,
  getConfig,
  getVendors,
  addVendor,
  getRawMaterials,
  getInventory,
  getLowStock,
  getPurchases,
  recordPurchases,
  EXPENSE_KINDS,
  recordExpense,
  mirrorPurchasingCsv,
  catalogPurchaseItem,
  linkPurchaseToMaterial,
  linkPurchasesToOdoo,
  tagPurchasesToSession,
  clearSessionPurchaseTags,
  deletePurchase,
  getInventoryAdjustments,
  addInventoryAdjustment,
};
