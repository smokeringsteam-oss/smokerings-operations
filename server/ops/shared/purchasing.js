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
import { all, getDbConfig } from '../../core/db.js';
import { insert, nextId, remove, selectOne, transaction, update } from '../../core/repo.js';
import { readPurchases, readVendors } from '../../core/kbViews.js';
import {
  getRawMaterials,
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

// What each of the attribution columns records:
//   client_id / client_name  — which B2B account this spend is FOR, so the
//     money side of the book can be totalled per account. Set on the buy
//     itself for things that never reach a smoker (packaging, bread), or
//     inherited from the session when a line is tagged to a cook.
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

  // Read back through the projection rather than returning the row as
  // written: the caller gets the same blank-not-null shape every other read
  // hands it, including the is_active the schema defaulted in.
  return { vendor: getVendors().find((v) => v.vendor_id === row.vendor_id) };
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
// moves stock (RM-047's unit of measure is pcs), so the weight rides
// alongside. Total weight is derived on read — see kbViews' PURCHASE_SQL —
// rather than stored, so it cannot drift from the piece weight beside it.
function recordPurchases({ vendorName, purchaseDate, channel, lines }) {
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

  const created = transaction(() =>
    usable.map((line) => {
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
        // B2C has no account book to attribute to, so the tag is ignored
        // there rather than quietly stored on a row nothing will ever total
        // by client.
        client_id: buyingFor === 'B2B' ? line.clientId || null : null,
        client_name: buyingFor === 'B2B' && line.clientId ? line.clientName || null : null,
        // Always null here — filled later at Start Smoking, see
        // tagPurchasesToSession.
        smoking_session_id: null,
        vendor_id: vendor.vendor_id,
        item_type: line.materialId ? 'material' : null,
        material_id: line.materialId || null,
        item_name: line.itemName,
        quantity_purchased: quantity,
        unit_of_measure: line.unit || null,
        unit_price: unitPrice,
        total_cost: totalCost,
        currency: 'INR',
        weight_per_unit_kg: weightPerUnitKg,
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
  const { applied: inventoryUpdated } = adjustInventory(adjustments, date);

  return { purchases, inventoryUpdated };
}

// Writes the Odoo draft-PO id + line id back onto the purchase rows created
// by a prior recordPurchases() call, once send-po succeeds — this is what
// lets deletePurchase() later remove the exact matching Odoo line instead of
// the whole PO. purchaseIds and lineIds are parallel arrays (same order as
// the `lines` sent to createPurchaseOrder).
function linkPurchasesToOdoo({ purchaseIds, poId, lineIds }) {
  if (!Array.isArray(purchaseIds) || !purchaseIds.length || !poId) return { linked: [] };

  return transaction(() => {
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

  return { deleted, inventoryReversal };
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
  linkPurchasesToOdoo,
  tagPurchasesToSession,
  clearSessionPurchaseTags,
  deletePurchase,
  getInventoryAdjustments,
  addInventoryAdjustment,
};
