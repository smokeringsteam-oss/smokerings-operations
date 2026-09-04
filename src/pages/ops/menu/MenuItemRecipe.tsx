import React, { useCallback, useEffect, useMemo, useState } from 'react';

// The kitchen half of a menu item, shown as the second section of the dish
// card in MenuItems: the meat weight, the sides and sauces, and the packaging
// that go into one order.
//
// It edits recipe_lines.csv in the knowledge-base repo, which Odoo has no
// model for and which every planner reads: the weekend meat weight, the
// Swiggy shopping list and the packing sheet are all this dish's numbers ×
// the order count. Change 120 g to 110 g here and Friday's buy list moves
// with it. That's why it saves on its own button rather than with the sales
// fields above it — two different files, two different blast radii.
//
// The one non-obvious thing it hides: a line stores its amount twice, as
// `quantity` and `baseQuantity`, and the planners read the base one. For meat
// and sides the two are one amount said twice, so the row shows a single input
// and the server writes both. Where a line is flagged as carrying two separate
// figures — foil counted one way and planned another — both are shown, since
// deriving one from the other is how a shopping list ends up asking for 30
// rolls of foil. See server/ops/menu/menuRecipe.js.

type RecipeGroup = 'meat' | 'side' | 'material';

type RecipeLine = {
  lineId: string;
  childId: string;
  childName: string;
  childType: string;
  group: RecipeGroup;
  quantity: number | null;
  baseQuantity: number | null;
  amountsLinked: boolean;
  plannerQuantity: number | null;
  isToTaste: boolean;
  status: string;
  notes: string;
};

type RecipeResponse = {
  menuId: string;
  lines: RecipeLine[];
  editable: boolean;
  changed?: string[];
  notes?: string[];
  error?: string;
};

// Kept as strings while being typed, so a half-typed "1." or a cleared box
// behaves like a text input instead of snapping to 0. The server parses and
// validates; a blank one clears the cell, which is how a "to taste" line is
// stored.
type LineDraft = { quantity?: string; baseQuantity?: string };

const GROUPS: { id: RecipeGroup; label: string; icon: string; hint: string }[] = [
  { id: 'meat', label: 'Meat', icon: '🍖', hint: 'Finished, smoked weight per order' },
  { id: 'side', label: 'Sides & sauces', icon: '🥗', hint: 'Made in-house, in batches' },
  { id: 'material', label: 'Bought as-is', icon: '📦', hint: 'Buns, chips, containers, packaging' },
];

const asText = (value: number | null) => (value == null ? '' : String(value));

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

