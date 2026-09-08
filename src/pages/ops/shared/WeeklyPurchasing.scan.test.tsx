// What a bill scan puts in the cart.
//
// The bill behind this is a real one: an S.K. Pork Palace thermal strip, three
// separate tills printed end to end, each a single weighed line under a
// "QTY/WT" header. Nothing here is logged — the cart is a draft to check
// against the paper — so what matters is that the numbers the server read
// arrive intact and that the ones it had to work out say so on screen.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WeeklyPurchasing from './WeeklyPurchasing';

// Verbatim from POST /api/purchasing/scan-bill against that photo, except the
// last line, which stands for the one the till reported as TQty:0 and
// normaliseScannedBill recovered from the two money columns.
const SCAN = {
  vendorName: '',
  vendorText: 'S.K. PORK PALACE',
  purchaseDate: '',
  dateText: '',
  notes: 'There are three separate receipts shown in the image.',
  lines: [
    { materialId: '', itemName: 'NON PLU', billText: 'NON PLU', unit: '', quantity: 4.43, derivedQuantity: false, unitPrice: 540, derivedPrice: false, lineTotal: 2392.2, matched: false },
    { materialId: '', itemName: 'NON PLU', billText: 'NON PLU', unit: '', quantity: 5.14, derivedQuantity: false, unitPrice: 560, derivedPrice: false, lineTotal: 2878.4, matched: false },
    { materialId: '', itemName: 'NON PLU', billText: 'NON PLU', unit: '', quantity: 1.39, derivedQuantity: true, unitPrice: 540, derivedPrice: false, lineTotal: 750.6, matched: false },
  ],
  skipped: [],
};

const qtyBoxes = (container: HTMLElement) =>
  (Array.from(container.querySelectorAll('.purch-cart-num')) as HTMLInputElement[])
    // Two number boxes per row — quantity, then unit price.
    .filter((_, i) => i % 2 === 0);

beforeEach(() => {
  // The cart is mirrored into localStorage now (see purchaseDraft.ts), so a
  // cart left behind by the test above would be restored into the one below
  // and scanned on top of.
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/vendors')
        ? { vendors: [] }
        : url.includes('/materials')
          ? { materials: [] }
          : url.includes('/scan-bill')
            ? SCAN
            : { purchases: [] };
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
});

const scanABill = async (container: HTMLElement) => {
  const fileInput = container.querySelector('.purch-scan-input') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['x'], 'bill.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(screen.getByText(/Read 3 lines off the bill/)).toBeInTheDocument());
};

test('every weight the scan read lands in the cart as its own line', async () => {
  const { container } = render(<WeeklyPurchasing />);
  await scanABill(container);

  expect(qtyBoxes(container).map((el) => el.value)).toEqual(['4.43', '5.14', '1.39']);
});

test('a quantity worked out from the money columns is marked, and unmarked once edited', async () => {
  // The mark is the whole reason the recovery is safe to do at all: the
  // pitmaster is checking these rows against the paper, and a derived weight
  // is exactly the one to look at twice.
  const { container } = render(<WeeklyPurchasing />);
  await scanABill(container);

  expect(screen.getAllByText('from total ÷ rate')).toHaveLength(1);

  fireEvent.change(qtyBoxes(container)[2], { target: { value: '1.5' } });
  expect(screen.queryByText('from total ÷ rate')).toBeNull();
});
