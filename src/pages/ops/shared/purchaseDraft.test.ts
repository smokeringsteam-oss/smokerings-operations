// The rules that decide what a browser hands back to Weekly Purchasing after
// the tab was evicted — read on plain objects, no DOM.
//
// What is worth pinning here is not that JSON round-trips. It is the three
// things that would make an automatic restore worse than no restore at all: a
// cart that logs money against a dead catalogue id, a cart from a different
// channel, and a cart old enough that nobody remembers agreeing to it.
import { describe, expect, it } from 'vitest';
import {
  DRAFT_VERSION,
  MAX_DRAFT_AGE_DAYS,
  buildPurchaseDraft,
  clearStoredPurchaseDraft,
  describePurchaseRestore,
  hasDraftContent,
  purchaseDraftKey,
  readStoredPurchaseDraft,
  reconcileDraftLines,
  restorePurchaseDraft,
  writeStoredPurchaseDraft,
  EMPTY_ENTRY,
  type DraftCartLine,
  type PurchaseDraftState,
} from './purchaseDraft';

const line = (over: Partial<DraftCartLine> = {}): DraftCartLine => ({
  key: 'k1',
  materialId: 'RM-001',
  itemName: 'Pork Shoulder',
  quantity: 4.43,
  unitPrice: 540,
  weightPerUnitKg: 0,
  purpose: 'Order',
  clientId: '',
  clientName: '',
  ...over,
});

const state = (over: Partial<PurchaseDraftState> = {}): PurchaseDraftState => ({
  vendorName: 'S.K. Pork Palace',
  purchaseDate: '2026-09-05',
  lines: [line()],
  scanReview: null,
  entry: EMPTY_ENTRY,
  ...over,
});

const NOW = new Date('2026-09-05T12:00:00Z');
const savedAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('restorePurchaseDraft', () => {
  it('brings back a cart written by this build', () => {
    const restored = restorePurchaseDraft(buildPurchaseDraft(state()), NOW);

    expect(restored.vendorName).toBe('S.K. Pork Palace');
    expect(restored.purchaseDate).toBe('2026-09-05');
    expect(restored.lines).toHaveLength(1);
    expect(restored.lines[0]).toMatchObject({ itemName: 'Pork Shoulder', quantity: 4.43, unitPrice: 540 });
  });

  it('keeps the scan review and the half-typed line with the cart', () => {
    // Both are the buyer's place in the job: the review is the checklist the
    // rows are being read against, and the entry form is the line they were
    // in the middle of when the phone rang.
    const restored = restorePurchaseDraft(
      buildPurchaseDraft(
        state({
          scanReview: {
            added: 3,
            vendorText: 'S.K. PORK PALACE',
            vendorMatched: false,
            dateText: '10/05/00',
            dateUsed: false,
            notes: 'Three separate receipts.',
            skipped: [{ itemName: 'Smudged', reason: 'Quantity was unreadable.' }],
          },
          entry: { ...EMPTY_ENTRY, materialChoice: 'RM-009', quantity: '2', unitPrice: '55' },
        }),
      ),
      NOW,
    );

    expect(restored.scanReview).toMatchObject({ added: 3, vendorMatched: false, notes: 'Three separate receipts.' });
    expect(restored.scanReview?.skipped).toHaveLength(1);
    expect(restored.entry).toMatchObject({ materialChoice: 'RM-009', quantity: '2', unitPrice: '55' });
  });

  it('drops a cart older than the trip it belonged to', () => {
    // Two weeks on, this is not work in progress. Restoring it would put a
    // fortnight-old buy back on screen, still carrying its own date, one
    // button away from being logged as if it had just happened.
    const stale = { ...buildPurchaseDraft(state()), savedAt: savedAgo((MAX_DRAFT_AGE_DAYS + 1) * 24) };
    expect(restorePurchaseDraft(stale, NOW).lines).toEqual([]);

    const fresh = { ...buildPurchaseDraft(state()), savedAt: savedAgo(MAX_DRAFT_AGE_DAYS * 24 - 1) };
    expect(restorePurchaseDraft(fresh, NOW).lines).toHaveLength(1);
  });

  it('refuses a draft written by a build with a different shape', () => {
    expect(restorePurchaseDraft({ ...buildPurchaseDraft(state()), version: DRAFT_VERSION + 1 }, NOW).lines).toEqual([]);
  });

  it('survives anything at all in that storage slot', () => {
    // A screen that will not open because of what an older build wrote is a
    // screen nobody can clear from the browser it broke.
    for (const junk of [null, undefined, 'nonsense', 42, [], {}, { version: DRAFT_VERSION }]) {
      expect(() => restorePurchaseDraft(junk, NOW)).not.toThrow();
      expect(restorePurchaseDraft(junk, NOW).lines).toEqual([]);
    }
  });

  it('leaves out a stored row that is not a line', () => {
    // A nameless or zero-quantity row is worse than no row: it blocks Log
    // purchase and gives the buyer nothing to fix.
    const restored = restorePurchaseDraft(
      buildPurchaseDraft(
        state({
          lines: [
            line({ key: 'a' }),
            line({ key: 'b', itemName: '   ' }),
            line({ key: 'c', quantity: 0 }),
            { ...line({ key: 'd' }), quantity: null as unknown as number },
          ],
        }),
      ),
      NOW,
    );

    expect(restored.lines.map((l) => l.key)).toEqual(['a']);
  });

  it('repairs duplicate row keys rather than trusting them', () => {
    // Two rows sharing a key edit as one under React.
    const restored = restorePurchaseDraft(
      buildPurchaseDraft(state({ lines: [line({ key: 'same' }), line({ key: 'same' })] })),
      NOW,
    );

    expect(restored.lines).toHaveLength(2);
    expect(new Set(restored.lines.map((l) => l.key)).size).toBe(2);
  });
});

