// AI SEO tracker — "when someone asks an AI assistant where to get BBQ in
// Bengaluru, do we come up, and what did it read to decide?"
//
// This is deliberately NOT classic SEO (keyword rank on a results page). The
// unit of measurement here is a *prompt* — a real question a customer would
// type into ChatGPT/Gemini/Perplexity — and the thing being measured is the
// prose answer that comes back: were we named, how early, alongside which
// competitors, and which URLs did the assistant actually cite to get there.
//
// Two ways a run gets logged:
//   auto   — Gemini with Google Search grounding answers the prompt, and a
//            second (ungrounded, JSON) call scores that answer. Grounding is
//            what makes this a real signal: an ungrounded model would answer
//            from training data, which says nothing about today's web.
//   manual — the same scoring pass over an answer pasted in by hand, for
//            ChatGPT/Perplexity/Copilot where there's no API key here.
// Both land in the same aiseo_runs.csv, tagged with which engine produced
// them, so the history is comparable across engines.
//
// Storage is the knowledge-base repo's Data folder (see knowledgeBase.js),
// same as vendors/inventory/weekend status. Both files are created on first
// use, so a fresh checkout doesn't need them committed ahead of time.
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { readCsvFile, writeCsvFile, appendCsvRows, nextSequentialId } from '../core/csvStore.js';
import { getDataDir } from '../core/knowledgeBase.js';

// Not in knowledgeBase.js's FILES map on purpose: everything listed there
// counts toward getConfig().configured, and a knowledge-base checkout that
// predates this module would start reporting itself as unconfigured to the
// purchasing/smoking screens over two files they don't use.
const PROMPTS_FILE = 'aiseo_prompts.csv';
const RUNS_FILE = 'aiseo_runs.csv';

const PROMPTS_HEADER = ['prompt_id', 'prompt_text', 'intent', 'is_active', 'created_at'];

// prompt_text is denormalized onto the run so the history stays readable —
// both as a standalone CSV and after its prompt row has been deleted.
const RUNS_HEADER = [
  'run_id',
  'prompt_id',
  'prompt_text',
  'engine',
  'source',
  'ran_at',
  'mentioned',
  'position',
  'total_brands',
  'sentiment',
  'framing',
  'competitors',
  'citation_domains',
  'citation_urls',
  // The one action worth taking off this answer. Written by the same scoring
  // pass that reads the answer, because the useful advice is specific to what
  // that answer said and cited — "get reviewed on the Reddit thread it read"
  // beats any generic checklist a dashboard could hardcode.
  'recommendation',
  'answer_excerpt',
];

// Which assistant produced the answer. Only 'gemini' can be run automatically
// from here; the rest are paste-in, and are listed so the history can be
// filtered per engine rather than lumping every manual entry together.
const ENGINES = ['gemini', 'chatgpt', 'perplexity', 'copilot', 'claude', 'other'];

// Semicolons join list-valued cells (competitors, citations). Commas would
// work — csvStore quotes correctly — but a business name with a comma in it
// would then be ambiguous to anyone opening the file in Excel.
const LIST_SEP = ';';

// Who we're looking for in the answer. Aliases matter because assistants
// write the name loosely ("Smoke Rings", "SmokeRings BBQ"); a run that only
// matched the exact registered name would under-report visibility.
const BRAND = {
  name: process.env.AISEO_BRAND_NAME || 'Smoke Rings BBQ',
  aliases: (process.env.AISEO_BRAND_ALIASES || 'Smoke Rings;SmokeRings BBQ;SmokeRings')
    .split(LIST_SEP)
    .map((s) => s.trim())
    .filter(Boolean),
  city: process.env.AISEO_BRAND_CITY || 'Bengaluru',
  // Used only to tag a cited source as "ours" vs earned third-party coverage
  // in the citation leaderboard. Blank is fine — everything just reads as
  // third-party then.
  site: (process.env.AISEO_BRAND_SITE || '').trim(),
};

