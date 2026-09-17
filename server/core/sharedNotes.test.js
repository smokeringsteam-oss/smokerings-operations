// The shared note bubble's rules, which are few and all about what happens
// when two devices are using it at once.
//
// The ordering tests are the ones worth having. The panel renders the array
// top to bottom and the unread bubble counts ids above a watermark, so both
// depend on note_id being the insertion sequence — and the case that would
// break it silently is two notes posted inside the same second, which is
// exactly what happens when someone taps Send twice.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from './testDb.js';

const { dir } = createTestDb();

const { run } = await import('./db.js');
const { listNotes, addNote, setNoteDone, assignNote, deleteNote, MAX_BODY } = await import('./sharedNotes.js');

beforeEach(() => {
  run('DELETE FROM shared_note');
});

afterAll(() => removeTestDb(dir));

describe('posting a note', () => {
  it('returns the stored note, with the author it was given', () => {
    const note = addNote({ body: 'Brisket price up next week', author: 'Adarsh' });
    expect(note).toMatchObject({ author: 'Adarsh', body: 'Brisket price up next week' });
    expect(note.id).toBeGreaterThan(0);
    // A full ISO-8601 UTC stamp, not SQLite's space-separated datetime() —
    // the browser has to be able to parse this.
    expect(note.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('refuses a note that is only whitespace', () => {
    expect(() => addNote({ body: '   \n  ', author: 'Adarsh' })).toThrow(/something in it/);
    expect(listNotes().notes).toHaveLength(0);
  });

  it('trims the body and keeps a note with no author at all', () => {
    const note = addNote({ body: '  gas cylinder low  ' });
    expect(note.body).toBe('gas cylinder low');
    // An author is a claim the browser makes, not a requirement — a device
    // that has never picked a name still gets to leave a note.
    expect(note.author).toBe('');
  });

  it('treats an author of pure whitespace as no author, not as spaces', () => {
    expect(addNote({ body: 'x', author: '   ' }).author).toBe('');
  });

  it('caps a pasted wall of text rather than storing it whole', () => {
    const note = addNote({ body: 'x'.repeat(MAX_BODY + 500) });
    expect(note.body).toHaveLength(MAX_BODY);
  });
});

describe('reading the panel', () => {
  it('returns notes oldest first, in the order they were posted', () => {
    addNote({ body: 'first', author: 'Adarsh' });
    addNote({ body: 'second', author: 'Kitchen' });
    addNote({ body: 'third', author: 'Adarsh' });
    expect(listNotes().notes.map((n) => n.body)).toEqual(['first', 'second', 'third']);
  });

  it('gives two notes posted in the same second a definite order', () => {
    // The failure this guards: ordering on created_at instead of note_id.
    // Both rows below carry the same stamp, so a created_at sort would be
    // free to return them either way round and the unread watermark would
    // have nothing monotonic to count against.
    const a = addNote({ body: 'tap one' });
    const b = addNote({ body: 'tap two' });
    run('UPDATE shared_note SET created_at = ?', a.createdAt);
    expect(b.id).toBeGreaterThan(a.id);
    expect(listNotes().notes.map((n) => n.body)).toEqual(['tap one', 'tap two']);
  });

  it('lists the names that have posted, most recent first', () => {
    addNote({ body: 'a', author: 'Adarsh' });
    addNote({ body: 'b', author: 'Kitchen' });
    addNote({ body: 'c', author: 'Adarsh' });
    addNote({ body: 'd' });
    // Adarsh is first because their latest note is the newest of the two, and
    // the anonymous note contributes no name.
    expect(listNotes().authors).toEqual(['Adarsh', 'Kitchen']);
  });

  it('reports the total and says so when the window is not the whole table', () => {
    addNote({ body: 'only one' });
    expect(listNotes()).toMatchObject({ total: 1, truncated: false });
  });
});

describe('searching', () => {
  const seed = () => {
    addNote({ body: 'Order gas cylinder before Friday', author: 'Adarsh' });
    addNote({ body: 'Call the brisket vendor back', author: 'Kitchen tablet' });
    addNote({ body: 'GAS hob needs a service', author: 'Adarsh' });
  };

  it('matches on the note text, ignoring case', () => {
    seed();
    expect(listNotes({ q: 'gas' }).notes.map((n) => n.body)).toEqual([
      'Order gas cylinder before Friday',
      'GAS hob needs a service',
    ]);
  });

  it('matches on who posted it', () => {
    seed();
    expect(listNotes({ q: 'kitchen' }).notes.map((n) => n.body)).toEqual(['Call the brisket vendor back']);
  });

  it('finds a note whose author was never set', () => {
    // A NULL author would make the whole OR NULL rather than false, which
    // would drop every anonymous note out of every search.
    addNote({ body: 'gas cylinder low' });
    expect(listNotes({ q: 'gas' }).notes).toHaveLength(1);
  });

  it('reports how many it found, and leaves the board counts alone', () => {
    seed();
    const found = listNotes({ q: 'gas' });
    // The header summarises the board, not the search — it must not appear to
    // empty out because someone typed in the box.
    expect(found).toMatchObject({ matched: 2, total: 3, open: 3, done: 0, query: 'gas' });
  });

  it('returns nothing, not everything, when nothing matches', () => {
    seed();
    expect(listNotes({ q: 'zzz' })).toMatchObject({ matched: 0, total: 3 });
    expect(listNotes({ q: 'zzz' }).notes).toEqual([]);
  });

  it('treats % and _ as characters to find, not as wildcards', () => {
    addNote({ body: 'Vendor wants 10% more' });
    addNote({ body: 'Plain note' });
    expect(listNotes({ q: '%' }).notes.map((n) => n.body)).toEqual(['Vendor wants 10% more']);
    // A bare underscore matches any single character in LIKE, so unescaped it
    // would return the whole board.
    expect(listNotes({ q: '_' }).matched).toBe(0);
  });

  it('treats a backslash as a character too', () => {
    addNote({ body: 'path is C:\\temp' });
    addNote({ body: 'Plain note' });
    expect(listNotes({ q: '\\' }).matched).toBe(1);
  });

  it('ignores an all-whitespace search rather than matching nothing', () => {
    seed();
    expect(listNotes({ q: '   ' }).notes).toHaveLength(3);
    expect(listNotes({ q: '   ' }).query).toBe('');
  });

  it('keeps the full author list while a search is running', () => {
    seed();
    // The composer's name picker is still on screen and still needs everyone.
    expect(listNotes({ q: 'brisket' }).authors).toEqual(['Adarsh', 'Kitchen tablet']);
  });

  it('carries the done state through', () => {
    seed();
    const gas = listNotes({ q: 'Order gas' }).notes[0];
    setNoteDone({ id: gas.id, done: true, by: 'Adarsh' });
    expect(listNotes({ q: 'Order gas' }).notes[0]).toMatchObject({ done: true, doneBy: 'Adarsh' });
  });
});

describe('filtering by who posted', () => {
  const seed = () => {
    addNote({ body: 'Order gas cylinder before Friday', author: 'Adarsh' });
    addNote({ body: 'Call the brisket vendor back', author: 'Sowmya' });
    addNote({ body: 'gas hob needs a service', author: 'Sowmya' });
    addNote({ body: 'no name here' });
  };

  it('returns only the notes that person posted', () => {
    seed();
    expect(listNotes({ author: 'Sowmya' }).notes.map((n) => n.body)).toEqual([
      'Call the brisket vendor back',
      'gas hob needs a service',
    ]);
  });

  it('matches the whole name, not part of one', () => {
    // The failure this guards: filtering with LIKE the way the search does,
    // which would make picking "Adarsh" off the roster also return everything
    // the second person wrote.
    addNote({ body: 'mine', author: 'Adarsh' });
    addNote({ body: 'theirs', author: 'Adarshini' });
    expect(listNotes({ author: 'Adarsh' }).notes.map((n) => n.body)).toEqual(['mine']);
  });

  it('ignores the case the name was typed in on each device', () => {
    addNote({ body: 'from the tablet', author: 'Adarsh' });
    addNote({ body: 'from the phone', author: 'adarsh' });
    expect(listNotes({ author: 'ADARSH' }).notes).toHaveLength(2);
  });

  it('stacks with the search rather than replacing it', () => {
    seed();
    const found = listNotes({ q: 'gas', author: 'Sowmya' });
    expect(found.notes.map((n) => n.body)).toEqual(['gas hob needs a service']);
    expect(found).toMatchObject({ query: 'gas', author: 'Sowmya', matched: 1 });
  });

  it('leaves the board counts and the roster alone', () => {
    seed();
    const found = listNotes({ author: 'Adarsh' });
    // The header summarises the board and the chips list everyone, so neither
    // may shrink to the filter — otherwise picking a name would hide the chip
    // needed to pick a different one.
    expect(found).toMatchObject({ total: 4, open: 4, done: 0, matched: 1 });
    expect(found.authors).toEqual(['Sowmya', 'Adarsh']);
  });

  it('shows the whole board again for an empty or whitespace name', () => {
    seed();
    expect(listNotes({ author: '' }).notes).toHaveLength(4);
    expect(listNotes({ author: '   ' }).notes).toHaveLength(4);
    expect(listNotes({ author: '   ' }).author).toBe('');
  });

  it('finds nothing for a name nobody posts under', () => {
    seed();
    expect(listNotes({ author: 'Nobody' })).toMatchObject({ matched: 0, total: 4 });
    expect(listNotes({ author: 'Nobody' }).notes).toEqual([]);
  });
});

describe('ticking a note', () => {
  it('starts unticked and records who ticked it', () => {
    const note = addNote({ body: 'Order gas', author: 'Adarsh' });
    expect(note.done).toBe(false);
    const ticked = setNoteDone({ id: note.id, done: true, by: 'Kitchen tablet' });
    expect(ticked).toMatchObject({ id: note.id, done: true, doneBy: 'Kitchen tablet' });
    expect(ticked.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is shared, not per browser — the next read sees the tick', () => {
    const note = addNote({ body: 'Order gas' });
    setNoteDone({ id: note.id, done: true, by: 'Adarsh' });
    expect(listNotes().notes[0]).toMatchObject({ done: true, doneBy: 'Adarsh' });
  });

  it('keeps the original doneAt when ticked twice', () => {
    // The useful timestamp is when the work happened, not when someone last
    // tapped the box — two people tapping it should not move it.
    const note = addNote({ body: 'Order gas' });
    const first = setNoteDone({ id: note.id, done: true, by: 'Adarsh' });
    const again = setNoteDone({ id: note.id, done: true, by: 'Kitchen tablet' });
    expect(again.doneAt).toBe(first.doneAt);
    expect(again.doneBy).toBe('Adarsh');
  });

  it('clears who and when on unticking', () => {
    const note = addNote({ body: 'Order gas' });
    setNoteDone({ id: note.id, done: true, by: 'Adarsh' });
    const back = setNoteDone({ id: note.id, done: false });
    expect(back).toMatchObject({ done: false, doneAt: null, doneBy: '' });
  });

  it('counts done and open over the whole table', () => {
    const a = addNote({ body: 'one' });
    addNote({ body: 'two' });
    addNote({ body: 'three' });
    setNoteDone({ id: a.id, done: true, by: 'Adarsh' });
    expect(listNotes()).toMatchObject({ total: 3, done: 1, open: 2 });
  });

  it('reports no done notes on an empty board rather than null', () => {
    // sum() over no rows is NULL in SQLite, which would reach the panel as
    // "null done" and render as nothing at all.
    expect(listNotes()).toMatchObject({ total: 0, done: 0, open: 0 });
  });

  it('refuses a missing note and a done that is not a boolean', () => {
    const note = addNote({ body: 'Order gas' });
    expect(() => setNoteDone({ id: 999999, done: true })).toThrow(/no longer exists/);
    expect(() => setNoteDone({ id: note.id, done: 'yes' })).toThrow(/true or false/);
    expect(() => setNoteDone({ id: 'abc', done: true })).toThrow(/note id is required/);
  });
});

describe('assigning a note', () => {
  it('starts unassigned and takes a name after posting', () => {
    const note = addNote({ body: 'Create custom payment links', author: 'Sowmya' });
    expect(note.assignedTo).toBe('');
    expect(assignNote({ id: note.id, assignedTo: '  Adarsh ' })).toMatchObject({ assignedTo: 'Adarsh', author: 'Sowmya' });
    expect(listNotes().notes[0].assignedTo).toBe('Adarsh');
  });

  it('can be handed on again, or cleared with a blank name', () => {
    const note = addNote({ body: 'x', author: 'Sowmya' });
    assignNote({ id: note.id, assignedTo: 'Adarsh' });
    expect(assignNote({ id: note.id, assignedTo: 'Naveen' }).assignedTo).toBe('Naveen');
    expect(assignNote({ id: note.id, assignedTo: '   ' }).assignedTo).toBe('');
  });

  it("puts the note under the assignee's chip and in a search for their name", () => {
    const note = addNote({ body: 'Add orders after Thursday', author: 'Sowmya' });
    addNote({ body: 'other', author: 'Sowmya' });
    assignNote({ id: note.id, assignedTo: 'Adarsh' });
    expect(listNotes({ author: 'adarsh' }).notes.map((n) => n.id)).toEqual([note.id]);
    expect(listNotes({ q: 'adarsh' }).notes.map((n) => n.id)).toEqual([note.id]);
    // Still the poster's too.
    expect(listNotes({ author: 'Sowmya' }).notes).toHaveLength(2);
  });

  it('refuses a missing note', () => {
    expect(() => assignNote({ id: 999999, assignedTo: 'Adarsh' })).toThrow(/no longer exists/);
    expect(() => assignNote({ id: 'abc', assignedTo: 'Adarsh' })).toThrow(/note id is required/);
  });
});

describe('deleting a note', () => {
  it('removes it and leaves the rest alone', () => {
    const keep = addNote({ body: 'keep me' });
    const drop = addNote({ body: 'drop me' });
    expect(deleteNote({ id: drop.id })).toEqual({ deleted: true, id: drop.id });
    expect(listNotes().notes.map((n) => n.id)).toEqual([keep.id]);
  });

  it('is not an error when the note is already gone', () => {
    // Two devices tapping the same ✕ within a second of each other. The
    // second one should find the note gone, which is the outcome it wanted.
    const note = addNote({ body: 'once' });
    deleteNote({ id: note.id });
    expect(deleteNote({ id: note.id })).toEqual({ deleted: false, id: note.id });
  });

  it('refuses an id that is not one', () => {
    expect(() => deleteNote({ id: 'abc' })).toThrow(/note id is required/);
    expect(() => deleteNote({})).toThrow(/note id is required/);
  });
});
