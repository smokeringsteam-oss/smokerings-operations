import { GoogleGenAI, Type } from '@google/genai';

const MODEL = process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-lite-latest';

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// Step 1 is Agent 0: an open, natural chat that figures out what the founder
// wants to post about. It should never hand back finished post copy — that's
// Agent 2's job (see below) — but otherwise it's a real conversation, not a
// form to fill out: it can answer questions, react to pasted-in context
// (e.g. GitHub activity), riff, push back, or just chat until intent is clear.
const CHAT_SYSTEM_PROMPT = `You are a sharp, friendly marketing co-pilot for the founder of Smoke Rings BBQ, chatting with them to figure out what their next LinkedIn post should be about.

BUSINESS CONTEXT (use as truth, weave in naturally — never as a sales pitch):
- Smoke Rings BBQ: a Bengaluru cloud kitchen making authentic wood-fired, slow-smoked BBQ (12-hour smoked pork, 3-hour smoked chicken, ribs, burnt ends). Premium, artisanal.
- Open Fri–Sun evenings only. Direct ordering via WhatsApp. Early sales came organically from Reddit.
- I'm an early-stage solo-ish founder figuring it out in real time.
- Offerings: The Weekend Drop (limited weekly release), Private Engagements (chef-led experiences), Corporate Partnerships (B2B supply) — B2B currently paused but open to the right partners.

GOAL (build in public): earn attention from founders/operators and Bangalore's food community, be genuinely useful/honest, and eventually open a soft door to sales — but that's what the finished post does later, not your job right now.

HOW TO TALK:
- Be a real conversational partner, not a form to fill out. Respond naturally to whatever they say — answer questions, riff on ideas, push back gently, suggest angles, ask what's actually on their mind. No fixed format, no forced bullet list every single reply — let the shape of your answer follow the shape of their message.
- If they paste in raw context (e.g. GitHub activity, a story, a stat), read it and react like a sharp colleague would — pull out what's actually interesting about it and ask what they want to do with it, rather than just restating it.
- If their ask is vague, have a real back-and-forth to narrow it down rather than immediately dumping a list of options.
- Keep the voice consistent with the founder's: first person (as the business), warm, honest, concrete, no corporate speak or buzzwords.

ONE HARD RULE: never write finished LinkedIn post copy in this chat — no hooks, no full paragraphs meant to be posted, no formatted hashtag lists. Once you and the founder land on a clear direction, say so plainly and let them know the next step hands this off to the post-writing agent — don't write the post yourself here.

Never invent specific facts about the restaurant (menu items, prices, locations, awards) that they haven't told you.`;

// Agent 2 is a genuine multi-step pipeline, not one call — see
// generatePostFromConversation below for the full sequence:
//   1. synthesizeBrief   — read the whole chat, extract topic/angle/facts/CTA
//   2. deriveInsights    — from that brief, find the most endearing, trust-
//                          building angle worth leading with
//   3. writeShortPost    — draft one ≤400-char post in a founder voice
//   4. refineShortPost   — if step 3 overshoots the limit, rewrite tighter
//                          (looped) instead of blindly truncating

const BRIEF_SYSTEM_PROMPT = `You are reading a chat conversation between a founder and their marketing co-pilot about an upcoming Smoke Rings BBQ LinkedIn post (a Bengaluru cloud kitchen doing wood-fired, slow-smoked BBQ).

Distill the conversation into a short brief for the writer who'll draft the actual post. Extract:
- "topic": the core topic/angle the founder settled on (one sentence).
- "keyDetails": the specific, concrete facts/numbers/moments mentioned in the conversation that should be used (verbatim where possible) — not invented, only what was actually said.
- "ctaTarget": who the post's call-to-action should speak to, if it came up (e.g. "fellow founders", "B2C customers", "B2B partners") — empty string if it never came up.

Only use what's actually in the conversation. If the conversation doesn't clearly land on a topic yet, still extract your best read of what's being discussed.`;

