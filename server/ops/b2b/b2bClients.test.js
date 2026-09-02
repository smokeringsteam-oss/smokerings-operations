// Covers the B2B client store on the database: the meat-demand rollup
// arithmetic (which is the number the kitchen would plan off), the
// Sampling/Onboarding stage fields, and the places a write could silently
// lose data — a demand edit that has to replace a client's whole set, an
// update that must not touch anyone else's row, and a delete that has to take
// its demand lines with it.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

// Before the module under test is imported, so its first query lands on this
// database rather than the real server/data/smokerings.db. No fixtures: every
// test below builds the accounts it needs through addClient, which is the
// only way a client row is ever created.
const { dir } = createTestDb();

const { listClients, addClient, updateClient, setStage, setDemands, deleteClient } = await import('./b2bClients.js');
// Straight to db.js for the fixture reset: repo.remove refuses a where-less
// delete on purpose, which is right for production code and exactly what
// "clear the table" has to do here.
const { run, all } = await import('../../core/db.js');

beforeEach(() => {
  run('DELETE FROM b2b_client_demand');
  run('DELETE FROM b2b_client');
});

afterAll(() => removeTestDb(dir));

const demandRows = (clientId) => all('SELECT * FROM b2b_client_demand WHERE client_id = ?', clientId);

