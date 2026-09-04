// Which catalogue item did this ad hoc purchase line actually mean?
//
// A buy typed in at the counter — "coriander bunch 100 g", "PORK SHLDR B/L",
// "amul butter 500g" — records the money and moves no stock, because there is
// no material row to move (see catalogPurchaseItem in ./purchasing.js for the
// other half of that story). Most of those names are not new ingredients at
// all; they are the catalogue's own items under a butcher's abbreviation, a
// brand name or a pack size. Finding the right one by eye means scrolling a
// dropdown of sixty-odd rows, which is why it does not get done.
//
// Two passes, and the split is the point:
//
//   * scoreMaterials, below, is pure string similarity. It is fast, free,
//     offline, deterministic and testable — and it is blind to meaning, so it
//     will never work out that "Boston butt" is pork shoulder.
//   * rankMaterialMatches (server/integrations/geminiContent.js) knows that,
//     and knows nothing about this kitchen's catalogue.
//
// So the local pass narrows the whole catalogue to a shortlist of plausible
// names, and Gemini picks from that shortlist. The model never sees an id it
// could match wrongly at scale, every id it returns is re-checked here
// against the shortlist, and if there is no API key or the call fails the
// local scores are shown on their own. A suggestion is a suggestion either
// way: nothing is linked until the pitmaster clicks the one they want.
import { rankMaterialMatches } from '../../integrations/geminiContent.js';
import { getPurchases, getRawMaterials } from './purchasing.js';

// How many names the local pass hands to Gemini. Big enough that the right
// answer is very unlikely to have been cut (the same ingredient under other
// wording still shares a token or a few bigrams with what was typed), small
// enough that the prompt stays short and the model is choosing rather than
// searching.
const SHORTLIST_SIZE = 12;

// Below this the local pass has found nothing but noise — a token in common
// that both names share with half the catalogue. Shortlisting those would
// pad the prompt with items no one would ever pick.
const MIN_LOCAL_SCORE = 0.12;

// How many suggestions the screen shows. Three is what fits above the
// fallback dropdown without turning the row into a second screen.
const MAX_SUGGESTIONS = 3;

// Words that say nothing about WHICH ingredient this is: units, pack wording
// and the filler that ends up on a bill. Dropping them is what makes "amul
// butter 500 g" and "Butter" comparable at all. Deliberately short — anything
// that could name an ingredient (oil, salt, mix) stays in.
const NOISE_TOKENS = new Set([
  'kg', 'kgs', 'g', 'gm', 'gms', 'gram', 'grams', 'ml', 'l', 'ltr', 'litre', 'liter',
  'pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'qty', 'x',
  'pkt', 'packet', 'pack', 'packs', 'box', 'bag', 'tin', 'tub', 'bottle', 'jar',
  'fresh', 'local', 'raw', 'the', 'and', 'of', 'with',
]);

// Lowercase, split on anything that is not a letter or a digit, drop the
// noise and the bare numbers, and singularise. A trailing "s" only comes off
// words long enough that it is plausibly a plural — "rib" and "ribs" matching
// is worth more here than the handful of short words the rule mangles, and it
// mangles them identically on both sides of the comparison.
function tokenise(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

// Sørensen–Dice over character bigrams. This is the half that survives the
// things a token comparison cannot see: a typo ("corriander"), an
// abbreviation ("shldr"), a name run together ("burgerbuns"). Bigrams are
// counted as a multiset, so a repeated pair is not double-credited.
function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const grams = (text) => {
    const out = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const pair = text.slice(i, i + 2);
      out.set(pair, (out.get(pair) || 0) + 1);
    }
    return out;
  };

  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  left.forEach((count, pair) => {
    shared += Math.min(count, right.get(pair) || 0);
  });
  const total = a.length - 1 + (b.length - 1);
  return total ? (2 * shared) / total : 0;
}

// Word overlap, from two angles that disagree usefully:
//   coverage — how much of the SHORTER name the longer one contains, so
//     "Pork Shoulder" scores well against "pork shoulder boneless 5 kg";
//   jaccard  — how much the two names share overall, which pulls back down
//     the case where the short name is a single generic word ("chicken")
//     that half the catalogue contains.
function tokenScore(a, b) {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  left.forEach((t) => {
    if (right.has(t)) shared += 1;
  });
  const coverage = shared / Math.min(left.size, right.size);
  const jaccard = shared / (left.size + right.size - shared);
  return 0.5 * coverage + 0.5 * jaccard;
}

// Every material scored against one typed name, best first. Pure — no
// database, no network — so the ranking rules can be tested on a fixed
// catalogue (see materialMatch.test.js).
//
// An exact match after normalisation scores 1 outright rather than being left
// to the blend: "Burger Buns" against "burger bun x 24" is the same item and
// nothing should be allowed to rank above it.
function scoreMaterials(itemName, materials = []) {
  const wanted = tokenise(itemName);
  if (!wanted.length) return [];
  const wantedText = wanted.join(' ');

  return materials
    .map((material) => {
      const theirs = tokenise(material.item_name);
      const theirText = theirs.join(' ');
      const score =
        theirText && theirText === wantedText
          ? 1
          : 0.6 * tokenScore(wanted, theirs) + 0.4 * bigramDice(wantedText, theirText);
      return { material, score: Math.round(score * 1000) / 1000 };
    })
    .filter((row) => row.score >= MIN_LOCAL_SCORE)
    .sort((a, b) => b.score - a.score || a.material.item_name.localeCompare(b.material.item_name));
}

