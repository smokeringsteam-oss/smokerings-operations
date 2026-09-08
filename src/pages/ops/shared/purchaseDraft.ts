// Keeping an unlogged purchase across an app switch.
//
// A cart is filled in at the shop or straight after the trip, on a phone, with
// the paper bill in the other hand. Between the first line and Log purchase
// the buyer switches to the calculator, to WhatsApp to ask what else is
// needed, to the camera. On a phone a backgrounded tab is evicted whenever the
// OS wants the memory, and everything on this screen lived in React state — so
// coming back showed an empty cart with no hint that anything had been there.
// Six scanned lines and a scan review, gone, with the vendor already paid.
//
// So the cart is mirrored into localStorage on every change and read back at
// mount. Two things make this different from the reel draft next door
// (src/pages/marketing/reelDraft.ts), and both make it simpler:
//
//   * A cart line is self-describing. It has a name, a quantity and a price,
//     and those are the three things that get logged. Nothing has to be
//     fetched to know what a line is, so the restore is synchronous and
//     happens as the component's initial state — there is no window between
//     mount and restore for an autosave to write an empty cart over a full
//     one, which is the failure the reel draft needs its `hydrated` gate to
//     avoid.
//
//   * Nothing here is destructive. The draft is a cart, not a log; the only
//     thing that writes a purchase is still the Log purchase button, and a
//     restored cart arrives in exactly the state it would have to be checked
//     in anyway.
//
// The one thing that CAN go stale is a catalogue id: `purchase.material_id`
// is a real foreign key onto `item`, so a line pointing at a material that has
// since been deleted would fail the whole insert on a constraint naming a
// column this screen never shows. reconcileDraftLines drops the dead id and
// keeps the money — the line then logs as ad hoc, which is what an
// unrecognised item does here already.
//
// Only the accessors at the bottom touch localStorage, so purchaseDraft.test.ts
// can exercise the rest on plain objects.

// A B2C cart and a B2B cart are different work on two screens that happen to
// share a component, and one must never restore into the other: a line tagged
// to a wholesale account has no meaning on the B2C side, and B2C spend logged
// against a client would quietly corrupt that account's costs. Hence a key per
// channel rather than a channel field to check.
export const PURCHASE_DRAFT_KEY_PREFIX = 'smokerings.purchaseDraft.v1';

export const purchaseDraftKey = (channel: string) => `${PURCHASE_DRAFT_KEY_PREFIX}.${channel}`;

export const DRAFT_VERSION = 1;

// A cart is one shopping trip: hours, not weeks. Past this the draft is not
// work in progress, it is something forgotten — and restoring it silently
// would offer to log a fortnight-old buy under whatever date it was carrying.
// Generous enough that a Friday cart logged on Monday still comes back.
export const MAX_DRAFT_AGE_DAYS = 14;

export type DraftCartLine = {
  key: string;
  materialId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  weightPerUnitKg: number;
  clientId: string;
  clientName: string;
  billText?: string;
  matched?: boolean;
  derivedPrice?: boolean;
  derivedQuantity?: boolean;
};

// What the last bill scan could not do for itself. Saved with the cart because
// it is the checklist the lines are being read against — a cart that comes
// back without it is a cart whose unmatched vendor and dropped lines nobody is
// looking for any more.
export type DraftScanReview = {
  added: number;
  vendorText: string;
  vendorMatched: boolean;
  dateText: string;
  dateUsed: boolean;
  notes: string;
  skipped: { itemName: string; reason: string }[];
};

// The half-typed line in the add-line form. Kept for the same reason as the
// cart: on a phone the switch away happens mid-line as often as between lines,
// and a weight read off a butcher's scale is not something anyone wants to go
// back and read twice.
export type DraftEntry = {
  materialChoice: string;
  customName: string;
  quantity: string;
  unitPrice: string;
  weightPerPiece: string;
  boughtByPiece: boolean;
  lineClientId: string;
};

export type PurchaseDraftState = {
  vendorName: string;
  purchaseDate: string;
  lines: DraftCartLine[];
  scanReview: DraftScanReview | null;
  entry: DraftEntry;
};

export type PurchaseDraft = PurchaseDraftState & {
  version: typeof DRAFT_VERSION;
  savedAt: string;
};

export const EMPTY_ENTRY: DraftEntry = {
  materialChoice: '',
  customName: '',
  quantity: '',
  unitPrice: '',
  weightPerPiece: '',
  boughtByPiece: false,
  lineClientId: '',
};

export type RestoredPurchase = PurchaseDraftState & {
  /** When the draft was written, or '' when nothing was restored. */
  savedAt: string;
};

export const EMPTY_RESTORE: RestoredPurchase = {
  vendorName: '',
  purchaseDate: '',
  lines: [],
  scanReview: null,
  entry: EMPTY_ENTRY,
  savedAt: '',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);