describe('b2bClients', () => {
  it('starts an account as a lead and allocates the next sequential id', () => {
    const first = addClient({ name: 'Toit Brewpub', businessType: 'Cafe / Bar', area: 'Indiranagar' }).client;
    const second = addClient({ name: 'Arbor Brewing' }).client;

    expect(first.id).toBe('B2B-0001');
    expect(second.id).toBe('B2B-0002');
    expect(first.stage).toBe('lead');
    expect(first.businessType).toBe('Cafe / Bar');
    expect(listClients().clients).toHaveLength(2);
  });

  it('reads the columns it never set as blanks, not as the string "null"', () => {
    // Every column addClient leaves alone is NULL in the database now, where
    // the CSV parser used to hand back ''. A bare null reaching the dashboard
    // renders as "null" in the contact fields, so the store has to fill them.
    const { client } = addClient({ name: 'Sparse Co' });
    expect(client.phone).toBe('');
    expect(client.gstin).toBe('');
    expect(client.lostReason).toBe('');
    expect(client.sampleItems).toEqual([]);
    expect(client.onboardingSteps).toEqual([]);
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

  it("replaces a client's demand set on save, drops zeroed lines, and leaves other clients alone", () => {
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
    // meat", so it must delete the line rather than store a 0 kg row — which
    // the column's CHECK (qty_kg > 0) would reject outright anyway.
    const { client } = setDemands({
      id: a.id,
      demands: [
        { category: 'chicken', qtyKg: 9, cadence: 'weekly' },
        { category: 'pulledPork', qtyKg: 0, cadence: 'weekly' },
      ],
    });

    expect(client.demands.map((d) => d.category)).toEqual(['chicken']);
    expect(client.kgPerWeek).toBe(9);
    // The replace clears only this client's lines: a where-less delete would
    // take B's with it and the rollup would quietly lose 4 kg a week.
    expect(demandRows(a.id)).toHaveLength(1);
    expect(demandRows(b.id)).toHaveLength(1);
    const clientB = listClients().clients.find((c) => c.id === b.id);
    expect(clientB.demands).toHaveLength(1);
  });

  it('stores the quantity as a number, so the rollup is not doing string maths', () => {
    const { id } = addClient({ name: 'Numeric Co' }).client;
    setDemands({ id, demands: [{ category: 'chicken', qtyKg: 2.5, cadence: 'weekly' }] });
    expect(demandRows(id)[0].qty_kg).toBe(2.5);
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

  it('leaves the stored demand untouched when a line in the same save is rejected', () => {
    const { id } = addClient({ name: 'Careful Co' }).client;
    setDemands({ id, demands: [{ category: 'chicken', qtyKg: 7, cadence: 'weekly' }] });

    // Every line is validated before anything is written, so a bad line in a
    // batch must not have already cleared the good set that was there.
    expect(() =>
      setDemands({
        id,
        demands: [
          { category: 'chicken', qtyKg: 9, cadence: 'weekly' },
          { category: 'mutton', qtyKg: 3, cadence: 'weekly' },
        ],
      }),
    ).toThrow(/not a meat category/);

    const [row] = demandRows(id);
    expect(row.qty_kg).toBe(7);
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
    // Ticked out of order — stored in checklist order so the stored value
    // reads the same as the list on screen.
    const { client } = updateClient({ id, onboardingSteps: ['first_order', 'pricing_agreed'] });

    expect(client.onboardingSteps).toEqual(['pricing_agreed', 'first_order']);
    expect(client.onboardingDone).toBe(2);
    expect(client.onboardingTotal).toBe(6);
    expect(() => updateClient({ id, onboardingSteps: ['send_flowers'] })).toThrow(/not an onboarding step/);
  });

  it('updates only the fields it was given, and only on the account it was given', () => {
    const a = addClient({ name: 'Edited Co', phone: '9000000001', area: 'Koramangala' }).client;
    const b = addClient({ name: 'Untouched Co', phone: '9000000002' }).client;

    const { client } = updateClient({ id: a.id, phone: '9111111111' });
    expect(client.phone).toBe('9111111111');
    // An UPDATE naming only the changed column must leave the rest of the row
    // alone — the whole-file rewrite this replaced could not promise that.
    expect(client.area).toBe('Koramangala');
    expect(client.name).toBe('Edited Co');

    const untouched = listClients().clients.find((c) => c.id === b.id);
    expect(untouched.phone).toBe('9000000002');
  });

  it('keeps the Odoo customer id a string on the way back out', () => {
    // The column is an INTEGER, but the detail form posts it as typed text
    // and compares it as text — a bare number here shows up as a changed
    // field on every save.
    const { id } = addClient({ name: 'Odoo Co' }).client;
    const { client } = updateClient({ id, odooPartnerId: '4211' });
    expect(client.odooPartnerId).toBe('4211');
  });

  it('refuses to blank out the name', () => {
    const { id } = addClient({ name: 'Named Co' }).client;
    expect(() => updateClient({ id, name: '   ' })).toThrow(/client name is required/);
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

  it("takes a deleted client's demand lines with it", () => {
    const a = addClient({ name: 'Doomed Co' }).client;
    const b = addClient({ name: 'Surviving Co' }).client;
    setDemands({ id: a.id, demands: [{ category: 'chicken', qtyKg: 5, cadence: 'weekly' }] });
    setDemands({ id: b.id, demands: [{ category: 'ribs', qtyKg: 2, cadence: 'weekly' }] });

    deleteClient({ id: a.id });

    const { clients, summary } = listClients();
    expect(clients.map((c) => c.name)).toEqual(['Surviving Co']);
    expect(summary.byCategory.some((c) => c.category === 'chicken')).toBe(false);
    // Not just absent from the rollup — gone from the table, so the next
    // account to take that id cannot inherit them.
    expect(demandRows(a.id)).toHaveLength(0);
    expect(demandRows(b.id)).toHaveLength(1);
  });

  it('404s on an id that is not on the book, rather than writing a new row', () => {
    expect(() => updateClient({ id: 'B2B-9999', phone: '9' })).toThrow(/No B2B client with id/);
    expect(() => setStage({ id: 'B2B-9999', stage: 'active' })).toThrow(/No B2B client with id/);
    expect(() => setDemands({ id: 'B2B-9999', demands: [] })).toThrow(/No B2B client with id/);
    expect(() => deleteClient({ id: 'B2B-9999' })).toThrow(/No B2B client with id/);
    expect(listClients().clients).toHaveLength(0);
  });
});
