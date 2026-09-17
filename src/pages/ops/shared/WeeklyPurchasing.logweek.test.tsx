// Where a logged bill goes, and whether you can see it land.
//
// The purchase table under the cart shows one week, and it opens on this one.
// A bill is dated by the bill — a scan reads the date off the paper — so a
// Sunday bill logged on the Monday after it is written into last week and the
// table, which has just refreshed, shows exactly what it showed before.
// Nothing says the buy was recorded anywhere the eye lands, and the reading
// that follows is "it did not save", followed by logging the same bill again.
// That happened three times over with one Swiggy Instamart bill.
//
// So: a bill from another week is filed under today, in the week the table
// shows, and a purchase date set by hand outside this week is flagged under
// Save rather than moving the table.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WeeklyPurchasing from './WeeklyPurchasing';
import { EMPTY_ENTRY, buildPurchaseDraft, writeStoredPurchaseDraft } from './purchaseDraft';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Yesterday-of-this-week's Monday: the Sunday that closed last week. Relative
// to today so the test says the same thing whenever it is run.
const lastSunday = () => {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() - 1);
  return sunday;
};

const BILL_DATE = iso(lastSunday());
const TODAY = iso(new Date());
const LAST_MONDAY = iso(new Date(lastSunday().getTime() - 6 * 86400000));

const SCAN = {
  vendorName: 'Swiggy Instamart',
  vendorText: 'Swiggy Instamart',
  purchaseDate: BILL_DATE,
  dateText: BILL_DATE,
  notes: '',
  lines: [
    {
      materialId: 'RM-014',
      itemName: 'Red tomato',
      billText: 'Tomato Local 1 kg',
      unit: '',
      quantity: 1,
      derivedQuantity: false,
      unitPrice: 21,
      derivedPrice: false,
      lineTotal: 21,
      matched: true,
    },
  ],
  skipped: [],
};

const VENDORS = [{ vendor_id: 'VEN-002', vendor_name: 'Swiggy Instamart', vendor_type: 'Grocery', supplies_category: '' }];

let purchaseGets: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  purchaseGets = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      if (url.includes('/scan-bill')) return { ok: true, json: async () => SCAN } as unknown as Response;
      if (url.includes('/vendors')) return { ok: true, json: async () => ({ vendors: VENDORS }) } as unknown as Response;
      if (url.includes('/materials')) return { ok: true, json: async () => ({ materials: [] }) } as unknown as Response;
      if (url.includes('/send-po')) return { ok: true, json: async () => ({ name: 'P00014', url: null }) } as unknown as Response;
      if (url.includes('/purchasing/purchases')) {
        if (method === 'POST') {
          return {
            ok: true,
            json: async () => ({ purchases: [{ purchase_id: 'PUR-0100' }], inventorySkipped: [] }),
          } as unknown as Response;
        }
        purchaseGets.push(url);
        return { ok: true, json: async () => ({ purchases: [] }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }),
  );
});

const scanTheBill = async (container: HTMLElement) => {
  const fileInput = container.querySelector('.purch-scan-input') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [new File(['x'], 'bill.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(screen.getByText(/Read 1 line off the bill/)).toBeInTheDocument());
};

test('a bill from another week is filed under today, and says so', async () => {
  const { container } = render(<WeeklyPurchasing />);
  await scanTheBill(container);

  expect((screen.getByLabelText(/Purchase date/i) as HTMLInputElement).value).toBe(TODAY);
  expect(screen.getByText(/so it lands in this week/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Keep the bill/ })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(screen.getByText(/Logged 1 line item/)).toBeInTheDocument());
  expect(screen.queryByText(/not the week showing below/)).not.toBeInTheDocument();
});

test('a restored draft from an earlier week comes back dated today', async () => {
  writeStoredPurchaseDraft(
    buildPurchaseDraft({
      vendorName: 'Swiggy Instamart',
      purchaseDate: BILL_DATE,
      lines: [
        { key: 'k1', materialId: 'RM-014', itemName: 'Red tomato', quantity: 1, unitPrice: 21, weightPerUnitKg: 0, clientId: '', clientName: '', purpose: 'Order' },
      ],
      scanReview: null,
      entry: EMPTY_ENTRY,
    }),
    'B2C',
  );
  render(<WeeklyPurchasing />);
  // The cart did come back — only its date was moved.
  expect((screen.getByDisplayValue('Red tomato') as HTMLInputElement).value).toBe('Red tomato');
  expect((screen.getByLabelText(/Purchase date/i) as HTMLInputElement).value).toBe(TODAY);
});

test('a date set by hand outside this week is flagged, and the table stays put', async () => {
  const { container } = render(<WeeklyPurchasing />);
  await scanTheBill(container);

  fireEvent.change(screen.getByLabelText(/Purchase date/i), { target: { value: BILL_DATE } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(screen.getByText(/Logged 1 line item/)).toBeInTheDocument());

  // Flagged, not jumped: nothing was re-read for the older week until asked.
  expect(screen.getByText(/not the week showing below/)).toBeInTheDocument();
  expect(purchaseGets.some((url) => url.includes(`from=${LAST_MONDAY}`))).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /Show that week/ }));
  await waitFor(() => expect(purchaseGets.some((url) => url.includes(`from=${LAST_MONDAY}`))).toBe(true));
});