// Seeded on request from the empty state. Local-intent discovery prompts are
// most of it on purpose: that's where a weekend cloud kitchen either shows up
// in an assistant's shortlist or doesn't.
const STARTER_PROMPTS = [
  { text: `Best BBQ in ${BRAND.city}?`, intent: 'discovery' },
  { text: `Where can I get authentic slow-smoked brisket in ${BRAND.city}?`, intent: 'discovery' },
  { text: `Who does the best pulled pork in ${BRAND.city}?`, intent: 'discovery' },
  { text: `Best smoked chicken delivery in ${BRAND.city}`, intent: 'discovery' },
  { text: `I want to preorder BBQ for a house party in ${BRAND.city} this weekend. What are my options?`, intent: 'preorder' },
  { text: `Cloud kitchens in ${BRAND.city} doing wood-fired American BBQ`, intent: 'discovery' },
  { text: `Is ${BRAND.name} any good? What do they serve?`, intent: 'brand' },
  { text: `${BRAND.name} menu and prices`, intent: 'brand' },
  { text: `Best burnt ends in ${BRAND.city}`, intent: 'discovery' },
  { text: `Which BBQ places in ${BRAND.city} are open only on weekends?`, intent: 'discovery' },
  { text: `BBQ catering for a corporate event in ${BRAND.city}`, intent: 'b2b' },
  { text: `Compare the top BBQ restaurants in ${BRAND.city}`, intent: 'comparison' },
];

const MODEL = process.env.AISEO_MODEL || process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-lite-latest';

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function requireClient() {
  const ai = getClient();
  if (!ai) {
    const err = new Error(
      "GEMINI_API_KEY is not configured on the server, so checks can't be run automatically. Paste an answer in manually, or set the key in .env and restart.",
    );
    err.status = 503;
    throw err;
  }
  return ai;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The SDK throws with the raw API error JSON as the message, which reaches the
// dashboard as an unreadable blob. This unwraps it and — for the two failures
// that actually happen here — says what to do about it.
//
// The 429 is the one worth calling out: Google Search grounding bills against
// its own quota, separate from plain generation, and a free-tier key can be
// refused grounded requests while ungrounded ones on the same model still
// work. Left as a bare "quota exceeded" that reads like the key is dead.
function translateGeminiError(err, what) {
  const raw = String(err?.message || err);
  let code = err?.status;
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    code = parsed?.error?.code || code;
    message = parsed?.error?.message || raw;
  } catch {
    // Not JSON — the SDK's own message is as good as it gets.
  }

  const wrapped = new Error(message);
  if (code === 429) {
    wrapped.message = what.grounded
      ? 'Gemini refused the search-grounded request: quota exceeded. Google Search grounding has its own daily free-tier allowance, separate from ordinary generation — so this can fail while everything else still works. Wait for the reset, enable billing on the key, or log answers manually in the meantime.'
      : 'Gemini quota exceeded. Wait for the daily reset or enable billing on the key.';
    wrapped.status = 429;
  } else if (code === 503) {
    wrapped.message = 'Gemini is busy right now (the model is over capacity). Try the check again in a minute.';
    wrapped.status = 503;
  } else {
    wrapped.status = code && code >= 400 && code < 600 ? code : 502;
  }
  return wrapped;
}

function ensureFile(fileName, header) {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    const err = new Error(
      `Can't find the knowledge-base Data folder at ${dir}. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env if that repo lives somewhere else.`,
    );
    err.status = 503;
    throw err;
  }
  const p = path.join(dir, fileName);
  if (!fs.existsSync(p)) fs.writeFileSync(p, `${header.join(',')}\r\n`, 'utf8');
  return p;
}

function loadPrompts() {
  const p = ensureFile(PROMPTS_FILE, PROMPTS_HEADER);
  const { header, rows } = readCsvFile(p);
  return { path: p, header: header.length ? header : PROMPTS_HEADER, rows };
}

// A runs file written before a column existed (recommendation was added after
// the first release) would otherwise keep appending rows in the old shape,
// silently dropping the new field on every write. Missing columns are added
// once, on read, and existing rows just carry a blank there.
function loadRuns() {
  const p = ensureFile(RUNS_FILE, RUNS_HEADER);
  const { header, rows } = readCsvFile(p);
  const onDisk = header.length ? header : RUNS_HEADER;
  const missing = RUNS_HEADER.filter((column) => !onDisk.includes(column));
  if (!missing.length) return { path: p, header: onDisk, rows };

  // RUNS_HEADER order, plus any column a human added to the file by hand —
  // dropping those would lose data the CSV's owner put there on purpose.
  const merged = [...RUNS_HEADER, ...onDisk.filter((column) => !RUNS_HEADER.includes(column))];
  writeCsvFile(p, merged, rows);
  return { path: p, header: merged, rows };
}

