// The Idea Board's store: what it accepts, what it refuses, and that a 🔥 tap
// is a counter rather than a read-then-write.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from '../core/testDb.js';

const { dir } = createTestDb();

const { run } = await import('../core/db.js');
const {
  listIdeas,
  addIdea,
  updateIdea,
  fireIdea,
  deleteIdea,
  listCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  MAX_TITLE,
} = await import('./ideas.js');

const DEFAULTS = ['menu', 'marketing', 'ops', 'experience', 'wild'];

beforeEach(() => {
  run('DELETE FROM idea');
  run(`DELETE FROM idea_category WHERE category_id NOT IN (${DEFAULTS.map(() => '?').join(', ')})`, ...DEFAULTS);
});

afterAll(() => removeTestDb(dir));

describe('adding an idea', () => {
  it('starts as a spark with no fire, in the wild category by default', () => {
    const idea = addIdea({ title: '  Smoked pineapple dessert  ', author: 'Adarsh' });
    expect(idea).toMatchObject({
      title: 'Smoked pineapple dessert',
      details: '',
      category: 'wild',
      stage: 'spark',
      fire: 0,
      author: 'Adarsh',
    });
    expect(idea.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('refuses a blank title and an unknown category', () => {
    expect(() => addIdea({ title: '   ' })).toThrow(/at least a line/);
    expect(() => addIdea({ title: 'Brewery pop-up', category: 'party' })).toThrow(/category does not exist/);
    expect(listIdeas().ideas).toHaveLength(0);
  });

  it('caps the title length', () => {
    const idea = addIdea({ title: 'x'.repeat(MAX_TITLE + 50) });
    expect(idea.title).toHaveLength(MAX_TITLE);
  });
});

describe('the board', () => {
  it('lists newest first', () => {
    addIdea({ title: 'First' });
    addIdea({ title: 'Second' });
    expect(listIdeas().ideas.map((i) => i.title)).toEqual(['Second', 'First']);
  });
});

describe('changing an idea', () => {
  it('moves the stage without touching the words', () => {
    const { id } = addIdea({ title: 'Brisket burnt-end tacos', details: 'Friday special', category: 'menu' });
    const moved = updateIdea({ id, stage: 'smoking' });
    expect(moved).toMatchObject({ stage: 'smoking', title: 'Brisket burnt-end tacos', details: 'Friday special' });
    expect(moved.updatedAt).not.toBeNull();
  });

  it('refuses an unknown stage, an empty patch and a missing idea', () => {
    const { id } = addIdea({ title: 'Loyalty card' });
    expect(() => updateIdea({ id, stage: 'eaten' })).toThrow(/stage must be one of/);
    expect(() => updateIdea({ id })).toThrow(/Nothing to change/);
    expect(() => updateIdea({ id: id + 99, stage: 'served' })).toThrow(/no longer exists/);
  });
});

describe('🔥', () => {
  it('counts every tap', () => {
    const { id } = addIdea({ title: 'Pitmaster masterclass' });
    fireIdea({ id });
    fireIdea({ id });
    expect(fireIdea({ id }).fire).toBe(3);
  });

  it('404s on an idea that is gone', () => {
    expect(() => fireIdea({ id: 12345 })).toThrow(/no longer exists/);
  });
});

describe('deleting', () => {
  it('is not an error the second time', () => {
    const { id } = addIdea({ title: 'Merch tees' });
    expect(deleteIdea({ id })).toEqual({ deleted: true, id });
    expect(deleteIdea({ id })).toEqual({ deleted: false, id });
  });
});

describe('categories', () => {
  it('starts with the five defaults, Wild card last and not removable', () => {
    const categories = listCategories();
    expect(categories.map((c) => c.id)).toEqual(DEFAULTS);
    expect(categories.find((c) => c.id === 'wild')).toMatchObject({ label: 'Wild card', removable: false });
  });

  it('adds one with a slug id, at the end, on a paper nobody else has', () => {
    const club = addCategory({ label: '  Supper club ideas ', emoji: '🕯️' });
    expect(club).toMatchObject({ id: 'supper-club-ideas', label: 'Supper club ideas', emoji: '🕯️', ideas: 0 });
    expect(listCategories().at(-1).id).toBe('supper-club-ideas');
    const taken = listCategories().filter((c) => c.id !== club.id).map((c) => c.color);
    expect(taken).not.toContain(club.color);
  });

  it('takes ideas once it exists, and counts them', () => {
    addCategory({ label: 'New menu' });
    addIdea({ title: 'Smoked lamb shoulder', category: 'new-menu' });
    expect(listCategories().find((c) => c.id === 'new-menu').ideas).toBe(1);
  });

  it('refuses a blank name, a duplicate name and an unknown colour', () => {
    expect(() => addCategory({ label: '  ' })).toThrow(/needs a name/);
    expect(() => addCategory({ label: 'menu' })).toThrow(/already a “menu”/);
    expect(() => addCategory({ label: 'Pop-ups', color: 'tartan' })).toThrow(/color must be one of/);
  });

  it('keeps its id through a rename, so its ideas stay with it', () => {
    addCategory({ label: 'Supper club' });
    const { id } = addIdea({ title: 'Candlelit brisket night', category: 'supper-club' });
    const renamed = updateCategory({ id: 'supper-club', label: 'Supper clubs', color: 'coral' });
    expect(renamed).toMatchObject({ id: 'supper-club', label: 'Supper clubs', color: 'coral', ideas: 1 });
    expect(listIdeas().ideas.find((i) => i.id === id).category).toBe('supper-club');
  });

  it('moves the ideas of a deleted category to Wild card', () => {
    addCategory({ label: 'Pop-ups' });
    const { id } = addIdea({ title: 'Brewery pop-up', category: 'pop-ups' });
    expect(deleteCategory({ id: 'pop-ups' })).toEqual({ deleted: true, id: 'pop-ups', moved: 1 });
    expect(listIdeas().ideas.find((i) => i.id === id).category).toBe('wild');
    expect(listCategories().map((c) => c.id)).not.toContain('pop-ups');
  });

  it('will not delete Wild card', () => {
    expect(() => deleteCategory({ id: 'wild' })).toThrow(/can’t be deleted/);
  });
});
