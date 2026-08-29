// Covers the B2B cost-attribution chain: which purchase_log.csv line ends up
// charged to which cook, and to which account.
//
// Two link columns exist between these two files and it matters that they
// stay separate, so most of what's tested here is the boundary between them:
//   smoking_log.csv   source_purchase_id  — where a session's raw weight came
//                                           from (one lot, drives FIFO maths)
//   purchase_log.csv  smoking_session_id  — which cook a line of spend was
//                                           for (many lines, and it includes
//                                           the spices and packaging that
//                                           never had a weight of their own)
// The rules worth pinning down are the ones a future edit could plausibly
// "simplify" into being wrong: a tag must never be stolen from another cook,
// a client set on the buy itself must outrank the session's, and deleting a
// session must free the spend rather than delete it.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCsvFile } from '../../core/csvStore.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-session-tag-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'Purchase'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'Inventory'), { recursive: true });
const purchasesPath = path.join(dataDir, 'Purchase', 'purchase_log.csv');

const { tagPurchasesToSession, clearSessionPurchaseTags, recordPurchases } = await import('./purchasing.js');

// The post-migration header. purchasesFile() only checks for the added
// columns once per process (the file is small, but every call would otherwise
// re-parse it for a migration that has already run), and beforeEach below
// rewrites this file between tests. A pre-migration fixture here would
// therefore migrate on the first test only, then silently drop the new
// columns on every one after it. The migration itself is covered separately
// in purchasingMigration.test.js, which gets its own fresh module registry.
const HEADER =
  'purchase_id,purchase_date,channel,client_id,client_name,smoking_session_id,vendor_id,vendor_name,' +
  'item_type,material_id,item_name,quantity_purchased,unit_of_measure,unit_price,total_cost,currency';
const FIXTURE =
  [
    HEADER,
    'PUR-0001,2026-08-17,B2B,,,,VEN-001,Pork Shop,material,RM-001,Pork shoulder,10,kg,400,4000,INR',
    'PUR-0002,2026-08-17,B2B,,,,VEN-002,Swiggy,,,Butcher paper,50,pcs,4,200,INR',
    'PUR-0003,2026-08-17,B2C,,,,VEN-001,Pork Shop,material,RM-001,Pork shoulder,5,kg,400,2000,INR',
  ].join('\n') + '\n';

// vendors.csv is only read by recordPurchases, to resolve a vendor_id.
fs.writeFileSync(
  path.join(dataDir, 'Purchase', 'vendors.csv'),
  'vendor_id,vendor_name,vendor_type,supplies_category,contact_person,phone,email,address,notes\n' +
    'VEN-001,Pork Shop,Meat Vendor,Pork,,,,,\n',
  'utf8',
);
// materials.csv is read by adjustInventory; an empty catalog just means every
// line is skipped for the inventory bump, which is fine here.
fs.writeFileSync(
  path.join(dataDir, 'Inventory', 'materials.csv'),
  'material_id,item_name,category,unit_of_measure,quantity_on_hand,reorder_level,last_updated\n',
  'utf8',
);

const rowFor = (id) => readCsvFile(purchasesPath).rows.find((r) => r.purchase_id === id);

