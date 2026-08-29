// Covers the B2B client store: the meat-demand rollup arithmetic (which is
// the number the kitchen would plan off), the Sampling/Onboarding stage
// fields, and the two places a write could silently lose data — a demand
// edit that has to replace a client's whole set, and a delete that has to
// take its demand lines with it.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-clients-'));
process.env.KNOWLEDGE_BASE_DATA_DIR = dataDir;

const { listClients, addClient, updateClient, setStage, setDemands, deleteClient } = await import('./b2bClients.js');

// Both files live under Data/B2B (server/ops/b2b/b2bClients.js CLIENTS_FILE) — the
// store creates that folder itself, so the temp dir starts out empty here.
const clientsPath = path.join(dataDir, 'B2B', 'b2b_clients.csv');
const demandsPath = path.join(dataDir, 'B2B', 'b2b_client_demands.csv');

const reset = () => {
  [clientsPath, demandsPath].forEach((p) => {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
};

beforeEach(reset);
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('b2bClients', () => {
  it('creates both CSVs on first use and starts an account as a lead', () => {
    const { client } = addClient({ name: 'Toit Brewpub', businessType: 'Cafe / Bar', area: 'Indiranagar' });

    expect(client.id).toBe('B2B-0001');
    expect(client.stage).toBe('lead');
    expect(fs.existsSync(clientsPath)).toBe(true);
    expect(listClients().clients).toHaveLength(1);
    // The demands file is created lazily, by the first read/write that needs
    // it — a fresh knowledge-base checkout doesn't have to ship either file.
    expect(fs.existsSync(demandsPath)).toBe(true);
  });

  it('refuses a duplicate name, case-insensitively', () => {
    addClient({ name: 'Toit Brewpub' });
    expect(() => addClient({ name: 'toit brewpub' })).toThrow(/already on the B2B client list/);
  });

  it('normalises every cadence to a weekly figure and keeps ad hoc out of it', () => {
    const { id } = addClient({ name: 'Big Hotel' }).client;
    const { client } = setDemands({
      id,
      demands: [
        { category: 'pulledPork', qtyKg: 10, cadence: 'weekly' },
        { category: 'chicken', qtyKg: 8, cadence: 'fortnightly' },
        { category: 'ribs', qtyKg: 26, cadence: 'monthly' },
        { category: 'porkBelly', qtyKg: 15, cadence: 'adhoc' },
      ],
    });

    const byCategory = Object.fromEntries(client.demands.map((d) => [d.category, d.kgPerWeek]));
    expect(byCategory.pulledPork).toBe(10);
    expect(byCategory.chicken).toBe(4);
    expect(byCategory.ribs).toBe(6); // 26 * 12/52
    expect(byCategory.porkBelly).toBe(0);
    // The ad-hoc 15 kg is real business but not standing weekly demand, so it
    // is reported on its own rather than averaged into the weekly total.
    expect(client.kgPerWeek).toBe(20);
    expect(client.adhocKg).toBe(15);
  });

  it('splits the rollup into committed and pipeline, and only counts active accounts as committed', () => {
    const active = addClient({ name: 'Active Cafe' }).client;
    const lead = addClient({ name: 'Maybe Cafe' }).client;
    setDemands({ id: active.id, demands: [{ category: 'chicken', qtyKg: 12, cadence: 'weekly' }] });
    setDemands({ id: lead.id, demands: [{ category: 'chicken', qtyKg: 5, cadence: 'weekly' }] });
    setStage({ id: active.id, stage: 'active' });

    const { summary } = listClients();
    expect(summary.committedKgPerWeek).toBe(12);
    expect(summary.pipelineKgPerWeek).toBe(5);
    expect(summary.byStage).toMatchObject({ active: 1, lead: 1 });

    const chicken = summary.byCategory.find((c) => c.category === 'chicken');
    expect(chicken).toMatchObject({ committedKgPerWeek: 12, pipelineKgPerWeek: 5 });
  });

  it('replaces a client\'s demand set on save, drops zeroed lines, and leaves other clients alone', () => {
    const a = addClient({ name: 'Client A' }).client;
    const b = addClient({ name: 'Client B' }).client;
    setDemands({ id: b.id, demands: [{ category: 'ribs', qtyKg: 4, cadence: 'weekly' }] });
    setDemands({
      id: a.id,
      demands: [
        { category: 'chicken', qtyKg: 6, cadence: 'weekly' },
        { category: 'pulledPork', qtyKg: 3, cadence: 'weekly' },
      ],
    });

    // Re-save with pulled pork zeroed: that is how the UI says "drop this
    // meat", so it must delete the line rather than store a 0 kg row.
    const { client } = setDemands({
      id: a.id,
      demands: [
        { category: 'chicken', qtyKg: 9, cadence: 'weekly' },
        { category: 'pulledPork', qtyKg: 0, cadence: 'weekly' },
      ],
    });

    expect(client.demands.map((d) => d.category)).toEqual(['chicken']);
    expect(client.kgPerWeek).toBe(9);
    const clientB = listClients().clients.find((c) => c.id === b.id);
    expect(clientB.demands).toHaveLength(1);
  });

  it('rejects an unknown category, a duplicated one, and a nonsense quantity', () => {
    const { id } = addClient({ name: 'Picky Client' }).client;
    expect(() => setDemands({ id, demands: [{ category: 'mutton', qtyKg: 2 }] })).toThrow(/not a meat category/);
    expect(() =>
      setDemands({
        id,
        demands: [
          { category: 'chicken', qtyKg: 2 },
          { category: 'chicken', qtyKg: 3 },
        ],
      }),
    ).toThrow(/listed twice/);
    expect(() => setDemands({ id, demands: [{ category: 'chicken', qtyKg: 'lots' }] })).toThrow(/number of kg/);
  });

  it('keeps the sampling round on the account and validates the outcome', () => {
    const { id } = addClient({ name: 'Sample Me' }).client;
    setStage({ id, stage: 'sampling' });
    const { client } = updateClient({
      id,
      sampleSentOn: '2026-08-14',
      sampleItems: ['Pulled pork', 'Beef ribs'],
      sampleOutcome: 'needs_changes',
      sampleFeedback: 'Loved the pork, wants it less sweet.',
    });

    expect(client.sampleItems).toEqual(['Pulled pork', 'Beef ribs']);
    expect(client.sampleOutcome).toBe('needs_changes');
    expect(() => updateClient({ id, sampleOutcome: 'maybe' })).toThrow(/not a sample outcome/);
  });

  it('stores onboarding steps in checklist order and counts them', () => {
    const { id } = addClient({ name: 'Onboarding Co' }).client;
    // Ticked out of order — stored in checklist order so the cell reads the
    // same as the list on screen.
    const { client } = updateClient({ id, onboardingSteps: ['first_order', 'pricing_agreed'] });

    expect(client.onboardingSteps).toEqual(['pricing_agreed', 'first_order']);
    expect(client.onboardingDone).toBe(2);
    expect(client.onboardingTotal).toBe(6);
    expect(() => updateClient({ id, onboardingSteps: ['send_flowers'] })).toThrow(/not an onboarding step/);
  });

  it('stamps the go-live date once, and does not rewrite it on a pause and restart', () => {
    const { id } = addClient({ name: 'Steady Co' }).client;
    const live = setStage({ id, stage: 'active' }).client;
    expect(live.onboardedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    setStage({ id, stage: 'paused' });
    const back = setStage({ id, stage: 'active' }).client;
    expect(back.onboardedOn).toBe(live.onboardedOn);
  });

  it('keeps the reason when an account is lost, and rejects an unknown stage', () => {
    const { id } = addClient({ name: 'Gone Co' }).client;
    const { client } = setStage({ id, stage: 'lost', lostReason: 'Went with a cheaper supplier.' });
    expect(client.stage).toBe('lost');
    expect(client.lostReason).toBe('Went with a cheaper supplier.');
    expect(() => setStage({ id, stage: 'nearly' })).toThrow(/not a pipeline stage/);
  });

  it('takes a deleted client\'s demand lines with it', () => {
    const a = addClient({ name: 'Doomed Co' }).client;
    const b = addClient({ name: 'Surviving Co' }).client;
    setDemands({ id: a.id, demands: [{ category: 'chicken', qtyKg: 5, cadence: 'weekly' }] });
    setDemands({ id: b.id, demands: [{ category: 'ribs', qtyKg: 2, cadence: 'weekly' }] });

    deleteClient({ id: a.id });

    const { clients, summary } = listClients();
    expect(clients.map((c) => c.name)).toEqual(['Surviving Co']);
    expect(summary.byCategory.some((c) => c.category === 'chicken')).toBe(false);
  });

  it('migrates a file written against an older header instead of dropping its new columns', () => {
    // A pre-Sampling-stage file: the columns this module has gained since
    // must be added on read, and the rows kept.
    fs.writeFileSync(clientsPath, 'client_id,name,stage\nB2B-0001,Legacy Co,active\n', 'utf8');

    const { client } = updateClient({ id: 'B2B-0001', sampleOutcome: 'liked' });
    expect(client.name).toBe('Legacy Co');
    expect(client.sampleOutcome).toBe('liked');
    expect(fs.readFileSync(clientsPath, 'utf8')).toMatch(/sample_outcome/);
  });
});