// Agent 2, step 2: reads the brief and pulls out the most endearing,
// human, trust-building angle worth leading with — deliberately NOT
// drafting a post itself, so the writer step can focus purely on voice
// and the tight character budget.
const INSIGHTS_SYSTEM_PROMPT = `You are a sharp brand strategist for Smoke Rings BBQ, a Bengaluru cloud kitchen doing wood-fired, slow-smoked BBQ (12-hour smoked pork, 3-hour smoked chicken, ribs, burnt ends).

You'll be given a brief (topic, key details, CTA target) distilled from a founder's chat about their next LinkedIn post. Your job is NOT to summarize the brief. Your job is to find the 2-4 most endearing, human, trust-building insights in it — the kind of honest, specific detail that makes a stranger reading a LinkedIn post think "I want to support this person/business."

Look for:
- A real struggle handled with grit, honesty, or humor (not corporate spin).
- A specific number, moment, or mistake that shows genuine craft or care.
- Evidence of a founder who is candid about what's hard and still pushing forward.
- Anything that builds trust in the food/business, even indirectly.

Output each insight as ONE tight, punchy sentence — raw material for a copywriter, not a post draft itself. No preamble, no post drafts, no hashtags. 2-4 insights, most compelling first.`;

// Agent 2, step 3: turns the insights into one finished, strictly short-form post.
const SHORT_POST_SYSTEM_PROMPT = `You are the founder of Smoke Rings BBQ, a Bengaluru cloud kitchen doing wood-fired, slow-smoked BBQ, writing a LinkedIn post yourself.

You'll be given a short list of insights already identified as endearing and trust-building. Turn ONE of them — the strongest — into a single finished LinkedIn post.

VOICE: Write like a highly capable, plain-spoken founder who is clearly on top of their business — confident, warm, a little wry. Not a marketing account. First person. No corporate speak, no buzzwords, no filler.

HARD CONSTRAINT: The post body must be 400 characters or fewer, TOTAL — count every character including spaces and punctuation. This is a strict LinkedIn-style short-form post, not a long-form one. Non-negotiable: prefer cutting a sentence over going over 400 characters.

STRUCTURE: A strong opening line, 1-2 more short lines of substance, then a CTA or question that invites replies. Use line breaks for readability within the budget. At most 1 hashtag — every character counts.

Never invent facts beyond what's in the insights you were given.`;

// Agent 2, step 4 (only runs if step 3 overshoots): rewrite tighter instead
// of blindly slicing the string, which can cut a sentence off mid-word.
const REFINE_SHORT_POST_SYSTEM_PROMPT = `You are the founder of Smoke Rings BBQ, tightening a LinkedIn post that came in over the strict 400-character budget.

You'll be given the over-length draft and its current character count. Rewrite it to fit in 400 characters or fewer, TOTAL, while keeping the strongest line and the core point intact. Cut secondary sentences or trim wording — don't just chop the end off mid-thought. Keep the same first-person founder voice: confident, warm, a little wry, no corporate speak.`;

function ensureMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages array is required');
  }
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

function requireClient() {
  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server. Copy .env.example to .env and set your key.');
    err.status = 503;
    throw err;
  }
  return ai;
}

function checkFinishReason(response, label) {
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    const err = new Error(`Gemini cut off ${label} before finishing (${finishReason}). Try again.`);
    err.status = 502;
    throw err;
  }
}

// Shared by every Agent 2 step below — a single-turn call with a system
// prompt and a required JSON output shape.
async function generateJSON({ systemInstruction, userText, schema, maxOutputTokens, label }) {
  const ai = requireClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    config: {
      systemInstruction,
      // Gemini's thinking tokens count against maxOutputTokens, so this needs
      // headroom above the visible JSON output length or generation gets cut off.
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  checkFinishReason(response, label);
  try {
    return JSON.parse(response.text || '{}');
  } catch {
    const err = new Error(`Gemini did not return structured ${label}. Try again.`);
    err.status = 502;
    throw err;
  }
}

// Step 1 / Agent 0: an open chat turn — see CHAT_SYSTEM_PROMPT above for what
// it can and can't do.
export async function brainstormReply({ messages }) {
  const ai = requireClient();
  const cleaned = ensureMessages(messages);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: cleaned,
    config: {
      systemInstruction: CHAT_SYSTEM_PROMPT,
      // Gemini's thinking tokens count against maxOutputTokens, so this needs
      // generous headroom above the visible reply length or generation gets cut off.
      maxOutputTokens: 3000,
    },
  });

  checkFinishReason(response, 'its reply');
  const text = (response.text || '').trim();
  return { reply: text };
}

