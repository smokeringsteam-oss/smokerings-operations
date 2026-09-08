// Bill scanning — turns a photo of a vendor bill into a draft set of purchase
// lines for Weekly Purchasing to show, check and (only then) log.
//
// Two halves, split on purpose:
//
//   * readPurchaseBill (server/integrations/geminiContent.js) does the read.
//     It is a language model looking at a photo, so it can misread a 5 as a
//     6, hallucinate an id, or return a date in the wrong century.
//   * normaliseScannedBill, below, is the part that assumes exactly that.
//     Every id is checked against the real catalogue, every number is coerced
//     and range-checked, and anything that fails is dropped into `skipped`
//     with the reason rather than passed on as fact.
//
// Nothing here writes. The result is a draft the screen loads into the cart
// for the pitmaster to check line by line against the paper still in their
// hand; recordPurchases only ever runs from their Log purchase click. That
// confirmation step is the whole design — an OCR'd bill is a suggestion, and
// treating it as a suggestion is what makes it safe for it to be wrong.
import { readPurchaseBill } from '../../integrations/geminiContent.js';
import { getRawMaterials, getVendors } from './purchasing.js';

// 10 MB. A phone photo is 2-4 MB, a scan of a long grocery bill a bit more;
// past this it is a video or a mistake, and base64 inflates it by a third
// again on the way to Gemini.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ACCEPTED_TYPES = /^(image\/(jpeg|jpg|png|webp|heic|heif)|application\/pdf)$/i;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// Coerces whatever Gemini put in a number field to a usable one. Strings get
// their rupee signs, commas and unit suffixes stripped ("Rs 1,250/kg" -> 1250)
// because the schema asks for a number but a model reading a printed price
// will sometimes hand back what it saw instead.
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = clean(value).replace(/[^0-9.-]/g, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

// Only a real ISO date, and only one that could plausibly be a bill: a
// mis-read "2205-03-14" would otherwise sail through and file the buy two
// centuries out, where no week's totals would ever show it again.
function toPurchaseDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = Number(text.slice(0, 4));
  const thisYear = new Date().getUTCFullYear();
  if (year < thisYear - 5 || year > thisYear + 1) return '';
  return text;
}

// Vendor names on a bill are never quite the name in the book — "Sri
// Venkateshwara Pork Stall, Johnson Mkt" against "Venkateshwara Pork". An
// exact match wins; otherwise one name containing the other counts, but only
// if exactly one vendor matches that way. Two candidates means the screen
// asks rather than filing the spend against the wrong shop.
function matchVendor(name, vendors) {
  const text = clean(name).toLowerCase();
  if (!text) return null;

  const exact = vendors.find((v) => clean(v.vendor_name).toLowerCase() === text);
  if (exact) return exact;

  const partial = vendors.filter((v) => {
    const known = clean(v.vendor_name).toLowerCase();
    return known.length > 3 && (text.includes(known) || known.includes(text));
  });
  return partial.length === 1 ? partial[0] : null;
}

// The catalogue id Gemini claimed, if it is real; failing that, an exact name
// match, which catches the case where it read the item perfectly and then
// mangled the id. Anything else is an unmatched line — logged as an ad hoc
// item with no stock movement, which is what recordPurchases already does
// for a name that isn't in the catalogue.
function matchMaterial(line, byId, byName) {
  const claimed = clean(line.materialId);
  if (claimed && byId.has(claimed)) return byId.get(claimed);

  const name = clean(line.itemName).toLowerCase();
  if (name && byName.has(name)) return byName.get(name);

  return null;
}

