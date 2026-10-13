import React, { useCallback, useEffect, useMemo, useState } from 'react';
import MenuItemRecipe from './MenuItemRecipe';
import { parseIsoDay, todayIso } from '../../../lib/localDay';

// Menu items — editing the dishes themselves, as opposed to picking which of
// them a week sells (that's ServiceWeeks).
//
// One dish, one card. Clicking a row opens everything there is to change
// about it in a single place: the picture, name, price and blurb the customer
// sees (written to the Odoo product), and underneath it, the recipe the
// kitchen and the buy list run on (written to the knowledge-base
// recipe_lines.csv). Those two things are what a menu item is, so neither
// hides behind a second button.
//
// Odoo is the source of truth for the sales half: nothing is kept locally,
// every save writes to the Odoo product and re-renders from what Odoo read
// back, and a failed save leaves the row as it was rather than showing a
// price the till doesn't have.
//
// The server also copies each saved name/price/description onto the
// knowledge-base menu.csv row (server/ops/menu/menuCsvMirror.js), since that file is
// what the prep planner reads. That copy is best-effort and reports back as
// `csv` on the response — when it couldn't find a row to update, the note
// below says so rather than letting the two quietly disagree.
//
// The one switch on the row itself is the till's: "Taking orders" flips
// Odoo's available_in_pos, so a dish that has sold out can be closed on the
// POS mid-service without opening its card and without taking it off the
// menu. Dishes that are off the menu altogether (sale_ok false — the old
// tacos, quesadillas and glaze burgers) are hidden by default, behind a
// "show" link, so the list is what's actually being sold.
//
// Deliberately not here: archiving, the on/off-menu flag and the raw Odoo
// product form. Taking a dish off a weekend is a decision about a service
// week rather than about the dish, and the full product record belongs in
// Odoo itself — both were noise on the screen where a price gets changed.
//
// Scoped to one sales channel via the `channel` prop, which the server turns
// into an Odoo category fence (server/ops/menu/menuItems.js): 'b2c' is the weekend
// consumer menu, 'b2b' the bulk wholesale products under Finished Products /
// B2B Wholesale. The B2C dashboard passes 'b2c', so a 1kg wholesale pack
// can't be repriced from the screen that edits burgers.

type MenuChannel = 'b2c' | 'b2b' | 'all';

export type MenuItem = {
  id: number;
  name: string;
  code: string;
  price: number;
  description: string;
  category: string;
  isArchived: boolean;
  isAvailable: boolean;
  // Odoo's available_in_pos: whether the till takes orders for it right now.
  isInPos: boolean;
  image: string | null; // data: URI of the Odoo thumbnail, or null
  // The knowledge-base menu.csv row this Odoo product matched, resolved
  // server-side (server/ops/menu/menuCsvMirror.js resolveMenuIds). It's what the
  // recipe section hangs off; null means no CSV row matched, so this dish has
  // no recipe the prep planner can see.
  menuId: string | null;
  // What smokerings.in says about this dish, read from its public menu feed.
  // The site keeps its own sold-out date and ignores isInPos, so the two can
  // disagree. null = the feed couldn't be read (or a save reply, which
  // doesn't carry it — replaceItem keeps the last known value).
  site?: SiteStatus | null;
};
type SiteStatus = { listed: boolean; soldOutThrough: string | null };
type MenuItemsResponse = {
  items: MenuItem[];
  editable: boolean;
  error?: string;
};
// Outcome of the knowledge-base menu.csv mirror. Absent on the picture write,
// which has no column in that file.
type CsvMirror = { mirrored: boolean; reason?: string };

// `undefined` = picture untouched by this edit, `null` = remove it, string =
// a newly picked file. Keeping "unchanged" distinct from "remove" is what
// stops merely opening a card from wiping an existing picture.
type ImageDraft = string | null | undefined;

const inrFormat = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Mirrors the server's cap (menuItems.js MAX_IMAGE_BYTES) so an oversized
// photo is caught before spending a slow upload on it.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const categoryAnchor = (category: string) => `menu-cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const readFileAsDataUri = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(file);
  });

