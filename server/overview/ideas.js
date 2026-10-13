// The Idea Board under Overview — somewhere to drop every "what if we…" the
// moment it turns up, and come back to it later.
//
// Not the notes bubble. A note is a to-do with a tick box and maybe a due
// date; an idea is a maybe. It has no deadline, it gets kicked around and
// voted on, and most of them are never done — which is fine, and is exactly
// why they should not sit on the board of things somebody has to do.
//
// So an idea carries a stage instead of a tick (spark → smoking → served, or
// parked), a category so the board can be read by part of the business, and a
// 🔥 count for "yes, this one". Unlike a note the text can be edited: ideas get
// sharpened as they are thought about, and there is one person logging most
// of them, so the two-device overwrite a shared to-do list worries about is
// not the risk here.
import { increment, insert, remove, select, update } from '../core/repo.js';
import { all, tx } from '../core/db.js';

// Categories are rows in idea_category, so anyone can add one ("Supper club",
// "New menu"). Wild card is the floor: it cannot be deleted, a new idea with
// no category lands there, and so do the ideas of a category that is deleted.
const FALLBACK_CATEGORY = 'wild';

// The sticky-note papers a category can be. Names rather than hex values, so
// every category is one the board has a readable paper and ink for — see the
// .idea-color-* rules in App.css.
const COLORS = ['peach', 'pink', 'blue', 'green', 'lilac', 'yellow', 'mint', 'coral'];

const STAGES = ['spark', 'smoking', 'served', 'parked'];

const MAX_TITLE = 140;
const MAX_DETAILS = 2000;
const MAX_AUTHOR = 40;
const MAX_LABEL = 40;
const MAX_EMOJI = 16;

