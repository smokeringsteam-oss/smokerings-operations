import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePersistedState, revivedString } from '../../lib/usePersistedState';
import { usePersistedChoice } from '../../lib/usePersistedChoice';
import { readNotesAuthor } from '../../lib/useSharedNotes';

// The Idea Board — Overview's notebook for every "what if we…". One row of
// categories that both filters the board and decides where a new idea goes,
// a box to type in, and cards whose stage badge moves them along in one tap.
// Tapping a card edits it; ⚙️ adds, renames and deletes categories. See
// server/overview/ideas.js.

type Stage = 'spark' | 'smoking' | 'served' | 'parked';

type Idea = {
  id: number;
  title: string;
  details: string;
  category: string;
  stage: Stage;
  author: string;
  fire: number;
  createdAt: string;
  updatedAt: string | null;
};

type Category = {
  id: string;
  label: string;
  emoji: string;
  color: string;
  ideas: number;
  removable: boolean;
};

// Wild card can't be deleted, so it is always there to fall back on.
const FALLBACK_CATEGORY = 'wild';

const COLORS = ['peach', 'pink', 'blue', 'green', 'lilac', 'yellow', 'mint', 'coral'];

// In tap order: tapping a card's badge moves it to the next one.
const STAGES: { id: Stage; label: string; emoji: string }[] = [
  { id: 'spark', label: 'Spark', emoji: '💡' },
  { id: 'smoking', label: 'Smoking', emoji: '🔥' },
  { id: 'served', label: 'Served', emoji: '🍽️' },
  { id: 'parked', label: 'Parked', emoji: '🧊' },
];

const stageOf = (id: Stage) => STAGES.find((s) => s.id === id) ?? STAGES[0];
const nextStage = (id: Stage) => STAGES[(STAGES.findIndex((s) => s.id === id) + 1) % STAGES.length];

type StageFilter = 'all' | Stage;
const STAGE_FILTERS: readonly StageFilter[] = ['all', 'spark', 'smoking', 'served', 'parked'];