const splitList = (value) =>
  String(value || '')
    .split(LIST_SEP)
    .map((s) => s.trim())
    .filter(Boolean);

function toPrompt(row) {
  return {
    id: row.prompt_id,
    text: row.prompt_text || '',
    intent: row.intent || '',
    // Anything but an explicit "no" is active — a hand-edited row that left
    // the column blank should still get checked.
    isActive: String(row.is_active || '').toLowerCase() !== 'no',
    createdAt: row.created_at || '',
  };
}

function toRun(row) {
  const position = Number(row.position);
  const totalBrands = Number(row.total_brands);
  return {
    id: row.run_id,
    promptId: row.prompt_id,
    promptText: row.prompt_text || '',
    engine: row.engine || 'other',
    source: row.source || 'manual',
    ranAt: row.ran_at || '',
    mentioned: String(row.mentioned || '').toLowerCase() === 'yes',
    position: Number.isFinite(position) && position > 0 ? position : null,
    totalBrands: Number.isFinite(totalBrands) && totalBrands > 0 ? totalBrands : null,
    sentiment: row.sentiment || 'not_mentioned',
    framing: row.framing || '',
    competitors: splitList(row.competitors),
    citationDomains: splitList(row.citation_domains),
    citationUrls: splitList(row.citation_urls),
    recommendation: row.recommendation || '',
    answerExcerpt: row.answer_excerpt || '',
  };
}

function getStatus() {
  const dir = getDataDir();
  return {
    dataDir: dir,
    dataDirPresent: fs.existsSync(dir),
    promptsFile: PROMPTS_FILE,
    runsFile: RUNS_FILE,
    // Drives the UI's "auto-run available?" state — without a key the page
    // still works, just paste-in only.
    autoRunAvailable: Boolean(process.env.GEMINI_API_KEY),
    model: MODEL,
    brand: BRAND,
    engines: ENGINES,
  };
}

function listPrompts() {
  const { rows } = loadPrompts();
  return { prompts: rows.map(toPrompt) };
}

function addPrompt({ text, intent }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw badRequest('A prompt needs some text — the question a customer would actually ask.');

  const { path: file, header, rows } = loadPrompts();
  const duplicate = rows.find((r) => (r.prompt_text || '').trim().toLowerCase() === trimmed.toLowerCase());
  if (duplicate) throw badRequest('That prompt is already being tracked.');

  const row = {
    prompt_id: nextSequentialId(rows, 'prompt_id', 'SEOP'),
    prompt_text: trimmed,
    intent: String(intent || '').trim(),
    is_active: 'yes',
    created_at: new Date().toISOString(),
  };
  appendCsvRows(file, header, [row]);
  return { prompt: toPrompt(row) };
}

function seedPrompts() {
  const { path: file, header, rows } = loadPrompts();
  const existing = new Set(rows.map((r) => (r.prompt_text || '').trim().toLowerCase()));

  // Re-seeding an already-seeded file adds nothing rather than duplicating,
  // so the button is safe to press twice.
  const fresh = STARTER_PROMPTS.filter((p) => !existing.has(p.text.toLowerCase()));
  const working = [...rows];
  const newRows = fresh.map((p) => {
    const row = {
      prompt_id: nextSequentialId(working, 'prompt_id', 'SEOP'),
      prompt_text: p.text,
      intent: p.intent,
      is_active: 'yes',
      created_at: new Date().toISOString(),
    };
    working.push(row);
    return row;
  });

  if (newRows.length) appendCsvRows(file, header, newRows);
  return { added: newRows.length, prompts: working.map(toPrompt) };
}

function updatePrompt({ id, text, intent, isActive }) {
  const { path: file, header, rows } = loadPrompts();
  const row = rows.find((r) => r.prompt_id === id);
  if (!row) {
    const err = new Error(`No tracked prompt with id ${id}.`);
    err.status = 404;
    throw err;
  }

  if (text !== undefined) {
    const trimmed = String(text).trim();
    if (!trimmed) throw badRequest('A prompt needs some text.');
    row.prompt_text = trimmed;
  }
  if (intent !== undefined) row.intent = String(intent).trim();
  if (isActive !== undefined) row.is_active = isActive ? 'yes' : 'no';

  writeCsvFile(file, header, rows);
  return { prompt: toPrompt(row) };
}