function toIdea(row) {
  return {
    id: row.idea_id,
    title: row.title,
    details: row.details || '',
    category: row.category,
    stage: row.stage,
    author: row.author || '',
    fire: row.fire || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function missing() {
  return notFound('That idea no longer exists.');
}

function clean(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.slice(0, max);
}

function oneOf(value, allowed, what) {
  if (!allowed.includes(value)) throw bad(`${what} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function toCategory(row) {
  return {
    id: row.category_id,
    label: row.label,
    emoji: row.emoji || '🏷️',
    color: row.color,
    ideas: row.ideas || 0,
    // So the board can hide the delete button rather than offer one that fails.
    removable: row.category_id !== FALLBACK_CATEGORY,
  };
}

function listCategories() {
  return all(
    `SELECT c.*, (SELECT count(*) FROM idea i WHERE i.category = c.category_id) AS ideas
       FROM idea_category c
      ORDER BY c.sort_order, c.created_at, c.category_id`,
  ).map(toCategory);
}

function categoryExists(id) {
  return typeof id === 'string' && select('idea_category', { category_id: id }).length > 0;
}

function cleanCategory(value) {
  if (value === undefined || value === null || value === '') return FALLBACK_CATEGORY;
  if (!categoryExists(value)) throw bad('That category does not exist (any more).');
  return value;
}

// "Supper club ideas" -> "supper-club-ideas". The id is fixed at creation and
// never follows a rename, because it is what every idea in it points at.
function slugFor(label) {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'category';
  let slug = base;
  for (let n = 2; categoryExists(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

function cleanColor(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return oneOf(value, COLORS, 'color');
}

function sameLabelExists(label, exceptId) {
  return all('SELECT category_id FROM idea_category WHERE lower(label) = lower(?)', label).some(
    (row) => row.category_id !== exceptId,
  );
}

// Adds one to the end of the list. A name already in use is refused rather
// than made into a second chip that looks identical to the first.
function addCategory({ label, emoji, color } = {}) {
  const name = clean(label, MAX_LABEL);
  if (!name) throw bad('A category needs a name.');
  if (sameLabelExists(name)) throw bad(`There is already a “${name}” category.`);
  const used = new Set(listCategories().map((c) => c.color));
  const id = slugFor(name);
  insert('idea_category', {
    category_id: id,
    label: name,
    emoji: clean(emoji, MAX_EMOJI),
    // Without a pick, the first paper nobody is using yet, so a new chip
    // stands out from the ones beside it.
    color: cleanColor(color, COLORS.find((c) => !used.has(c)) || COLORS[0]),
    sort_order: (all('SELECT max(sort_order) AS n FROM idea_category')[0].n ?? -1) + 1,
    created_at: new Date().toISOString(),
  });
  return listCategories().find((c) => c.id === id);
}

// Renames, re-emojis or recolours one. The id stays, so its ideas stay with it.
function updateCategory({ id, label, emoji, color } = {}) {
  if (!categoryExists(id)) throw notFound('That category no longer exists.');
  const patch = {};
  if (label !== undefined) {
    const name = clean(label, MAX_LABEL);
    if (!name) throw bad('A category needs a name.');
    if (sameLabelExists(name, id)) throw bad(`There is already a “${name}” category.`);
    patch.label = name;
  }
  if (emoji !== undefined) patch.emoji = clean(emoji, MAX_EMOJI);
  if (color !== undefined) patch.color = cleanColor(color);
  if (!Object.keys(patch).length) throw bad('Nothing to change.');
  update('idea_category', { category_id: id }, patch);
  return listCategories().find((c) => c.id === id);
}

// Deletes one and moves its ideas to Wild card in the same transaction, so an
// idea is never left pointing at a category that is not there. The ideas are
// the point of the board; a category is only a way of sorting them.
function deleteCategory({ id } = {}) {
  if (id === FALLBACK_CATEGORY) throw bad('Wild card is where everything else lands — it can’t be deleted.');
  if (!categoryExists(id)) return { deleted: false, id, moved: 0 };
  return tx(() => {
    const moved = all('SELECT count(*) AS n FROM idea WHERE category = ?', id)[0].n;
    if (moved) update('idea', { category: id }, { category: FALLBACK_CATEGORY });
    remove('idea_category', { category_id: id });
    return { deleted: true, id, moved };
  });
}

function ideaId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw bad('An idea id is required.');
  return n;
}

function load(id) {
  const row = select('idea', { idea_id: id })[0];
  if (!row) throw missing();
  return row;
}

// Every idea, newest first. The board is one person's notebook, not a feed of
// thousands, so it comes back whole and the browser filters and sorts — a
// search box that answers as you type is half the fun of a board like this.
function listIdeas() {
  const rows = all('SELECT * FROM idea ORDER BY idea_id DESC');
  return {
    ideas: rows.map(toIdea),
    categories: listCategories(),
    colors: COLORS,
    stages: STAGES,
    fetchedAt: new Date().toISOString(),
  };
}

function addIdea({ title, details, category, author } = {}) {
  const headline = clean(title, MAX_TITLE);
  if (!headline) throw bad('An idea needs at least a line.');
  const result = insert('idea', {
    title: headline,
    details: clean(details, MAX_DETAILS),
    category: cleanCategory(category),
    stage: 'spark',
    author: clean(author, MAX_AUTHOR),
    fire: 0,
    // Full ISO-8601 UTC, for the same Safari reason as sharedNotes.js.
    created_at: new Date().toISOString(),
  });
  return toIdea(load(Number(result.lastInsertRowid)));
}

// Edits any of the text, the category or the stage. Only the fields sent are
// touched, so moving a card along does not need to resend its words.
function updateIdea({ id, title, details, category, stage } = {}) {
  const n = ideaId(id);
  load(n);
  const patch = {};
  if (title !== undefined) {
    const headline = clean(title, MAX_TITLE);
    if (!headline) throw bad('An idea needs at least a line.');
    patch.title = headline;
  }
  if (details !== undefined) patch.details = clean(details, MAX_DETAILS);
  if (category !== undefined) patch.category = cleanCategory(category);
  if (stage !== undefined) patch.stage = oneOf(stage, STAGES, 'stage');
  if (!Object.keys(patch).length) throw bad('Nothing to change.');
  patch.updated_at = new Date().toISOString();
  update('idea', { idea_id: n }, patch);
  return toIdea(load(n));
}

// One more 🔥. Bumped in SQL rather than read-add-write, so two taps landing
// together are two, not one.
function fireIdea({ id } = {}) {
  const n = ideaId(id);
  load(n);
  increment('idea', { idea_id: n }, 'fire', 1, { places: 0 });
  return toIdea(load(n));
}

// Like the notes bubble, deleting something already gone is not an error.
function deleteIdea({ id } = {}) {
  const n = ideaId(id);
  const changes = remove('idea', { idea_id: n }, { required: false });
  return { deleted: changes > 0, id: n };
}

export {
  listIdeas,
  addIdea,
  updateIdea,
  fireIdea,
  deleteIdea,
  listCategories,
  addCategory,
  updateCategory,
  deleteCategory,
  COLORS,
  STAGES,
  MAX_TITLE,
  MAX_DETAILS,
};
