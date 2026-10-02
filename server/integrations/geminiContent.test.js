// The only part of the Gemini layer that can be tested without a key: the
// repair that rescues a bill read Gemini stopped partway through. It is
// worth pinning down because its failure mode is silent — a bad repair
// hands the pitmaster a cart of numbers that were never on the paper.
import { describe, it, expect } from 'vitest';
import {
  baseAudioMimeType,
  normaliseNoteReading,
  normaliseTaskPlacement,
  repairTruncatedJSON,
} from './geminiContent.js';

describe('normaliseNoteReading', () => {
  it('keeps flags and the kitchen line on a note that asked for no time', () => {
    const reading = normaliseNoteReading({
      orderId: '7',
      hasPreference: false,
      kind: 'other',
      urgencyFlags: ['Birthday lunch', '  ', 42],
      kitchenInstructions: ' No onions; sauces separate ',
    });
    expect(reading).toMatchObject({
      hasPreference: false,
      label: '',
      urgencyFlags: ['Birthday lunch'],
      kitchenInstructions: 'No onions; sauces separate',
    });
  });

  it('drops a timing read with nothing to show, and an unknown kind', () => {
    expect(normaliseNoteReading({ hasPreference: true, kind: 'soon', label: '', quote: '' })).toMatchObject({
      hasPreference: false,
      kind: 'other',
    });
    expect(
      normaliseNoteReading({ hasPreference: true, kind: 'by', label: 'By 1 PM', preferredTime: '1pm' }),
    ).toMatchObject({ hasPreference: true, kind: 'by', preferredTime: '', urgencyFlags: [] });
  });

  it('caps the flags at three', () => {
    expect(normaliseNoteReading({ urgencyFlags: ['a', 'b', 'c', 'd'] }).urgencyFlags).toEqual(['a', 'b', 'c']);
  });
});

const BILL = {
  vendorName: 'Venkateshwara Pork',
  purchaseDate: '2026-09-01',
  notes: '',
  lines: [
    { itemName: 'Pork Belly B/L', materialId: 'RM001', quantity: 5, unitPrice: 420, lineTotal: 2100, unit: 'kg' },
    { itemName: 'Amul Butter 500g', materialId: '', quantity: 2, unitPrice: 265, lineTotal: 530, unit: 'pcs' },
    { itemName: 'Charcoal 10kg', materialId: 'RM014', quantity: 1, unitPrice: 800, lineTotal: 800, unit: 'bag' },
  ],
};

describe('repairTruncatedJSON', () => {
  it('leaves whole JSON exactly as it was', () => {
    expect(repairTruncatedJSON(JSON.stringify(BILL))).toEqual(BILL);
  });

  it('keeps the lines that made it and drops the half-written one', () => {
    const full = JSON.stringify(BILL);
    const cut = full.indexOf('Charcoal') + 4;
    const repaired = repairTruncatedJSON(full.slice(0, cut));
    expect(repaired.lines).toEqual([BILL.lines[0], BILL.lines[1]]);
    expect(repaired.vendorName).toBe('Venkateshwara Pork');
  });

  // The dangerous outcome is not a dropped line but an invented one, so every
  // cut point gets checked: whatever survives must match the bill line for
  // line, and anything unsalvageable must say so rather than guess.
  it('never invents or corrupts a line, at any cut point', () => {
    const full = JSON.stringify(BILL);
    for (let cut = 1; cut < full.length; cut += 1) {
      const repaired = repairTruncatedJSON(full.slice(0, cut));
      if (repaired === null) continue;
      const lines = repaired.lines ?? [];
      expect(lines).toEqual(BILL.lines.slice(0, lines.length));
      if (repaired.vendorName) expect(repaired.vendorName).toBe(BILL.vendorName);
    }
  });

  it('survives a cut inside an escaped string', () => {
    const text = '{"notes":"total says \\"1250\\" but adds to 1240","lines":[{"itemName":"Ribs","quantity":3},{"itemNa';
    expect(repairTruncatedJSON(text)).toEqual({
      notes: 'total says "1250" but adds to 1240',
      lines: [{ itemName: 'Ribs', quantity: 3 }],
    });
  });

  it('returns null when the cut landed before anything closed', () => {
    expect(repairTruncatedJSON('{"vendorName":"Sri Ven')).toBeNull();
    expect(repairTruncatedJSON('')).toBeNull();
  });
});