// Past runs are deliberately left behind: they carry their own prompt_text,
// so the history stays honest about what was asked even after the prompt
// stops being tracked.
function deletePrompt({ id }) {
  const { path: file, header, rows } = loadPrompts();
  const remaining = rows.filter((r) => r.prompt_id !== id);
  if (remaining.length === rows.length) {
    const err = new Error(`No tracked prompt with id ${id}.`);
    err.status = 404;
    throw err;
  }
  writeCsvFile(file, header, remaining);
  return { deleted: id };
}

function listRuns({ days } = {}) {
  const { rows } = loadRuns();
  const runs = rows.map(toRun);
  const window = Number(days);
  if (!Number.isFinite(window) || window <= 0) return { runs };

  const cutoff = Date.now() - window * 24 * 60 * 60 * 1000;
  return {
    // A row with an unparseable ran_at is kept rather than silently dropped —
    // losing a hand-edited run from the window would understate visibility.
    runs: runs.filter((r) => {
      const t = Date.parse(r.ranAt);
      return Number.isNaN(t) ? true : t >= cutoff;
    }),
  };
}

function deleteRun({ id }) {
  const { path: file, header, rows } = loadRuns();
  const remaining = rows.filter((r) => r.run_id !== id);
  if (remaining.length === rows.length) {
    const err = new Error(`No run with id ${id}.`);
    err.status = 404;
    throw err;
  }
  writeCsvFile(file, header, remaining);
  return { deleted: id };
}

const ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    mentioned: {
      type: Type.BOOLEAN,
      description: 'True only if the brand (or one of its aliases) is named in the answer.',
    },
    position: {
      type: Type.INTEGER,
      description:
        'Where the brand appears in the order businesses are named, 1 = named first. 0 if not mentioned at all.',
    },
    totalBrands: {
      type: Type.INTEGER,
      description: 'How many distinct businesses/restaurants the answer names in total.',
    },
    sentiment: {
      type: Type.STRING,
      description: 'How the brand is framed: positive, neutral, negative, or not_mentioned.',
    },
    framing: {
      type: Type.STRING,
      description:
        'One short sentence on how the answer characterised the brand, or — if absent — what it recommended instead.',
    },
    competitors: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Every other business/restaurant named in the answer, in the order they appear.',
    },
    recommendation: {
      type: Type.STRING,
      description:
        'The single most useful thing the business could do to show up better next time this question is asked — one specific action, under 25 words.',
    },
  },
  required: ['mentioned', 'position', 'totalBrands', 'sentiment', 'framing', 'competitors', 'recommendation'],
};

const SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'not_mentioned']);

// Every Gemini call goes through here, so a raw API error blob never reaches
// the dashboard.
async function generate(ai, request, what) {
  try {
    return await ai.models.generateContent(request);
  } catch (err) {
    throw translateGeminiError(err, what);
  }
}