beforeEach(() => {
  process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;
  fs.writeFileSync(purchasesPath, FIXTURE, 'utf8');
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('tagPurchasesToSession', () => {
  it('stamps the session and inherits its client onto each line', () => {
    const result = tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    expect(result.tagged).toEqual(['PUR-0001', 'PUR-0002']);
    // The packaging line matters as much as the meat: "what did this cook
    // cost" is the whole point, and the answer isn't only the meat.
    expect(rowFor('PUR-0002')).toMatchObject({ smoking_session_id: 'SMK-0001', client_name: 'Taj Hotel' });
  });

  it('never steals a line already tagged to a different cook', () => {
    tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });

    const result = tagPurchasesToSession({
      sessionId: 'SMK-0002',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-002',
      clientName: 'Marriott',
    });

    // Re-pointing it would silently move 4000 rupees off the first cook with
    // nothing left to show it ever happened.
    expect(result.skipped).toEqual([{ purchase_id: 'PUR-0001', taggedTo: 'SMK-0001' }]);
    expect(rowFor('PUR-0001').smoking_session_id).toBe('SMK-0001');
    expect(rowFor('PUR-0001').client_name).toBe('');
    // The unclaimed line still goes through — one conflict doesn't sink the batch.
    expect(result.tagged).toEqual(['PUR-0002']);
  });

  it('leaves a client set on the buy itself alone', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 4,
          unitPrice: 400,
          clientId: 'CLI-009',
          clientName: 'Leela',
        },
      ],
    });

    tagPurchasesToSession({
      sessionId: 'SMK-0003',
      purchaseIds: [purchases[0].purchase_id],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    // Whoever logged the buy said outright who it was for; inheriting from
    // whichever cook happened to eat it is the weaker claim.
    expect(rowFor(purchases[0].purchase_id)).toMatchObject({
      client_name: 'Leela',
      smoking_session_id: 'SMK-0003',
    });
  });

  it('treats purchaseIds as the full set, so unticking untags', () => {
    tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001', 'PUR-0002'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    const result = tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });

    expect(result.untagged).toEqual(['PUR-0002']);
    expect(rowFor('PUR-0002').smoking_session_id).toBe('');
    // Which account the money was for outlives any one cook.
    expect(rowFor('PUR-0002').client_name).toBe('Taj Hotel');
  });

  it('only touches the session it was given', () => {
    tagPurchasesToSession({ sessionId: 'SMK-0001', purchaseIds: ['PUR-0001'] });
    tagPurchasesToSession({ sessionId: 'SMK-0002', purchaseIds: ['PUR-0002'] });

    expect(rowFor('PUR-0001').smoking_session_id).toBe('SMK-0001');
    expect(rowFor('PUR-0002').smoking_session_id).toBe('SMK-0002');
  });

  it('rejects a missing sessionId rather than blanking every tag', () => {
    expect(() => tagPurchasesToSession({ purchaseIds: ['PUR-0001'] })).toThrow(/sessionId is required/);
  });
});

describe('clearSessionPurchaseTags', () => {
  it('frees the spend but keeps the purchase', () => {
    tagPurchasesToSession({
      sessionId: 'SMK-0001',
      purchaseIds: ['PUR-0001'],
      clientId: 'CLI-001',
      clientName: 'Taj Hotel',
    });

    expect(clearSessionPurchaseTags('SMK-0001').untagged).toEqual(['PUR-0001']);
    // Deleting a mis-logged cook must not erase money that was actually spent.
    expect(rowFor('PUR-0001')).toMatchObject({
      smoking_session_id: '',
      client_name: 'Taj Hotel',
      total_cost: '4000',
    });
  });
});

describe('recordPurchases client tag', () => {
  it('stores a per-line client on B2B', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2B',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 6,
          unitPrice: 400,
          clientId: 'CLI-001',
          clientName: 'Taj Hotel',
        },
        { itemName: 'Butcher paper', unit: 'pcs', quantity: 20, unitPrice: 4 },
      ],
    });

    // Per line, because one butcher run routinely covers two accounts and one
    // cart routinely mixes a client's meat with packaging bought for nobody.
    expect(purchases[0]).toMatchObject({ client_id: 'CLI-001', client_name: 'Taj Hotel' });
    expect(purchases[1]).toMatchObject({ client_id: '', client_name: '' });
    // Never pre-set here — the cook doesn't exist yet at buying time.
    expect(purchases.every((p) => p.smoking_session_id === '')).toBe(true);
  });

  it('drops a client tag on a B2C buy, which has no account book', () => {
    const { purchases } = recordPurchases({
      vendorName: 'Pork Shop',
      purchaseDate: '2026-08-18',
      channel: 'B2C',
      lines: [
        {
          materialId: 'RM-001',
          itemName: 'Pork shoulder',
          unit: 'kg',
          quantity: 3,
          unitPrice: 400,
          clientId: 'CLI-001',
          clientName: 'Taj Hotel',
        },
      ],
    });

    expect(purchases[0]).toMatchObject({ client_id: '', client_name: '' });
  });
});