async function readJson<T extends { error?: string }>(resp: Response, fallbackMessage: string): Promise<T> {
  let json: T;
  try {
    json = (await resp.json()) as T;
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
  if (!resp.ok) throw new Error(json.error || fallbackMessage);
  return json;
}

// A sold-out date already behind us means the dish is back on sale, so the
// date alone isn't the state. The feed sends YYYY-MM-DD, compared as text.
const SiteBadge: React.FC<{ site: SiteStatus }> = ({ site }) => {
  if (!site.listed) {
    return (
      <em className="menu-item-tag is-site-off" title="Not in the smokerings.in menu feed">
        not on website
      </em>
    );
  }
  if (site.soldOutThrough && site.soldOutThrough >= todayIso()) {
    const until = parseIsoDay(site.soldOutThrough).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return (
      <em className="menu-item-tag is-site-off" title="Set on the website, not from this screen">
        website: sold out till {until}
      </em>
    );
  }
  return <em className="menu-item-tag is-site-on">website: on sale</em>;
};

const MenuItems: React.FC<{ channel?: MenuChannel }> = ({ channel = 'b2c' }) => {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [editable, setEditable] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showOffMenu, setShowOffMenu] = useState(false);

  // One card open at a time. It holds unsaved drafts for two different stores
  // (the Odoo product and the recipe CSV), and two open at once is two sets
  // of half-finished edits to lose track of — it's also what stops a slow
  // Odoo write being raced by an edit to a different dish landing first.
  const [openId, setOpenId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPrice, setDraftPrice] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftImage, setDraftImage] = useState<ImageDraft>(undefined);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [csvNote, setCsvNote] = useState('');

  // The panel is embedded in a channel-specific dashboard, so its heading
  // says which catalogue it edits rather than leaving "Menu" ambiguous once
  // the B2B dashboard grows its own copy of it.
  const title = channel === 'b2b' ? 'B2B menu' : channel === 'b2c' ? 'B2C menu' : 'Menu';

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    setCsvNote('');
    setSaveNote('');
    try {
      const resp = await fetch(`/api/ops/menu-items?channel=${channel}`);
      const json = await readJson<MenuItemsResponse>(resp, 'Could not load menu items from Odoo.');
      setItems(json.items || []);
      setEditable(json.editable !== false);
      setHasLoaded(true);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    load();
  }, [load]);

  // Typing filters on everything printed on a row, so a word from the name,
  // the code or the blurb all find the dish.
  const onMenu = useMemo(() => items.filter((item) => item.isAvailable), [items]);
  const offMenuCount = items.length - onMenu.length;

  const visible = useMemo(() => {
    const pool = showOffMenu ? items : onMenu;
    const needle = search.trim().toLowerCase();
    if (!needle) return pool;
    return pool.filter((item) =>
      `${item.name} ${item.code} ${item.description} ${item.category}`.toLowerCase().includes(needle),
    );
  }, [items, onMenu, showOffMenu, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, MenuItem[]>();
    visible.forEach((item) => {
      const key = item.category || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    });
    return [...groups.entries()];
  }, [visible]);

  // Also the "undo" for the sales fields: re-seeding the drafts from the item
  // is exactly what discarding them means.
  const openCard = (item: MenuItem) => {
    setOpenId(item.id);
    setDraftName(item.name);
    setDraftPrice(String(item.price));
    setDraftDescription(item.description);
    setDraftImage(undefined);
    setSaveError('');
    setSaveNote('');
    setCsvNote('');
  };

  const toggleCard = (item: MenuItem) => {
    if (openId === item.id) {
      setOpenId(null);
      setSaveError('');
      setSaveNote('');
      return;
    }
    openCard(item);
  };

  const handlePickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so picking the same file twice still fires onChange.
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setSaveError("That file isn't an image. Pick a JPG, PNG or WebP.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSaveError(
        `That picture is ${(file.size / (1024 * 1024)).toFixed(1)}mb. Please use one under ${
          MAX_IMAGE_BYTES / (1024 * 1024)
        }mb.`,
      );
      return;
    }
    try {
      setDraftImage(await readFileAsDataUri(file));
      setSaveError('');
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    }
  };

  // Odoo's version of a record takes the place of the row it came from.
  const replaceItem = useCallback(
    (updated: MenuItem) =>
      setItems((prev) =>
        prev.map((row) => (row.id === updated.id ? { ...updated, site: updated.site ?? row.site } : row)),
      ),
    [],
  );

  // Every write lands here so the row is always replaced with Odoo's version
  // of the record rather than an optimistic guess.
  const applyWrite = async (item: MenuItem, body: Record<string, unknown>, path: string, failMessage: string) => {
    setSavingId(item.id);
    setSaveError('');
    try {
      const resp = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, ...body }),
      });
      const json = await readJson<{
        item?: MenuItem;
        csv?: CsvMirror;
        error?: string;
      }>(resp, failMessage);
      if (!json.item) throw new Error(failMessage);
      // Only touched when this write had a menu.csv side — so the note from
      // saving the text fields survives the picture write that follows it.
      if (json.csv) setCsvNote(json.csv.mirrored ? '' : json.csv.reason || '');
      replaceItem(json.item);
      return true;
    } catch (err) {
      setSaveError(`Couldn't update ${item.name}: ${String((err as Error).message || err)}`);
      return false;
    } finally {
      setSavingId(null);
    }
  };

  // Saves straight away, independent of the card's drafts — closing a sold-out
  // dish on the till shouldn't wait on (or discard) a half-typed price.
  const handleTogglePos = async (item: MenuItem) => {
    if (savingId !== null) return;
    setSaveNote('');
    const ok = await applyWrite(
      item,
      { isInPos: !item.isInPos },
      '/api/ops/menu-items/update',
      'Odoo rejected the change.',
    );
    if (ok) setSaveNote(item.isInPos ? `${item.name} closed on the POS.` : `${item.name} is taking orders on the POS.`);
  };

  const handleSaveDish = async (item: MenuItem) => {
    if (savingId !== null) return;
    const price = Number(draftPrice);
    if (!draftName.trim()) {
      setSaveError('A menu item needs a name.');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setSaveError('Price must be a number and cannot be negative.');
      return;
    }
    setSaveNote('');
    const ok = await applyWrite(
      item,
      { name: draftName.trim(), price, description: draftDescription },
      '/api/ops/menu-items/update',
      'Odoo rejected the change.',
    );
    if (!ok) return;

    // The picture is a separate Odoo write (a different field, and a much
    // bigger payload), so it only goes out when actually changed. If it
    // fails the text fields are already saved — the card stays open with the
    // error rather than pretending the whole save succeeded.
    if (draftImage !== undefined) {
      const imageOk = await applyWrite(
        item,
        { image: draftImage },
        '/api/ops/menu-items/image',
        'Odoo rejected the picture.',
      );
      if (!imageOk) return;
      setDraftImage(undefined);
    }
    // The card stays open: the recipe underneath it is usually the next thing
    // being edited, and pulling the screen away mid-job is what made the old
    // version feel like it was fighting back.
    setSaveNote(`Saved ${draftName.trim()}.`);
  };

  // Opening a card lower down the list leaves its header wherever the
  // previous card's collapse put it — often off the top of a phone screen.
  // Bring the opened row's header back into view once it has rendered.
  useEffect(() => {
    if (openId === null) return;
    const row = document.getElementById(`menu-item-${openId}`);
    if (!row) return;
    const top = row.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) {
      row.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [openId]);

  const jumpToCategory = (category: string) => {
    document.getElementById(categoryAnchor(category))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const dishDirty = (item: MenuItem) =>
    draftName !== item.name ||
    draftPrice !== String(item.price) ||
    draftDescription !== item.description ||
    draftImage !== undefined;

  return (
    <section className="menu-items-panel">
      <div className="menu-items-head">
        <div className="menu-items-head-text">
          <h3 className="inv-section-title">
            {title}
            {onMenu.length > 0 && <span className="menu-items-count">{onMenu.length} dishes</span>}
          </h3>
          <p className="inv-section-hint">
            Tap a dish to edit its picture, name, price, blurb and recipe. The switch opens or closes the dish on the
            Odoo POS only — the website's sold-out state is set on the website and shown on each row.
          </p>
          {offMenuCount > 0 && (
            <button type="button" className="menu-items-offmenu-toggle" onClick={() => setShowOffMenu((v) => !v)}>
              {showOffMenu
                ? `Hide ${offMenuCount} off-menu ${offMenuCount === 1 ? 'dish' : 'dishes'}`
                : `Show ${offMenuCount} off-menu ${offMenuCount === 1 ? 'dish' : 'dishes'}`}
            </button>
          )}
        </div>
        <button
          type="button"
          className="secondary-button small menu-items-refresh"
          onClick={load}
          disabled={isLoading}
          aria-label="Refresh from Odoo"
          title="Refresh from Odoo"
        >
          <span
            className={isLoading ? 'menu-items-refresh-icon is-spinning' : 'menu-items-refresh-icon'}
            aria-hidden="true"
          >
            ↻
          </span>
          <span className="menu-items-refresh-label">{isLoading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {/* Search and category jumps stay pinned while the list scrolls, since
          on a phone the list is several screens long. */}
      <div className="menu-items-toolbar">
        <div className="menu-items-search-wrap">
          <span className="menu-items-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            className="menu-items-search"
            placeholder="Search dishes, codes, blurbs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search dishes"
          />
          {search && (
            <button
              type="button"
              className="menu-items-search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        {grouped.length > 1 && (
          <nav className="menu-items-chips" aria-label="Jump to category">
            {grouped.map(([category, categoryItems]) => (
              <button key={category} type="button" className="menu-items-chip" onClick={() => jumpToCategory(category)}>
                {category}
                <span className="menu-items-chip-count">{categoryItems.length}</span>
              </button>
            ))}
          </nav>
        )}
      </div>

      {error && <p className="chat-error">{error}</p>}
      {saveError && <p className="chat-error">{saveError}</p>}
      {saveNote && <p className="status-message">{saveNote}</p>}
      {csvNote && <p className="status-message">{csvNote}</p>}
      {!editable && !error && (
        <p className="status-message">
          Couldn't identify the menu category in Odoo, so these items can't be edited safely from here.
        </p>
      )}

      {isLoading && !items.length ? (
        <p className="status-message">Loading the menu from Odoo…</p>
      ) : !error && !items.length && hasLoaded ? (
        <p className="status-message">No menu items found in Odoo.</p>
      ) : items.length && !grouped.length ? (
        <p className="status-message">
          {search.trim() ? `Nothing matches “${search.trim()}”.` : 'Every dish is off the menu right now.'}
        </p>
      ) : (
        grouped.map(([category, categoryItems]) => (
          <div key={category} id={categoryAnchor(category)} className="menu-item-group">
            <span className="menu-item-group-title">
              {category}
              <span className="menu-item-group-count">{categoryItems.length}</span>
            </span>
            {categoryItems.map((item) => {
              const busy = savingId === item.id;
              const isOpen = openId === item.id;
              // The card previews a newly picked picture; the collapsed row
              // keeps showing what Odoo actually has.
              const shownImage = isOpen && draftImage !== undefined ? draftImage : item.image;
              return (
                <article
                  key={item.id}
                  id={`menu-item-${item.id}`}
                  className={`menu-item-row${isOpen ? ' is-open' : ''}${item.isInPos ? '' : ' is-pos-closed'}${
                    item.isAvailable ? '' : ' is-off-menu'
                  }`}
                >
                  <div className="menu-item-head">
                    <button
                      type="button"
                      className="menu-item-open"
                      onClick={() => toggleCard(item)}
                      aria-expanded={isOpen}
                    >
                      {item.image ? (
                        <img className="menu-item-thumb" src={item.image} alt="" loading="lazy" />
                      ) : (
                        <span className="menu-item-thumb is-empty" aria-hidden="true">
                          🍽
                        </span>
                      )}

                      <span className="menu-item-main">
                        <span className="menu-item-name">{item.name}</span>
                        {(item.code || !item.menuId || item.site) && (
                          <span className="menu-item-meta">
                            {item.code && <em className="menu-item-code">{item.code}</em>}
                            {item.site && <SiteBadge site={item.site} />}
                            {!item.menuId && (
                              <em className="menu-item-tag" title="No knowledge-base menu.csv row, so it has no recipe">
                                no recipe
                              </em>
                            )}
                          </span>
                        )}
                        {item.description && <span className="menu-item-desc">{item.description}</span>}
                      </span>

                      <span className="menu-item-side">
                        <span className="menu-item-price">{inrFormat(item.price)}</span>
                        <svg
                          className="menu-item-chevron"
                          viewBox="0 0 20 20"
                          width="18"
                          height="18"
                          aria-hidden="true"
                        >
                          <path
                            d="M7 4l6 6-6 6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </button>
                    {/* A sibling of the row button rather than inside it: a
                      switch nested in a button is invalid markup, and a tap on
                      it must not also open the card. */}
                    <label
                      className="menu-item-pos"
                      title={
                        item.isInPos
                          ? 'On in the Odoo POS — tap to close. Does not change the website.'
                          : 'Off in the Odoo POS — tap to reopen. Does not change the website.'
                      }
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        checked={item.isInPos}
                        onChange={() => handleTogglePos(item)}
                        disabled={!editable || savingId !== null}
                        aria-label={`${item.name} available in the Odoo POS`}
                      />
                      <span className="menu-item-pos-track" aria-hidden="true" />
                      <span className="menu-item-pos-label">
                        {busy ? 'Saving…' : item.isInPos ? 'POS on' : 'POS off'}
                      </span>
                    </label>
                  </div>

                  {isOpen && (
                    <div className="menu-item-card">
                      <div className="menu-item-card-section">
                        <span className="menu-item-card-title">On the menu</span>
                        <div className="menu-item-edit-row">
                          <div className="menu-item-image-edit">
                            {shownImage ? (
                              <img className="menu-item-thumb is-large" src={shownImage} alt={item.name} />
                            ) : (
                              <span className="menu-item-thumb is-large is-empty" aria-hidden="true">
                                🍽
                              </span>
                            )}
                            <div className="menu-item-image-actions">
                              <label className="svc-week-menu-edit as-label">
                                {shownImage ? 'Change picture' : 'Add picture'}
                                <input type="file" accept="image/*" onChange={handlePickImage} disabled={busy} hidden />
                              </label>
                              {shownImage && (
                                <button
                                  type="button"
                                  className="svc-week-menu-edit is-danger"
                                  onClick={() => setDraftImage(null)}
                                  disabled={busy}
                                >
                                  Remove picture
                                </button>
                              )}
                              {draftImage !== undefined && (
                                <button
                                  type="button"
                                  className="svc-week-menu-edit"
                                  onClick={() => setDraftImage(undefined)}
                                  disabled={busy}
                                >
                                  Undo picture change
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="menu-item-edit-fields">
                            <label className="svc-week-field is-wide">
                              <span>Name</span>
                              <input
                                type="text"
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                disabled={!editable || busy}
                              />
                            </label>
                            <label className="svc-week-field menu-item-price-field">
                              <span>Price (₹)</span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="1"
                                value={draftPrice}
                                onChange={(e) => setDraftPrice(e.target.value)}
                                disabled={!editable || busy}
                              />
                            </label>
                            <label className="svc-week-field is-wide">
                              <span>Description</span>
                              <textarea
                                rows={3}
                                value={draftDescription}
                                onChange={(e) => setDraftDescription(e.target.value)}
                                disabled={!editable || busy}
                              />
                            </label>
                          </div>
                        </div>

                        <div className={`svc-week-form-actions menu-item-actions${dishDirty(item) ? ' is-dirty' : ''}`}>
                          <button
                            type="button"
                            className="primary-button small"
                            onClick={() => handleSaveDish(item)}
                            disabled={!editable || busy || !dishDirty(item)}
                          >
                            {busy ? 'Saving…' : dishDirty(item) ? 'Save dish' : 'Saved'}
                          </button>
                          <button
                            type="button"
                            className="secondary-button small"
                            onClick={() => openCard(item)}
                            disabled={busy || !dishDirty(item)}
                          >
                            Undo changes
                          </button>
                        </div>
                      </div>

                      <MenuItemRecipe menuId={item.menuId} itemName={item.name} disabled={busy} />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
};

export default MenuItems;