// parsed: whatever readPurchaseBill returned. Pure, so the rules above can be
// tested without a Gemini key or a photo — see purchaseScan.test.js.
function normaliseScannedBill(parsed, { materials = [], vendors = [] } = {}) {
  const byId = new Map(materials.map((m) => [m.material_id, m]));
  const byName = new Map(materials.map((m) => [clean(m.item_name).toLowerCase(), m]));

  const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const lines = [];
  const skipped = [];

  rawLines.forEach((raw) => {
    if (!raw) return;
    const itemName = clean(raw.itemName);
    if (!itemName) {
      skipped.push({ itemName: '', reason: 'No item name was readable on this line.' });
      return;
    }

    // A bill prints one of the two, or both, and they disagree as often as
    // not once a discount is involved. The unit price is what the purchase
    // log stores, so a printed one is used as-is and a missing one is derived
    // from the line total — never the other way round, and never from a grand
    // total (the prompt forbids that read in the first place).
    const printedUnitPrice = toNumber(raw.unitPrice);
    const lineTotal = toNumber(raw.lineTotal);

    // A butcher's slip bills by weight, and its till knows that: the column
    // is headed QTY/WT and holds 4.430, but the summary two lines down reads
    // "#ITEMS:1 TQty:0 TWt:4.430", because to the till a weighed item has no
    // countable quantity at all. Read off a photo, that 0 wins often enough
    // to matter, and it used to take the whole line with it — a 4.430 kg
    // shoulder dropped for want of a number printed twice on the same slip.
    //
    // When both money columns came back it is not a guess: 2392.20 / 540.00
    // is 4.430 exactly, the same arithmetic the derived unit price below
    // already trusts, run the other way. Both printed, so still nothing
    // inferred from a grand total. Three decimals because the number being
    // recovered is a weight in kg.
    let quantity = toNumber(raw.quantity);
    let derivedQuantity = false;
    if (!(quantity > 0) && lineTotal > 0 && printedUnitPrice > 0) {
      quantity = Math.round((lineTotal / printedUnitPrice) * 1000) / 1000;
      derivedQuantity = true;
    }
    if (!(quantity > 0)) {
      skipped.push({ itemName, reason: 'Quantity was missing or unreadable — add this line by hand.' });
      return;
    }
    let unitPrice = printedUnitPrice > 0 ? printedUnitPrice : 0;
    let derivedPrice = false;
    if (!unitPrice && lineTotal > 0) {
      unitPrice = Math.round((lineTotal / quantity) * 100) / 100;
      derivedPrice = true;
    }

    const material = matchMaterial(raw, byId, byName);
    lines.push({
      materialId: material ? material.material_id : '',
      // The catalogue's own wording once matched, so the cart, the log and
      // the stock count all say the same thing about the same item. The
      // bill's wording is kept beside it for the review.
      itemName: material ? material.item_name : itemName,
      billText: itemName,
      unit: clean(raw.unit),
      quantity,
      derivedQuantity,
      unitPrice,
      derivedPrice,
      lineTotal: lineTotal > 0 ? lineTotal : Math.round(quantity * unitPrice * 100) / 100,
      matched: Boolean(material),
    });
  });

  const vendor = matchVendor(parsed?.vendorName, vendors);
  return {
    vendorName: vendor ? vendor.vendor_name : '',
    vendorText: clean(parsed?.vendorName),
    purchaseDate: toPurchaseDate(parsed?.purchaseDate),
    dateText: clean(parsed?.purchaseDate),
    notes: clean(parsed?.notes),
    lines,
    skipped,
  };
}

// The route's half: validate the upload, read it, normalise it. `buffer` is
// the raw file from multer's memory storage — a bill is read once and thrown
// away, so unlike the Reddit image uploads there is nothing to keep on disk.
async function scanPurchaseBill({ buffer, mimeType, size }) {
  if (!buffer || !buffer.length) {
    const err = new Error('No image was uploaded. Pick a photo of the bill first.');
    err.status = 400;
    throw err;
  }
  if (!ACCEPTED_TYPES.test(mimeType || '')) {
    const err = new Error(
      `Unsupported file type${mimeType ? ` (${mimeType})` : ''} — upload a photo (JPEG/PNG/HEIC) or a PDF.`,
    );
    err.status = 400;
    throw err;
  }
  if ((size ?? buffer.length) > MAX_IMAGE_BYTES) {
    const err = new Error('That file is over 10 MB — take the photo again at a smaller size.');
    err.status = 413;
    throw err;
  }

  const materials = getRawMaterials();
  const vendors = getVendors();
  const parsed = await readPurchaseBill({
    imageBase64: buffer.toString('base64'),
    mimeType,
    catalogue: materials.map((m) => ({ material_id: m.material_id, item_name: m.item_name, category: m.category })),
  });

  return normaliseScannedBill(parsed, { materials, vendors });
}

export { MAX_IMAGE_BYTES, normaliseScannedBill, scanPurchaseBill };