// Strict, for the same reason reelDraft.ts is strict: Number(null) and
// Number('') are both 0, and a 0 quantity restored as a real number would be a
// line that Log purchase then refuses, with the buyer unable to see why the
// number they typed became nothing.
const asNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asBool = (value: unknown) => value === true;

export function buildPurchaseDraft(state: PurchaseDraftState): PurchaseDraft {
  return { version: DRAFT_VERSION, savedAt: new Date().toISOString(), ...state };
}

// Is there anything in this state worth keeping? An empty cart with no vendor
// picked and nothing half-typed is not a draft, it is a screen someone opened.
// Writing one would leave a permanent record in the browser saying nothing.
export function hasDraftContent(state: PurchaseDraftState): boolean {
  return Boolean(
    state.lines.length ||
      state.vendorName ||
      state.scanReview ||
      state.entry.materialChoice ||
      state.entry.customName.trim() ||
      state.entry.quantity ||
      state.entry.unitPrice ||
      state.entry.weightPerPiece,
  );
}

function restoreLine(entry: Record<string, unknown>, index: number, usedKeys: Set<string>): DraftCartLine | null {
  const itemName = asString(entry.itemName).trim();
  const quantity = asNumber(entry.quantity, 0);
  // The two things a line has to have to be a line at all. Anything else is a
  // fragment of a shape that no longer exists, and a nameless zero-quantity
  // row in the cart is worse than no row: it blocks Log purchase and gives
  // nothing to fix.
  if (!itemName || !(quantity > 0)) return null;

  // React's identity for the row. A duplicate would make two lines edit as
  // one, so a repeated key is repaired rather than trusted.
  let key = asString(entry.key) || `draft-${index}`;
  while (usedKeys.has(key)) key = `${key}~`;
  usedKeys.add(key);

  return {
    key,
    materialId: asString(entry.materialId),
    itemName,
    quantity,
    unitPrice: Math.max(0, asNumber(entry.unitPrice, 0)),
    weightPerUnitKg: Math.max(0, asNumber(entry.weightPerUnitKg, 0)),
    clientId: asString(entry.clientId),
    clientName: asString(entry.clientName),
    billText: asString(entry.billText) || undefined,
    matched: typeof entry.matched === 'boolean' ? entry.matched : undefined,
    derivedPrice: typeof entry.derivedPrice === 'boolean' ? entry.derivedPrice : undefined,
    derivedQuantity: typeof entry.derivedQuantity === 'boolean' ? entry.derivedQuantity : undefined,
  };
}

function restoreScanReview(value: unknown): DraftScanReview | null {
  if (!isRecord(value)) return null;
  const skipped = Array.isArray(value.skipped)
    ? value.skipped
        .filter(isRecord)
        .map((s) => ({ itemName: asString(s.itemName), reason: asString(s.reason) }))
        .filter((s) => s.reason)
    : [];
  return {
    added: Math.max(0, asNumber(value.added, 0)),
    vendorText: asString(value.vendorText),
    vendorMatched: asBool(value.vendorMatched),
    dateText: asString(value.dateText),
    dateUsed: asBool(value.dateUsed),
    notes: asString(value.notes),
    skipped,
  };
}

function restoreEntry(value: unknown): DraftEntry {
  if (!isRecord(value)) return EMPTY_ENTRY;
  return {
    materialChoice: asString(value.materialChoice),
    customName: asString(value.customName),
    quantity: asString(value.quantity),
    unitPrice: asString(value.unitPrice),
    weightPerPiece: asString(value.weightPerPiece),
    boughtByPiece: asBool(value.boughtByPiece),
    lineClientId: asString(value.lineClientId),
  };
}

/**
 * Reads a stored draft back into state to mount with.
 *
 * Total by design: any shape of input yields a RestoredPurchase rather than an
 * exception. A screen that will not open because of something an older build
 * wrote into localStorage is a screen nobody can clear from the browser it
 * broke — and this one gets opened at a shop counter.
 *
 * `now` is injected so the age rule can be tested without waiting a fortnight.
 */
export function restorePurchaseDraft(stored: unknown, now: Date = new Date()): RestoredPurchase {
  if (!isRecord(stored)) return EMPTY_RESTORE;
  if (stored.version !== DRAFT_VERSION) return EMPTY_RESTORE;

  const savedAt = asString(stored.savedAt);
  const saved = savedAt ? new Date(savedAt) : null;
  if (!saved || Number.isNaN(saved.getTime())) return EMPTY_RESTORE;
  const ageDays = (now.getTime() - saved.getTime()) / 86_400_000;
  // A draft from the future is a clock that has been changed, not a draft from
  // tomorrow; treating it as fresh is the harmless read, so only staleness is
  // checked.
  if (ageDays > MAX_DRAFT_AGE_DAYS) return EMPTY_RESTORE;

  const usedKeys = new Set<string>();
  const lines = (Array.isArray(stored.lines) ? stored.lines : [])
    .filter(isRecord)
    .map((entry, index) => restoreLine(entry, index, usedKeys))
    .filter((line): line is DraftCartLine => line !== null);

  return {
    vendorName: asString(stored.vendorName),
    purchaseDate: asString(stored.purchaseDate),
    lines,
    scanReview: restoreScanReview(stored.scanReview),
    entry: restoreEntry(stored.entry),
    savedAt,
  };
}

