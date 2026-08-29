// One-off/re-runnable CLI entry point for server/integrations/odoo.js
// syncRawMaterialsToOdoo — backfills odoo_product_id on materials.csv.
// Run with: node server/scripts/syncOdooProducts.js
import 'dotenv/config';
import { syncRawMaterialsToOdoo } from '../integrations/odoo.js';

const result = await syncRawMaterialsToOdoo();
console.log(JSON.stringify(result, null, 2));
console.log(
  `\nmatched ${result.matched.length}, created ${result.created.length}, skipped ${result.skipped.length}, errors ${result.errors.length}`,
);