// Local score -> the same three-way confidence Gemini speaks, so the screen
// renders one kind of pill whichever pass produced the row. The thresholds
// are deliberately mean: without a model reading the names, a 0.6 string
// similarity is a coincidence about as often as it is a match.
function localConfidence(score) {
  if (score >= 0.9) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

const suggestionFrom = (material, { confidence, reason, score, source }) => ({
  materialId: material.material_id,
  itemName: material.item_name,
  category: material.category || '',
  quantityOnHand: material.quantity_on_hand ?? null,
  confidence,
  reason: reason || '',
  score,
  source,
});

// The whole thing: shortlist locally, let Gemini choose, fall back to the
// shortlist if it can't.
//
// `source` in the result says which pass produced the list, and the screen
// shows it — "why is it suggesting this" has a different answer in each case,
// and a pitmaster who knows the key is missing will trust a row differently.
async function suggestMaterialMatches({ itemName, materials = [] }) {
  const name = typeof itemName === 'string' ? itemName.trim() : '';
  if (!name) {
    const err = new Error('itemName is required.');
    err.status = 400;
    throw err;
  }

  const shortlist = scoreMaterials(name, materials).slice(0, SHORTLIST_SIZE);
  if (!shortlist.length) {
    return { itemName: name, suggestions: [], source: 'local', note: '' };
  }

  const localOnly = (note) => ({
    itemName: name,
    suggestions: shortlist
      .slice(0, MAX_SUGGESTIONS)
      .map(({ material, score }) =>
        suggestionFrom(material, {
          confidence: localConfidence(score),
          reason: 'similar name',
          score,
          source: 'local',
        }),
      ),
    source: 'local',
    note,
  });

  if (!process.env.GEMINI_API_KEY) {
    return localOnly('Name similarity only — set GEMINI_API_KEY for smarter suggestions.');
  }

  let ranked;
  try {
    ranked = await rankMaterialMatches({
      itemName: name,
      candidates: shortlist.map(({ material }) => ({
        material_id: material.material_id,
        item_name: material.item_name,
        category: material.category || '',
      })),
    });
  } catch (err) {
    // A ranking that didn't happen is not worth failing the screen over — the
    // local shortlist is still a useful answer, and the alternative is a
    // pitmaster staring at an error where a dropdown used to be. Gemini's
    // free tier rate-limits often enough that this path is routine.
    return localOnly(`Name similarity only — the smart match failed (${err.message}).`);
  }

  const byId = new Map(shortlist.map(({ material, score }) => [material.material_id, { material, score }]));
  const seen = new Set();
  const suggestions = [];
  (ranked.matches || []).forEach((match) => {
    // Same guard as the bill scan: an id that isn't on the shortlist is
    // something the model made up, and it is dropped rather than shown.
    const hit = byId.get(String(match?.materialId || '').trim());
    if (!hit || seen.has(hit.material.material_id)) return;
    seen.add(hit.material.material_id);
    suggestions.push(
      suggestionFrom(hit.material, {
        confidence: ['high', 'medium', 'low'].includes(match.confidence) ? match.confidence : 'low',
        reason: typeof match.reason === 'string' ? match.reason.trim() : '',
        score: hit.score,
        source: 'gemini',
      }),
    );
  });

  // An empty list after a successful ranking is a real answer — Gemini looked
  // at the shortlist and said none of these is the same ingredient — so it is
  // returned as one rather than falling back to the local scores, which would
  // undo the judgement that was just made.
  return {
    itemName: name,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    source: 'gemini',
    note: suggestions.length ? '' : 'Nothing in the catalogue looks like the same ingredient — add it as a new item.',
  };
}

// The route's half: find the ad hoc line, score its wording against the
// buyable catalogue, rank. Reads only — the link itself is a separate,
// explicit call (linkPurchaseToMaterial in ./purchasing.js) made when the
// pitmaster picks one.
//
// A line that already has a material is refused rather than answered: there
// is nothing to suggest for a buy whose stock has already moved, and asking
// is a sign the screen is out of date with the log.
async function suggestMatchesForPurchase(purchaseId) {
  if (!purchaseId) {
    const err = new Error('purchaseId is required.');
    err.status = 400;
    throw err;
  }

  const purchase = getPurchases().find((row) => row.purchase_id === purchaseId);
  if (!purchase) {
    const err = new Error(`No purchase found with id ${purchaseId}.`);
    err.status = 404;
    throw err;
  }
  if (purchase.material_id) {
    const err = new Error(`${purchaseId} is already linked to ${purchase.material_id}.`);
    err.status = 409;
    throw err;
  }

  return suggestMaterialMatches({ itemName: purchase.item_name, materials: getRawMaterials() });
}

export {
  MAX_SUGGESTIONS,
  MIN_LOCAL_SCORE,
  SHORTLIST_SIZE,
  scoreMaterials,
  suggestMaterialMatches,
  suggestMatchesForPurchase,
  tokenise,
};
