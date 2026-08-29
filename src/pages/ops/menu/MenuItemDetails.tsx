import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { MenuItem } from './MenuItems';

// The rest of an Odoo product record, edited from the menu editor.
//
// MenuItems.tsx owns the four fields the menu is normally changed through
// (name, price, sales description, photo). This panel is everything else on
// the product form — internal reference, cost, unit of measure, sales taxes,
// HSN code, POS setup, the x_ Studio fields this business added — for the one
// item whose "Odoo product details" was opened.
//
// Nothing about the form is hardcoded. The server (server/ops/menu/menuItems.js
// fetchMenuItemDetails) discovers which fields Odoo says are writable and
// hands back each one's label, help text, type and options, and this renders
// whatever it's given. A field added or renamed in Odoo Studio therefore
// appears here on its own; the alternative — a fixed list of inputs — would
// quietly go stale against the real product form.
//
// Saves send only the fields actually touched, so two people editing
// different fields on the same product don't overwrite each other, and a
// field this UI got wrong can't clear one it never showed.

type RelationValue = { id: number; name: string };

type DetailFieldType =
  | 'char'
  | 'text'
  | 'html'
  | 'float'
  | 'monetary'
  | 'integer'
  | 'boolean'
  | 'selection'
  | 'many2one'
  | 'many2many'
  | 'date'
  | 'datetime';

type DetailField = {
  name: string;
  label: string;
  type: DetailFieldType;
  help: string | null;
  required: boolean;
  relation: string | null;
  selection: { value: string; label: string }[] | null;
  group: string;
  order: number | null;
  value: string | number | boolean | RelationValue | RelationValue[] | null;
};

type DetailsResponse = { id: number; name: string; fields: DetailField[]; groups: string[]; error?: string };

// What an input holds while being edited. Numbers are kept as strings so a
// half-typed "1." or a cleared box behaves like a text input rather than
// snapping back to 0; the server coerces and validates on the way in.
type DraftValue = string | boolean | number | null | number[];

const NUMERIC_TYPES: DetailFieldType[] = ['float', 'monetary', 'integer'];
const MULTILINE_TYPES: DetailFieldType[] = ['text', 'html'];

// Odoo's stored value -> what the input binds to.
function toDraft(field: DetailField): DraftValue {
  switch (field.type) {
    case 'many2one':
      return field.value ? (field.value as RelationValue).id : null;
    case 'many2many':
      return ((field.value as RelationValue[]) || []).map((entry) => entry.id);
    case 'boolean':
      return Boolean(field.value);
    default:
      return field.value === null || field.value === undefined ? '' : String(field.value);
  }
}

const sameDraft = (a: DraftValue, b: DraftValue) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((entry, index) => entry === b[index])
    : a === b;

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

// ---- Relational fields ---------------------------------------------------
// A many2one/many2many can point at hundreds of records (accounts, taxes,
// units), so options are searched on the server rather than shipped with the
// form. They load on first use and re-search as you type — and the values the
// record already holds are always offered, so a picker whose search hasn't
// run yet still shows what's currently set instead of an empty box.

