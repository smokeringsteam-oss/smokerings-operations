import React, { useCallback, useEffect, useMemo, useState } from 'react';

// Service Weeks — the B2C Dashboard's Service Weeks screen, showing which
// weekends the kitchen is actually open for, with a toggle to flip one open
// or closed. (It used to be a strip pinned above the landing page's module
// flow; it's one of the dashboard's three landing choices now.)
//
// The grid is driven by the calendar, not by Odoo: every Sat/Sun in the shown
// month gets a card whether or not a Service Week record exists for it, so
// opening a new month never means filling in a form first. Toggling a weekend
// with no record behind it creates one in Odoo on the spot (see
// setServiceWeekOpen in server/ops/b2c/serviceWeeks.js).
//
// Odoo is still the source of truth (the custom Service Weeks model's
// OPEN/CLOSED Kitchen field), so this never keeps its own copy: the toggle
// writes to Odoo and re-renders from what Odoo reads back, and a failed write
// leaves the switch where it was rather than showing a state the business
// doesn't actually have.

type ServiceWeek = {
  id: number;
  name: string;
  from: string | null; // 'YYYY-MM-DD'
  to: string | null;
  isOpen: boolean;
  menuIds: number[];
  menu: string[];
};
type ServiceWeeksResponse = {
  weeks: ServiceWeek[];
  editable: boolean;
  creatable?: boolean;
  menuEditable?: boolean;
  error?: string;
};
type MenuOption = { id: number; name: string; category: string };
type MenuOptionsResponse = { options: MenuOption[]; menuEditable: boolean; error?: string };

// One Sat/Sun slot on the grid; the Odoo record behind it (if any) is looked
// up separately, since a slot exists whether or not one does.
type Weekend = { sat: string; sun: string };

const MENU_CHIPS_SHOWN = 4;

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const todayIso = () => toIso(new Date());

