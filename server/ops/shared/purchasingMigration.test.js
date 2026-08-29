// The one-time purchase_log.csv column migration, on its own because
// purchasesFile() only runs the check once per process — a second test file
// gets a fresh module registry, and so a fresh chance to migrate.
//
// What this is guarding: writeCsvFile and appendCsvRows only ever write the
// columns the header names. A knowledge-base checkout that predates B2B cost
// attribution would therefore take a client or a session tag and silently
// drop it on every save, with no error anywhere. The behavioural tests live
// in purchaseSessionTag.test.js.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCsvFile } from '../../core/csvStore.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchasing-migration-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'Purchase'), { recursive: true });
const purchasesPath = path.join(dataDir, 'Purchase', 'purchase_log.csv');

// The pre-feature header: channel is there (B2B purchasing shipped before
// this), the three attribution columns are not.
fs.writeFileSync(
  purchasesPath,
  'purchase_id,purchase_date,channel,vendor_id,vendor_name,item_type,material_id,item_name,' +
    'quantity_purchased,unit_of_measure,unit_price,total_cost,currency\n' +
    'PUR-0001,2026-08-17,B2B,VEN-001,Pork Shop,material,RM-001,Pork shoulder,10,kg,400,4000,INR\n',
  'utf8',
);

const { getPurchases } = await import('./purchasing.js');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('purchase_log.csv attribution columns', () => {
  it('adds them to a pre-feature file without disturbing the rows', () => {
    // Any read through purchasesFile() triggers it; getPurchases is the
    // cheapest one that does.
    getPurchases({});

    const { header, rows } = readCsvFile(purchasesPath);
    expect(header).toEqual(expect.arrayContaining(['client_id', 'client_name', 'smoking_session_id']));
    // This is a whole-file rewrite, not an append, so the existing buy has to
    // come through it unchanged.
    expect(rows[0]).toMatchObject({
      purchase_id: 'PUR-0001',
      channel: 'B2B',
      vendor_name: 'Pork Shop',
      quantity_purchased: '10',
      total_cost: '4000',
    });
    // Blank, not guessed: there is no honest way to say after the fact which
    // account or cook a historic buy was for.
    expect(rows[0]).toMatchObject({ client_id: '', client_name: '', smoking_session_id: '' });
  });
});