const RelationPicker: React.FC<{
  field: DetailField;
  draft: DraftValue;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
}> = ({ field, draft, disabled, onChange }) => {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [options, setOptions] = useState<RelationValue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // The record's own values, which double as the name lookup for ids the
  // search hasn't returned.
  const current = useMemo<RelationValue[]>(
    () =>
      field.type === 'many2many'
        ? ((field.value as RelationValue[]) || [])
        : field.value
          ? [field.value as RelationValue]
          : [],
    [field],
  );

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      setLoadError('');
      try {
        const resp = await fetch(
          `/api/ops/menu-items/field-options?field=${encodeURIComponent(field.name)}&q=${encodeURIComponent(search)}`,
        );
        const json = await readJson<{ options: RelationValue[]; error?: string }>(
          resp,
          `Couldn't load the options for ${field.label}.`,
        );
        setOptions(json.options || []);
      } catch (err) {
        setLoadError(String((err as Error).message || err));
        setOptions([]);
      } finally {
        setLoading(false);
      }
    },
    [field.name, field.label],
  );

  // Typing re-searches, but only once you've stopped — one request per pause,
  // not one per keystroke.
  useEffect(() => {
    if (!searched) return undefined;
    const timer = setTimeout(() => load(query), 300);
    return () => clearTimeout(timer);
  }, [query, searched, load]);

  const startSearching = () => {
    if (searched) return;
    setSearched(true);
    if (options === null) load('');
  };

  // Everything offered: what's loaded, plus whatever the record holds (and
  // anything already picked), so a selection never disappears from its own
  // dropdown after a narrower search.
  const known = useMemo(() => {
    const merged = new Map<number, RelationValue>();
    current.forEach((entry) => merged.set(entry.id, entry));
    (options || []).forEach((entry) => merged.set(entry.id, entry));
    return merged;
  }, [current, options]);

  const nameFor = (id: number) => known.get(id)?.name || `#${id}`;

  if (field.type === 'many2many') {
    const selected = Array.isArray(draft) ? draft : [];
    const addable = [...known.values()].filter((entry) => !selected.includes(entry.id));
    return (
      <div className="menu-detail-relation">
        {selected.length > 0 && (
          <div className="menu-detail-chips">
            {selected.map((id) => (
              <span key={id} className="menu-detail-chip">
                {nameFor(id)}
                <button
                  type="button"
                  className="menu-detail-chip-remove"
                  onClick={() => onChange(selected.filter((entry) => entry !== id))}
                  disabled={disabled}
                  aria-label={`Remove ${nameFor(id)}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="menu-detail-relation-controls">
          <input
            type="text"
            placeholder={`Search ${field.label.toLowerCase()}…`}
            value={query}
            onFocus={startSearching}
            onChange={(e) => {
              startSearching();
              setQuery(e.target.value);
            }}
            disabled={disabled}
          />
          <select
            value=""
            onFocus={startSearching}
            onChange={(e) => {
              if (!e.target.value) return;
              onChange([...selected, Number(e.target.value)]);
            }}
            disabled={disabled}
          >
            <option value="">{loading ? 'Searching…' : addable.length ? '+ Add…' : 'No matches'}</option>
            {addable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        {loadError && <span className="menu-detail-note is-error">{loadError}</span>}
      </div>
    );
  }

  const selectedId = typeof draft === 'number' ? draft : null;
  const choices = [...known.values()];
  return (
    <div className="menu-detail-relation">
      <div className="menu-detail-relation-controls">
        <select
          value={selectedId === null ? '' : String(selectedId)}
          onFocus={startSearching}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          disabled={disabled}
        >
          <option value="">{field.required ? '— pick one —' : '— none —'}</option>
          {choices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder={loading ? 'Searching…' : 'Search…'}
          value={query}
          onFocus={startSearching}
          onChange={(e) => {
            startSearching();
            setQuery(e.target.value);
          }}
          disabled={disabled}
        />
      </div>
      {loadError && <span className="menu-detail-note is-error">{loadError}</span>}
    </div>
  );
};

// ---- One field -----------------------------------------------------------

const DetailInput: React.FC<{
  field: DetailField;
  draft: DraftValue;
  disabled: boolean;
  onChange: (next: DraftValue) => void;
}> = ({ field, draft, disabled, onChange }) => {
  if (field.type === 'boolean') {
    return (
      <input type="checkbox" checked={Boolean(draft)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
    );
  }
  if (field.type === 'selection') {
    return (
      <select value={String(draft ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{field.required ? '— pick one —' : '— none —'}</option>
        {(field.selection || []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'many2one' || field.type === 'many2many') {
    return <RelationPicker field={field} draft={draft} disabled={disabled} onChange={onChange} />;
  }
  if (MULTILINE_TYPES.includes(field.type)) {
    return (
      <textarea rows={3} value={String(draft ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    );
  }
  if (NUMERIC_TYPES.includes(field.type)) {
    return (
      <input
        type="number"
        step={field.type === 'integer' ? '1' : 'any'}
        value={String(draft ?? '')}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    );
  }
  if (field.type === 'date' || field.type === 'datetime') {
    return (
      <input
        type={field.type === 'date' ? 'date' : 'text'}
        value={String(draft ?? '')}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={field.type === 'datetime' ? 'YYYY-MM-DD HH:MM:SS' : undefined}
      />
    );
  }
  return (
    <input type="text" value={String(draft ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  );
};

// ---- The panel -----------------------------------------------------------

const MenuItemDetails: React.FC<{
  itemId: number;
  itemName: string;
  disabled?: boolean;
  // The list row above this panel is re-rendered from Odoo's copy of the
  // record after a save, since a detail write can change what it shows (the
  // internal reference, or a move between the B2C and wholesale categories).
  onSaved: (item: MenuItem) => void;
}> = ({ itemId, itemName, disabled = false, onSaved }) => {
  const [details, setDetails] = useState<DetailsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // Only the fields actually touched — this is exactly what gets written.
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/ops/menu-items/${itemId}/details`);
      const json = await readJson<DetailsResponse>(resp, "Couldn't load this product's details from Odoo.");
      setDetails(json);
      setDrafts({});
      setOpenGroup((current) => current || json.groups[0] || null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  const fieldsByGroup = useMemo(() => {
    const groups = new Map<string, DetailField[]>();
    (details?.fields || []).forEach((field) => {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group)!.push(field);
    });
    return groups;
  }, [details]);

  // A draft is dropped once it matches Odoo again, so undoing an edit by hand
  // leaves nothing to save rather than writing the value back unchanged.
  const setDraft = (field: DetailField, next: DraftValue) => {
    setSavedNote('');
    setDrafts((prev) => {
      const updated = { ...prev };
      if (sameDraft(next, toDraft(field))) delete updated[field.name];
      else updated[field.name] = next;
      return updated;
    });
  };

  const changedNames = Object.keys(drafts);

  const handleSave = async () => {
    if (!changedNames.length) return;
    setIsSaving(true);
    setSaveError('');
    setSavedNote('');
    try {
      const resp = await fetch('/api/ops/menu-items/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: itemId, values: drafts }),
      });
      const json = await readJson<{ item: MenuItem; details: DetailsResponse; error?: string }>(
        resp,
        'Odoo rejected the change.',
      );
      // Odoo's version of the record replaces the form, so a value it
      // normalised (a rounded float, a name it title-cased) shows as what was
      // actually stored rather than what was typed.
      setDetails(json.details);
      setDrafts({});
      setSavedNote(`Saved ${changedNames.length} field${changedNames.length === 1 ? '' : 's'} to Odoo.`);
      onSaved(json.item);
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const busy = disabled || isSaving;

  return (
    <div className="menu-detail-panel">
      <div className="menu-detail-head">
        <span className="menu-detail-title">Odoo product details · {itemName}</span>
        <div className="menu-detail-head-actions">
          {changedNames.length > 0 && (
            <span className="menu-detail-dirty">
              {changedNames.length} unsaved change{changedNames.length === 1 ? '' : 's'}
            </span>
          )}
          <button type="button" className="svc-week-menu-edit" onClick={load} disabled={isLoading || isSaving}>
            {isLoading ? 'Loading…' : 'Reload from Odoo'}
          </button>
        </div>
      </div>

      <p className="inv-section-hint">
        Everything else on the product record. Name, price, sales description and the picture are edited above — they're
        left off this list so one value can't have two drafts going at once.
      </p>

      {error && <p className="chat-error">{error}</p>}
      {saveError && <p className="chat-error">{saveError}</p>}
      {savedNote && <p className="status-message">{savedNote}</p>}

      {isLoading && !details ? (
        <p className="status-message">Loading the product record from Odoo…</p>
      ) : (
        details && (
          <>
            {/* One group open at a time: 60-odd fields laid out flat is a
                wall, and the form they mirror is paged the same way. */}
            <div className="menu-detail-tabs">
              {details.groups.map((group) => {
                const changedHere = (fieldsByGroup.get(group) || []).filter((field) => field.name in drafts).length;
                return (
                  <button
                    key={group}
                    type="button"
                    className={`menu-detail-tab${openGroup === group ? ' is-active' : ''}`}
                    onClick={() => setOpenGroup(group)}
                  >
                    {group}
                    {changedHere > 0 && <em className="menu-detail-tab-dot" aria-label={`${changedHere} changed`} />}
                  </button>
                );
              })}
            </div>

            <div className="menu-detail-fields">
              {(fieldsByGroup.get(openGroup || '') || []).map((field) => {
                const draft = field.name in drafts ? drafts[field.name] : toDraft(field);
                const isChanged = field.name in drafts;
                return (
                  <label
                    key={field.name}
                    className={`menu-detail-field${isChanged ? ' is-changed' : ''}${
                      field.type === 'boolean' ? ' is-check' : ''
                    }${MULTILINE_TYPES.includes(field.type) ? ' is-wide' : ''}`}
                    title={field.help || undefined}
                  >
                    <span className="menu-detail-label">
                      {field.label}
                      {field.required && <em className="menu-detail-required">required</em>}
                      <em className="menu-detail-tech">{field.name}</em>
                    </span>
                    <DetailInput
                      field={field}
                      draft={draft}
                      disabled={busy}
                      onChange={(next) => setDraft(field, next)}
                    />
                  </label>
                );
              })}
            </div>

            <div className="svc-week-form-actions">
              <button
                type="button"
                className="primary-button small"
                onClick={handleSave}
                disabled={busy || !changedNames.length}
              >
                {isSaving
                  ? 'Saving…'
                  : changedNames.length
                    ? `Save ${changedNames.length} field${changedNames.length === 1 ? '' : 's'} to Odoo`
                    : 'No changes to save'}
              </button>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => setDrafts({})}
                disabled={busy || !changedNames.length}
              >
                Discard changes
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
};

export default MenuItemDetails;
