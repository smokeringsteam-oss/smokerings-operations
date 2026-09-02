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
// Both land in the same aiseo_run table, tagged with which engine produced
// them, so the history is comparable across engines.
//
// Storage is the SQLite database (server/core/db.js), migrated off
// aiseo_prompts.csv / aiseo_runs.csv. The two tables are part of the schema,
// so there is no file to create on first use and no header to patch when a
// column is added — the migration that used to rewrite a runs file written
// before `recommendation` existed is gone, because a schema change gives
// every row the column at once. Writes go through core/repo.js like every
// other module's; nothing here touches a file.
import { GoogleGenAI, Type } from '@google/genai';
import { getDbConfig } from '../core/db.js';
import { exists, insert, nextId, remove, select, selectOne, transaction, update } from '../core/repo.js';

const PROMPTS_TABLE = 'aiseo_prompt';
// prompt_text is denormalized onto the run so the history stays readable
// after the prompt row it was checking has been deleted.
const RUNS_TABLE = 'aiseo_run';

// Which assistant produced the answer. Only 'gemini' can be run automatically
// from here; the rest are paste-in, and are listed so the history can be
// filtered per engine rather than lumping every manual entry together.
const ENGINES = ['gemini', 'chatgpt', 'perplexity', 'copilot', 'claude', 'other'];

// Competitors and citations are stored as one semicolon-joined TEXT column
// each rather than child tables. They are only ever read back whole — the
// dashboard counts them and lists them — so a join per run would buy nothing,
// and the export of this table stays one readable row per check. Semicolons
// rather than commas because a business name can contain a comma.
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

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

// Both tables stay small — a couple of dozen prompts, a few hundred runs — so
// the reads below select the table and finish the work in JS rather than
// pushing every filter into SQL. Case-insensitive duplicate matching and the
// "keep a row whose ran_at won't parse" rule are both easier to read here,
// and neither is worth an index at these row counts.
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
    // is_active is a 0/1 integer defaulting to 1, so a row that never said
    // otherwise is active — the same reading the CSV's blank cell got.
    isActive: row.is_active !== 0,
    createdAt: row.created_at || '',
  };
}

