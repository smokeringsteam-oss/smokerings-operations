// What a line of spend was FOR — the second dimension of the purchase log,
// beside the one it already had.
//
// Until now every buy answered exactly one question about itself: B2C or B2B.
// That is who the money was spent on behalf of, and it is genuinely useful —
// it is what makes a per-side margin possible at all. What it cannot say is
// what the money bought. A ₹900 line against B2C is a bag of charcoal, a
// stack of A3 posters, or a pork shoulder cooked on a Tuesday to trial a rub,
// and those three are not the same kind of cost: one is fuel that scales with
// volume, one is marketing, and one is a bet on a recipe that sold nothing.
// Averaged into a single "B2C spend" figure they read as one thing, and the
// week that spent half its money on practice looks exactly like the week that
// spent it on meat.
//
// So the category is a dimension INSIDE the channel, not an alternative to
// it. Equipment bought for the wholesale kitchen is B2B + Equipment; posters
// for the weekend counter are B2C + Marketing collateral. Every rollup that
// groups by category keeps the b2c/b2b split alongside it, and neither
// column is derived from the other.
//
// WHY THIS LIVES IN CODE
//
// Same reason as packagingConfig.js: it is a vocabulary the business agrees
// on, not data the business accumulates. A category table would let two
// people invent "Equipment" and "Equipments" and split one line of the P&L
// in half forever. Editing the list is editing this array — and because the
// stored value is the label itself, a rename is an UPDATE, which is exactly
// what categorisePurchases in server/finance/purchaseLog.js does.
//
// WHY AD SPEND IS NOT ON THE LIST
//
// Instagram and Reddit money already has its own ledger
// (server/marketing/marketingBudget.js), and the weekly report adds that
// ledger to the purchase table to get a week's total spend. A "Marketing —
// ads" category here would let the same ₹5,000 be typed into both, and the
// two would silently sum. Physical collateral — posters, flyers, menu cards —
// is on the list precisely because it is bought from a vendor on a bill and
// has never had anywhere else to go.

// The list, in the order the dropdown shows it: the two that move stock
// first, since they are the commonest by a distance, then the rest roughly by
// how often a bill for one lands.
//
// `movesStock` is a hint to the screen, not a rule the writer enforces — it
// says "this kind of buy usually has a catalogue material behind it, so offer
// the picker", and a practice cook that used up meat already on the shelf is
// a perfectly good line with no material on it.
const EXPENSE_CATEGORIES = [
  {
    category: 'Raw materials',
    hint: 'Meat, produce, spices — the catalogue buying that feeds an order.',
    movesStock: true,
  },
  {
    category: 'Practice / R&D',
    hint: 'A cook nobody was billed for: trialling a rub, training a hand, testing a cut.',
    movesStock: true,
  },
  {
    category: 'Marketing collateral',
    hint: 'Posters, flyers, banners, menu cards, stickers — printed and physical. Ad spend goes in the Marketing Budget, not here.',
  },
  {
    category: 'Packaging & consumables',
    hint: 'Boxes, cups, foil, gloves, butcher paper, cling film.',
    movesStock: true,
  },
  {
    category: 'Equipment & tools',
    hint: 'Smokers, thermometers, knives, trays, scales — bought once and kept.',
  },
  {
    category: 'Repairs & maintenance',
    hint: 'Fixing or servicing something already owned.',
  },
  {
    category: 'Fuel & gas',
    hint: 'Charcoal, wood, LPG — what a cook actually burns.',
    movesStock: true,
  },
  {
    category: 'Samples & giveaways',
    hint: 'Food given away to win an account or a review. Nothing was invoiced for it.',
  },
  {
    // Was "Delivery & logistics" (no stored rows used it). One word so the
    // Weekly Purchasing "Logistics" tab, its vendor and this list match.
    category: 'Logistics',
    hint: 'Couriers, third-party riders, porters, fuel for a delivery run.',
  },
  {
    // Logged from the Weekly Purchasing "Investment" tab. Spending vs Sales
    // keeps it out of spend and counts it only in Total investment.
    category: 'Investment',
    hint: 'Money put into the business rather than spent running a week — a smoker, a freezer, a setup cost.',
  },
  {
    category: 'Labour',
    hint: 'Wages for the week — the kitchen helper, a hand for the weekend.',
  },
  {
    category: 'Staff & training',
    hint: 'Uniforms, a course, a certification. Wages go under Labour.',
  },
  {
    category: 'Admin, software & fees',
    hint: 'Subscriptions, licences, bank charges, registrations.',
  },
  {
    // Was "Other". Renamed so the Weekly Purchasing "Misc" tab and this list
    // are one word; the rename is applied to stored rows in migrations.js.
    category: 'Miscellaneous',
    hint: 'Real spend that fits none of the above — a porter, ice, an auto fare. A bucket, not an answer — if it fills up, the list is missing a row.',
  },
];

// The categories Weekly Purchasing's Labour, Logistics, Investment and Misc tabs log
// straight into the purchase table, each under a vendor of the same name (see
// recordExpense in server/ops/shared/purchasing.js). Weekly Ledger reports
// labour and misc as their own spend lines rather than as purchases.
const LABOUR_CATEGORY = 'Labour';
const LOGISTICS_CATEGORY = 'Logistics';

// A buy for a practice cook. Spending vs Sales leaves these out of spend (they
// fed no sale) and counts them only in its Total investment figure.
const PRACTICE_CATEGORY = 'Practice / R&D';
const INVESTMENT_CATEGORY = 'Investment';
const MISC_CATEGORY = 'Miscellaneous';

// What a catalogue buy logged from Weekly Purchasing is called when nobody
// said otherwise. Only material lines get it: an ad hoc line typed in at the
// counter is left uncategorised on purpose, so it surfaces in the Purchase
// Logger's "needs a category" queue rather than being quietly filed as meat.
const DEFAULT_MATERIAL_CATEGORY = 'Raw materials';

const CATEGORY_NAMES = EXPENSE_CATEGORIES.map((row) => row.category);

const BY_LOWER = new Map(EXPENSE_CATEGORIES.map((row) => [row.category.toLowerCase(), row.category]));

// The list as an error message says it. Quoted, not bare: one of the twelve
// has a comma inside it ("Admin, software & fees"), and a comma-joined list of
// names that themselves contain commas reads as thirteen categories, two of
// them invented.
const CATEGORY_LIST_TEXT = CATEGORY_NAMES.map((name) => `"${name}"`).join(', ');

// Blank in, blank out: an uncategorised line is a real state, not a rejected
// one. Anything else has to be on the list, matched case-insensitively and
// returned in the list's own spelling — so "practice / r&d" typed into a
// script cannot become a thirteenth category sitting next to the twelve.
function normaliseExpenseCategory(value) {
  const wanted = (value == null ? '' : String(value)).trim();
  if (!wanted) return null;

  const canonical = BY_LOWER.get(wanted.toLowerCase());
  if (!canonical) {
    const err = new Error(
      `"${wanted}" is not an expense category. One of: ${CATEGORY_LIST_TEXT}.`,
    );
    err.status = 400;
    throw err;
  }
  return canonical;
}

export {
  EXPENSE_CATEGORIES,
  CATEGORY_NAMES,
  CATEGORY_LIST_TEXT,
  DEFAULT_MATERIAL_CATEGORY,
  LABOUR_CATEGORY,
  LOGISTICS_CATEGORY,
  MISC_CATEGORY,
  PRACTICE_CATEGORY,
  INVESTMENT_CATEGORY,
  normaliseExpenseCategory,
};