// "🕯️ Supper club" -> { emoji: '🕯️', label: 'Supper club' }, so a category's
// emoji is typed with its name rather than picked in a second step.
const LEADING_EMOJI = /^\s*((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[‍️⃣]|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;
const splitEmoji = (text: string) => {
  const match = LEADING_EMOJI.exec(text);
  return match ? { emoji: match[1], label: text.slice(match[0].length).trim() } : { emoji: '', label: text.trim() };
};

const ago = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A short tap of the phone's buzzer when an idea lands or gets a 🔥. Phones
// without one, and desktops, just skip it.
const buzz = () => {
  try {
    navigator.vibrate?.(12);
  } catch {
    // Nothing to buzz.
  }
};

// What flies out of the Add button on a phone (hidden on a desktop, see
// .idea-burst in App.css).
const BURST = ['💡', '🔥', '✨', '🍖', '🎉'];

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data as T;
}

const IdeaBoard = () => {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);

  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [saving, setSaving] = useState(false);

  // The one category choice on the board: what you are looking at, and where
  // a new idea goes. Any id is accepted back; one deleted since reads as all.
  const [current, setCurrent] = usePersistedState<string>('smokerings.ideas.category', 'all', revivedString());
  const [stageFilter, setStageFilter] = usePersistedChoice<StageFilter>('smokerings.ideas.stage', 'all', STAGE_FILTERS);
  const [search, setSearch] = useState('');

  const [toast, setToast] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [burstAt, setBurstAt] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await send<{ ideas: Idea[]; categories: Category[] }>('/api/ideas', 'GET');
      setIdeas(data.ideas);
      setCategories(data.categories);
      setError('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Back from another app or tab — pick up anything logged on another phone.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // The burst is gone once it has flown.
  useEffect(() => {
    if (!burstAt) return undefined;
    const timer = window.setTimeout(() => setBurstAt(0), 900);
    return () => window.clearTimeout(timer);
  }, [burstAt]);

  const categoryOf = useCallback(
    (id: string): Category =>
      categories.find((c) => c.id === id) ??
      categories.find((c) => c.id === FALLBACK_CATEGORY) ?? {
        id,
        label: 'Wild card',
        emoji: '🚀',
        color: 'lilac',
        ideas: 0,
        removable: false,
      },
    [categories],
  );

  const view = current === 'all' || !categories.length || categories.some((c) => c.id === current) ? current : 'all';
  const viewing = view === 'all' ? null : categoryOf(view);

  const replace = (idea: Idea) => setIdeas((list) => list.map((i) => (i.id === idea.id ? idea : i)));
  const bumpCount = (id: string, by: number) =>
    setCategories((list) => list.map((c) => (c.id === id ? { ...c, ideas: Math.max(0, c.ideas + by) } : c)));

  const add = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const idea = await send<Idea>('/api/ideas', 'POST', {
        title,
        details,
        category: viewing ? viewing.id : FALLBACK_CATEGORY,
        author: readNotesAuthor(),
      });
      setIdeas((list) => [idea, ...list]);
      bumpCount(idea.category, 1);
      setTitle('');
      setDetails('');
      setBurstAt(Date.now());
      buzz();
      // A new spark should be visible, whatever stage the board was showing.
      if (stageFilter !== 'all' && stageFilter !== 'spark') setStageFilter('all');
    } catch (err) {
      setToast(`Couldn’t save: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const fire = async (idea: Idea) => {
    buzz();
    replace({ ...idea, fire: idea.fire + 1 });
    try {
      replace(await send<Idea>(`/api/ideas/${idea.id}/fire`, 'POST'));
    } catch {
      replace(idea);
      setToast('That 🔥 didn’t land — try again');
    }
  };

  const patch = async (idea: Idea, change: Partial<Pick<Idea, 'title' | 'details' | 'category' | 'stage'>>) => {
    replace({ ...idea, ...change });
    try {
      const saved = await send<Idea>(`/api/ideas/${idea.id}`, 'PATCH', change);
      replace(saved);
      if (saved.category !== idea.category) {
        bumpCount(idea.category, -1);
        bumpCount(saved.category, 1);
      }
      return true;
    } catch (err) {
      replace(idea);
      setToast(`Couldn’t save: ${errorText(err)}`);
      return false;
    }
  };

  const remove = async (idea: Idea) => {
    if (!window.confirm(`Bin “${idea.title}”?`)) return;
    setEditingId(null);
    setIdeas((list) => list.filter((i) => i.id !== idea.id));
    bumpCount(idea.category, -1);
    try {
      await send(`/api/ideas/${idea.id}`, 'DELETE');
    } catch {
      setIdeas((list) => [idea, ...list.filter((i) => i.id !== idea.id)]);
      bumpCount(idea.category, 1);
      setToast('Couldn’t delete that one');
    }
  };

  const inView = useMemo(() => ideas.filter((i) => view === 'all' || i.category === view), [ideas, view]);

  const counts = useMemo(() => {
    const byStage: Record<StageFilter, number> = { all: inView.length, spark: 0, smoking: 0, served: 0, parked: 0 };
    inView.forEach((i) => {
      byStage[i.stage] += 1;
    });
    return byStage;
  }, [inView]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return inView.filter(
      (i) =>
        (stageFilter === 'all' || i.stage === stageFilter) &&
        (!term || `${i.title} ${i.details} ${i.author}`.toLowerCase().includes(term)),
    );
  }, [inView, stageFilter, search]);

  return (
    <div className="idea-board">
      <h2 className="idea-title">
        <span className="idea-title-bulb" aria-hidden="true">💡</span> Idea Board
      </h2>

      {/* The one category row: tap to look at it and to file new ideas there.
          ⚙️ sits outside the scroll so it never needs a swipe to find. */}
      <div className="idea-cat-bar">
        <div className="idea-chip-row" role="radiogroup" aria-label="Category">
          <button
            type="button"
            role="radio"
            aria-checked={view === 'all'}
            className={`idea-chip idea-chip-all${view === 'all' ? ' is-on' : ''}`}
            onClick={() => setCurrent('all')}
          >
            All <span className="idea-chip-count">{ideas.length}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={view === c.id}
              className={`idea-chip idea-color-${c.color}${view === c.id ? ' is-on' : ''}`}
              onClick={() => setCurrent(c.id)}
            >
              <span aria-hidden="true">{c.emoji}</span> {c.label} <span className="idea-chip-count">{c.ideas}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="idea-chip idea-chip-new"
          aria-label="Edit categories"
          onClick={() => setManaging(true)}
        >
          ⚙️
        </button>
      </div>

      <form
        className={`idea-composer${viewing ? ` idea-color-${viewing.color} is-tinted` : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="idea-composer-row">
          <input
            className="idea-composer-input"
            value={title}
            maxLength={140}
            placeholder={viewing ? `New ${viewing.label} idea…` : 'New idea…'}
            aria-label={viewing ? `New idea in ${viewing.label}` : 'New idea'}
            autoComplete="off"
            enterKeyHint="send"
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit" className="idea-drop" disabled={!title.trim() || saving}>
            {saving ? '…' : 'Add'}
          </button>
          {burstAt ? (
            <span className="idea-burst" key={burstAt} aria-hidden="true">
              {BURST.map((e, n) => (
                <span key={n} style={{ ['--n' as string]: n }}>
                  {e}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {/* Only once there is an idea to say more about — no extra tap to open it. */}
        {title.trim() ? (
          <textarea
            className="idea-composer-details"
            value={details}
            maxLength={2000}
            rows={2}
            placeholder="More detail? (optional)"
            onChange={(event) => setDetails(event.target.value)}
          />
        ) : null}
      </form>

      <div className="idea-toolbar">
        <div className="idea-tabs" role="tablist" aria-label="Stage">
          {STAGE_FILTERS.map((s) => {
            const meta = s === 'all' ? { emoji: '', label: 'All' } : stageOf(s);
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={stageFilter === s}
                className={`idea-tab${stageFilter === s ? ' is-on' : ''}`}
                onClick={() => setStageFilter(s)}
              >
                {meta.emoji ? <span aria-hidden="true">{meta.emoji}</span> : null} {meta.label}
                <span className="idea-tab-count">{counts[s]}</span>
              </button>
            );
          })}
        </div>
        <input
          className="idea-search"
          type="search"
          value={search}
          placeholder="🔎 Search"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {error ? (
        <div className="idea-error">
          Couldn’t load the board: {error}{' '}
          <button type="button" className="idea-link" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className="idea-empty">Loading…</p>
      ) : !inView.length && !error ? (
        <p className="idea-empty">Nothing here yet — type the first one above.</p>
      ) : !visible.length ? (
        <p className="idea-empty">Nothing matches that.</p>
      ) : (
        <div className="idea-grid">
          {visible.map((idea, index) => {
            const cat = categoryOf(idea.category);
            const stage = stageOf(idea.stage);
            const next = nextStage(idea.stage);
            return (
              <article
                key={idea.id}
                className={`idea-card idea-color-${cat.color} idea-stage-${idea.stage}`}
                // Staggers the cards dropping in on a phone; only the first few wait.
                style={{ ['--i' as string]: Math.min(index, 8) }}
              >
                {editingId === idea.id ? (
                  <IdeaEditor
                    idea={idea}
                    categories={categories}
                    onCancel={() => setEditingId(null)}
                    onDelete={() => void remove(idea)}
                    onSave={async (change) => {
                      if (await patch(idea, change)) setEditingId(null);
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="idea-card-body"
                      aria-label={`Edit “${idea.title}”`}
                      onClick={() => setEditingId(idea.id)}
                    >
                      {/* Only worth saying when the board is showing every category. */}
                      {view === 'all' ? (
                        <span className="idea-card-cat">
                          <span aria-hidden="true">{cat.emoji}</span> {cat.label}
                        </span>
                      ) : null}
                      <span className="idea-card-title">{idea.title}</span>
                      {idea.details ? <span className="idea-card-details">{idea.details}</span> : null}
                      <span className="idea-card-meta">
                        {idea.author ? `${idea.author} · ` : ''}
                        {ago(idea.createdAt)}
                      </span>
                    </button>
                    <div className="idea-card-actions">
                      <button
                        type="button"
                        className="idea-fire"
                        onClick={() => void fire(idea)}
                        aria-label={`Fire this idea, ${idea.fire} so far`}
                      >
                        {/* Keyed on the count, so each 🔥 replays the bump. */}
                        🔥 <span className="idea-fire-count" key={idea.fire}>{idea.fire}</span>
                      </button>
                      <button
                        type="button"
                        className="idea-stage-btn"
                        onClick={() => void patch(idea, { stage: next.id })}
                        aria-label={`${stage.label}. Tap to move to ${next.label}`}
                        title={`Tap → ${next.emoji} ${next.label}`}
                      >
                        {stage.emoji} {stage.label}
                      </button>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      {managing ? (
        <CategoryList
          categories={categories}
          onClose={() => setManaging(false)}
          onAdded={(created) => {
            setCategories((list) => [...list, created]);
            setCurrent(created.id);
          }}
          onChanged={(changed) => setCategories((list) => list.map((c) => (c.id === changed.id ? changed : c)))}
          onDeleted={(id, moved) => {
            setCategories((list) => list.filter((c) => c.id !== id));
            setToast(moved ? `Deleted — ${moved} idea${moved === 1 ? '' : 's'} moved to Wild card` : 'Category deleted');
            void load();
          }}
          onError={(message) => setToast(message)}
        />
      ) : null}

      {toast ? (
        <div className="idea-toast" role="status" key={toast}>
          {toast}
        </div>
      ) : null}
    </div>
  );
};

type EditorProps = {
  idea: Idea;
  categories: Category[];
  onCancel: () => void;
  onDelete: () => void;
  onSave: (change: { title: string; details: string; category: string }) => void;
};

const IdeaEditor = ({ idea, categories, onCancel, onDelete, onSave }: EditorProps) => {
  const [title, setTitle] = useState(idea.title);
  const [details, setDetails] = useState(idea.details);
  const [category, setCategory] = useState(idea.category);
  return (
    <form
      className="idea-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim()) onSave({ title, details, category });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <input
        className="idea-composer-input"
        value={title}
        maxLength={140}
        aria-label="Idea"
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="idea-composer-details"
        value={details}
        maxLength={2000}
        rows={3}
        aria-label="Details"
        placeholder="Details (optional)"
        onChange={(event) => setDetails(event.target.value)}
      />
      <select
        className="idea-select"
        value={category}
        aria-label="Category"
        onChange={(event) => setCategory(event.target.value)}
      >
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.emoji} {c.label}
          </option>
        ))}
      </select>
      <div className="idea-editor-actions">
        <button type="button" className="idea-icon-btn" aria-label="Delete idea" onClick={onDelete}>
          🗑️
        </button>
        <span className="idea-editor-spacer" />
        <button type="button" className="idea-tool-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="idea-drop" disabled={!title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
};

type ListProps = {
  categories: Category[];
  onClose: () => void;
  onAdded: (category: Category) => void;
  onChanged: (category: Category) => void;
  onDeleted: (id: string, moved: number) => void;
  onError: (message: string) => void;
};

// Add, rename, recolour or delete. Each row saves itself — type and tap away,
// or tap the dot to try the next colour — so there is no Save button to find.
const CategoryList = ({ categories, onClose, onAdded, onChanged, onDeleted, onError }: ListProps) => {
  const [newName, setNewName] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const create = async () => {
    const { emoji, label } = splitEmoji(newName);
    if (!label) return;
    try {
      onAdded(await send<Category>('/api/ideas/categories', 'POST', { label, emoji }));
      setNewName('');
    } catch (err) {
      onError(errorText(err));
    }
  };

  const save = async (c: Category, change: Partial<Pick<Category, 'label' | 'emoji' | 'color'>>) => {
    try {
      onChanged(await send<Category>(`/api/ideas/categories/${encodeURIComponent(c.id)}`, 'PATCH', change));
    } catch (err) {
      onError(errorText(err));
    }
  };

  const destroy = async (c: Category) => {
    const warning = c.ideas
      ? `Delete “${c.label}”? Its ${c.ideas} idea${c.ideas === 1 ? '' : 's'} move to Wild card.`
      : `Delete “${c.label}”?`;
    if (!window.confirm(warning)) return;
    try {
      const result = await send<{ moved: number }>(`/api/ideas/categories/${encodeURIComponent(c.id)}`, 'DELETE');
      onDeleted(c.id, result.moved || 0);
    } catch (err) {
      onError(errorText(err));
    }
  };

  return (
    <div className="idea-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="idea-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Categories"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="idea-sheet-head">
          <h3>Categories</h3>
          <button type="button" className="idea-icon-btn" aria-label="Done" onClick={onClose}>
            ✕
          </button>
        </div>
        <ul className="idea-sheet-list">
          {categories.map((c) => (
            <li key={c.id} className={`idea-sheet-item idea-color-${c.color}`}>
              <button
                type="button"
                className={`idea-swatch idea-color-${c.color}`}
                aria-label={`Colour: ${c.color}. Tap for the next one`}
                onClick={() => void save(c, { color: COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length] })}
              />
              <input
                className="idea-sheet-input"
                defaultValue={`${c.emoji} ${c.label}`}
                maxLength={50}
                aria-label={`Rename ${c.label}`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                onBlur={(event) => {
                  const { emoji, label } = splitEmoji(event.target.value);
                  if (!label) {
                    event.target.value = `${c.emoji} ${c.label}`;
                    return;
                  }
                  if (label !== c.label || (emoji || c.emoji) !== c.emoji) {
                    void save(c, { label, ...(emoji ? { emoji } : {}) });
                  }
                }}
              />
              <span className="idea-sheet-count">{c.ideas}</span>
              {c.removable ? (
                <button
                  type="button"
                  className="idea-icon-btn"
                  aria-label={`Delete ${c.label}`}
                  onClick={() => void destroy(c)}
                >
                  🗑️
                </button>
              ) : (
                <span className="idea-icon-btn idea-sheet-lock" title="Wild card catches everything else">
                  🔒
                </span>
              )}
            </li>
          ))}
        </ul>
        <form
          className="idea-sheet-add"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            className="idea-sheet-input"
            value={newName}
            maxLength={50}
            placeholder="🕯️ New category"
            aria-label="New category name, emoji first if you like"
            enterKeyHint="done"
            onChange={(event) => setNewName(event.target.value)}
          />
          <button type="submit" className="idea-tool-btn" disabled={!newName.trim()}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
};

export default IdeaBoard;
