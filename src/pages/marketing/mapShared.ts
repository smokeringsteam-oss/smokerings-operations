// The pieces the two halves of the Customer Map screen share.
//
// That screen has two views now — where our orders come from (CustomerMap)
// and who else is selling smoked meat (CompetitorMap) — drawn on two Leaflet
// maps that must agree about everything except what they are showing: the
// same centre, the same circle scale, the same way of writing a rupee, the
// same admission that a point is only approximate. Two copies of any of that
// would drift, and the drift would be invisible until somebody compared the
// two views and found the same address drawn two sizes.
//
// Nothing here knows about React. Types and pure functions only.

// The two sides of the business, as the same colours Sales by Item uses.
// Ember is the weekend kitchen on every screen that splits the business in
// two; purple is wholesale. Validated against this screen's white surface
// with the dataviz palette validator: adjacent CVD separation 24.8 (protan)
// against a floor of 8, normal vision 28.8, both inside the lightness band
// and over 3:1 on contrast. Do not swap these for eyeballed values.
export const COLOR_B2C = '#d9480f';
export const COLOR_B2B = '#6b3fa0';

// Where the map opens when there is nothing to fit it to. The kitchen's city,
// not the customers' — with no orders on screen this is a starting point, not
// a claim about anybody.
export const DEFAULT_CENTRE: [number, number] = [12.9716, 77.5946];
export const DEFAULT_ZOOM = 11;

export type Channel = 'both' | 'B2C' | 'B2B';
export type Precision = 'address' | 'locality' | 'postcode';

export type Tally = {
  orders: number;
  revenue: number;
  b2cOrders: number;
  b2bOrders: number;
  b2cRevenue: number;
  b2bRevenue: number;
};

export type Point = Tally & {
  key: string;
  address: string;
  latitude: number;
  longitude: number;
  precision: Precision;
  provider: string;
  area: string;
  customers: number;
  names: string[];
  otherNames: number;
  lastOrder: string;
};

export type Area = Tally & {
  key: string;
  name: string;
  locality: string;
  postcode: string;
  customers: number;
  repeatCustomers: number;
  addresses: number;
  latitude: number;
  longitude: number;
  sharePct: number;
};

export type Unlocated = Tally & {
  address: string;
  street: string;
  street2: string;
  city: string;
  zip: string;
  status: 'pending' | 'not_found';
  customers: number;
};

export type OdooSource = {
  configured: boolean;
  url: string;
  error: string;
  reachable: boolean;
  ordersRead: number;
};

export type LocateResult = {
  attempted: number;
  located: number;
  notFound: number;
  remaining: number;
  error: string;
};

export const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export const money = (value: number) => `₹${grouped.format(Math.round(value))}`;
export const shortMoney = (value: number) => {
  if (!value) return '₹0';
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(value) >= 1000) return `₹${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `₹${Math.round(value)}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayLabel = (iso: string) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

const pad = (n: number) => String(n).padStart(2, '0');
export const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const weeksAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n * 7);
  return iso(date);
};

// Distances are straight-line everywhere on this screen, so they are always
// written with a "~" — see the note at the top of
// server/ops/shared/deliveryDistance.js for why road distance is not worth a
// routing key inside one city.
export const km = (value: number | null) => (value === null || value === undefined ? '—' : `~${value.toFixed(1)} km`);

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );

// Orders on the side of the business currently being shown. One function, so
// the tiles, the circles and the table can never end up reading different
// sides from each other.
export const ordersOn = (row: Tally, channel: Channel) =>
  channel === 'B2C' ? row.b2cOrders : channel === 'B2B' ? row.b2bOrders : row.orders;
export const revenueOn = (row: Tally, channel: Channel) =>
  channel === 'B2C' ? row.b2cRevenue : channel === 'B2B' ? row.b2bRevenue : row.revenue;

// Radius in pixels for a circle carrying `orders` of them, against the
// busiest circle on the map. Area-proportional (hence the square roots), with
// a floor of 6px so a single order is still a target worth clicking and a
// ceiling that keeps the busiest street from swallowing its neighbours.
export const MIN_RADIUS = 6;
export const MAX_RADIUS = 26;
export const radiusFor = (orders: number, max: number) => {
  if (orders <= 0) return 0;
  if (max <= 1) return MIN_RADIUS + 6;
  const scale = Math.sqrt(orders) / Math.sqrt(max);
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scale;
};

export const PRECISION_NOTE: Record<Precision, string> = {
  address: '',
  locality: 'Placed at the middle of the neighbourhood — the street itself could not be found.',
  postcode: 'Placed at the middle of the PIN code, which is a few kilometres across.',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  both: 'Both sides',
  B2C: 'B2C weekend',
  B2B: 'B2B wholesale',
};

// The standard OpenStreetMap raster layer, with the attribution their tile
// policy requires. Both maps call this rather than each writing the URL out,
// because a tile server swapped in one view and not the other would be two
// basemaps under one screen.
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
