// Files every note on the shared board as a GitHub issue, nested under the
// category issue it belongs to in smokeringsteam-oss/knowledge-base.
//
// The board is where a to-do gets typed; the repo is where the backlog is
// actually planned, as sub-issues of a dozen standing category issues. Before
// this, getting a note from one to the other was a copy-paste and a guess at
// the category. Gemini makes the guess, and the note keeps the issue number it
// was filed as, so nothing is filed twice.
//
// Filing runs in the background after a note is posted — a slow or failed
// GitHub call must never hold up, or fail, the post itself. A note that did
// not get filed keeps a NULL github_issue and is picked up by the next run,
// which is every post, plus `npm run notes:file` by hand.
import { GoogleGenAI, Type } from '@google/genai';
import { all, run } from '../core/db.js';
import { placeIssueOnBoard } from './githubProjects.js';

const MODEL = process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-lite-latest';

// The standing category issues. Fixed here rather than read off the repo:
// nothing in GitHub marks an issue as a category rather than a task, and a
// Gemini choice that could land on any open issue would scatter the backlog.
export const CATEGORIES = [
  { number: 1, title: 'Legal, Licensing & Compliance' },
  { number: 2, title: 'Technology & Systems' },
  { number: 3, title: 'Customer / CRM & Retention' },
  { number: 4, title: 'Fulfilment & Delivery Logistics' },
  { number: 5, title: 'Sales & Channels / Distribution' },
  { number: 6, title: 'Marketing & Brand' },
  { number: 7, title: 'Menu, Costing & R&D' },
  { number: 8, title: 'Procurement & Inventory' },
  { number: 9, title: 'Kitchen / Production Operations' },
  { number: 54, title: 'B2B – Orders Making' },
  { number: 96, title: 'Financial planning' },
];

const SYSTEM_PROMPT = `You file to-dos for Smoke Rings BBQ, a barbecue cloud kitchen in Bengaluru (B2C weekend orders, B2B supply to restaurants, a website and ops dashboard built in-house).
For each numbered to-do, pick the ONE category issue it belongs under. Categories:
${CATEGORIES.map((c) => `- ${c.number}: ${c.title}`).join('\n')}
Guidance:
- website, ordering app, dashboard, automation, MCP/AI tooling, software bugs and features -> 2, even when the feature is about orders, payments or delivery
- ads, social media, videos, reviews, Google business profile, marketing channels, business address/listing details -> 6
- WhatsApp customer messages/templates, discount codes, loyalty, repeat customers -> 3
- delivery partners, packing, dispatch, delivery addresses -> 4
- licences, FSSAI, GST registration, contracts -> 1
- finding property or space for the kitchen/store, equipment, kitchen workflow -> 9
- buying wood, meat, supplies -> 8
- new dishes, menu changes, recipe costing -> 7
- expenses, budgets, pricing strategy, unit economics, spreadsheets of spend -> 96
- restaurant/hotel clients, B2B meetings and B2B orders -> 54
- selling through new channels or aggregators -> 5`;

let client = null;
function gemini() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// The category issue number for each note's text, in one Gemini call. One
// call for the lot rather than one per note: the free tier allows a handful
// of requests a minute, which a backlog of thirty notes blows straight through.
// A note Gemini gives no usable answer for comes back as null.
export async function classifyNotes(bodies) {
  if (!bodies.length) return [];
  const ai = gemini();
  if (!ai) throw new Error('GEMINI_API_KEY is not set, so notes cannot be classified.');
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: bodies.map((b, i) => `${i + 1}. ${b}`).join('\n') }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 8000,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.INTEGER, description: 'The to-do number as given.' },
            category: { type: Type.STRING, enum: CATEGORIES.map((c) => String(c.number)) },
          },
          required: ['index', 'category'],
        },
      },
    },
  });
  const picks = new Map();
  for (const row of JSON.parse(response.text || '[]')) {
    const category = Number(row?.category);
    if (CATEGORIES.some((c) => c.number === category)) picks.set(Number(row.index), category);
  }
  return bodies.map((_, i) => picks.get(i + 1) ?? null);
}

async function github(path, { method = 'GET', body } = {}) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO must be set to file notes as issues.');
  }
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`GitHub ${method} ${path} failed (${resp.status}): ${json.message || ''}`);
  return json;
}

// One line, short enough for an issue list. The whole note goes in the body.
function issueTitle(body) {
  const line = body.split('\n')[0].trim();
  return line.length > 100 ? `${line.slice(0, 97)}…` : line;
}

// Files one note: classify, create the issue, nest it under its category, and
// close it straight away if the note is already ticked. The issue number is
// recorded the moment the issue exists, so a failure at the sub-issue step
// cannot lead to a second issue on the retry.
async function fileNote(note, category) {
  const who = note.assigned_to || note.author;
  const issue = await github('/issues', {
    method: 'POST',
    body: {
      title: issueTitle(note.body),
      body: `${note.body}\n\n---\nFrom the shared notes board${who ? ` · ${who}` : ''}`,
    },
  });
  run('UPDATE shared_note SET github_issue = ?, github_category = ? WHERE note_id = ?', issue.number, category, note.note_id);
  await github(`/issues/${category}/sub_issues`, { method: 'POST', body: { sub_issue_id: issue.id } });
  if (note.done) await github(`/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  // Onto the project board, in the sprint for the week the note was posted.
  const { sprint } = await placeIssueOnBoard({ issueNodeId: issue.node_id, at: note.created_at, done: !!note.done });
  return { noteId: note.note_id, issue: issue.number, category, sprint };
}

// Puts every note already filed as an issue onto the board in its week's
// sprint. For notes filed before sprints were set, and to repair one whose
// filing stopped after the issue was created. Repeatable.
export async function placeFiledNotesOnBoard() {
  const results = [];
  const filed = all('SELECT note_id, github_issue, created_at, done FROM shared_note WHERE github_issue IS NOT NULL ORDER BY note_id');
  for (const note of filed) {
    try {
      const issue = await github(`/issues/${note.github_issue}`);
      const { sprint } = await placeIssueOnBoard({ issueNodeId: issue.node_id, at: note.created_at, done: !!note.done });
      results.push({ noteId: note.note_id, issue: note.github_issue, sprint });
    } catch (err) {
      results.push({ noteId: note.note_id, issue: note.github_issue, error: err.message });
    }
  }
  return results;
}

// Every note not yet filed, oldest first. One run at a time: two posts in
// quick succession would otherwise both pick up the same unfiled note.
let running = null;
export function fileUnfiledNotes() {
  if (running) return running.then(() => fileUnfiledNotes());
  running = (async () => {
    const results = [];
    const pending = all(
      'SELECT note_id, author, assigned_to, body, done, created_at FROM shared_note WHERE github_issue IS NULL ORDER BY note_id',
    );
    let categories;
    try {
      categories = await classifyNotes(pending.map((note) => note.body));
    } catch (err) {
      return pending.map((note) => ({ noteId: note.note_id, error: `Classification failed: ${err.message}` }));
    }
    for (const [i, note] of pending.entries()) {
      try {
        if (!categories[i]) throw new Error('Gemini gave no category for this note.');
        results.push(await fileNote(note, categories[i]));
      } catch (err) {
        results.push({ noteId: note.note_id, error: err.message });
      }
    }
    return results;
  })().finally(() => {
    running = null;
  });
  return running;
}
