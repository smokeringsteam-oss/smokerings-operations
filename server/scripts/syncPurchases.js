// Brings the three places a purchase lives back into step:
//
//   the database          the source of truth; nothing here changes a row's
//                         content, only its Odoo link.
//   purchase_log.csv      rewritten whole from the database (with vendors.csv).
//   Odoo                  any purchase row with no odoo_po_id is sent as a
//                         draft PO, and the link written back.
//
//   npm run purchases:sync            do it
//   npm run purchases:sync -- --dry   say what would be sent, send nothing
//
// The app already writes all three on every save. This is for the rows that
// missed one — saved while Odoo was down, or moved in by a migration — so
// they don't stay half-recorded. Rows are grouped into one PO per vendor, date
// and side, the way one bill would have been logged.
import 'dotenv/config';
import { all } from '../core/db.js';
import { readPurchases } from '../core/kbViews.js';
import { EXPENSE_KINDS, linkPurchasesToOdoo, mirrorPurchasingCsv } from '../ops/shared/purchasing.js';
import { createPurchaseOrder, getConfig as getOdooConfig } from '../integrations/odoo.js';

const dry = process.argv.includes('--dry');

const unlinked = readPurchases()
  .filter((row) => !row.odoo_po_id)
  .reverse();

const groups = new Map();
unlinked.forEach((row) => {
  const key = `${row.vendor_name}|${row.purchase_date}|${row.channel}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
});

let failed = false;

if (!groups.size) {
  console.log('Odoo: every purchase is already linked to a PO.');
} else if (!getOdooConfig().configured) {
  console.error(`Odoo: not configured — ${unlinked.length} purchase(s) left unsent.`);
  failed = true;
} else {
  for (const rows of groups.values()) {
    const [first] = rows;
    const label = `${first.vendor_name} ${first.purchase_date} ${first.channel}: ${rows.map((r) => r.purchase_id).join(', ')}`;
    if (dry) {
      console.log(`would send ${label}`);
      continue;
    }
    try {
      const po = await createPurchaseOrder({
        vendorName: first.vendor_name,
        lines: rows.map((row) => ({
          materialId: row.material_id || undefined,
          serviceProduct: EXPENSE_KINDS.includes(row.expense_category) ? row.expense_category : undefined,
          itemName: row.item_name,
          quantity: Number(row.quantity_purchased) || 0,
          unitPrice: row.unit_price,
        })),
      });
      linkPurchasesToOdoo({ purchaseIds: rows.map((r) => r.purchase_id), poId: po.id, lineIds: po.lineIds });
      console.log(`sent ${label} → ${po.name}`);
    } catch (err) {
      failed = true;
      console.error(`FAILED ${label}: ${err.message || err}`);
    }
  }
}

if (!dry) {
  const csv = mirrorPurchasingCsv();
  if (csv.mirrored) console.log(`CSV: wrote ${csv.rows} row(s) to ${csv.path}`);
  else {
    failed = true;
    console.error(`CSV: ${csv.reason}`);
  }
}

const { n } = all('SELECT count(*) AS n FROM purchase')[0];
console.log(`Database: ${n} purchase row(s).`);
process.exit(failed ? 1 : 0);