/**
 * Checks a restored cart against the catalogue and the account book, now that
 * both have loaded.
 *
 * `purchase.material_id` REFERENCES item(item_id) with foreign keys on, so a
 * line still pointing at a material someone has since deleted would not log a
 * wrong number — it would fail the whole cart on a constraint naming a column
 * the buyer has never seen. The id goes and the line stays: name, quantity and
 * price are what was actually bought, and an item the catalogue doesn't know
 * is already an ordinary thing here (it logs the money and moves no stock).
 *
 * Never call this with an empty catalogue. A failed GET /materials leaves
 * `materials` at [], and reconciling against that would strip every id in the
 * cart — the caller guards on a catalogue that actually arrived.
 */
export function reconcileDraftLines(
  lines: DraftCartLine[],
  materials: { material_id: string }[],
  clients: { id: string }[],
): { lines: DraftCartLine[]; unlinked: string[]; untagged: string[] } {
  const materialIds = new Set(materials.map((m) => m.material_id));
  const clientIds = new Set(clients.map((c) => c.id));
  const unlinked: string[] = [];
  const untagged: string[] = [];

  const reconciled = lines.map((line) => {
    let next = line;
    if (next.materialId && !materialIds.has(next.materialId)) {
      unlinked.push(next.itemName);
      next = { ...next, materialId: '', matched: next.billText ? false : next.matched };
    }
    // Only checked when there are accounts to check against — the B2C screen
    // never loads any, and its lines carry no tag to begin with.
    if (next.clientId && clients.length && !clientIds.has(next.clientId)) {
      untagged.push(next.itemName);
      next = { ...next, clientId: '', clientName: '' };
    }
    return next;
  });

  return { lines: reconciled, unlinked, untagged };
}

const joinNames = (names: string[]) => {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(' and ');
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
};

// Deliberately coarse. The buyer needs to know whether this is from the trip
// they are on or from a different day; "3 days ago" answers that and a
// timestamp to the minute does not.
function describeSavedAt(savedAt: string, now: Date): string {
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return '';
  const hours = (now.getTime() - saved.getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) {
    const whole = Math.max(1, Math.round(hours));
    return `${whole} hour${whole === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * One line saying what came back, or '' when nothing did.
 *
 * Said out loud rather than restored silently, because a cart that reappears
 * on its own is a cart someone can log twice — the buyer needs to know these
 * lines are from Tuesday's trip before they press the button. The date is
 * named for the same reason: it is what the purchase gets filed under.
 */
export function describePurchaseRestore(
  restored: RestoredPurchase,
  reconciled: { unlinked: string[]; untagged: string[] } = { unlinked: [], untagged: [] },
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  if (restored.lines.length) {
    const when = describeSavedAt(restored.savedAt, now);
    parts.push(
      `Picked up the cart you hadn't logged yet — ${restored.lines.length} line${
        restored.lines.length === 1 ? '' : 's'
      }${when ? `, last edited ${when}` : ''}${restored.purchaseDate ? `, dated ${restored.purchaseDate}` : ''}.`,
    );
  }
  if (reconciled.unlinked.length) {
    parts.push(
      `${joinNames(reconciled.unlinked)} ${reconciled.unlinked.length === 1 ? 'is' : 'are'} no longer in the catalog, so ${
        reconciled.unlinked.length === 1 ? 'that line' : 'those lines'
      } will log the money without moving stock — pick the item again to restore that.`,
    );
  }
  if (reconciled.untagged.length) {
    parts.push(`${joinNames(reconciled.untagged)} lost its client tag — that account is gone from the book.`);
  }
  return parts.join(' ');
}

// ---- the three lines that actually touch the browser ----------------------
//
// Wrapped because localStorage throws rather than returning null in a private
// window and when a quota is hit, and a purchasing screen that will not open
// because a cart could not be *saved* would be a poor trade for the thing this
// file is for.

export function readStoredPurchaseDraft(channel: string, storage: Storage = window.localStorage): unknown {
  try {
    const raw = storage.getItem(purchaseDraftKey(channel));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStoredPurchaseDraft(
  draft: PurchaseDraft,
  channel: string,
  storage: Storage = window.localStorage,
): void {
  try {
    storage.setItem(purchaseDraftKey(channel), JSON.stringify(draft));
  } catch {
    // Out of quota or a locked-down browser. The cart is still on screen and
    // still loggable; only the safety net is gone.
  }
}

export function clearStoredPurchaseDraft(channel: string, storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(purchaseDraftKey(channel));
  } catch {
    // Nothing to do, and nothing worth saying about it.
  }
}