function toRun(row) {
  return {
    id: row.run_id,
    // Null once the prompt it was checking has been deleted — the FK is ON
    // DELETE SET NULL — which the dashboard then groups as an ad-hoc check.
    promptId: row.prompt_id || '',
    promptText: row.prompt_text || '',
    engine: row.engine || 'other',
    source: row.source || 'manual',
    ranAt: row.ran_at || '',
    mentioned: Boolean(row.mentioned),
    // Stored as INTEGER or NULL, and the schema's CHECKs keep them sane, so
    // these come back ready to use rather than needing to be parsed.
    position: row.position ?? null,
    totalBrands: row.total_brands ?? null,
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
  // The database, not a Data folder: a machine that has never built one has
  // nowhere to put a check, and the page says so.
  const { dbPath, exists: dbPresent } = getDbConfig();
  return {
    dbPath,
    dbPresent,
    // Drives the UI's "auto-run available?" state — without a key the page
    // still works, just paste-in only.
    autoRunAvailable: Boolean(process.env.GEMINI_API_KEY),
    model: MODEL,
    brand: BRAND,
    engines: ENGINES,
  };
}

function listPrompts() {
  return { prompts: select(PROMPTS_TABLE, {}, { orderBy: 'prompt_id' }).map(toPrompt) };
}

function addPrompt({ text, intent }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw badRequest('A prompt needs some text — the question a customer would actually ask.');

  const duplicate = select(PROMPTS_TABLE).find(
    (r) => (r.prompt_text || '').trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) throw badRequest('That prompt is already being tracked.');

  const row = {
    prompt_id: nextId(PROMPTS_TABLE, 'prompt_id', 'SEOP'),
    prompt_text: trimmed,
    intent: String(intent || '').trim(),
    is_active: 1,
    created_at: new Date().toISOString(),
  };
  insert(PROMPTS_TABLE, row);
  return { prompt: toPrompt(row) };
}

function seedPrompts() {
  const existing = new Set(select(PROMPTS_TABLE).map((r) => (r.prompt_text || '').trim().toLowerCase()));

  // Re-seeding an already-seeded table adds nothing rather than duplicating,
  // so the button is safe to press twice.
  const fresh = STARTER_PROMPTS.filter((p) => !existing.has(p.text.toLowerCase()));
  if (!fresh.length) return { added: 0, prompts: listPrompts().prompts };

  // One transaction: seeding is a single action from the button's point of
  // view, and nextId re-reads the highest id inside it, so the ids come out
  // contiguous rather than all resolving to the same one.
  transaction(() =>
    fresh.forEach((p) =>
      insert(PROMPTS_TABLE, {
        prompt_id: nextId(PROMPTS_TABLE, 'prompt_id', 'SEOP'),
        prompt_text: p.text,
        intent: p.intent,
        is_active: 1,
        created_at: new Date().toISOString(),
      }),
    ),
  );
  return { added: fresh.length, prompts: listPrompts().prompts };
}

function updatePrompt({ id, text, intent, isActive }) {
  const row = selectOne(PROMPTS_TABLE, { prompt_id: id });
  if (!row) throw notFound(`No tracked prompt with id ${id}.`);

  // Only the fields that were actually sent: the dashboard's active toggle
  // posts isActive alone, and an UPDATE that also set prompt_text from a
  // half-built payload would quietly blank the question being tracked.
  const patch = {};
  if (text !== undefined) {
    const trimmed = String(text).trim();
    if (!trimmed) throw badRequest('A prompt needs some text.');
    patch.prompt_text = trimmed;
  }
  if (intent !== undefined) patch.intent = String(intent).trim();
  if (isActive !== undefined) patch.is_active = isActive ? 1 : 0;

  if (Object.keys(patch).length) update(PROMPTS_TABLE, { prompt_id: id }, patch);
  return { prompt: toPrompt({ ...row, ...patch }) };
}

// Past runs are deliberately left behind: they carry their own prompt_text,
// so the history stays honest about what was asked even after the prompt
// stops being tracked. The FK does that part now — ON DELETE SET NULL, so a
// run outlives its prompt with the dangling id cleared rather than pointing
// at nothing.
//
// Checked before the delete rather than reading repo.remove's count, so the
// dashboard gets "No tracked prompt with id SEOP-0009" instead of the
// generic no-rows-matched message.
function deletePrompt({ id }) {
  if (!exists(PROMPTS_TABLE, { prompt_id: id })) throw notFound(`No tracked prompt with id ${id}.`);
  remove(PROMPTS_TABLE, { prompt_id: id });
  return { deleted: id };
}

function listRuns({ days } = {}) {
  const runs = select(RUNS_TABLE, {}, { orderBy: 'ran_at desc' }).map(toRun);
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
  if (!exists(RUNS_TABLE, { run_id: id })) throw notFound(`No run with id ${id}.`);
  remove(RUNS_TABLE, { run_id: id });
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

// Long answers are truncated on the way in: the excerpt exists to make a row
// readable when scanning history, not to archive the full response, and the
// history is read as a list of rows — a full answer per row would push the
// interesting columns off the screen and out of any export of the table.
const EXCERPT_LIMIT = 1200;
const excerpt = (text) => (text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…` : text);

// aiseo_run CHECKs that a rank fits its total (position <= total_brands), and
// a scoring pass can return "3rd of 2" — the model ranking against businesses
// it didn't end up listing. The CSV took that contradiction silently; the
// table would refuse the INSERT and lose a run that cost two Gemini calls.
// The rank is the field the dashboard averages, so it wins and the total is
// widened to fit rather than the other way round.
function reconcileRank({ mentioned, position, totalBrands }) {
  const rank = mentioned && position > 0 ? position : null;
  if (rank == null) return { position: null, total_brands: totalBrands ?? null };
  return { position: rank, total_brands: totalBrands == null ? null : Math.max(totalBrands, rank) };
}

function saveRun({ promptId, promptText, engine, source, analysis, citations }) {
  const row = {
    run_id: nextId(RUNS_TABLE, 'run_id', 'SEOR'),
    // Null, not '', for an ad-hoc check: the column is a foreign key, and ''
    // is a value the prompt table will never hold.
    prompt_id: promptId || null,
    prompt_text: promptText,
    engine,
    source,
    ran_at: new Date().toISOString(),
    mentioned: analysis.mentioned ? 1 : 0,
    ...reconcileRank(analysis),
    sentiment: analysis.sentiment,
    framing: analysis.framing,
    competitors: analysis.competitors.join(LIST_SEP),
    citation_domains: (citations?.domains || []).join(LIST_SEP),
    citation_urls: (citations?.urls || []).join(LIST_SEP),
    recommendation: analysis.recommendation,
    answer_excerpt: excerpt(analysis.answerText || ''),
  };
  insert(RUNS_TABLE, row);
  return toRun(row);
}

// Resolves the prompt text to actually ask: a tracked prompt by id, or ad-hoc
// text for a one-off check that isn't in the list.
function resolvePromptText({ promptId, promptText }) {
  if (promptId) {
    const row = selectOne(PROMPTS_TABLE, { prompt_id: promptId });
    if (!row) throw notFound(`No tracked prompt with id ${promptId}.`);
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
