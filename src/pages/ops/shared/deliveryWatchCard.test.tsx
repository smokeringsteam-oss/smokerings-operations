// What the order card says about the Porter delivery watch.
//
// The rule being pinned is that there is no silent state. An order out with a
// rider either says when it is next looking, or says the watch has stopped
// and why — because the whole point of the watch is that nobody has to
// remember to come back to the order, and a card that showed nothing would
// leave them wondering whether to.
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FulfilmentControl, type DeliveryWatch, type FulfilmentOrder, type PackingStatus } from './orderFulfilment';

const order: FulfilmentOrder = { orderId: 123, orderName: 'S00113' };

const status = (over: Partial<PackingStatus> = {}): PackingStatus => ({
  status: 'out_for_delivery',
  deliveryPerson: null,
  trackingUrl: 'https://porter.in/rd/bb04ee9fda',
  inSmokerAt: null,
  preppingAt: null,
  packedAt: null,
  findingPartnerAt: null,
  assignedPartnerAt: null,
  outForDeliveryAt: '2026-09-19T07:00:00.000Z',
  deliveredAt: null,
  invoice: null,
  invoiceError: null,
  ...over,
});

const watch = (over: Partial<DeliveryWatch> = {}): DeliveryWatch => ({
  orderId: '123',
  state: 'watching',
  porterStatus: 'live',
  etaAt: new Date(Date.now() + 9 * 60000).toISOString(),
  etaBasis: 'rider',
  nextCheckAt: new Date(Date.now() + 9 * 60000).toISOString(),
  checks: 3,
  errors: 0,
  lastError: null,
  lastCheckedAt: new Date().toISOString(),
  rider: 'Manu T S',
  porterEndedAt: null,
  closedReason: null,
  ...over,
});

const renderCard = (w: DeliveryWatch | undefined, over: Partial<PackingStatus> = {}) => {
  const onCheckDelivery = vi.fn();
  render(
    <FulfilmentControl
      order={order}
      status={status(over)}
      watch={w}
      busy={false}
      onSetStatus={vi.fn()}
      onSaveTracking={vi.fn()}
      onCheckDelivery={onCheckDelivery}
    />,
  );
  return { onCheckDelivery };
};

test('an order still out says when it lands and when it is next looking', () => {
  renderCard(watch());
  expect(screen.getByText(/Marking this delivered when Porter does/)).toBeInTheDocument();
  expect(screen.getByText(/~9 min/)).toBeInTheDocument();
  expect(screen.getByText(/Porter: live/)).toBeInTheDocument();
  expect(screen.getByText(/Manu T S/)).toBeInTheDocument();
  expect(screen.getByText(/next check/)).toBeInTheDocument();
});

test('an estimate that is not from the rider says so', () => {
  // A number measured from the kitchen rather than from where the rider
  // actually is should not be read out to a customer as an ETA.
  renderCard(watch({ etaBasis: 'pickup' }));
  expect(screen.getByText(/estimated from the kitchen/)).toBeInTheDocument();
});

test('a failing check is shown while it is still being retried', () => {
  renderCard(watch({ errors: 2, lastError: 'ETIMEDOUT' }));
  expect(screen.getByText(/Last check failed: ETIMEDOUT/)).toBeInTheDocument();
  // Still watching, so the card must not read as though it has given up.
  expect(screen.getByText(/retrying/)).toBeInTheDocument();
});

test('Check now asks the server to look, rather than setting the stage itself', () => {
  const { onCheckDelivery } = renderCard(watch());
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(onCheckDelivery).toHaveBeenCalledWith(order);
});

test('a delivered order shows Porter’s own handover time', () => {
  renderCard(
    watch({ state: 'delivered', porterStatus: 'completed', porterEndedAt: '2026-09-19T07:19:16.000Z' }),
    { status: 'delivered', deliveredAt: '2026-09-19T07:19:30.000Z' },
  );
  expect(screen.getByText(/Porter delivered this at/)).toBeInTheDocument();
  expect(screen.getByText(/marked in Odoo/)).toBeInTheDocument();
});

test('a cancelled trip says plainly that the order did NOT arrive', () => {
  // The dangerous misreading is "Porter is done with it" as "it got there".
  renderCard(watch({ state: 'cancelled', porterStatus: 'cancelled', closedReason: 'Porter status: cancelled' }));
  expect(screen.getByText(/the order is NOT delivered/)).toBeInTheDocument();
  expect(screen.getByText(/Book another rider/)).toBeInTheDocument();
});

test('a watch that gave up asks for a human, and says why', () => {
  renderCard(watch({ state: 'given_up', closedReason: 'still running after 8h' }));
  expect(screen.getByText(/set the stage by hand/)).toBeInTheDocument();
  expect(screen.getByText(/still running after 8h/)).toBeInTheDocument();
});

test('an order marked delivered from the board says nothing extra', () => {
  // 'stopped' means a human did the job. The stage above already says so.
  renderCard(watch({ state: 'stopped', closedReason: 'delivered_on_the_board' }), { status: 'delivered' });
  expect(screen.queryByText(/Marking this delivered/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Porter delivered this/)).not.toBeInTheDocument();
});

test('an order with no watch on it renders the card exactly as before', () => {
  renderCard(undefined);
  expect(screen.getByText(/Porter tracking/)).toBeInTheDocument();
  expect(screen.queryByText(/Marking this delivered/)).not.toBeInTheDocument();
});