// The other testable half of this file: what a suggestion is allowed to say.
//
// Worth pinning down because the consequence is not cosmetic. The sprint
// board's add form hands this straight to createSubIssueTask, which files a
// real GitHub issue under whatever parent comes back — so an epic the model
// invented, or one it half-remembered from another board, would put a task
// somewhere nobody is looking and take a manual edit on github.com to undo.
describe('normaliseTaskPlacement', () => {
  const EPICS = [
    { number: 1, title: 'Kitchen Ops' },
    { number: 4, title: 'Marketing' },
    { number: 54, title: 'Ops Dashboard' },
  ];
  const ASSIGNEES = ['adarsh', 'sowmya'];
  const STATUSES = ['Backlog', 'In Progress', 'Done'];
  const lists = { epics: EPICS, assignees: ASSIGNEES, statuses: STATUSES };

  it('passes through a suggestion that only names things it was offered', () => {
    expect(
      normaliseTaskPlacement(
        { parentNumber: 4, status: 'Backlog', assignee: 'sowmya', reason: 'reel captions' },
        lists,
      ),
    ).toEqual({
      parentNumber: 4,
      parentTitle: 'Marketing',
      status: 'Backlog',
      assignee: 'sowmya',
      reason: 'reel captions',
    });
  });

  it('drops an epic that was never on the board', () => {
    // The one that would file a real issue in the wrong place.
    const placement = normaliseTaskPlacement({ parentNumber: 99, reason: 'made it up' }, lists);
    expect(placement.parentNumber).toBeNull();
    expect(placement.parentTitle).toBe('');
  });

  it('drops a person and a status it was not offered', () => {
    const placement = normaliseTaskPlacement(
      { parentNumber: 1, status: 'Blocked', assignee: 'someone-else' },
      lists,
    );
    // The epic still stands — one bad field does not throw the rest away,
    // since the form is going to show all three either way.
    expect(placement).toMatchObject({ parentNumber: 1, status: '', assignee: '' });
  });

  it('reads a number that came back as a string', () => {
    // The schema asks for an integer but enum values go over the wire as
    // strings, and which one arrives has changed between model versions.
    expect(normaliseTaskPlacement({ parentNumber: '54' }, lists).parentTitle).toBe('Ops Dashboard');
  });

  it('survives an empty, malformed or missing answer', () => {
    const empty = { parentNumber: null, parentTitle: '', status: '', assignee: '', reason: '' };
    expect(normaliseTaskPlacement({}, lists)).toEqual(empty);
    expect(normaliseTaskPlacement(null, lists)).toEqual(empty);
    expect(normaliseTaskPlacement({ parentNumber: 1 }, {})).toEqual(empty);
  });

  it('trims a reason that ran long rather than letting it fill the form', () => {
    const placement = normaliseTaskPlacement({ parentNumber: 1, reason: 'x'.repeat(400) }, lists);
    expect(placement.reason).toHaveLength(160);
  });

  it('ignores a reason that is not text at all', () => {
    expect(normaliseTaskPlacement({ parentNumber: 1, reason: { text: 'no' } }, lists).reason).toBe('');
  });
});

describe('baseAudioMimeType', () => {
  it('drops the codec MediaRecorder appends', () => {
    expect(baseAudioMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseAudioMimeType('audio/mp4')).toBe('audio/mp4');
  });
  it('treats a video-typed audio clip as audio and an unknown type as webm', () => {
    expect(baseAudioMimeType('video/webm')).toBe('audio/webm');
    expect(baseAudioMimeType('')).toBe('audio/webm');
    expect(baseAudioMimeType('application/octet-stream')).toBe('audio/webm');
  });
});
