// The note bubble in the top bar — one app-wide scratchpad, shared by every
// device that can reach the dashboard.
//
// The problem it solves is the note you think of on the wrong screen. "Vendor
// says brisket is up next week" occurs to you halfway through a smoking
// session; "second gas cylinder nearly out" occurs to whoever is at the
// kitchen tablet. Before this the only homes for either were a phone's own
// notes app, which nothing else in the kitchen can see, or a task in the
// weekly cadence, which turns a remark into a chore with a due date. This is
// the third option: type it anywhere, read it everywhere.
//
// Append-only, deliberately. A note is written once and either stays or is
// deleted whole; nothing edits a body in place. Two phones typing at the same
// moment therefore produce two notes rather than one silently overwriting the
// other, which is the failure an editable shared list has and cannot detect —
// there is no last-write-wins race here because there is no second write.
//
// No CSV mirror. The mirrors elsewhere in server/ exist because those tables
// were seeded from files in the knowledge-base repo and are still read there
// as a spreadsheet; this table has no such history and no reader outside the
// bubble, so a file would be a copy nothing opens.
import { insert, remove, select, update } from './repo.js';
import { all } from './db.js';

// How many notes a fetch returns. The panel is a scrolling column read newest
// -last, and nobody scrolls back past a couple of hundred remarks; the total
// count comes back alongside so the UI can say what it is not showing rather
// than pretend the list is the whole table.
const PAGE_SIZE = 200;

// Long enough for a paragraph about a vendor call, short enough that a pasted
// document is refused at the door rather than becoming a wall in the panel.
const MAX_BODY = 2000;
const MAX_AUTHOR = 40;

// One row as the panel wants it: camelCase, a real boolean for the tick box,
// and never a null string where the UI would render "null".
function toNote(row) {
  return {
    id: row.note_id,
    author: row.author || '',
    body: row.body,
    createdAt: row.created_at,
    done: !!row.done,
    doneAt: row.done_at || null,
    doneBy: row.done_by || '',
    assignedTo: row.assigned_to || '',
  };
}

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Trimmed, length-capped, and collapsed to null when there is nothing left —
// applied to both fields so a name of three spaces is stored as "no author"
// rather than as three spaces that render as an empty chip.
function clean(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.slice(0, max);
}

