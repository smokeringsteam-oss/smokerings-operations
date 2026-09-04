// What the local pass is allowed to shortlist.
//
// This is the half that runs with no key and no network, and everything
// Gemini is later asked to choose between comes from it — so a right answer
// it fails to shortlist is an answer the whole feature can never give. The
// tests below pin both directions: the wordings that must still find their
// item (abbreviations, plurals, pack sizes, brand prefixes, typos), and the
// near-misses that must NOT outrank it, because the expensive mistake here is
// linking a buy to the wrong ingredient and moving stock onto it.
import { describe, it, expect } from 'vitest';
import { MIN_LOCAL_SCORE, scoreMaterials, tokenise } from './materialMatch.js';

const MATERIALS = [
  { material_id: 'RM-001', item_name: 'Pork Shoulder', category: 'Meat' },
  { material_id: 'RM-002', item_name: 'Pork Belly', category: 'Meat' },
  { material_id: 'RM-003', item_name: 'Chicken Whole', category: 'Meat' },
  { material_id: 'RM-004', item_name: 'Chicken Breast', category: 'Meat' },
  { material_id: 'RM-010', item_name: 'Burger Buns', category: 'Bread' },
  { material_id: 'RM-020', item_name: 'Butter', category: 'Dairy' },
  { material_id: 'RM-030', item_name: 'Coriander', category: 'Produce' },
  { material_id: 'RM-040', item_name: 'Smoked Paprika', category: 'Spices' },
];

const best = (name) => scoreMaterials(name, MATERIALS)[0]?.material.material_id;
const ranked = (name) => scoreMaterials(name, MATERIALS).map((r) => r.material.material_id);

describe('tokenise', () => {
  it('drops units, pack wording and bare numbers', () => {
    expect(tokenise('Amul Butter 500 g pkt')).toEqual(['amul', 'butter']);
  });

  it('singularises, so a plural on either side still lines up', () => {
    expect(tokenise('Burger Buns')).toEqual(tokenise('burger bun'));
  });

  it('splits on punctuation the bill uses as separators', () => {
    expect(tokenise('PORK-SHLDR/BL')).toEqual(['pork', 'shldr', 'bl']);
  });
});

describe('scoring a typed name against the catalogue', () => {
  it('scores an exact match, once normalised, at 1', () => {
    const [top] = scoreMaterials('burger buns x 24', MATERIALS);

    expect(top.material.material_id).toBe('RM-010');
    expect(top.score).toBe(1);
  });

  it.each([
    ['pork shoulder boneless 5 kg', 'RM-001'],
    ['Amul Butter 500g', 'RM-020'],
    ['corriander', 'RM-030'],
    ['smoked paprika powder', 'RM-040'],
  ])('ranks %s first against %s', (typed, expected) => {
    expect(best(typed)).toBe(expected);
  });

  // The one that matters most: two catalogue items share a word, and the
  // shared word must not be enough to pick the wrong one.
  it('keeps two cuts of the same animal apart', () => {
    expect(best('pork belly skin on')).toBe('RM-002');
    expect(best('whole chicken 4 nos')).toBe('RM-003');
  });

  it('still shortlists the sibling cut, since deciding between them is the model\'s job', () => {
    expect(ranked('pork belly skin on')).toContain('RM-001');
  });

  it('leaves out the catalogue items that merely share a category', () => {
    expect(ranked('Amul Butter 500g')).not.toContain('RM-030');
  });

  it('returns nothing for a name with no usable words', () => {
    expect(scoreMaterials('500 g', MATERIALS)).toEqual([]);
    expect(scoreMaterials('', MATERIALS)).toEqual([]);
  });

  it('returns nothing when the catalogue has nothing like it', () => {
    // A real ad hoc item — the answer here is "add it as a new material",
    // and a shortlist of coincidences would only push someone towards
    // linking it to the wrong row.
    expect(scoreMaterials('Aluminium Foil Roll', MATERIALS)).toEqual([]);
  });

  it('never shortlists below the noise floor', () => {
    scoreMaterials('pork shoulder', MATERIALS).forEach((row) => {
      expect(row.score).toBeGreaterThanOrEqual(MIN_LOCAL_SCORE);
    });
  });

  it('ranks best first', () => {
    const scores = scoreMaterials('chicken breast fillet', MATERIALS).map((r) => r.score);

    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
