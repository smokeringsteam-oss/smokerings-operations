// One-off cleanup: removes the two stale copies of recipe data that live in
// Odoo, leaving the app's SQLite recipes as the single source of truth.
//
// Odoo held three competing versions of "what goes into one dish":
//   1. the app's `recipe` tables (authoritative — the prep planner, the buy
//      list and the smoking sessions all run off these),
//   2. 11 `phantom` mrp.bom records on the menu products, last touched
//      2026-08-17 and drifted from the app on every single item (CB-001 said
//      120 g pulled chicken against the app's 110 g; PL-002 said 850 g ribs
//      against 500 g; CT-001 said 3 taco shells against 2),
//   3. hand-typed "Recipe / BOM: ..." prose in the Internal Notes
//      (product.template.description) of 6 products, stale in its own
//      direction again.
//
// This deletes (2) and clears (3). It deliberately leaves the `normal` BoMs
// alone: those sit on the IP-* intermediates and B2B-* bulk packs, they feed
// real manufacturing orders, and none of them describe a menu dish.
//
// Safe to re-run — it re-reads what's there and does nothing when both are
// already clean.
//
// Run with: node server/scripts/stripOdooRecipeDuplicates.js
//   --dry-run   print what would change and exit without writing
//
// A rollback snapshot of everything removed is written to server/data/
// before anything is deleted.
import 'dotenv/config';
import fs from 'node:fs';
import { execute } from '../integrations/odoo.js';

const dryRun = process.argv.includes('--dry-run');

// Same fence every other menu write uses: only products under Finished
// Products are in scope, so this can't reach raw materials or packaging.
async function finishedProductIds() {
  const cats = await execute('product.category', 'search_read', [
    [['complete_name', 'ilike', 'finished product']],
    ['id'],
  ]);
  if (!cats.length) throw new Error('No "Finished Products" category found — refusing to guess at scope.');
  const rows = await execute('product.template', 'search_read', [
    [['categ_id', 'child_of', cats.map((c) => c.id)]],
    ['id'],
  ]);
  return rows.map((r) => r.id);
}

const phantomBoms = await execute('mrp.bom', 'search_read', [[['type', '=', 'phantom']], []]);
const productIds = await finishedProductIds();
const noted = (await execute('product.template', 'read', [productIds, ['name', 'default_code', 'description']])).filter(
  (r) => r.description,
);

console.log(`phantom BoMs to delete: ${phantomBoms.length}`);
phantomBoms.forEach((b) => console.log(`  ${b.id}  ${b.product_tmpl_id[1]}`));
console.log(`Internal Notes to clear: ${noted.length}`);
noted.forEach((n) => console.log(`  ${n.default_code || '(no code)'}  ${n.name}`));

if (!phantomBoms.length && !noted.length) {
  console.log('\nNothing to do — Odoo already holds no duplicate recipe data.');
  process.exit(0);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

// A phantom BoM an manufacturing order points at can't be deleted cleanly, so
// the check is a hard stop rather than a warning. At the time of writing no MO
// referenced one — they all use the `normal` BoMs this script leaves alone.
const usedByMo = await execute('mrp.production', 'search_read', [
  [['bom_id', 'in', phantomBoms.map((b) => b.id)]],
  ['name', 'bom_id'],
]);
if (usedByMo.length) {
  console.error('\nRefusing to delete: these BoMs are referenced by manufacturing orders:');
  usedByMo.forEach((m) => console.error(`  ${m.name} -> BoM ${m.bom_id[1]}`));
  process.exit(1);
}

const lineIds = phantomBoms.flatMap((b) => b.bom_line_ids || []);
const lines = lineIds.length ? await execute('mrp.bom.line', 'read', [lineIds, []]) : [];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const snapshot = `server/data/odoo-recipe-rollback-${stamp}.json`;
fs.writeFileSync(
  snapshot,
  JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      note: 'Taken by stripOdooRecipeDuplicates.js before deleting phantom BoMs and clearing Recipe/BOM Internal Notes.',
      phantom_boms: phantomBoms,
      phantom_bom_lines: lines,
      internal_notes: noted,
    },
    null,
    2,
  ),
);
console.log(`\nrollback snapshot: ${snapshot} (${phantomBoms.length} BoMs, ${lines.length} lines, ${noted.length} notes)`);

if (phantomBoms.length) {
  await execute('mrp.bom', 'unlink', [phantomBoms.map((b) => b.id)]);
  console.log(`deleted ${phantomBoms.length} phantom BoMs`);
}
if (noted.length) {
  await execute('product.template', 'write', [noted.map((n) => n.id), { description: false }]);
  console.log(`cleared ${noted.length} Internal Notes`);
}

const leftBoms = await execute('mrp.bom', 'search_count', [[['type', '=', 'phantom']]]);
const leftNotes = (await execute('product.template', 'read', [productIds, ['description']])).filter(
  (r) => r.description,
).length;
console.log(`\nverified: phantom BoMs remaining ${leftBoms}, Internal Notes remaining ${leftNotes}`);