// A search term as a LIKE pattern. The three characters LIKE treats specially
// have to be neutralised or a note containing a literal "%" is unfindable and
// a search for "_" quietly matches everything.
function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// The newest PAGE_SIZE notes, oldest of those first — the order they are read
// in, so the panel can render the array top to bottom and scroll to the end.
//
// Two statements rather than one windowed query: the inner select takes the
// newest by id, the outer reverses them. Ordering by note_id and not
// created_at is the point — the id is the insertion sequence, so two notes
// posted in the same second still have a definite order, and the client's
// "what is new since I last looked" comparison has something monotonic to
// compare against.
//
// `q` filters on the note text and the name that posted it. It is done here
// rather than in the browser because the browser only ever holds the most
// recent PAGE_SIZE notes: filtering that window would search the newest 200
// and silently find nothing older, which is worse than not having search at
// all — it answers "no" convincingly. LIKE is case-insensitive for ASCII in
// SQLite, which is what the names and the notes on this board are.
// `author` narrows to one person, and stacks with `q` rather than replacing
// it: "what did Sowmya leave me about gas" is the question a board with three
// people on it actually gets asked. Filtered here for the same reason the
// search is — the browser only holds the newest PAGE_SIZE notes, so filtering
// that window would confidently report that someone had written nothing.
function listNotes({ q, author } = {}) {
  const term = typeof q === 'string' ? q.trim() : '';
  const who = clean(author, MAX_AUTHOR);
  const clauses = [];
  const filter = [];
  if (term) {
    // ifnull, because a note posted before anyone picked a name has a NULL
    // author, and NULL LIKE anything is NULL — which would drop those notes
    // from every search rather than just failing to match on their author.
    clauses.push(
      `(body LIKE ? ESCAPE '\\' OR ifnull(author, '') LIKE ? ESCAPE '\\' OR ifnull(assigned_to, '') LIKE ? ESCAPE '\\')`,
    );
    filter.push(likePattern(term), likePattern(term), likePattern(term));
  }
  if (who) {
    // Whole name, not a substring: this is a chip picked off the roster, so
    // filtering to "Adarsh" must not also drag in "Adarshini". lower() on both
    // sides because the name is retyped by hand on every device — the same
    // person is "adarsh" on the phone and "Adarsh" on the tablet, and the
    // roster below would list those as two people if they ever diverged.
    // Or assigned to them: the chip answers "what is mine", and a note handed
    // to Sowmya is hers whoever typed it.
    clauses.push(`(lower(ifnull(author, '')) = lower(?) OR lower(ifnull(assigned_to, '')) = lower(?))`);
    filter.push(who, who);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM (
       SELECT note_id, author, body, created_at, done, done_at, done_by, assigned_to FROM shared_note
        ${where}
        ORDER BY note_id DESC LIMIT ?
     ) ORDER BY note_id ASC`,
    ...filter,
    PAGE_SIZE,
  );
  // Deliberately over the whole table, not the search: the panel's summary is
  // the state of the board, and it should not appear to empty out because
  // someone typed in the search box.
  const counts = all('SELECT count(*) AS n, sum(done) AS done FROM shared_note')[0];
  const total = counts.n;
  // How many the search actually found, which may be more than fits in one
  // window. Without a search this is just the total.
  const matched = where ? all(`SELECT count(*) AS n FROM shared_note ${where}`, ...filter)[0].n : total;
  return {
    notes: rows.map(toNote),
    total,
    query: term,
    // The name being filtered on, echoed back the way the search term is, so
    // the panel marks the chip the rows on screen actually answer to rather
    // than the one tapped a request ago.
    author: who || '',
    matched,
    // Over the whole table, not over the window, so "3 of 12 done" stays true
    // when the panel is only showing the most recent 200. sum() of an empty
    // table is NULL rather than 0.
    done: counts.done || 0,
    open: total - (counts.done || 0),
    // True when the panel is looking at a window rather than the whole thing,
    // so it can say so at the top of the scroll instead of the oldest note
    // just appearing to be the first one ever written. Against the match count
    // rather than the total, so a search that found eleven things does not
    // claim to be hiding some of them.
    truncated: matched > rows.length,
    // Every name that has posted, newest first, for the "posting as" picker.
    // Not filtered by the search: it is the roster for the composer, which is
    // still there and still needs every name while you are searching.
    // Derived rather than configured: there is no roster anywhere in this app
    // — Daily View builds its assignee list the same way, off the schedule —
    // so the list of people is whoever has actually written something.
    authors: all(
      `SELECT author FROM shared_note
        WHERE author IS NOT NULL AND trim(author) <> ''
        GROUP BY author ORDER BY max(note_id) DESC LIMIT 20`,
    ).map((row) => row.author),
    fetchedAt: new Date().toISOString(),
  };
}

// Posts one note. The author is whatever the browser claims — see the note on
// the column in schema.sql — and is optional; the body is not.
function addNote({ body, author } = {}) {
  const text = clean(body, MAX_BODY);
  if (!text) throw bad('A note needs something in it.');
  const result = insert('shared_note', {
    author: clean(author, MAX_AUTHOR),
    body: text,
    // Written here rather than left to the column default: datetime('now')
    // stores "2026-09-08 07:14:22", which Date() in Safari refuses outright
    // and other browsers read as local time. A full ISO-8601 UTC string is
    // the one spelling every client agrees on.
    created_at: new Date().toISOString(),
  });
  // node:sqlite reports lastInsertRowid as a BigInt or a number depending on
  // magnitude; Number() makes it one thing before it reaches JSON, which
  // cannot serialize a BigInt at all.
  const noteId = Number(result.lastInsertRowid);
  return toNote(select('shared_note', { note_id: noteId })[0]);
}

// Ticks or unticks one. The whole point of a shared board is that the tick is
// shared too — one person marking the gas ordered has to be visible to the
// other before they go and order it again — so this is a write to the table
// and not a flag in a browser.
//
// Idempotent: ticking an already-ticked note keeps the original doneAt rather
// than moving it, because the useful timestamp is when the work happened, not
// when someone last tapped the box.
function setNoteDone({ id, done, by } = {}) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) throw bad('A note id is required.');
  if (typeof done !== 'boolean') throw bad('done must be true or false.');
  const existing = select('shared_note', { note_id: noteId })[0];
  if (!existing) {
    const err = new Error('That note no longer exists.');
    err.status = 404;
    throw err;
  }
  if (!!existing.done === done) return toNote(existing);
  update('shared_note', { note_id: noteId }, {
    done: done ? 1 : 0,
    // Unticking clears both, so a note put back on the list does not still
    // claim someone finished it.
    done_at: done ? new Date().toISOString() : null,
    done_by: done ? clean(by, MAX_AUTHOR) : null,
  });
  return toNote(select('shared_note', { note_id: noteId })[0]);
}

// Hands a note to someone, or back to nobody with a blank name. A column
// update rather than a rewrite, like the tick — the body is still never
// edited, so two devices cannot clobber each other's text.
function assignNote({ id, assignedTo } = {}) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) throw bad('A note id is required.');
  if (assignedTo !== undefined && assignedTo !== null && typeof assignedTo !== 'string') {
    throw bad('assignedTo must be a name.');
  }
  const existing = select('shared_note', { note_id: noteId })[0];
  if (!existing) {
    const err = new Error('That note no longer exists.');
    err.status = 404;
    throw err;
  }
  update('shared_note', { note_id: noteId }, { assigned_to: clean(assignedTo, MAX_AUTHOR) });
  return toNote(select('shared_note', { note_id: noteId })[0]);
}

// Deletes one. A note that is already gone is not an error worth surfacing —
// two devices tapping the same ✕ within a second of each other is an ordinary
// thing to happen, and the second one should see the note gone, which it
// does — so this reports what it found rather than throwing a 404.
function deleteNote({ id } = {}) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) throw bad('A note id is required.');
  const changes = remove('shared_note', { note_id: noteId }, { required: false });
  return { deleted: changes > 0, id: noteId };
}

export { listNotes, addNote, setNoteDone, assignNote, deleteNote, MAX_BODY, MAX_AUTHOR, PAGE_SIZE };
