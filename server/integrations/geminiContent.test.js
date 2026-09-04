// The only part of the Gemini layer that can be tested without a key: the
// repair that rescues a bill read Gemini stopped partway through. It is
// worth pinning down because its failure mode is silent — a bad repair
// hands the pitmaster a cart of numbers that were never on the paper.
import { describe, it, expect } from 'vitest';
import { repairTruncatedJSON } from './geminiContent.js';

const BILL = {
  vendorName: 'Venkateshwara Pork',
  purchaseDate: '2026-09-01',
  notes: '',
  lines: [
    { itemName: 'Pork Belly B/L', materialId: 'RM001', quantity: 5, unitPrice: 420, lineTotal: 2100, unit: 'kg' },
    { itemName: 'Amul Butter 500g', materialId: '', quantity: 2, unitPrice: 265, lineTotal: 530, unit: 'pcs' },
    { itemName: 'Charcoal 10kg', materialId: 'RM014', quantity: 1, unitPrice: 800, lineTotal: 800, unit: 'bag' },
  ],
};

describe('repairTruncatedJSON', () => {
  it('leaves whole JSON exactly as it was', () => {
    expect(repairTruncatedJSON(JSON.stringify(BILL))).toEqual(BILL);
  });

  it('keeps the lines that made it and drops the half-written one', () => {
    const full = JSON.stringify(BILL);
    const cut = full.indexOf('Charcoal') + 4;
    const repaired = repairTruncatedJSON(full.slice(0, cut));
    expect(repaired.lines).toEqual([BILL.lines[0], BILL.lines[1]]);
    expect(repaired.vendorName).toBe('Venkateshwara Pork');
  });

  // The dangerous outcome is not a dropped line but an invented one, so every
  // cut point gets checked: whatever survives must match the bill line for
  // line, and anything unsalvageable must say so rather than guess.
  it('never invents or corrupts a line, at any cut point', () => {
    const full = JSON.stringify(BILL);
    for (let cut = 1; cut < full.length; cut += 1) {
      const repaired = repairTruncatedJSON(full.slice(0, cut));
      if (repaired === null) continue;
      const lines = repaired.lines ?? [];
      expect(lines).toEqual(BILL.lines.slice(0, lines.length));
      if (repaired.vendorName) expect(repaired.vendorName).toBe(BILL.vendorName);
    }
  });

  it('survives a cut inside an escaped string', () => {
    const text = '{"notes":"total says \\"1250\\" but adds to 1240","lines":[{"itemName":"Ribs","quantity":3},{"itemNa';
    expect(repairTruncatedJSON(text)).toEqual({
      notes: 'total says "1250" but adds to 1240',
      lines: [{ itemName: 'Ribs', quantity: 3 }],
    });
  });

  it('returns null when the cut landed before anything closed', () => {
    expect(repairTruncatedJSON('{"vendorName":"Sri Ven')).toBeNull();
    expect(repairTruncatedJSON('')).toBeNull();
  });
});
