// A platter is one Odoo line whose picks live in its text — see platterPicks.
import { describe, it, expect } from 'vitest';
import { platterPicks } from './odoo.js';

describe('platterPicks', () => {
  it('leaves anything that is not a platter alone', () => {
    expect(platterPicks('pork-bbq-burger', 'Texas Style Pulled Pork BBQ Burger', 1, 'S1')).toBeNull();
  });

  it('splits the website line text into one row per pick, at the platter quantity', () => {
    const text =
      '[PLT-6] Any 6 Platter (Pulled Pork 250g, BBQ Pork Burnt Ends 150g, Teriyaki Pork Burnt Ends 150g, ' +
      'Cajun Chicken Half, Cajun Chicken Quarter, Smoked Chicken Wings 6 pcs)\nChoose any 6 of our smoked meats.';
    const result = platterPicks('any-6-platter', text, 2, 'S2');
    expect(result.problems).toEqual([]);
    expect(result.picks.map((p) => p.itemId)).toEqual([
      'platter-pulled-pork',
      'platter-bbq-burnt-ends',
      'platter-teriyaki-burnt-ends',
      'platter-cajun-half',
      'platter-cajun-quarter',
      'platter-wings',
    ]);
    expect(result.picks.every((p) => p.qty === 2)).toBe(true);
    expect(result.picks.every((p) => p.platterId === 'any-6-platter')).toBe(true);
  });

  it('knows brisket and ribs apart', () => {
    const result = platterPicks('any-3-platter', 'Any 3 Platter (Smoked Brisket 250g, Smokey BBQ Ribs 250g, Pulled Pork 250g)', 1, 'S3');
    expect(result.picks.map((p) => p.itemId)).toEqual(['platter-brisket', 'platter-ribs', 'platter-pulled-pork']);
  });

  it('says so when the picks are missing or unknown, rather than guessing', () => {
    expect(platterPicks('any-3-platter', 'Any 3 Platter', 1, 'S4').problems[0]).toMatch(/no meats listed/);
    const odd = platterPicks('any-3-platter', 'Any 3 Platter (Smoked Brisket 250g, Lamb Chops)', 1, 'S5');
    expect(odd.picks.map((p) => p.itemId)).toEqual(['platter-brisket']);
    expect(odd.problems[0]).toMatch(/Lamb Chops/);
  });
});
