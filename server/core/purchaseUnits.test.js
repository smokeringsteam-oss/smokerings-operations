// What "1" on a purchase line is, in the units a recipe counts in.
//
// The price sheet writes cost_basis as 'per 250 ml' / 'per kg' / 'per 30 pcs'
// and unitCost.js reads it back through basisOf, so the two halves have to
// agree on every spelling — a pack size that saves but does not parse would
// look like it worked and leave the dish exactly as uncosted as before.
import { describe, it, expect } from 'vitest';
import { basisFromCostBasis, basisOf, formatCostBasis, packFromText } from './purchaseUnits.js';

describe('basisFromCostBasis', () => {
  it('still reads the two spellings the catalogue had before the sheet', () => {
    expect(basisFromCostBasis('per kg')).toMatchObject({ bomUnits: 1000, unit: 'g' });
    expect(basisFromCostBasis('per pcs')).toMatchObject({ bomUnits: 1, unit: 'pcs' });
    expect(basisFromCostBasis('per pcs (2-ft baguette, ~30 slices)')).toMatchObject({ bomUnits: 1, unit: 'pcs' });
  });

  it('reads a counted pack in any of the units the sheet offers', () => {
    expect(basisFromCostBasis('per 250 ml')).toMatchObject({ bomUnits: 250, unit: 'ml' });
    expect(basisFromCostBasis('per 2 L')).toMatchObject({ bomUnits: 2000, unit: 'ml' });
    expect(basisFromCostBasis('per 500 g')).toMatchObject({ bomUnits: 500, unit: 'g' });
    expect(basisFromCostBasis('per 0.5 kg')).toMatchObject({ bomUnits: 500, unit: 'g' });
    expect(basisFromCostBasis('per 30 pcs')).toMatchObject({ bomUnits: 30, unit: 'pcs' });
    expect(basisFromCostBasis('per dozen')).toMatchObject({ bomUnits: 12, unit: 'pcs' });
    expect(basisFromCostBasis('per roll')).toMatchObject({ bomUnits: 1, unit: 'roll' });
  });

  it('does not read "litres" as "l" followed by junk, or "nos" as "no"', () => {
    expect(basisFromCostBasis('per 1 litres')).toMatchObject({ bomUnits: 1000, unit: 'ml' });
    expect(basisFromCostBasis('per 10 nos')).toMatchObject({ bomUnits: 10, unit: 'pcs' });
  });

  it('refuses free text rather than guessing a basis out of it', () => {
    expect(basisFromCostBasis('')).toBeNull();
    expect(basisFromCostBasis('about a tub')).toBeNull();
    expect(basisFromCostBasis('per tub')).toBeNull();
    expect(basisFromCostBasis('per 0 kg')).toBeNull();
  });
});

describe('formatCostBasis', () => {
  it('writes what basisFromCostBasis reads, for every unit', () => {
    for (const [size, unit] of [
      [1, 'kg'],
      [250, 'ml'],
      [2, 'L'],
      [100, 'g'],
      [30, 'pcs'],
      [1, 'dozen'],
      [1, 'roll'],
    ]) {
      const text = formatCostBasis(size, unit);
      expect(basisFromCostBasis(text)).toMatchObject({ packSize: size, packUnit: unit });
    }
  });

  it('leaves the count off at one, the way the older rows read', () => {
    expect(formatCostBasis(1, 'kg')).toBe('per kg');
    expect(formatCostBasis(250, 'ml')).toBe('per 250 ml');
  });

  it('refuses a unit it does not know or a size that is not a positive number', () => {
    expect(formatCostBasis(1, 'tub')).toBeNull();
    expect(formatCostBasis(0, 'kg')).toBeNull();
    expect(formatCostBasis('', 'kg')).toBeNull();
  });
});

describe('basisOf', () => {
  it('lets a pack size set on the sheet override the purchaseUnits.js table', () => {
    // RM-056 (tortilla) is in the table as one piece; a sheet entry of a
    // 10-piece pack is newer evidence and has to win, or the save does nothing.
    expect(basisOf('RM-056', '')).toMatchObject({ bomUnits: 1, unit: 'pcs' });
    expect(basisOf('RM-056', 'per 10 pcs')).toMatchObject({ bomUnits: 10, unit: 'pcs' });
  });
});

describe('packFromText', () => {
  it('finds the pack size in a purchase line as it was typed at the counter', () => {
    expect(packFromText('Amul Blend Diced Cheese 200 g')).toEqual({ packSize: 200, packUnit: 'g' });
    expect(packFromText('amul butter 500g')).toEqual({ packSize: 500, packUnit: 'g' });
    expect(packFromText('Mapped to RM-058; logged at the counter as "Mozzarella 1 kg".')).toEqual({
      packSize: 1,
      packUnit: 'kg',
    });
  });

  it('finds nothing in wording that carries no size', () => {
    expect(packFromText('Panini-Medium')).toBeNull();
    expect(packFromText('2 large onions')).toBeNull();
    expect(packFromText('')).toBeNull();
  });
});