// The grounded answer and the scoring pass are separate calls by necessity:
// Gemini rejects a responseSchema on a request that also enables the search
// tool. That split is useful anyway — manual paste-ins reuse this half
// verbatim, so an auto run and a hand-logged one are scored identically.
async function analyzeAnswer({ promptText, answerText, citationDomains = [] }) {
  const ai = requireClient();
  const aliasList = [BRAND.name, ...BRAND.aliases].join(', ');

  // The cited sources are what makes the recommendation actionable rather than
  // generic — they name the specific pages the answer was built from, which
  // are the pages worth influencing. Omitted entirely when there are none, so
  // the model isn't handed an empty list to read meaning into.
  const sourcesLine = citationDomains.length
    ? `\n\nSOURCES THE ASSISTANT CITED:\n${[...new Set(citationDomains)].join(', ')}`
    : '';

  const response = await generate(
    ai,
    {
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `QUESTION ASKED OF AN AI ASSISTANT:\n${promptText}\n\nTHE ASSISTANT'S ANSWER:\n${answerText}${sourcesLine}\n\nScore this answer for the brand "${BRAND.name}" (also written as: ${aliasList}), a ${BRAND.city} business.`,
            },
          ],
        },
      ],
      config: {
      systemInstruction: `You score AI assistant answers for brand visibility. You are given a question and the answer an assistant gave, and you report only what is actually in that answer — never your own knowledge of the businesses involved, and never a guess about what the assistant meant to say.

Rules:
- "mentioned" is true only if the brand or one of its listed aliases actually appears in the answer text.
- "position" counts the order businesses are named in: the first business named is 1. Use 0 when the brand is not mentioned.
- "competitors" lists every OTHER business named — real named businesses only, not categories ("local cloud kitchens") and not dish names.
- If the answer names no businesses at all, totalBrands is 0 and competitors is empty.
- "sentiment" describes how the brand specifically is framed, not the overall tone of the answer. Use not_mentioned when the brand is absent.

"recommendation" is the exception to reporting only: it is your advice, and it is the most valuable field here. Name ONE specific, doable action, under 25 words, that would make this exact answer come out better next time. Ground it in the evidence in front of you:
- Prefer the sources the answer actually cited. If it leaned on a Reddit thread, a directory or a listicle, say which one and what to do about it (get listed, get reviewed, answer the thread, correct a stale detail).
- If a competitor was named first, say what that answer credited them with that we would need to be credited with too.
- If the answer named no businesses at all, or dodged the question, say what kind of page would have let it answer.
- If we were named and framed well, say what would move us earlier in the list — not "keep it up".
- Best of all: if the answer states WHY businesses like ours were left out or hard to recommend ("most small kitchens don't publish their preorder terms", "hours aren't listed anywhere"), the action is to fix exactly that. Read the answer for that sentence before falling back to anything else.
Two hard rules. A competitor's own website or booking page is never somewhere to get listed — only genuine directories, review sites, forums and publications count. And never give generic marketing advice ("improve SEO", "post more on social media", "engage customers"). If nothing specific is supportable from this answer, say plainly what is missing instead of inventing an action.`,
        // Gemini's thinking tokens count against maxOutputTokens, so this needs
        // headroom well above the small JSON payload or generation gets cut off.
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
      },
    },
    { grounded: false },
  );

  let parsed;
  try {
    parsed = JSON.parse(response.text || '{}');
  } catch {
    const err = new Error('Gemini did not return a structured score for that answer. Try again.');
    err.status = 502;
    throw err;
  }

  const mentioned = Boolean(parsed.mentioned);
  const position = Number(parsed.position);
  const totalBrands = Number(parsed.totalBrands);
  const sentiment = String(parsed.sentiment || '').toLowerCase();

  return {
    mentioned,
    // A model that says "mentioned: false, position: 3" is contradicting
    // itself; the mention flag wins and the rank is dropped.
    position: mentioned && Number.isFinite(position) && position > 0 ? Math.round(position) : null,
    totalBrands: Number.isFinite(totalBrands) && totalBrands >= 0 ? Math.round(totalBrands) : null,
    sentiment: SENTIMENTS.has(sentiment) ? sentiment : mentioned ? 'neutral' : 'not_mentioned',
    framing: String(parsed.framing || '').trim(),
    competitors: Array.isArray(parsed.competitors)
      ? parsed.competitors
          .map((c) => String(c).trim())
          .filter(Boolean)
          .slice(0, 25)
      : [],
    recommendation: String(parsed.recommendation || '').trim(),
  };
}

