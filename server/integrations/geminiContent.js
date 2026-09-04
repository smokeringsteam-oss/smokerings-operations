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

function requireClient() {
  const ai = getClient();
  if (!ai) {
    const err = new Error('GEMINI_API_KEY is not configured on the server. Copy .env.example to .env and set your key.');
    err.status = 503;
    throw err;
  }
  return ai;
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

// ---- Purchase bills: read a photo of the vendor's bill into PO lines ------
// The butcher hands over a paper slip, Bread Time Stories send a printed
// invoice, and Swiggy Instamart is a screenshot on the phone. All three end
// up typed into Weekly Purchasing line by line, which is the slowest part of
// a Friday. This reads the picture instead.
//
// It deliberately stops at "here is what I read" — nothing is written, and
// every number comes back for the pitmaster to check against the paper still
// in their hand before they hit Log purchase. See scanPurchaseBill in
// server/ops/shared/purchaseScan.js for the matching/validation half, which
// is where anything Gemini invents gets thrown away.
const BILL_SYSTEM_PROMPT = `You are reading a photo of a purchase bill for Smoke Rings BBQ, a barbecue cloud kitchen in Bengaluru, India. The image is a vendor bill, invoice, delivery challan, handwritten butcher's slip, or a screenshot of a grocery-app order (Swiggy Instamart, Zepto, Blinkit).

Your job is to transcribe what was BOUGHT into structured lines. You are transcribing, not estimating — every number must be visible in the image.

Return:
- "vendorName": the shop/supplier the bill is FROM, exactly as printed. Empty string if you cannot see one. Never use "Smoke Rings BBQ" — that is the buyer, not the vendor.
- "purchaseDate": the bill date as YYYY-MM-DD. Empty string if no date is visible. If the year is missing from a date, leave it empty rather than guessing the year.
- "lines": one entry per item bought.
- "notes": at most one short sentence about anything that made the read hard (blurry section, torn slip, a total that doesn't add up). Empty string if the read was clean.

Each line has:
- "itemName": the item as written on the bill, verbatim (e.g. "Pork Belly B/L", "Amul Butter 500g").
- "materialId": the id of the matching item from the kitchen's catalogue below, if one clearly matches the same physical thing. Use "" when nothing in the catalogue matches — an unmatched line is fine and expected. Never invent an id that is not in the list.
- "quantity": how many units/kg were bought, as a number. This is the number the vendor charges by.
- "unitPrice": price per unit in rupees, as a number. 0 if only a line total is printed.
- "lineTotal": the line's total in rupees, as a number. 0 if only a unit price is printed.
- "unit": the unit the quantity is in, exactly as the bill words it ("kg", "pcs", "packet", "litre"). Empty string if the bill does not say.

Rules:
- Only rupee amounts actually printed on the bill. Never compute a missing price by dividing a grand total, and never carry a price over from another line.
- Skip the bill's own summary rows — subtotal, total, GST/CGST/SGST, delivery fee, discount, round-off, amount paid. Those are not items bought.
- A quantity written as "2 x 500g" means quantity 2 of a 500g pack; keep quantity 2 and put the pack size in itemName.
- If a line is genuinely unreadable, leave it out entirely and say so in "notes". A missing line the pitmaster adds by hand is far better than a made-up one.
- If the image is not a bill at all, return empty lines and say so in "notes".

Kitchen catalogue (id — name — category):
`;

// Closes off JSON that stopped mid-sentence, dropping whatever element was
// half-written. Only ever used on a MAX_TOKENS response: the bill schema puts
// "lines" last, so a cut costs the tail of that array and nothing else, and
// twenty-eight lines the pitmaster checks by eye beats an error that throws
// away a read they have to redo. Returns null when the cut landed too early
// for anything to be salvageable.
export function repairTruncatedJSON(text) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  // End of the last value that closed while still nested — i.e. the last
  // point the document was structurally whole apart from its open parents.
  let lastComplete = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth > 0) lastComplete = i + 1;
    }
  }

  if (lastComplete < 0) return null;

  // Re-walk the kept prefix to learn which brackets are still open, then shut
  // them in reverse — the array of lines first, the wrapper object last.
  const kept = text.slice(0, lastComplete);
  const open = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < kept.length; i += 1) {
    const ch = kept[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') open.push('}');
    else if (ch === '[') open.push(']');
    else if (ch === '}' || ch === ']') open.pop();
  }

  try {
    return JSON.parse(kept + open.reverse().join(''));
  } catch {
    return null;
  }
}

