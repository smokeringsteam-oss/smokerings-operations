// Switching away from Weekly Purchasing and coming back.
//
// On a phone at a shop counter, a backgrounded tab is evicted whenever the OS
// wants the memory, and coming back is a fresh mount — which is what unmount
// and re-render stands for here. Everything on this screen used to live in
// React state, so what came back was an empty cart with no sign anything had
// been there.
//
// The properties worth pinning are the ones that would make an automatic
// restore worse than none: that the cart survives at all, that the two
// channels never restore into each other, that a logged cart does not come
// back to be logged twice, and that a catalogue that failed to load cannot
// strip the ids off the lines waiting in it.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WeeklyPurchasing from './WeeklyPurchasing';
import { purchaseDraftKey } from './purchaseDraft';

const MATERIALS = [
  { material_id: 'RM-001', item_name: 'Pork Shoulder', category: 'Meat', quantity_on_hand: 3 },
  { material_id: 'RM-009', item_name: 'Lemon', category: 'Produce', quantity_on_hand: 10 },
];

const VENDORS = [
  { vendor_id: 'VEN-002', vendor_name: 'S.K. Pork Palace', vendor_type: 'Meat Vendor', supplies_category: 'Meat' },
];

let catalogFails = false;

beforeEach(() => {
  window.localStorage.clear();
  catalogFails = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/vendors')) {
        return { ok: true, json: async () => ({ vendors: VENDORS }) } as unknown as Response;
      }
      if (url.includes('/materials')) {
        if (catalogFails) throw new Error('backend is down');
        return { ok: true, json: async () => ({ materials: MATERIALS }) } as unknown as Response;
      }
      if (url.includes('/b2b/clients')) {
        return { ok: true, json: async () => ({ clients: [] }) } as unknown as Response;
      }
      if (url.includes('/purchasing/purchases') && url.includes('from=')) {
        return { ok: true, json: async () => ({ purchases: [] }) } as unknown as Response;
      }
      // POST /api/purchasing/purchases — logging the cart.
      return {
        ok: true,
        json: async () => ({ purchases: [{ purchase_id: 'PUR-1' }], inventoryUpdated: 1, skipped: [] }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Fills in one cart line through the form, the way the buyer does — vendor
// first, because the item list is filtered by what that vendor supplies.
const addALine = async (container: HTMLElement, { item = 'RM-001', qty = '4.43', price = '540' } = {}) => {
  await waitFor(() => expect(container.querySelector('.purch-add-line optgroup')).toBeTruthy());
  const selects = Array.from(container.querySelectorAll('.purch-add-line select')) as HTMLSelectElement[];
  fireEvent.change(selects[0], { target: { value: item } });
  const numbers = Array.from(container.querySelectorAll('.purch-add-line input[type="number"]')) as HTMLInputElement[];
  fireEvent.change(numbers[0], { target: { value: qty } });
  fireEvent.change(numbers[1], { target: { value: price } });
  fireEvent.click(screen.getByRole('button', { name: /\+ Add line/i }));
};

const pickVendor = async (container: HTMLElement, name = 'S.K. Pork Palace') => {
  await waitFor(() => expect(container.querySelector('optgroup, option[value="S.K. Pork Palace"]')).toBeTruthy());
  fireEvent.change(container.querySelector('select')!, { target: { value: name } });
};

const cartNames = (container: HTMLElement) =>
  (Array.from(container.querySelectorAll('.purch-cart-name')) as HTMLInputElement[]).map((el) => el.value);

test('a cart survives the tab being thrown away and re-opened', async () => {
  const first = render(<WeeklyPurchasing />);
  await pickVendor(first.container);
  await addALine(first.container);
  await waitFor(() => expect(cartNames(first.container)).toEqual(['Pork Shoulder']));

  // The eviction: nothing in memory carries over, only the browser's storage.
  first.unmount();
  const second = render(<WeeklyPurchasing />);

  await waitFor(() => expect(cartNames(second.container)).toEqual(['Pork Shoulder']));
  // And it says so, rather than the line simply being there — an unlogged cart
  // that reappears silently is one somebody can log a second time.
  expect(screen.getByText(/Picked up the cart you hadn't logged yet/)).toBeInTheDocument();
});

test('the vendor and the date come back with it', async () => {
  const first = render(<WeeklyPurchasing />);
  await waitFor(() => expect(screen.getByRole('option', { name: /S.K. Pork Palace/ })).toBeInTheDocument());
  fireEvent.change(first.container.querySelector('select')!, { target: { value: 'S.K. Pork Palace' } });
  await addALine(first.container);

  first.unmount();
  const second = render(<WeeklyPurchasing />);

  await waitFor(() => expect((second.container.querySelector('select') as HTMLSelectElement).value).toBe('S.K. Pork Palace'));
});

test('a B2C cart never turns up on the B2B screen', async () => {
  // One component, two screens. A line restored across would put household
  // spend on a wholesale account's costs.
  const first = render(<WeeklyPurchasing />);
  await pickVendor(first.container);
  await addALine(first.container);
  await waitFor(() => expect(cartNames(first.container)).toEqual(['Pork Shoulder']));
  first.unmount();

  const b2b = render(<WeeklyPurchasing channel="B2B" />);
  await waitFor(() => expect(b2b.container.querySelector('.purch-add-line select')).toBeTruthy());
  expect(cartNames(b2b.container)).toEqual([]);
  expect(screen.queryByText(/Picked up the cart/)).toBeNull();
});

test('a cart that has been logged does not come back', async () => {
  const first = render(<WeeklyPurchasing />);
  await waitFor(() => expect(screen.getByRole('option', { name: /S.K. Pork Palace/ })).toBeInTheDocument());
  fireEvent.change(first.container.querySelector('select')!, { target: { value: 'S.K. Pork Palace' } });
  await addALine(first.container);
  await waitFor(() => expect(cartNames(first.container)).toEqual(['Pork Shoulder']));

  fireEvent.click(screen.getByRole('button', { name: /Log purchase to CSV and Odoo/i }));
  await waitFor(() => expect(cartNames(first.container)).toEqual([]));
  first.unmount();

  const second = render(<WeeklyPurchasing />);
  await waitFor(() => expect(second.container.querySelector('.purch-add-line select')).toBeTruthy());
  expect(cartNames(second.container)).toEqual([]);
  expect(screen.queryByText(/Picked up the cart/)).toBeNull();
});

test('a catalogue that fails to load leaves the restored ids alone', async () => {
  // The mirror of the reel draft's gate. Reconciling a restored cart against
  // a catalogue that never arrived would strip the material id off every line
  // — turning a stocked buy into an ad hoc one that moves nothing, silently,
  // because the backend happened to be restarting.
  const first = render(<WeeklyPurchasing />);
  await pickVendor(first.container);
  await addALine(first.container);
  await waitFor(() => expect(cartNames(first.container)).toEqual(['Pork Shoulder']));
  first.unmount();

  const before = window.localStorage.getItem(purchaseDraftKey('B2C'));
  expect(before).toContain('RM-001');

  catalogFails = true;
  const second = render(<WeeklyPurchasing />);
  await waitFor(() => expect(cartNames(second.container)).toEqual(['Pork Shoulder']));
  await waitFor(() => expect(screen.getByText(/Couldn't load the purchasing catalog/)).toBeInTheDocument());

  // Still linked, and still linked in storage after the autosave has run.
  await waitFor(() => expect(window.localStorage.getItem(purchaseDraftKey('B2C'))).toContain('RM-001'));
});

test('discarding a restored cart clears it from the browser too', async () => {
  const first = render(<WeeklyPurchasing />);
  await pickVendor(first.container);
  await addALine(first.container);
  await waitFor(() => expect(cartNames(first.container)).toEqual(['Pork Shoulder']));
  first.unmount();

  const second = render(<WeeklyPurchasing />);
  await waitFor(() => expect(cartNames(second.container)).toEqual(['Pork Shoulder']));

  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: /discard it/i }));

  await waitFor(() => expect(cartNames(second.container)).toEqual([]));
  await waitFor(() => expect(window.localStorage.getItem(purchaseDraftKey('B2C'))).not.toContain('Pork Shoulder'));

  // And it stays discarded — which is the point. The vendor stays picked,
  // because discarding a stale cart is almost always the prelude to entering
  // the real one from the same shop.
  second.unmount();
  const third = render(<WeeklyPurchasing />);
  await waitFor(() => expect(third.container.querySelector('.purch-add-line select')).toBeTruthy());
  expect(cartNames(third.container)).toEqual([]);
  expect(screen.queryByText(/Picked up the cart/)).toBeNull();
});
