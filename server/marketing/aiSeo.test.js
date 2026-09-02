// The AI SEO store, on the database.
//
// Everything here is the half of aiSeo.js that doesn't call Gemini: tracked
// prompts and the run history they accumulate. That half is what moved off
// aiseo_prompts.csv / aiseo_runs.csv, and the cases below are the ones where
// the CSV and the table genuinely behave differently — a prompt's active
// flag as 0/1 rather than "yes"/"no", a partial update that must not blank
// the columns it wasn't given, and a deleted prompt whose runs survive it
// because the foreign key clears the id instead of cascading.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb();
const seo = await import('./aiSeo.js');
const { insert, selectOne } = await import('../core/repo.js');
const { run } = await import('../core/db.js');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

// The columns saveRun writes, minus the ones each case is actually about.
const runRow = (over) => ({
  prompt_text: 'Best BBQ in Bengaluru?',
  engine: 'gemini',
  source: 'auto',
  mentioned: 0,
  sentiment: 'not_mentioned',
  competitors: '',
  ...over,
});

beforeEach(() => {
  run('DELETE FROM aiseo_run');
  run('DELETE FROM aiseo_prompt');
});

afterAll(() => removeTestDb(dir));

describe('tracked prompts', () => {
  it('allocates sequential SEOP ids and refuses a duplicate however it was typed', () => {
    const first = seo.addPrompt({ text: 'Best BBQ in Bengaluru?', intent: 'discovery' });
    const second = seo.addPrompt({ text: 'Best burnt ends in Bengaluru' });

    expect([first.prompt.id, second.prompt.id]).toEqual(['SEOP-0001', 'SEOP-0002']);
    expect(first.prompt).toMatchObject({ text: 'Best BBQ in Bengaluru?', intent: 'discovery', isActive: true });

    // Same question, different case and padding: tracking it twice would
    // double every average the dashboard computes off it.
    expect(() => seo.addPrompt({ text: '  best bbq in BENGALURU?  ' })).toThrow(/already being tracked/);
  });

  it('seeds the starter set once, whatever a nervous second click does', () => {
    const first = seo.seedPrompts();
    expect(first.added).toBeGreaterThan(0);

    const second = seo.seedPrompts();
    expect(second.added).toBe(0);
    expect(second.prompts).toHaveLength(first.prompts.length);

    // Contiguous ids: nextId re-reading the max inside the transaction is
    // what stops a batch insert from resolving every id to SEOP-0001.
    expect(new Set(first.prompts.map((p) => p.id)).size).toBe(first.prompts.length);
  });

  it('updates only the fields it was given', () => {
    const { prompt } = seo.addPrompt({ text: 'Best BBQ in Bengaluru?', intent: 'discovery' });

    // The dashboard's toggle posts isActive alone. A patch built from every
    // field would write undefined over the text and the intent.
    const off = seo.updatePrompt({ id: prompt.id, isActive: false });
    expect(off.prompt).toMatchObject({ text: 'Best BBQ in Bengaluru?', intent: 'discovery', isActive: false });
    expect(selectOne('aiseo_prompt', { prompt_id: prompt.id }).is_active).toBe(0);

    const renamed = seo.updatePrompt({ id: prompt.id, text: '  Where to get brisket in Bengaluru?  ' });
    expect(renamed.prompt).toMatchObject({ text: 'Where to get brisket in Bengaluru?', isActive: false });
  });

  it('says which prompt is missing rather than reporting a no-op write', () => {
    expect(() => seo.updatePrompt({ id: 'SEOP-9999', intent: 'brand' })).toThrow(/No tracked prompt with id SEOP-9999/);
    expect(() => seo.deletePrompt({ id: 'SEOP-9999' })).toThrow(/No tracked prompt with id SEOP-9999/);
  });
});

describe('the run history', () => {
  it('outlives the prompt it was checking, carrying the question with it', () => {
    const { prompt } = seo.addPrompt({ text: 'Best BBQ in Bengaluru?' });
    insert('aiseo_run', runRow({ run_id: 'SEOR-0001', prompt_id: prompt.id, ran_at: daysAgo(1) }));

    seo.deletePrompt({ id: prompt.id });

    const { runs } = seo.listRuns({});
    expect(runs).toHaveLength(1);
    // The id is cleared by the foreign key, so nothing points at a prompt
    // that no longer exists — but the denormalized text is still readable,
    // which is the whole reason it's on the row.
    expect(runs[0]).toMatchObject({ id: 'SEOR-0001', promptId: '', promptText: 'Best BBQ in Bengaluru?' });
  });

  it('returns the window newest first, and keeps a row whose date will not parse', () => {
    insert('aiseo_run', runRow({ run_id: 'SEOR-0001', ran_at: daysAgo(2) }));
    insert('aiseo_run', runRow({ run_id: 'SEOR-0002', ran_at: daysAgo(40) }));
    insert('aiseo_run', runRow({ run_id: 'SEOR-0003', ran_at: daysAgo(1) }));
    // Hand-entered by someone filling in a check they ran last week. Dropping
    // it would quietly understate visibility, so an unreadable date is kept.
    insert('aiseo_run', runRow({ run_id: 'SEOR-0004', ran_at: 'last tuesday' }));

    expect(seo.listRuns({ days: 7 }).runs.map((r) => r.id)).toEqual(['SEOR-0004', 'SEOR-0003', 'SEOR-0001']);
    expect(seo.listRuns({}).runs).toHaveLength(4);
  });

  it('reads a scored run back in the shape the dashboard expects', () => {
    insert(
      'aiseo_run',
      runRow({
        run_id: 'SEOR-0001',
        ran_at: daysAgo(1),
        mentioned: 1,
        position: 2,
        total_brands: 5,
        sentiment: 'positive',
        competitors: 'Smoke House;Barbeque Nation',
        citation_domains: 'reddit.com;zomato.com',
      }),
    );

    expect(seo.listRuns({}).runs[0]).toMatchObject({
      // 0/1 integers, not the CSV's "yes"/"no" strings.
      mentioned: true,
      position: 2,
      totalBrands: 5,
      competitors: ['Smoke House', 'Barbeque Nation'],
      citationDomains: ['reddit.com', 'zomato.com'],
      // Never logged, so it reads as empty rather than undefined.
      citationUrls: [],
    });
  });

  it('deletes one run and leaves the rest', () => {
    insert('aiseo_run', runRow({ run_id: 'SEOR-0001', ran_at: daysAgo(1) }));
    insert('aiseo_run', runRow({ run_id: 'SEOR-0002', ran_at: daysAgo(2) }));

    expect(seo.deleteRun({ id: 'SEOR-0001' })).toEqual({ deleted: 'SEOR-0001' });
    expect(seo.listRuns({}).runs.map((r) => r.id)).toEqual(['SEOR-0002']);
    expect(() => seo.deleteRun({ id: 'SEOR-0001' })).toThrow(/No run with id SEOR-0001/);
  });
});
