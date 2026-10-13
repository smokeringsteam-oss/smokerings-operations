// Step 1's count tiles: a platter is one dish, and the meats the server splits
// out of its Odoo line are counted in the matching meat tile (as "Platter",
// apart from the prime cuts) and listed again on their platter's own card —
// never added to the weekend total a second time.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WeekendPrepPlanner from './WeekendPrepPlanner';

// The 2026-10-10 weekend as Odoo had it: two Any 3s on Saturday dinner.
const ORDERS = [
  { itemId: 'any-3-platter', slotId: 'satEvening', quantity: 2 },
  { itemId: 'platter-brisket', slotId: 'satEvening', quantity: 2, platterId: 'any-3-platter' },
  { itemId: 'platter-ribs', slotId: 'satEvening', quantity: 2, platterId: 'any-3-platter' },
  { itemId: 'platter-pulled-pork', slotId: 'satEvening', quantity: 1, platterId: 'any-3-platter' },
  { itemId: 'platter-bbq-burnt-ends', slotId: 'satEvening', quantity: 1, platterId: 'any-3-platter' },
  { itemId: 'any-6-platter', slotId: 'sunLunch', quantity: 1 },
  { itemId: 'platter-brisket', slotId: 'sunLunch', quantity: 1, platterId: 'any-6-platter' },
  { itemId: 'platter-wings', slotId: 'sunLunch', quantity: 1, platterId: 'any-6-platter' },
  { itemId: 'platter-cajun-half', slotId: 'sunLunch', quantity: 1, platterId: 'any-6-platter' },
  { itemId: 'pork-burnt-ends', slotId: 'satLunch', quantity: 5 },
  { itemId: 'teriyaki-burnt-ends', slotId: 'sunLunch', quantity: 1 },
  { itemId: 'bbq-ribs-250g', slotId: 'satLunch', quantity: 5 },
  { itemId: 'brisket-slices-500g', slotId: 'satLunch', quantity: 4 },
  { itemId: 'brisket-slices-250g', slotId: 'satLunch', quantity: 1 },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/odoo/orders')) {
        return {
          ok: true,
          json: async () => ({ orders: ORDERS, quotations: [], unmatched: [], ordersFound: 6 }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tile = (label: string) => {
  const card = Array.from(document.querySelectorAll('.prep-summary-card')).find(
    (el) => el.querySelector('.prep-summary-label')?.textContent === label,
  );
  if (!card) throw new Error(`No tile for ${label}`);
  return card as HTMLElement;
};
const valueOf = (label: string) => tile(label).querySelector('.prep-summary-value')?.textContent;
const originOf = (label: string) => tile(label).querySelector('.prep-summary-origin')?.textContent;
// Each side's line carries its own sizes, so a count can't be misread as the
// other side's.
const originRows = (label: string) =>
  Array.from(tile(label).querySelectorAll('.prep-summary-origin-row')).map((row) => row.textContent);

test('meat tiles count platter portions, told apart from prime cuts', async () => {
  render(<WeekendPrepPlanner />);
  // 3 platters + 16 prime cuts; the platter meats aren't dishes of their own.
  await waitFor(() => expect(valueOf('Weekend total')).toBe('19'));

  expect(valueOf('Pork Burnt Ends (150g)')).toBe('7');
  expect(originRows('Pork Burnt Ends (150g)')).toEqual(['Prime cuts 6BBQ 5Teriyaki 1', 'Platter 1BBQ 1']);

  // One size only: the label says it, so no size breakdown.
  expect(valueOf('BBQ Ribs (250g)')).toBe('7');
  expect(originRows('BBQ Ribs (250g)')).toEqual(['Prime cuts 5', 'Platter 2']);

  expect(valueOf('Brisket Slices')).toBe('8');
  expect(originRows('Brisket Slices')).toEqual(['Prime cuts 5250 g 1500 g 4', 'Platter 3250 g 3']);

  // A meat nobody put on a platter shows no platter line at all.
  expect(originOf('BBQ Ribs (500g)')).toBeUndefined();
  expect(screen.queryByText(/Jackfruit/)).toBeNull();
});

test('each platter size gets its own count and its own meats', async () => {
  render(<WeekendPrepPlanner />);
  await waitFor(() => expect(valueOf('Any 3 Platter')).toBe('2'));

  const any3 = tile('Any 3 Platter').textContent || '';
  expect(any3).toContain('Smoked Brisket 250g 2');
  expect(any3).toContain('Smokey BBQ Ribs 250g 2');
  expect(any3).toContain('Pulled Pork 250g 1');
  expect(any3).toContain('BBQ Pork Burnt Ends 150g 1');
  expect(any3).not.toContain('Wings');

  expect(valueOf('Any 6 Platter')).toBe('1');
  const any6 = tile('Any 6 Platter').textContent || '';
  expect(any6).toContain('Smoked Brisket 250g 1');
  expect(any6).toContain('Smoked Chicken Wings 6 pcs 1');
  expect(any6).not.toContain('Ribs');
});