// Grounding chunks come back with a Google redirect URI, not the publisher's
// URL — the readable domain is in `title` ("reddit.com"), so that's what the
// citation leaderboard groups on, with a parse of the URI as the fallback.
function domainFromChunk(chunk) {
  const title = String(chunk?.web?.title || '').trim();
  if (title && !title.includes(' ')) return title.replace(/^www\./, '').toLowerCase();
  try {
    return new URL(chunk?.web?.uri || '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return title.toLowerCase() || 'unknown';
  }
}

function extractCitations(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const domains = [];
  const urls = [];
  chunks.forEach((chunk) => {
    const uri = String(chunk?.web?.uri || '').trim();
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    domains.push(domainFromChunk(chunk));
    urls.push(uri);
  });
  return { domains, urls };
}

// Asks the prompt the way a customer would and captures what the assistant
// read to answer it. Search grounding is the whole point: without it the
// answer reflects training data, not the live web the brand can influence.
async function askGrounded({ promptText }) {
  const ai = requireClient();
  const response = await generate(
    ai,
    {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: {
        // No persona and no mention of the brand — the moment the prompt hints
        // at who's asking, the answer stops being the one a customer would get.
        maxOutputTokens: 4000,
        tools: [{ googleSearch: {} }],
      },
    },
    { grounded: true },
  );

  const answer = (response.text || '').trim();
  if (!answer) {
    const err = new Error(
      `Gemini returned an empty answer for that prompt (finish reason: ${
        response?.candidates?.[0]?.finishReason || 'unknown'
      }). Try again.`,
    );
    err.status = 502;
    throw err;
  }
  return { answer, ...extractCitations(response) };
}

// Long answers are truncated on the way to disk: the excerpt exists to make a
// row readable when scanning history, not to archive the full response, and
// keeping whole answers would bloat a CSV meant to be opened in Excel.
const EXCERPT_LIMIT = 1200;
const excerpt = (text) => (text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…` : text);

function saveRun({ promptId, promptText, engine, source, analysis, citations }) {
  const { path: file, header, rows } = loadRuns();
  const row = {
    run_id: nextSequentialId(rows, 'run_id', 'SEOR'),
    prompt_id: promptId || '',
    prompt_text: promptText,
    engine,
    source,
    ran_at: new Date().toISOString(),
    mentioned: analysis.mentioned ? 'yes' : 'no',
    position: analysis.position == null ? '' : String(analysis.position),
    total_brands: analysis.totalBrands == null ? '' : String(analysis.totalBrands),
    sentiment: analysis.sentiment,
    framing: analysis.framing,
    competitors: analysis.competitors.join(LIST_SEP),
    citation_domains: (citations?.domains || []).join(LIST_SEP),
    citation_urls: (citations?.urls || []).join(LIST_SEP),
    recommendation: analysis.recommendation,
    answer_excerpt: excerpt(analysis.answerText || ''),
  };
  appendCsvRows(file, header, [row]);
  return toRun(row);
}

// Resolves the prompt text to actually ask: a tracked prompt by id, or ad-hoc
// text for a one-off check that isn't in the list.
function resolvePromptText({ promptId, promptText }) {
  if (promptId) {
    const { rows } = loadPrompts();
    const row = rows.find((r) => r.prompt_id === promptId);
    if (!row) {
      const err = new Error(`No tracked prompt with id ${promptId}.`);
      err.status = 404;
      throw err;
    }
    return row.prompt_text;
  }
  const trimmed = String(promptText || '').trim();
  if (!trimmed) throw badRequest('Give a promptId or some promptText to check.');
  return trimmed;
}

// One prompt per call rather than a batch: each check is two Gemini round
// trips, and the dashboard walks its list one at a time so progress shows as
// it goes and a mid-sweep failure costs one prompt instead of the whole run.
async function runCheck({ promptId, promptText }) {
  const text = resolvePromptText({ promptId, promptText });
  const { answer, domains, urls } = await askGrounded({ promptText: text });
  const analysis = await analyzeAnswer({ promptText: text, answerText: answer, citationDomains: domains });
  return {
    run: saveRun({
      promptId,
      promptText: text,
      engine: 'gemini',
      source: 'auto',
      analysis: { ...analysis, answerText: answer },
      citations: { domains, urls },
    }),
    answer,
  };
}

// Scores an answer copied out of an assistant this server can't call.
// Citations have to be pasted separately — ChatGPT and Perplexity render them
// as footnote chips that don't survive a copy — so the field is optional and
// a run logged without them just doesn't contribute to the sources panel.
async function logManualRun({ promptId, promptText, engine, answerText, citationUrls }) {
  const text = resolvePromptText({ promptId, promptText });
  const answer = String(answerText || '').trim();
  if (!answer) throw badRequest('Paste the answer the assistant gave before logging the run.');

  const chosenEngine = String(engine || '').toLowerCase();
  if (!ENGINES.includes(chosenEngine)) {
    throw badRequest(`engine must be one of: ${ENGINES.join(', ')}.`);
  }

  const urls = (Array.isArray(citationUrls) ? citationUrls : String(citationUrls || '').split(/[\s,;]+/))
    .map((u) => String(u).trim())
    .filter(Boolean);
  const domains = urls.map((u) => {
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  });

  const analysis = await analyzeAnswer({ promptText: text, answerText: answer, citationDomains: domains });
  return {
    run: saveRun({
      promptId,
      promptText: text,
      engine: chosenEngine,
      source: 'manual',
      analysis: { ...analysis, answerText: answer },
      citations: { domains, urls },
    }),
  };
}

export {
  getStatus,
  listPrompts,
  addPrompt,
  seedPrompts,
  updatePrompt,
  deletePrompt,
  listRuns,
  deleteRun,
  runCheck,
  logManualRun,
};
