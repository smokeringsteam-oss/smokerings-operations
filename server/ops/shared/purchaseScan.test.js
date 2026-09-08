// What a scanned bill is allowed to turn into.
//
// Every test here is about the same thing: Gemini read a photo, so treat the
// answer as a claim rather than a fact. The id it names has to exist, the
// numbers have to be numbers, the date has to be a date that could belong to
// a bill, and anything failing those has to come back visibly skipped rather
// than quietly filed. The screen puts all of it in front of the pitmaster to
// confirm before a single row is written, and these are the rules that decide
// what it is allowed to put there.
import { describe, it, expect } from 'vitest';
import { normaliseScannedBill } from './purchaseScan.js';

const MATERIALS = [
  { material_id: 'RM-001', item_name: 'Pork Shoulder', category: 'Meat' },
  { material_id: 'RM-002', item_name: 'Chicken Whole', category: 'Meat' },
  { material_id: 'RM-010', item_name: 'Burger Buns', category: 'Bread' },
];

const VENDORS = [
  { vendor_id: 'VEN-001', vendor_name: 'Venkateshwara Pork' },
  { vendor_id: 'VEN-002', vendor_name: 'Bread Time Stories' },
];

const scan = (parsed) => normaliseScannedBill(parsed, { materials: MATERIALS, vendors: VENDORS });

describe('normaliseScannedBill — line items', () => {
  it('keeps the catalogue id and the catalogue wording when the id is real', () => {
    const { lines } = scan({
      lines: [{ itemName: 'PORK SHLDR B/L', materialId: 'RM-001', quantity: 12, unitPrice: 480 }],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      materialId: 'RM-001',
      itemName: 'Pork Shoulder',
      billText: 'PORK SHLDR B/L',
      quantity: 12,
      unitPrice: 480,
      matched: true,
    });
  });

  it('falls back to an exact name match when the id was invented', () => {
    const { lines } = scan({ lines: [{ itemName: 'Burger Buns', materialId: 'RM-999', quantity: 24, unitPrice: 12 }] });

    expect(lines[0].materialId).toBe('RM-010');
    expect(lines[0].matched).toBe(true);
  });

  it('leaves an item the catalogue does not have as an unmatched ad hoc line', () => {
    const { lines } = scan({ lines: [{ itemName: 'Butcher paper roll', materialId: '', quantity: 2, unitPrice: 300 }] });

    expect(lines[0]).toMatchObject({ materialId: '', itemName: 'Butcher paper roll', matched: false });
  });

  it('derives a missing unit price from the line total, and flags that it did', () => {
    const { lines } = scan({ lines: [{ itemName: 'Pork Shoulder', quantity: 4, unitPrice: 0, lineTotal: 1920 }] });

    expect(lines[0].unitPrice).toBe(480);
    expect(lines[0].derivedPrice).toBe(true);
  });

  it('prefers the printed unit price over one the line total implies', () => {
    // Bills disagree with themselves all the time once a discount is on the
    // slip. The printed per-unit price is the one the log stores, so it wins.
    const { lines } = scan({ lines: [{ itemName: 'Pork Shoulder', quantity: 4, unitPrice: 480, lineTotal: 1800 }] });

    expect(lines[0].unitPrice).toBe(480);
    expect(lines[0].derivedPrice).toBe(false);
  });

  it('strips rupee signs and commas off numbers that came back as text', () => {
    const { lines } = scan({ lines: [{ itemName: 'Pork Shoulder', quantity: '12 kg', unitPrice: 'Rs 1,250' }] });

    expect(lines[0]).toMatchObject({ quantity: 12, unitPrice: 1250 });
  });

  it('recovers a weighed line whose quantity came back as the tillâs own zero', () => {
    // S.K. Pork Palace, bill #9341: one row reading "NON PLU 4.430 540.00
    // 2392.20" under a QTY/WT header, and then "#ITEMS:1 TQty:0 TWt:4.430"
    // below the total. The read picked up the till's 0 and the whole 2392
    // rupee line used to vanish; both money columns are printed, so the
    // weight comes back exactly.
    const { lines, skipped } = scan({
      lines: [{ itemName: 'NON PLU', quantity: 0, unitPrice: 540, lineTotal: 2392.2 }],
    });

    expect(skipped).toEqual([]);
    expect(lines[0]).toMatchObject({ quantity: 4.43, unitPrice: 540, derivedQuantity: true, derivedPrice: false });
  });

  it('leaves a printed quantity alone even when the money columns disagree with it', () => {
    // Same reason the printed unit price wins above: a discounted line does
    // not add up, and the numbers actually on the paper are the ones logged.
    const { lines } = scan({
      lines: [{ itemName: 'Pork Shoulder', quantity: 4, unitPrice: 480, lineTotal: 1800 }],
    });

    expect(lines[0]).toMatchObject({ quantity: 4, derivedQuantity: false });
  });

  it('skips a line with no readable quantity instead of guessing one', () => {
    const { lines, skipped } = scan({
      lines: [
        // Nothing to recover from: a price with no total, a total with no
        // price, and neither.
        { itemName: 'Pork Shoulder', quantity: 0, unitPrice: 480 },
        { itemName: 'Smudged', quantity: null, unitPrice: 0, lineTotal: 900 },
        { itemName: 'Torn corner', quantity: null, unitPrice: 100 },
        { itemName: 'Burger Buns', quantity: 24, unitPrice: 12 },
      ],
    });

    expect(lines.map((l) => l.itemName)).toEqual(['Burger Buns']);
    expect(skipped.map((s) => s.itemName)).toEqual(['Pork Shoulder', 'Smudged', 'Torn corner']);
  });

  it('survives a read that came back with nothing usable at all', () => {
    expect(scan({ notes: 'This is a photo of a menu, not a bill.' })).toMatchObject({ lines: [], skipped: [] });
    expect(scan(null).lines).toEqual([]);
  });
});

describe('normaliseScannedBill — vendor and date', () => {
  it('matches a vendor whose printed name carries extra address words', () => {
    const result = scan({ vendorName: 'Sri Venkateshwara Pork Stall, Johnson Mkt', lines: [] });

    expect(result.vendorName).toBe('Venkateshwara Pork');
    expect(result.vendorText).toBe('Sri Venkateshwara Pork Stall, Johnson Mkt');
  });

  it('leaves the vendor blank when the name is not in the book', () => {
    const result = scan({ vendorName: 'Some New Shop', lines: [] });

    // The bill's own wording is still handed back, so the screen can say who
    // it read rather than silently picking the vendor that was already there.
    expect(result.vendorName).toBe('');
    expect(result.vendorText).toBe('Some New Shop');
  });

  it('takes a plausible bill date and rejects one from the wrong century', () => {
    const year = new Date().getUTCFullYear();

    expect(scan({ purchaseDate: `${year}-03-14`, lines: [] }).purchaseDate).toBe(`${year}-03-14`);
    expect(scan({ purchaseDate: '2205-03-14', lines: [] }).purchaseDate).toBe('');
    expect(scan({ purchaseDate: '14/03', lines: [] }).purchaseDate).toBe('');
    expect(scan({ purchaseDate: '14/03', lines: [] }).dateText).toBe('14/03');
  });
});