describe('reconcileDraftLines', () => {
  const materials = [{ material_id: 'RM-001' }, { material_id: 'RM-009' }];

  it('drops a catalogue id that no longer exists and keeps the money', () => {
    // purchase.material_id REFERENCES item(item_id) with foreign keys on, so
    // logging a dead id fails the whole cart on a constraint naming a column
    // this screen never shows. The line survives as ad hoc.
    const result = reconcileDraftLines([line({ materialId: 'RM-DELETED' })], materials, []);

    expect(result.lines[0]).toMatchObject({ materialId: '', itemName: 'Pork Shoulder', quantity: 4.43, unitPrice: 540 });
    expect(result.unlinked).toEqual(['Pork Shoulder']);
  });

  it('leaves a live id, and an ad hoc line, exactly as they were', () => {
    const result = reconcileDraftLines([line(), line({ key: 'k2', materialId: '', itemName: 'Ice' })], materials, []);

    expect(result.lines[0].materialId).toBe('RM-001');
    expect(result.lines[1].materialId).toBe('');
    expect(result.unlinked).toEqual([]);
  });

  it('drops a client tag whose account has left the book', () => {
    const tagged = line({ clientId: 'C-9', clientName: 'Gone Cafe' });
    const result = reconcileDraftLines([tagged], materials, [{ id: 'C-1' }]);

    expect(result.lines[0]).toMatchObject({ clientId: '', clientName: '' });
    expect(result.untagged).toEqual(['Pork Shoulder']);
  });

  it('leaves client tags alone when there is no account book to check against', () => {
    // An empty list is a fetch that failed as often as it is a real absence,
    // and dropping every tag on a failed fetch would be the same bug as
    // reconciling against an empty catalogue.
    const tagged = line({ clientId: 'C-9', clientName: 'Some Cafe' });
    const result = reconcileDraftLines([tagged], materials, []);

    expect(result.lines[0].clientId).toBe('C-9');
    expect(result.untagged).toEqual([]);
  });
});

describe('describePurchaseRestore', () => {
  it('says how much came back, when it was touched and what date it carries', () => {
    const restored = restorePurchaseDraft({ ...buildPurchaseDraft(state()), savedAt: savedAgo(3) }, NOW);
    const message = describePurchaseRestore(restored, { unlinked: [], untagged: [] }, NOW);

    expect(message).toContain('1 line');
    expect(message).toContain('3 hours ago');
    // The date is named because it is what the buy gets filed under.
    expect(message).toContain('2026-09-05');
  });

  it('says nothing at all when nothing was restored', () => {
    expect(describePurchaseRestore(restorePurchaseDraft(null, NOW), { unlinked: [], untagged: [] }, NOW)).toBe('');
  });

  it('warns that an unlinked line will move no stock', () => {
    const restored = restorePurchaseDraft(buildPurchaseDraft(state()), NOW);
    const message = describePurchaseRestore(restored, { unlinked: ['Pork Shoulder'], untagged: [] }, NOW);

    expect(message).toContain('no longer in the catalog');
    expect(message).toContain('without moving stock');
  });
});

describe('hasDraftContent', () => {
  it('is false for a screen someone merely opened', () => {
    expect(hasDraftContent(state({ vendorName: '', purchaseDate: '2026-09-05', lines: [] }))).toBe(false);
  });

  it('is true for a line half-typed but not yet added', () => {
    expect(
      hasDraftContent(state({ vendorName: '', lines: [], entry: { ...EMPTY_ENTRY, quantity: '4.43' } })),
    ).toBe(true);
  });
});

describe('storage accessors', () => {
  // A stand-in for localStorage, plus the one that throws — a private window,
  // or a quota that is already full.
  const memory = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  };

  const hostile = (): Storage =>
    ({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    }) as unknown as Storage;

  it('keeps the B2C and B2B carts apart', () => {
    // One component, two screens. A B2C cart restoring into B2B would log
    // household spend against a wholesale account.
    const storage = memory();
    writeStoredPurchaseDraft(buildPurchaseDraft(state()), 'B2C', storage);

    expect(readStoredPurchaseDraft('B2B', storage)).toBeNull();
    expect(restorePurchaseDraft(readStoredPurchaseDraft('B2C', storage), NOW).lines).toHaveLength(1);
    expect(purchaseDraftKey('B2C')).not.toBe(purchaseDraftKey('B2B'));
  });

  it('clears one channel without touching the other', () => {
    const storage = memory();
    writeStoredPurchaseDraft(buildPurchaseDraft(state()), 'B2C', storage);
    writeStoredPurchaseDraft(buildPurchaseDraft(state()), 'B2B', storage);

    clearStoredPurchaseDraft('B2C', storage);

    expect(readStoredPurchaseDraft('B2C', storage)).toBeNull();
    expect(readStoredPurchaseDraft('B2B', storage)).not.toBeNull();
  });

  it('does not take the screen down with a storage that refuses', () => {
    // Losing the safety net is a fair trade; refusing to open the purchasing
    // screen at a shop counter is not.
    const storage = hostile();
    expect(() => writeStoredPurchaseDraft(buildPurchaseDraft(state()), 'B2C', storage)).not.toThrow();
    expect(readStoredPurchaseDraft('B2C', storage)).toBeNull();
    expect(() => clearStoredPurchaseDraft('B2C', storage)).not.toThrow();
  });

  it('reads back nothing from a slot holding unparseable text', () => {
    const storage = memory();
    storage.setItem(purchaseDraftKey('B2C'), '{not json');
    expect(readStoredPurchaseDraft('B2C', storage)).toBeNull();
  });
});
