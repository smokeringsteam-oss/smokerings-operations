// Smoking Session's draft persistence.
//
// The bug these exist for is a phone one: the pitmaster fills in half a step,
// switches to WhatsApp to check an order, and the OS discards the tab. React
// state goes with it, so coming back used to show an empty form with no hint
// that anything had been typed. Everything below is about that round trip —
// what survives a remount, what deliberately does not, and the two fields in
// the Smoking step whose own effects used to clear them a beat after the
// restore put them back.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import SmokingSession from './SmokingSession';

const DRAFT_KEY = 'smokerings.smokingSession.draft.v1.B2C';

const readyToSmoke = {
  session_id: 'SM-1',
  channel: 'B2C',
  session_purpose: 'Order',
  client_id: '',
  client_name: '',
  source_material_id: 'MAT-1',
  source_material_name: 'Pork shoulder',
  output_type: 'Pulled',
  pitmaster: 'Adarsh',
  brine_recipe_name: 'House brine',
  brine_start: '',
  brine_end: '',
  rub_recipe_name: 'House rub',
  rub_start: '',
  rub_end: '',
  raw_weight_kg: '',
  source_purchase_id: '',
  smoking_start: '',
  smoking_end: '',
  finished_weight_with_bone_kg: '',
  finished_weight_without_bone_kg: '',
  rest_start: '',
  rest_end: '',
  shred_start: '',
  shred_end: '',
  tenderness_notes: '',
  smoke_rings_formed: '',
  bark_notes: '',
  juiciness: '',
  fed_order_refs: '',
  stage: 'ready_to_smoke',
};

const respond = (url: string) => {
  if (url.startsWith('/api/smoking/meat-items')) return { items: [{ material_id: 'MAT-1', item_name: 'Pork shoulder' }] };
  if (url.startsWith('/api/smoking/recipes')) {
    return { recipes: [{ recipe_id: 'R-1', recipe_name: 'House brine', kind: 'Brine' }] };
  }
  if (url.startsWith('/api/smoking/purchases-for-material')) {
    return {
      purchases: [
        { purchase_id: 'P-1', purchase_date: '2026-09-01', vendor_name: 'Butcher', quantity_purchased: 5, remaining: 5, remaining_in_kg: 1 },
      ],
    };
  }
  if (url.includes('/taggable-purchases')) {
    return {
      purchases: [
        { purchase_id: 'P-1', purchase_date: '2026-09-01', vendor_name: 'Butcher', item_name: 'Pork shoulder', quantity_purchased: 5, total_cost: 2000, client_name: '', tagged: false, isSessionMaterial: true },
        { purchase_id: 'P-2', purchase_date: '2026-09-01', vendor_name: 'Spice shop', item_name: 'Paprika', quantity_purchased: 1, total_cost: 200, client_name: '', tagged: false, isSessionMaterial: false },
        { purchase_id: 'P-3', purchase_date: '2026-08-30', vendor_name: 'Packaging Co', item_name: 'Foil trays', quantity_purchased: 20, total_cost: 400, client_name: '', tagged: true, isSessionMaterial: false },
      ],
    };
  }
  if (url.startsWith('/api/smoking/sessions')) return { sessions: [readyToSmoke] };
  if (url.startsWith('/api/b2b/clients')) return { clients: [] };
  return {};
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, json: async () => respond(url) })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// The stage badge in "All sessions" is on the page whichever step is in view,
// so it settles the session load without assuming which step the test opened on.
const settled = () => waitFor(() => expect(screen.getByText('Rubbed — ready to smoke')).toBeInTheDocument());

// Brining also needs the meat catalogue, which is a second request.
const settledOnBrining = async () => {
  await settled();
  await screen.findByRole('option', { name: 'Pork shoulder' });
};

test('what was typed survives the component being torn down and rebuilt', async () => {
  const first = render(<SmokingSession />);
  await settledOnBrining();

  fireEvent.change(screen.getByLabelText(/^Pitmaster/), { target: { value: 'Sowmya' } });
  fireEvent.change(screen.getByLabelText(/^Meat item/), { target: { value: 'MAT-1' } });
  fireEvent.change(screen.getByLabelText(/^Brine start/), { target: { value: '2026-09-04T07:30' } });

  // Standing in for the OS discarding the tab and the user coming back to it.
  first.unmount();
  render(<SmokingSession />);
  await settledOnBrining();

  expect(screen.getByLabelText(/^Pitmaster/)).toHaveValue('Sowmya');
  expect(screen.getByLabelText(/^Meat item/)).toHaveValue('MAT-1');
  expect(screen.getByLabelText(/^Brine start/)).toHaveValue('2026-09-04T07:30');
  // And it says so, rather than quietly showing yesterday's timings as if
  // they were today's.
  expect(screen.getByText(/Picked up where you left off/)).toBeInTheDocument();
});

