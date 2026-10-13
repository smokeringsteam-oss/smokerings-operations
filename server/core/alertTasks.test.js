// Push alerts that leave a job also leave a to-do on the note board. The rules
// worth pinning: one open to-do per source, a fresh one once it is ticked, and
// closing by source when the thing was dealt with elsewhere.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createTestDb, removeTestDb } from './testDb.js';

const { dir } = createTestDb();

const { run, all } = await import('./db.js');
const { fileAlertTask, closeAlertTask, openAlertSources } = await import('./alertTasks.js');
const { listNotes } = await import('./sharedNotes.js');

beforeEach(() => {
  run('DELETE FROM shared_note');
});

afterAll(() => removeTestDb(dir));

const now = new Date(2026, 9, 8, 14, 30);

describe('filing an alert as a to-do', () => {
  it('adds an open, unassigned to-do due today', () => {
    const id = fileAlertTask({ source: 'whatsapp:42', body: 'Reply to Priya on WhatsApp', now });
    expect(id).toBeGreaterThan(0);
    const [note] = listNotes().notes;
    expect(note).toMatchObject({
      body: 'Reply to Priya on WhatsApp',
      author: 'Alert',
      assignedTo: '',
      done: false,
      dueDate: '2026-10-08',
    });
  });

  it('adds nothing while a to-do for the same source is still open', () => {
    fileAlertTask({ source: 'whatsapp:42', body: 'first', now });
    expect(fileAlertTask({ source: 'whatsapp:42', body: 'second', now })).toBeNull();
    fileAlertTask({ source: 'whatsapp:7', body: 'other customer', now });
    expect(listNotes().notes.map((note) => note.body)).toEqual(['first', 'other customer']);
  });

  it('starts a fresh one once the earlier one is ticked', () => {
    fileAlertTask({ source: 'delivery:1187', body: 'trip cancelled', now });
    expect(closeAlertTask('delivery:1187', 'Adarsh', now)).toBe(1);
    expect(fileAlertTask({ source: 'delivery:1187', body: 'still not delivered', now })).toBeGreaterThan(0);
    expect(listNotes().notes.filter((note) => !note.done).map((note) => note.body)).toEqual(['still not delivered']);
  });

  it('ignores a blank source or body rather than throwing', () => {
    expect(fileAlertTask({ source: '', body: 'x', now })).toBeNull();
    expect(fileAlertTask({ source: 'whatsapp:1', body: '  ', now })).toBeNull();
    expect(all('SELECT * FROM shared_note')).toHaveLength(0);
  });
});

describe('closing and listing by source', () => {
  it('records who closed it and lists only the open sources for a prefix', () => {
    fileAlertTask({ source: 'whatsapp:1', body: 'a', now });
    fileAlertTask({ source: 'whatsapp:2', body: 'b', now });
    fileAlertTask({ source: 'delivery:9', body: 'c', now });
    closeAlertTask('whatsapp:1', 'WhatsApp reply', now);
    expect(openAlertSources('whatsapp:')).toEqual(['whatsapp:2']);
    const closed = listNotes().notes.find((note) => note.body === 'a');
    expect(closed).toMatchObject({ done: true, doneBy: 'WhatsApp reply' });
  });
});