// Odoo date fields arrive as 'YYYY-MM-DD' (datetimes as 'YYYY-MM-DD HH:mm:ss');
// take the date half either way and build it as local, not UTC, so the day
// never shifts backwards for IST.
const toDate = (value: string) => {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

const addDays = (iso: string, days: number) => {
  const date = toDate(iso);
  date.setDate(date.getDate() + days);
  return toIso(date);
};

const formatDate = (value: string | null) => {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// "Sat 5 – Sun 6 Sep" — the day names matter here in a way they don't on a
// full-week card, since the whole point of the grid is which weekend it is.
const formatWeekend = ({ sat, sun }: Weekend) => {
  const satDate = toDate(sat);
  const sunDate = toDate(sun);
  const sameMonth = satDate.getMonth() === sunDate.getMonth();
  const satText = satDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    ...(sameMonth ? {} : { month: 'short' }),
  });
  const sunText = sunDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${satText} – ${sunText}`;
};

const monthLabel = (year: number, month: number) =>
  new Date(year, month, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

// Odoo product display names carry the internal reference ("[PT-001] Smoked
// Pork Tacos"). The code means nothing on an ops screen, so it's dropped for
// display only — the id is what every write actually uses.
const cleanMenuName = (name: string) => name.replace(/^\s*\[[^\]]+\]\s*/, '');

// Every Sat/Sun pair whose Saturday falls in the given month. A weekend that
// straddles a month boundary (Sat 31 Oct / Sun 1 Nov) belongs to October, so
// it's listed exactly once across the two months.
function weekendsOfMonth(year: number, month: number): Weekend[] {
  const cursor = new Date(year, month, 1);
  cursor.setDate(1 + ((6 - cursor.getDay() + 7) % 7)); // first Saturday
  const weekends: Weekend[] = [];
  while (cursor.getMonth() === month) {
    const sat = toIso(cursor);
    weekends.push({ sat, sun: addDays(sat, 1) });
    cursor.setDate(cursor.getDate() + 7);
  }
  return weekends;
}

// String compare is safe on 'YYYY-MM-DD' and avoids timezone drift entirely.
const overlaps = (week: ServiceWeek, from: string, to: string) => {
  const wFrom = week.from?.slice(0, 10);
  const wTo = week.to?.slice(0, 10);
  return Boolean(wFrom && wTo && wFrom <= to && wTo >= from);
};

// The record backing a weekend card: whichever Service Week covers those two
// days. Usually a Sat/Sun record created from this grid, but the older
// Mon–Sun weeks in Odoo cover a weekend too, and toggling the card should
// flip that existing record rather than create an overlapping second one.
const coveringWeek = (weeks: ServiceWeek[], weekend: Weekend) =>
  weeks.find((week) => overlaps(week, weekend.sat, weekend.sun)) || null;

const isWeekendPair = (week: ServiceWeek, weekend: Weekend) =>
  week.from?.slice(0, 10) === weekend.sat && week.to?.slice(0, 10) === weekend.sun;

// "This weekend" from Monday onwards — the prep flow below this panel runs all
// week towards Sat/Sun, so the weekend being worked towards is the current one
// well before Saturday arrives.
const isCurrentWeekend = ({ sat, sun }: Weekend) => {
  const today = todayIso();
  return addDays(sat, -5) <= today && today <= sun;
};

// Every response that carries a week comes back the same shape, and an empty
// body means the backend isn't up — worth saying so explicitly rather than
// surfacing a JSON parse error.
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

const ServiceWeeks: React.FC = () => {
  const [weeks, setWeeks] = useState<ServiceWeek[]>([]);
  const [editable, setEditable] = useState(true);
  const [creatable, setCreatable] = useState(true);
  const [menuEditable, setMenuEditable] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  // Which card's toggle is mid-flight, keyed by its Saturday — a weekend with
  // no record yet has no id to key on. One at a time, so a slow Odoo write
  // can't be raced by a second click.
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');

  // Which month the grid is showing. Starts on the current one.
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // Menu items pickable on a week. Fetched once, lazily — it's a second Odoo
  // round-trip and most dashboard visits never open a picker.
  const [menuOptions, setMenuOptions] = useState<MenuOption[]>([]);
  const [menuOptionsError, setMenuOptionsError] = useState('');
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);

  // "Custom range" form — for the weeks that aren't a plain Sat/Sun (a
  // festival run, a private booking), which the grid can't express.
  const [showForm, setShowForm] = useState(false);
  const [formFrom, setFormFrom] = useState('');
  const [formTo, setFormTo] = useState('');
  const [formName, setFormName] = useState('');
  const [formIsOpen, setFormIsOpen] = useState(true);
  const [formMenuIds, setFormMenuIds] = useState<number[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Per-card menu editing — which record is open for editing, and its draft.
  const [editingMenuId, setEditingMenuId] = useState<number | null>(null);
  const [draftMenuIds, setDraftMenuIds] = useState<number[]>([]);
  const [isSavingMenu, setIsSavingMenu] = useState(false);
  const [menuError, setMenuError] = useState('');

  const weekends = useMemo(() => weekendsOfMonth(month.year, month.month), [month]);

  const load = useCallback(async () => {
    if (!weekends.length) return;
    setIsLoading(true);
    setError('');
    try {
      // Scoped to the shown month's weekends rather than "the latest 12
      // weeks", so paging back to an old month shows what was open then.
      const params = new URLSearchParams({ from: weekends[0].sat, to: weekends[weekends.length - 1].sun });
      const resp = await fetch(`/api/ops/service-weeks?${params}`);
      const json = await readJson<ServiceWeeksResponse>(resp, 'Could not load Service Weeks from Odoo.');
      setWeeks(json.weeks || []);
      setEditable(json.editable !== false);
      setCreatable(json.creatable !== false);
      setMenuEditable(json.menuEditable !== false);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, [weekends]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMenuOptions = useCallback(async () => {
    if (menuOptions.length || isLoadingOptions) return;
    setIsLoadingOptions(true);
    setMenuOptionsError('');
    try {
      const resp = await fetch('/api/ops/service-weeks/menu-options');
      const json = await readJson<MenuOptionsResponse>(resp, 'Could not load menu items from Odoo.');
      setMenuOptions(json.options || []);
    } catch (err) {
      setMenuOptionsError(String((err as Error).message || err));
    } finally {
      setIsLoadingOptions(false);
    }
  }, [menuOptions.length, isLoadingOptions]);

  // Grouped by Odoo product category, which is what makes a flat list of
  // burgers/tacos/platters scannable.
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, MenuOption[]>();
    menuOptions.forEach((option) => {
      const key = option.category || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(option);
    });
    return [...groups.entries()];
  }, [menuOptions]);

  // Records in this month that no weekend card claims — a Mon–Wed special, a
  // range someone entered by hand. Shown separately rather than dropped, so
  // the grid can never hide a week that exists in Odoo.
  const otherWeeks = useMemo(() => {
    const claimed = new Set(weekends.map((weekend) => coveringWeek(weeks, weekend)?.id).filter(Boolean));
    return weeks.filter((week) => !claimed.has(week.id));
  }, [weeks, weekends]);

  const shiftMonth = (delta: number) => {
    setEditingMenuId(null);
    setShowForm(false);
    setSaveError('');
    setMenuError('');
    setMonth(({ year, month: current }) => {
      const next = new Date(year, current + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const goToThisMonth = () => {
    const now = new Date();
    setMonth({ year: now.getFullYear(), month: now.getMonth() });
  };

  const isThisMonth = useMemo(() => {
    const now = new Date();
    return month.year === now.getFullYear() && month.month === now.getMonth();
  }, [month]);

  // Replaces the record Odoo just handed back, or adds it if the toggle just
  // created it. Never echoes what was requested — see readWeek() on the server.
  const upsertWeek = (updated: ServiceWeek) =>
    setWeeks((prev) => {
      const known = prev.some((week) => week.id === updated.id);
      const next = known ? prev.map((week) => (week.id === updated.id ? updated : week)) : [...prev, updated];
      return next.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    });

  const toggleId = (list: number[], id: number) =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id];

  const openForm = () => {
    const first = weekends[0];
    setFormFrom(first?.sat || todayIso());
    setFormTo(first?.sun || addDays(todayIso(), 6));
    setFormName('');
    setFormIsOpen(true);
    setFormMenuIds([]);
    setCreateError('');
    setShowForm(true);
    loadMenuOptions();
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isCreating) return;
    setIsCreating(true);
    setCreateError('');
    try {
      const resp = await fetch('/api/ops/service-weeks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim() || undefined,
          from: formFrom,
          to: formTo,
          isOpen: formIsOpen,
          menuIds: formMenuIds,
        }),
      });
      const json = await readJson<{ week?: ServiceWeek; error?: string }>(resp, 'Odoo rejected the new week.');
      if (!json.week) throw new Error('Odoo rejected the new week.');
      upsertWeek(json.week);
      setShowForm(false);
    } catch (err) {
      setCreateError(String((err as Error).message || err));
    } finally {
      setIsCreating(false);
    }
  };

  const startEditingMenu = (week: ServiceWeek) => {
    setEditingMenuId(week.id);
    setDraftMenuIds(week.menuIds || []);
    setMenuError('');
    loadMenuOptions();
  };

  const handleSaveMenu = async (week: ServiceWeek) => {
    if (isSavingMenu) return;
    setIsSavingMenu(true);
    setMenuError('');
    try {
      const resp = await fetch('/api/ops/service-weeks/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: week.id, productIds: draftMenuIds }),
      });
      const json = await readJson<{ week?: ServiceWeek; error?: string }>(resp, 'Odoo rejected the menu change.');
      if (!json.week) throw new Error('Odoo rejected the menu change.');
      upsertWeek(json.week);
      setEditingMenuId(null);
    } catch (err) {
      setMenuError(`Couldn't update the menu for ${week.name}: ${String((err as Error).message || err)}`);
    } finally {
      setIsSavingMenu(false);
    }
  };

  // `week` is null for a weekend with nothing behind it yet — the server
  // creates the record from the from/to dates in that case.
  const handleToggle = async (key: string, week: ServiceWeek | null, weekend: Weekend | null) => {
    if (savingKey !== null || !editable) return;
    setSavingKey(key);
    setSaveError('');
    try {
      const resp = await fetch('/api/ops/service-weeks/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: week?.id,
          from: weekend?.sat,
          to: weekend?.sun,
          isOpen: !week?.isOpen,
        }),
      });
      const json = await readJson<{ week?: ServiceWeek; error?: string }>(resp, 'Odoo rejected the change.');
      if (!json.week) throw new Error('Odoo rejected the change.');
      upsertWeek(json.week);
    } catch (err) {
      const label = week?.name || (weekend ? formatWeekend(weekend) : 'that weekend');
      setSaveError(`Couldn't update ${label}: ${String((err as Error).message || err)}`);
    } finally {
      setSavingKey(null);
    }
  };

  // The menu chips and picker, identical on a weekend card and a custom-range
  // card — both are just a Service Week record once one exists.
  const renderMenuControls = (week: ServiceWeek) => (
    <>
      {week.menu.length > 0 && editingMenuId !== week.id && (
        <div className="svc-week-menu">
          {week.menu.slice(0, MENU_CHIPS_SHOWN).map((item) => (
            <span key={item} className="svc-week-menu-chip">
              {cleanMenuName(item)}
            </span>
          ))}
          {week.menu.length > MENU_CHIPS_SHOWN && (
            <span className="svc-week-menu-chip is-more">+{week.menu.length - MENU_CHIPS_SHOWN}</span>
          )}
        </div>
      )}

      {menuEditable &&
        (editingMenuId === week.id ? (
          <div className="svc-week-menu-editor">
            <span className="svc-week-picker-title">
              Menu this week{draftMenuIds.length > 0 && <em> · {draftMenuIds.length} selected</em>}
            </span>
            {isLoadingOptions && <p className="status-message">Loading menu items…</p>}
            {menuOptionsError && <p className="chat-error">{menuOptionsError}</p>}
            <div className="svc-week-picker is-inline">
              {groupedOptions.map(([category, options]) => (
                <div key={category} className="svc-week-picker-group">
                  <span className="svc-week-picker-group-title">{category}</span>
                  {options.map((option) => (
                    <label key={option.id} className="svc-week-picker-item">
                      <input
                        type="checkbox"
                        checked={draftMenuIds.includes(option.id)}
                        onChange={() => setDraftMenuIds((prev) => toggleId(prev, option.id))}
                      />
                      <span>{cleanMenuName(option.name)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="svc-week-form-actions">
              <button
                type="button"
                className="primary-button small"
                onClick={() => handleSaveMenu(week)}
                disabled={isSavingMenu}
              >
                {isSavingMenu ? 'Saving…' : 'Save menu'}
              </button>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => setEditingMenuId(null)}
                disabled={isSavingMenu}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="svc-week-menu-edit"
            onClick={() => startEditingMenu(week)}
            disabled={editingMenuId !== null}
          >
            {week.menu.length ? 'Edit menu' : '+ Add menu items'}
          </button>
        ))}
    </>
  );

  return (
    <section className="svc-week-panel">
      <div className="svc-week-panel-head">
        <div>
          <h3 className="inv-section-title">Service weekends</h3>
          <p className="inv-section-hint">
            Which weekends the kitchen is open for. Odoo is the source of truth — toggling here updates the Service Week
            record in Odoo, and creates one for a weekend that doesn't have one yet.
          </p>
        </div>
        <div className="svc-week-head-actions">
          {creatable && !error && (
            <button
              type="button"
              className="secondary-button small"
              onClick={() => (showForm ? setShowForm(false) : openForm())}
            >
              {showForm ? 'Cancel' : '+ Custom range'}
            </button>
          )}
          <button type="button" className="secondary-button small" onClick={load} disabled={isLoading}>
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="svc-week-month-nav">
        <button type="button" className="svc-week-month-step" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className="svc-week-month-title">{monthLabel(month.year, month.month)}</span>
        <button type="button" className="svc-week-month-step" onClick={() => shiftMonth(1)} aria-label="Next month">
          ›
        </button>
        {!isThisMonth && (
          <button type="button" className="svc-week-month-today" onClick={goToThisMonth}>
            Today
          </button>
        )}
        {isLoading && <span className="svc-week-month-loading">Loading from Odoo…</span>}
      </div>

      {error && <p className="chat-error">{error}</p>}
      {saveError && <p className="chat-error">{saveError}</p>}
      {menuError && <p className="chat-error">{menuError}</p>}

      {showForm && (
        <form className="svc-week-form" onSubmit={handleCreate}>
          <div className="svc-week-form-row">
            <label className="svc-week-field">
              <span>From</span>
              <input type="date" value={formFrom} onChange={(e) => setFormFrom(e.target.value)} required />
            </label>
            <label className="svc-week-field">
              <span>To</span>
              <input type="date" value={formTo} onChange={(e) => setFormTo(e.target.value)} required />
            </label>
            <label className="svc-week-field is-wide">
              <span>Name (optional)</span>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={formFrom && formTo ? 'Auto-named from the dates' : 'e.g. Week of 7-13 Sep 2026'}
              />
            </label>
            <label className="svc-week-field is-check">
              <input type="checkbox" checked={formIsOpen} onChange={(e) => setFormIsOpen(e.target.checked)} />
              <span>Kitchen open</span>
            </label>
          </div>

          {menuEditable && (
            <div className="svc-week-picker">
              <span className="svc-week-picker-title">
                Menu this week{formMenuIds.length > 0 && <em> · {formMenuIds.length} selected</em>}
              </span>
              {isLoadingOptions && <p className="status-message">Loading menu items from Odoo…</p>}
              {menuOptionsError && <p className="chat-error">{menuOptionsError}</p>}
              {!isLoadingOptions && !menuOptionsError && !menuOptions.length && (
                <p className="status-message">No menu items found in Odoo.</p>
              )}
              {groupedOptions.map(([category, options]) => (
                <div key={category} className="svc-week-picker-group">
                  <span className="svc-week-picker-group-title">{category}</span>
                  {options.map((option) => (
                    <label key={option.id} className="svc-week-picker-item">
                      <input
                        type="checkbox"
                        checked={formMenuIds.includes(option.id)}
                        onChange={() => setFormMenuIds((prev) => toggleId(prev, option.id))}
                      />
                      <span>{cleanMenuName(option.name)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}

          {createError && <p className="chat-error">{createError}</p>}

          <div className="svc-week-form-actions">
            <button type="submit" className="primary-button small" disabled={isCreating}>
              {isCreating ? 'Creating…' : 'Create in Odoo'}
            </button>
            <button
              type="button"
              className="secondary-button small"
              onClick={() => setShowForm(false)}
              disabled={isCreating}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!editable && !error && (
        <p className="status-message">This Service Week field is read-only in Odoo, so it can't be toggled from here.</p>
      )}

      <div className="svc-week-list">
        {weekends.map((weekend) => {
          const week = coveringWeek(weeks, weekend);
          const current = isCurrentWeekend(weekend);
          const busy = savingKey === weekend.sat;
          const isOpen = Boolean(week?.isOpen);
          const editing = week !== null && editingMenuId === week.id;
          return (
            <article
              key={weekend.sat}
              className={`svc-week-card${week ? (isOpen ? ' is-open' : ' is-closed') : ' is-unset'}${
                current ? ' is-current' : ''
              }${editing ? ' is-editing' : ''}`}
            >
              <div className="svc-week-card-top">
                <span className="svc-week-dates">{formatWeekend(weekend)}</span>
                {current && <span className="svc-week-now">This weekend</span>}
              </div>

              {/* Only worth naming the record when it isn't just this weekend —
                  an older Mon–Sun week covering these two days is what the
                  toggle actually writes to, and that shouldn't be a surprise. */}
              {week && !isWeekendPair(week, weekend) && (
                <span className="svc-week-name">
                  Set by {week.name} ({formatDate(week.from)} – {formatDate(week.to)})
                </span>
              )}

              <div className="svc-week-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOpen}
                  aria-label={`Kitchen ${isOpen ? 'open' : 'closed'} for ${formatWeekend(weekend)}`}
                  className="svc-week-switch"
                  onClick={() => handleToggle(weekend.sat, week, weekend)}
                  disabled={busy || savingKey !== null || !editable}
                >
                  <span className="svc-week-switch-knob" />
                </button>
                <span className="svc-week-state">
                  {busy
                    ? 'Saving…'
                    : isOpen
                      ? 'Open — serviceable'
                      : week
                        ? 'Closed — not serviceable'
                        : 'Not set up — toggle to open'}
                </span>
              </div>

              {week && renderMenuControls(week)}
            </article>
          );
        })}
      </div>

      {otherWeeks.length > 0 && (
        <>
          <p className="svc-week-subhead">Other ranges this month</p>
          <div className="svc-week-list">
            {otherWeeks.map((week) => {
              const busy = savingKey === `id:${week.id}`;
              return (
                <article
                  key={week.id}
                  className={`svc-week-card${week.isOpen ? ' is-open' : ' is-closed'}${
                    editingMenuId === week.id ? ' is-editing' : ''
                  }`}
                >
                  <div className="svc-week-card-top">
                    <span className="svc-week-dates">
                      {formatDate(week.from)} – {formatDate(week.to)}
                    </span>
                  </div>
                  <span className="svc-week-name">{week.name}</span>
                  <div className="svc-week-control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={week.isOpen}
                      aria-label={`Kitchen ${week.isOpen ? 'open' : 'closed'} for ${week.name}`}
                      className="svc-week-switch"
                      onClick={() => handleToggle(`id:${week.id}`, week, null)}
                      disabled={busy || savingKey !== null || !editable}
                    >
                      <span className="svc-week-switch-knob" />
                    </button>
                    <span className="svc-week-state">
                      {busy ? 'Saving…' : week.isOpen ? 'Open — serviceable' : 'Closed — not serviceable'}
                    </span>
                  </div>
                  {renderMenuControls(week)}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};

export default ServiceWeeks;