// Agent 2, step 1: distill the chat conversation into a topic/facts/CTA brief.
async function synthesizeBrief({ messages }) {
  const cleaned = ensureMessages(messages);
  const transcript = cleaned.map((m) => `${m.role === 'model' ? 'Co-pilot' : 'Founder'}: ${m.parts[0].text}`).join('\n\n');
  return generateJSON({
    systemInstruction: BRIEF_SYSTEM_PROMPT,
    userText: transcript,
    label: 'a brief',
    maxOutputTokens: 1500,
    schema: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING },
        keyDetails: { type: Type.ARRAY, items: { type: Type.STRING } },
        ctaTarget: { type: Type.STRING },
      },
      required: ['topic', 'keyDetails'],
    },
  });
}

// Agent 2, step 2: derive endearing, trust-building insights from the brief.
async function deriveInsights({ brief }) {
  const contextText = [
    `Topic: ${brief.topic}`,
    brief.keyDetails?.length ? `Key details:\n${brief.keyDetails.map((d) => `- ${d}`).join('\n')}` : '',
    brief.ctaTarget ? `CTA target: ${brief.ctaTarget}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const ai = requireClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: contextText }] }],
    config: { systemInstruction: INSIGHTS_SYSTEM_PROMPT, maxOutputTokens: 1500 },
  });
  checkFinishReason(response, 'insight extraction');
  return (response.text || '').trim();
}

// Agent 2, step 3: draft one ≤400-char post from the insights.
async function writeShortPost({ insightsText }) {
  return generateJSON({
    systemInstruction: SHORT_POST_SYSTEM_PROMPT,
    userText: insightsText,
    label: 'a post',
    maxOutputTokens: 2000,
    schema: {
      type: Type.OBJECT,
      properties: {
        body: { type: Type.STRING, description: 'The finished post text, 400 characters or fewer.' },
        hashtags: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'At most 1 hashtag, without the # symbol.' },
      },
      required: ['body'],
    },
  });
}

// Agent 2, step 4 (only if step 3 overshoots): rewrite tighter rather than
// blindly truncating mid-sentence.
async function refineShortPost({ body, hashtags }) {
  const userText = `Current draft (${body.length} characters, needs to be ≤400):\n\n${body}`;
  const result = await generateJSON({
    systemInstruction: REFINE_SHORT_POST_SYSTEM_PROMPT,
    userText,
    label: 'a refined post',
    maxOutputTokens: 2000,
    schema: {
      type: Type.OBJECT,
      properties: {
        body: { type: Type.STRING, description: 'The rewritten post text, 400 characters or fewer.' },
      },
      required: ['body'],
    },
  });
  return { body: result.body || body, hashtags };
}

// Agent 2 end to end: the full multi-step pipeline from chat conversation to
// a finished, on-voice, ≤400-character LinkedIn post.
export async function generatePostFromConversation({ messages }) {
  const brief = await synthesizeBrief({ messages });
  const insightsText = await deriveInsights({ brief });
  let { body = '', hashtags = [] } = await writeShortPost({ insightsText });

  // The 400-char limit is a hard product requirement, not just a prompt
  // suggestion — give the model one shot at a proper rewrite if it
  // overshoots, then fall back to a hard truncation as a last resort so the
  // pipeline always returns something usable.
  if (body.length > 400) {
    ({ body, hashtags } = await refineShortPost({ body, hashtags }));
  }
  if (body.length > 400) {
    body = body.slice(0, 400);
  }

  return { title: '', body, hashtags, brief, insights: insightsText };
}

const WEEKEND_PREP_MENU = `- chicken-bbq-burger: Signature Pulled Chicken BBQ Burger
- chicken-glaze-burger: Smoke and Glaze Pulled Chicken Burger
- chicken-tacos: Smoked Chicken Tacos
- chicken-quesadilla: Smoked Chicken Quesadilla
- pork-bbq-burger: Signature Pulled Pork BBQ Burger
- pork-glaze-burger: Smoke and Glaze Pulled Pork Burger
- pork-tacos: Smoked Pork Tacos
- pork-quesadilla: Smoked Pork Quesadilla
- pork-burnt-ends: Pork Burnt Ends (150g)
- bbq-ribs-250g: Smokey BBQ Ribs (250g)
- bbq-ribs-half-rack: Smokey BBQ Ribs (1/2 rack, 6-7 ribs)`;

const WEEKEND_PREP_ITEM_IDS = [
  'chicken-bbq-burger',
  'chicken-glaze-burger',
  'chicken-tacos',
  'chicken-quesadilla',
  'pork-bbq-burger',
  'pork-glaze-burger',
  'pork-tacos',
  'pork-quesadilla',
  'pork-burnt-ends',
  'bbq-ribs-250g',
  'bbq-ribs-half-rack',
];

const WEEKEND_PREP_SLOT_IDS = ['satLunch', 'satEvening', 'sunLunch', 'sunEvening'];

const EXTRACT_ORDERS_SYSTEM_PROMPT = `You are the order-intake assistant for Smoke Rings BBQ, a barbecue cloud kitchen in Bengaluru. The kitchen team pastes in raw weekend order info (WhatsApp messages, pre-order form dumps, spreadsheet rows, handwritten notes typed up, etc.) and you convert it into structured item counts for Saturday/Sunday prep planning.

Menu items (use these exact ids):
${WEEKEND_PREP_MENU}

Time slots (use these exact ids):
- satLunch: Saturday, lunch/afternoon
- satEvening: Saturday, evening/dinner/night
- sunLunch: Sunday, lunch/afternoon
- sunEvening: Sunday, evening/dinner/night

Rules:
- Match each order line to the closest menu item id above. Never invent an item id that isn't in the list.
- If a line mentions food but you cannot confidently match it to one menu item AND one slot, put the original phrase (verbatim) in "unmatched" instead of guessing.
- Smoke Rings BBQ only actually serves Friday-Sunday, 5-11pm, so if a day is given with no lunch/afternoon wording, default to the evening slot for that day.
- If the same item+slot combination appears more than once in the pasted text (e.g. two different customers each ordering a burger for Saturday evening), sum their quantities into a single entry for that item+slot.
- Only output entries for item+slot combinations that actually appear in the text. Do not pad with zero-quantity entries.
- These are NEW orders to ADD on top of whatever the kitchen already has logged, not a replacement of the full order book. Only use a negative quantity if the text explicitly says an existing order was cancelled or reduced.
- If the pasted text has nothing resembling a food order, return an empty "orders" array.`;

export async function extractWeekendOrders({ text }) {
  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server. Copy .env.example to .env and set your key.');
    err.status = 503;
    throw err;
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    const err = new Error('Paste some order text first.');
    err.status = 400;
    throw err;
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: trimmed }] }],
    config: {
      systemInstruction: EXTRACT_ORDERS_SYSTEM_PROMPT,
      // Gemini's thinking tokens count against maxOutputTokens, so this needs headroom
      // above the visible JSON output length or generation gets cut off.
      maxOutputTokens: 4000,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          orders: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                itemId: { type: Type.STRING, enum: WEEKEND_PREP_ITEM_IDS },
                slotId: { type: Type.STRING, enum: WEEKEND_PREP_SLOT_IDS },
                quantity: { type: Type.INTEGER, description: 'Positive to add, negative only for an explicit cancellation.' },
              },
              required: ['itemId', 'slotId', 'quantity'],
            },
          },
          unmatched: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Verbatim phrases that looked like food orders but could not be confidently matched.',
          },
        },
        required: ['orders'],
      },
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    const err = new Error(`Gemini cut off the extraction before finishing (${finishReason}). Try pasting a shorter chunk.`);
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text || '{}');
  } catch {
    const err = new Error('Gemini did not return structured order data. Try again.');
    err.status = 502;
    throw err;
  }

  const orders = Array.isArray(parsed?.orders)
    ? parsed.orders.filter(
        (o) =>
          o &&
          WEEKEND_PREP_ITEM_IDS.includes(o.itemId) &&
          WEEKEND_PREP_SLOT_IDS.includes(o.slotId) &&
          Number.isFinite(o.quantity),
      )
    : [];
  const unmatched = Array.isArray(parsed?.unmatched) ? parsed.unmatched.filter((s) => typeof s === 'string' && s.trim()) : [];

  return { orders, unmatched };
}

// ---- Order notes: what time does this customer actually want it? ----------
// Odoo carries a free-text note on every sale order (server/integrations/odoo.js
// fetchOrderPackingList reads it as `note`). For a website order that note is
// a machine-written summary of the checkout, and the only human part of it is
// the "Customer note:" line at the end — which is where a "please deliver by
// 1PM if possible" ends up, phrased however the customer felt like phrasing
// it. Nothing structured to match on, so this is a Gemini read rather than a
// regex.
//
// The trap this prompt exists to avoid: every website note also carries a
// "Delivery slot: Saturday · Lunch (12:30 PM – 3:00 PM)" line. That is the
// standard slot the order was placed into, not a request — reporting it would
// put a "time preference" badge on every single order and make the badge
// worthless. Only what the customer themselves asked for counts.
const TIME_PREFERENCE_SYSTEM_PROMPT = `You read the notes attached to Smoke Rings BBQ delivery orders and pick out any DELIVERY TIME PREFERENCE the customer asked for.

You are given a JSON array of orders, each with an "orderId" and a "note". Return one entry per order, using the same orderId you were given.

What counts as a time preference:
- The customer asking for a specific time or window ("deliver by 1PM", "after 8pm please", "around 7:30", "as early as possible in the slot", "don't come before 6").
- A time-shaped constraint even if vague ("ASAP", "as late as possible", "need it before the match starts at 4").

What does NOT count (this is the important part):
- The "Delivery slot: ..." line, e.g. "Delivery slot: Saturday · Lunch (12:30 PM – 3:00 PM)". That is the standard slot every order is placed into, NOT a customer request. Never report it as a preference.
- Anything about payment, Razorpay ids, totals, addresses, phone numbers, item lists, or test-order warnings.
- Non-time requests (extra sauce, no onions, call on arrival). Those are notes, not time preferences.
- A customer explicitly saying they have no preference ("nothing specific", "anytime is fine").

For each order return:
- "orderId": exactly the id you were given.
- "hasPreference": true only if the customer asked for something about WHEN it arrives.
- "label": a very short phrase for a kitchen board badge, capitalised like a sentence rather than Like A Title, e.g. "Deliver by 1:00 PM", "After 8:00 PM", "ASAP", "Around 7:30 PM". Empty string when hasPreference is false.
- "preferredTime": the time in 24-hour HH:MM if the customer named a concrete clock time, otherwise an empty string. For "by 1PM" that is "13:00". For "ASAP" or "as early as possible" it is "".
- "quote": the customer's own words, copied verbatim from the note, that you based this on. Empty string when hasPreference is false.
- "confidence": "high" when the customer stated a clear time, "medium" when they were vague but clearly meant timing, "low" when you are unsure it is a timing request at all.

Never invent a time the note does not contain. If a note is empty or has no customer-written part, return hasPreference false for it.`;

// Gemini is asked once per distinct note, not once per board render: the
// packing boards re-fetch whenever the date range changes or someone hits
// refresh, and the notes almost never change in between. Keyed by orderId
// plus the note itself, so a note edited in Odoo is re-read rather than served
// stale. Bounded, because this is a long-lived server process.
const TIME_PREFERENCE_CACHE_LIMIT = 500;
const timePreferenceCache = new Map();

const timePreferenceKey = (orderId, note) => `${orderId}|${note}`;

function cacheGet(key) {
  if (!timePreferenceCache.has(key)) return undefined;
  // Re-insert so the entry evicted below is the genuinely least-recently-used
  // one rather than just the oldest-written.
  const value = timePreferenceCache.get(key);
  timePreferenceCache.delete(key);
  timePreferenceCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  timePreferenceCache.set(key, value);
  while (timePreferenceCache.size > TIME_PREFERENCE_CACHE_LIMIT) {
    timePreferenceCache.delete(timePreferenceCache.keys().next().value);
  }
}

const NO_TIME_PREFERENCE = { hasPreference: false, label: '', preferredTime: '', quote: '', confidence: 'high' };

// orders: [{ orderId, note }], straight off fetchOrderPackingList. Returns
// { preferences: { [orderId]: {...} }, read, cached } — orders with no note
// never reach Gemini and simply don't appear in the map.
export async function readOrderTimePreferences({ orders }) {
  const list = Array.isArray(orders) ? orders : [];
  const preferences = {};
  const toRead = [];
  let cached = 0;

  for (const order of list) {
    const orderId = String(order?.orderId ?? '').trim();
    const note = typeof order?.note === 'string' ? order.note.trim() : '';
    if (!orderId || !note) continue;
    const hit = cacheGet(timePreferenceKey(orderId, note));
    if (hit) {
      preferences[orderId] = hit;
      cached += 1;
      continue;
    }
    toRead.push({ orderId, note });
  }

  if (!toRead.length) return { preferences, read: 0, cached };

  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server, so order notes cannot be read.');
    err.status = 503;
    throw err;
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(toRead) }] }],
    config: {
      systemInstruction: TIME_PREFERENCE_SYSTEM_PROMPT,
      // Thinking tokens come out of this budget too (see extractWeekendOrders),
      // and website notes are long, so this needs real headroom above the JSON.
      maxOutputTokens: 8000,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          preferences: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                orderId: { type: Type.STRING },
                hasPreference: { type: Type.BOOLEAN },
                label: { type: Type.STRING, description: 'Short badge text, empty when hasPreference is false.' },
                preferredTime: { type: Type.STRING, description: '24-hour HH:MM, or empty when no clock time was named.' },
                quote: { type: Type.STRING, description: "The customer's own words, verbatim." },
                confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
              },
              required: ['orderId', 'hasPreference'],
            },
          },
        },
        required: ['preferences'],
      },
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    const err = new Error(`Gemini cut off reading the order notes before finishing (${finishReason}).`);
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text || '{}');
  } catch {
    const err = new Error('Gemini did not return structured note data. Try again.');
    err.status = 502;
    throw err;
  }

  const byId = new Map();
  if (Array.isArray(parsed?.preferences)) {
    for (const row of parsed.preferences) {
      if (!row || typeof row.orderId !== 'string') continue;
      byId.set(row.orderId, {
        hasPreference: Boolean(row.hasPreference),
        label: typeof row.label === 'string' ? row.label.trim() : '',
        preferredTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(row.preferredTime || '') ? row.preferredTime : '',
        quote: typeof row.quote === 'string' ? row.quote.trim() : '',
        confidence: ['high', 'medium', 'low'].includes(row.confidence) ? row.confidence : 'low',
      });
    }
  }

  // Every note that was sent gets its answer cached, the "nothing asked for"
  // ones included — otherwise the orders without a preference (the majority)
  // would be re-sent to Gemini on every fetch and quietly burn the quota.
  for (const { orderId, note } of toRead) {
    const result = byId.get(orderId) || NO_TIME_PREFERENCE;
    // A preference with nothing to show on the card is just a no-preference.
    const usable = result.hasPreference && (result.label || result.quote) ? result : NO_TIME_PREFERENCE;
    preferences[orderId] = usable;
    cacheSet(timePreferenceKey(orderId, note), usable);
  }

  return { preferences, read: toRead.length, cached };
}