test('the step in view comes back too, not just the fields on it', async () => {
  const first = render(<SmokingSession />);
  await settledOnBrining();

  fireEvent.click(screen.getByRole('button', { name: '3. Smoking' }));
  fireEvent.change(screen.getByLabelText(/Pre-smoked weight/), { target: { value: '4.2' } });

  first.unmount();
  render(<SmokingSession />);
  await settled();

  expect(screen.getByRole('heading', { name: 'Smoking' })).toBeInTheDocument();
  expect(screen.getByLabelText(/Pre-smoked weight/)).toHaveValue(4.2);
});

// The two fields in the Smoking step that are driven by effects keyed on the
// selected session: both clear themselves when that selection changes, and a
// restore looks exactly like a change unless the effects are told otherwise.
test('a restored smoke start keeps its purchase lot and its cost ticks', async () => {
  window.localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      savedAt: Date.now(),
      step: 'smoke',
      smokeStartSessionId: 'SM-1',
      rawWeightKg: '4.2',
      sourcePurchaseId: 'P-1',
      taggedIds: ['P-1', 'P-2'],
    }),
  );

  render(<SmokingSession />);
  await settled();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Paprika/ })).toBeInTheDocument());

  expect((screen.getByRole('option', { name: /^P-1 —/ }) as HTMLOptionElement).selected).toBe(true);
  // P-1 and P-2 are the pitmaster's own unsaved ticks; P-3 is one the server
  // already had. The load must end with all three, not with the server's set
  // overwriting the draft's.
  expect(screen.getByRole('checkbox', { name: /Pork shoulder/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Paprika/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Foil trays/ })).toBeChecked();
});

test('changing the session still clears the lot and the ticks it was for', async () => {
  render(<SmokingSession />);
  await settled();

  fireEvent.click(screen.getByRole('button', { name: '3. Smoking' }));
  fireEvent.change(screen.getByLabelText(/^Session/), { target: { value: 'SM-1' } });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Paprika/ })).toBeInTheDocument());

  fireEvent.click(screen.getByRole('checkbox', { name: /Paprika/ }));
  expect(screen.getByRole('checkbox', { name: /Paprika/ })).toBeChecked();

  fireEvent.change(screen.getByLabelText(/^Session/), { target: { value: '' } });
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Paprika/ })).not.toBeInTheDocument());

  fireEvent.change(screen.getByLabelText(/^Session/), { target: { value: 'SM-1' } });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Paprika/ })).toBeInTheDocument());
  // Back on the same session, but by a fresh pick rather than a restore: only
  // what the server has tagged should be ticked.
  expect(screen.getByRole('checkbox', { name: /Paprika/ })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Foil trays/ })).toBeChecked();
});

test('"Start fresh" empties the form and the saved draft with it', async () => {
  const first = render(<SmokingSession />);
  await settledOnBrining();
  fireEvent.change(screen.getByLabelText(/^Pitmaster/), { target: { value: 'Sowmya' } });
  fireEvent.change(screen.getByLabelText(/^Meat item/), { target: { value: 'MAT-1' } });

  first.unmount();
  render(<SmokingSession />);
  await settledOnBrining();

  fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));

  expect(screen.getByLabelText(/^Pitmaster/)).toHaveValue('Adarsh');
  expect(screen.getByLabelText(/^Meat item/)).toHaveValue('');
  expect(screen.queryByText(/Picked up where you left off/)).not.toBeInTheDocument();
  expect(JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}').materialId).toBe('');
});

// A cook is logged step by step and each step clears itself on submit, so a
// draft still sitting here the next day is an abandoned one — and restoring it
// would drop yesterday's timestamps into today's cook.
test('a draft older than a day is dropped rather than restored', async () => {
  window.localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({ savedAt: Date.now() - 25 * 60 * 60 * 1000, pitmaster: 'Sowmya', materialId: 'MAT-1' }),
  );

  render(<SmokingSession />);
  await settledOnBrining();

  expect(screen.getByLabelText(/^Pitmaster/)).toHaveValue('Adarsh');
  expect(screen.queryByText(/Picked up where you left off/)).not.toBeInTheDocument();
});

// Status banners are the one thing deliberately left out of the draft: a
// restored "✅ logged" would claim a write that may never have been sent.
test('a nonsense draft is discarded instead of blanking the screen', async () => {
  window.localStorage.setItem(DRAFT_KEY, 'not json');

  render(<SmokingSession />);
  await settledOnBrining();

  expect(screen.getByLabelText(/^Pitmaster/)).toHaveValue('Adarsh');
});