const MenuItemRecipe: React.FC<{
  menuId: string | null;
  itemName: string;
  disabled: boolean;
}> = ({ menuId, itemName, disabled }) => {
  const [lines, setLines] = useState<RecipeLine[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!menuId) return;
    setIsLoading(true);
    setError('');
    try {
      const resp = await fetch(`/api/ops/menu-items/recipe?menuId=${encodeURIComponent(menuId)}`);
      const json = await readJson<RecipeResponse>(resp, "Couldn't read the recipe.");
      setLines(json.lines || []);
      setDrafts({});
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, [menuId]);

  useEffect(() => {
    load();
  }, [load]);

  const byGroup = useMemo(() => {
    const groups = new Map<RecipeGroup, RecipeLine[]>();
    (lines || []).forEach((line) => {
      if (!groups.has(line.group)) groups.set(line.group, []);
      groups.get(line.group)!.push(line);
    });
    return groups;
  }, [lines]);

  // A draft that matches what's on file again is dropped, so undoing an edit
  // by hand leaves nothing to save rather than rewriting the same value.
  const setDraft = (line: RecipeLine, field: keyof LineDraft, next: string) => {
    setNotes([]);
    setSaveError('');
    setDrafts((prev) => {
      const updated = { ...prev };
      const current: LineDraft = { ...(updated[line.lineId] || {}) };
      const saved = field === 'quantity' ? asText(line.quantity) : asText(line.baseQuantity);
      if (next === saved) delete current[field];
      else current[field] = next;
      if (Object.keys(current).length) updated[line.lineId] = current;
      else delete updated[line.lineId];
      return updated;
    });
  };

  const draftValue = (line: RecipeLine, field: keyof LineDraft) => {
    const draft = drafts[line.lineId];
    if (draft && draft[field] !== undefined) return draft[field] as string;
    return field === 'quantity' ? asText(line.quantity) : asText(line.baseQuantity);
  };

  const dirtyIds = Object.keys(drafts);

  const handleSave = async () => {
    if (!menuId || !dirtyIds.length) return;
    setIsSaving(true);
    setSaveError('');
    setNotes([]);
    try {
      const edits = dirtyIds.map((lineId) => {
        const line = (lines || []).find((l) => l.lineId === lineId)!;
        const draft = drafts[lineId];
        return {
          lineId,
          quantity: draft.quantity !== undefined ? draft.quantity : asText(line.quantity),
          // Only sent for a line carrying two separate figures: on a linked
          // line the server derives the base column from the quantity, which
          // is the whole point of the single input.
          ...(line.amountsLinked
            ? {}
            : { baseQuantity: draft.baseQuantity !== undefined ? draft.baseQuantity : asText(line.baseQuantity) }),
        };
      });
      const resp = await fetch('/api/ops/menu-items/recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuId, edits }),
      });
      const json = await readJson<RecipeResponse>(resp, "The recipe couldn't be saved.");
      // The file's version of the recipe replaces the form, so what's on
      // screen is what was actually written.
      setLines(json.lines || []);
      setDrafts({});
      const saved = json.changed?.length || 0;
      setNotes([
        saved
          ? `Saved ${saved} line${saved === 1 ? '' : 's'} — the prep planner and buy list use these numbers from now on.`
          : 'Nothing changed — the file already had those numbers.',
        ...(json.notes || []),
      ]);
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const busy = disabled || isSaving;

  if (!menuId) {
    return (
      <div className="menu-item-card-section">
        <span className="menu-item-card-title">Recipe</span>
        <p className="status-message">
          No menu row matches {itemName}, so there's no recipe to edit. Add one with a matching name (or put this
          product's Odoo id in its odoo_product_id column) and the recipe will open here.
        </p>
      </div>
    );
  }

  return (
    <div className="menu-item-card-section">
      <div className="menu-recipe-head">
        <span className="menu-item-card-title">
          Recipe — what goes into one order
          {dirtyIds.length > 0 && (
            <em className="menu-detail-dirty">
              {dirtyIds.length} unsaved line{dirtyIds.length === 1 ? '' : 's'}
            </em>
          )}
        </span>
        <button type="button" className="svc-week-menu-edit" onClick={load} disabled={isLoading || isSaving}>
          {isLoading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {error && <p className="chat-error">{error}</p>}
      {saveError && <p className="chat-error">{saveError}</p>}
      {notes.map((note) => (
        <p key={note} className="status-message">
          {note}
        </p>
      ))}

      {isLoading && !lines ? (
        <p className="status-message">Reading the recipe…</p>
      ) : lines && !lines.length ? (
        <p className="status-message">
          No recipe lines reference {menuId} yet, so nothing about this dish reaches the prep planner. Add its
          ingredients to get it costed and bought for.
        </p>
      ) : (
        lines && (
          <>
            {GROUPS.map((group) => {
              const groupLines = byGroup.get(group.id) || [];
              if (!groupLines.length) return null;
              return (
                <div key={group.id} className="menu-recipe-group">
                  <span className="menu-recipe-group-head">
                    <span className="menu-recipe-group-title">
                      {group.icon} {group.label}
                    </span>
                    <span className="menu-recipe-group-hint">{group.hint}</span>
                  </span>

                  {groupLines.map((line) => {
                    const isDirty = line.lineId in drafts;
                    // Only worth flagging before it's fixed: the two columns
                    // disagreeing is what makes an edit look like it did
                    // nothing, so it's called out on the row rather than left
                    // to be discovered on a Friday.
                    const drifted =
                      line.amountsLinked && line.plannerQuantity != null && line.plannerQuantity !== line.quantity;
                    return (
                      <div key={line.lineId} className={`menu-recipe-line${isDirty ? ' is-changed' : ''}`}>
                        <span className="menu-recipe-name">
                          {line.childName}
                          {line.isToTaste && <em className="menu-item-tag">to taste</em>}
                          {line.status && line.status !== 'ok' && (
                            <em className="menu-item-tag">{line.status.replace(/_/g, ' ')}</em>
                          )}
                        </span>

                        <span className="menu-recipe-inputs">
                          <label className="menu-recipe-qty">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={draftValue(line, 'quantity')}
                              onChange={(e) => setDraft(line, 'quantity', e.target.value)}
                              disabled={busy}
                              aria-label={`${line.childName} quantity`}
                            />
                          </label>

                          {/* Two separate figures, so both are stated: what
                              the kitchen counts, and what the buy list works
                              in. */}
                          {!line.amountsLinked && (
                            <label className="menu-recipe-qty is-base">
                              <span className="menu-recipe-arrow" aria-hidden="true">
                                =
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={draftValue(line, 'baseQuantity')}
                                onChange={(e) => setDraft(line, 'baseQuantity', e.target.value)}
                                disabled={busy}
                                aria-label={`${line.childName} planner quantity`}
                              />
                              <span className="menu-recipe-unit">buy list</span>
                            </label>
                          )}
                        </span>

                        {drifted && (
                          <span className="menu-recipe-drift">
                            planner currently uses {line.plannerQuantity} — saving this line fixes it
                          </span>
                        )}
                        {line.notes && <span className="menu-recipe-note">{line.notes}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div className="svc-week-form-actions">
              <button
                type="button"
                className="primary-button small"
                onClick={handleSave}
                disabled={busy || !dirtyIds.length}
              >
                {isSaving
                  ? 'Saving…'
                  : dirtyIds.length
                    ? `Save recipe (${dirtyIds.length} line${dirtyIds.length === 1 ? '' : 's'})`
                    : 'Recipe saved'}
              </button>
              <button
                type="button"
                className="secondary-button small"
                onClick={() => setDrafts({})}
                disabled={busy || !dirtyIds.length}
              >
                Undo changes
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
};

export default MenuItemRecipe;