// `catalogue` is the buyable materials list, passed in rather than baked into
// the prompt: it is a database read that changes as the kitchen adds items,
// and a stale copy here would quietly stop matching the very items that were
// added most recently.
export async function readPurchaseBill({ imageBase64, mimeType, catalogue = [] }) {
  const ai = requireClient();
  if (!imageBase64) {
    const err = new Error('No image was uploaded.');
    err.status = 400;
    throw err;
  }

  const catalogueText = catalogue
    .map((m) => `- ${m.material_id} — ${m.item_name}${m.category ? ` — ${m.category}` : ''}`)
    .join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: 'Read this bill and return its line items.' },
        ],
      },
    ],
    config: {
      systemInstruction: `${BILL_SYSTEM_PROMPT}${catalogueText || '(catalogue unavailable — leave every materialId empty)'}`,
      // A long grocery bill is thirty-odd lines of JSON, and thinking tokens
      // count against this budget too — see generateJSON above. 8000 shared
      // between the two was not enough: a dense Instamart bill against a
      // catalogue this size can spend most of it deciding materialIds and
      // then get cut off partway through the array. The budget is a ceiling,
      // not a spend, so the room here is close to free; capping thinking
      // separately is what actually guarantees the JSON gets its share.
      maxOutputTokens: 24000,
      thinkingConfig: { thinkingBudget: 2048 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          vendorName: { type: Type.STRING },
          purchaseDate: { type: Type.STRING, description: 'YYYY-MM-DD, or empty string.' },
          notes: { type: Type.STRING },
          lines: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                itemName: { type: Type.STRING },
                materialId: { type: Type.STRING, description: 'A catalogue id, or empty string when nothing matches.' },
                quantity: { type: Type.NUMBER },
                unitPrice: { type: Type.NUMBER },
                lineTotal: { type: Type.NUMBER },
                unit: { type: Type.STRING },
              },
              required: ['itemName', 'quantity'],
            },
          },
        },
        required: ['lines'],
      },
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  const text = response.text || '';

  // Everything except a clean stop and a clean overrun is a real failure —
  // a blocked image or a safety stop has nothing worth salvaging.
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    const err = new Error(`Gemini cut off the bill read before finishing (${finishReason}). Try again.`);
    err.status = 502;
    throw err;
  }

  if (finishReason === 'MAX_TOKENS') {
    const partial = repairTruncatedJSON(text);
    if (partial?.lines?.length) {
      // Loud, because the screen shows `notes` in the scan review and this is
      // exactly the case where the cart is right but incomplete — the missing
      // lines look like lines the bill never had.
      return {
        ...partial,
        notes: [
          typeof partial.notes === 'string' ? partial.notes.trim() : '',
          `This bill was too long to read in one go — only the first ${partial.lines.length} line${partial.lines.length === 1 ? '' : 's'} came back. Check the paper for lines below those and add them by hand.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    const err = new Error(
      'Gemini ran out of room before it read anything usable off that bill. Photograph it in two halves and scan each.',
    );
    err.status = 502;
    throw err;
  }

  try {
    return JSON.parse(text || '{}');
  } catch {
    const err = new Error('Gemini did not return structured bill data. Try a clearer photo.');
    err.status = 502;
    throw err;
  }
}

// ---- Matching an ad hoc purchase line to a catalogue item -----------------
// The counter-side twin of the bill read above. A buy logged as "coriander
// bunch 100 g" or "PORK SHLDR B/L" has no catalogue row, so it recorded the
// money and moved no stock; the fix is almost always an item that IS in the
// catalogue under different wording, and finding it by eye means scrolling a
// sixty-row dropdown.
//
// The shortlist is built by string similarity first (scoreMaterials in
// server/ops/shared/materialMatch.js) and only then handed here, for two
// reasons: string distance has no idea that "shoulder" and "Boston butt" are
// the same cut, and Gemini has no idea what is actually in this kitchen. So
// the local pass decides what could plausibly be it, and this pass decides
// which of those it is — over a dozen names, not the whole catalogue, which
// keeps the call small and keeps a hallucinated id out of reach by
// construction.
//
// Nothing here writes. Every id that comes back is checked against the
// shortlist by the caller, and the pitmaster clicks the one they want.
const MATCH_SYSTEM_PROMPT = `You are helping the kitchen team at Smoke Rings BBQ, a barbecue cloud kitchen in Bengaluru, India, tidy up their purchase log.

Someone logged a purchase by typing an item name at the counter. That name is not in the materials catalogue, so the buy recorded no stock. You are given the typed name and a shortlist of catalogue items that might be the same physical thing.

Decide which catalogue items, if any, are the SAME physical ingredient as the typed name.

Return "matches", ordered best first, at most 3 entries. Each has:
- "materialId": the id, copied exactly from the shortlist.
- "confidence": "high" when it is plainly the same thing (an abbreviation, a plural, a brand name, a pack size, a spelling variant, or the same cut under another butcher's name); "medium" when it is probably the same thing but a detail differs; "low" when it is only worth a look.
- "reason": one short phrase, under 12 words, saying why — written for a pitmaster, e.g. "same cut, butcher's abbreviation" or "same spice, catalogue spells it out".

Rules:
- Only ids from the shortlist. Never invent one.
- Same INGREDIENT, not same category. "Chicken Breast" and "Chicken Whole" are different items; do not match them to each other just because both are chicken.
- A different pack or unit size of the same ingredient IS a match — the catalogue tracks the ingredient, not the packet.
- If nothing on the shortlist is the same thing, return an empty "matches" array. That is a useful answer, not a failure — the team will add a new catalogue item instead.
- Never return more than one "high" unless two shortlist entries really are the same ingredient as each other.`;

// `candidates` is the local shortlist: [{ material_id, item_name, category }].
// Returns [{ materialId, confidence, reason }] — unvalidated, since checking
// the ids against the shortlist is the caller's job (suggestMaterialMatches).
export async function rankMaterialMatches({ itemName, candidates = [] }) {
  const ai = requireClient();
  const name = typeof itemName === 'string' ? itemName.trim() : '';
  if (!name) {
    const err = new Error('itemName is required.');
    err.status = 400;
    throw err;
  }
  if (!candidates.length) return { matches: [] };

  const ids = candidates.map((c) => c.material_id);
  const shortlist = candidates
    .map((c) => `- ${c.material_id} — ${c.item_name}${c.category ? ` — ${c.category}` : ''}`)
    .join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [{ text: `Typed at the counter: "${name}"\n\nCatalogue shortlist (id — name — category):\n${shortlist}` }],
      },
    ],
    config: {
      systemInstruction: MATCH_SYSTEM_PROMPT,
      // Three short entries of JSON, but the thinking budget shares this
      // ceiling — see readPurchaseBill above for why that matters.
      maxOutputTokens: 2000,
      thinkingConfig: { thinkingBudget: 512 },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          matches: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                // The enum is the shortlist itself, so the decoder cannot
                // spell an id that was never offered.
                materialId: { type: Type.STRING, enum: ids },
                confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
                reason: { type: Type.STRING },
              },
              required: ['materialId', 'confidence'],
            },
          },
        },
        required: ['matches'],
      },
    },
  });

  try {
    const parsed = JSON.parse(response.text || '{}');
    return { matches: Array.isArray(parsed.matches) ? parsed.matches : [] };
  } catch {
    const err = new Error('Gemini did not return structured match data.');
    err.status = 502;
    throw err;
  }
}
