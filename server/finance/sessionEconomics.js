// Cost to Make, per smoking session — what a cook cost, what it yielded, and
// what it earned.
//
// The per-dish and per-order lenses cost meat off the PLAN: meatConfig.js's
// loss %, the same number the Weekend Prep Planner buys against. A session is
// where the plan meets the smoker. Its raw weight and its rate per kilo are
// facts; its finished weight, once somebody weighs it, is the realised yield.
// So this is the one lens that can say "at this cook's yield, a pulled pork
// burger's meat actually cost ₹X" rather than "should have cost".
//
// Cost
// ----
//   meat         raw_weight_kg × rate. The rate is the session's own purchase
//                when it names one (source_purchase_id) — that is what was
//                paid for this meat — then the newest purchase of the cut,
//                then the catalogue's standard cost. Rub and brine are not
//                costed: their recipe lines carry no quantity per kilo yet
//                (see unitCost.js), and they come back named, not guessed.
//   other spend  anything else on the purchase log tagged to this session
//                (purchase.smoking_session_id) that is not the meat itself —
//                wood, charcoal, a one-off. Added as logged.
//
// Revenue — which orders a cook fed
// ---------------------------------
// Two ways, strongest first:
//
//   linked   the session lists its orders (smoking_session_order). Taken as
//            given.
//   week     it does not, so the orders PROMISED in the same Monday-to-Sunday
//            week are taken instead — a Friday cook feeds that Saturday and
//            Sunday. Promised, not ordered: an order placed on Tuesday for
//            Saturday is Saturday's cook.
//
// Within those orders only the lines whose dish uses this session's smoked
// product count — a pork session did not feed the chicken tacos on the same
// order. Where two sessions could claim the same line (two pork shoulders in
// one weekend, or a linked and an inferred session), the linked one wins and
// the rest is split by raw weight, so a line's revenue is only ever counted
// once across all sessions.
//
// Samples and practice cooks earn nothing by definition, and B2B cooks bill
// through the wholesale invoice book, which prices kilos rather than plates.
// Those sessions are costed but not credited, and say why.
//
// Pure apart from nothing: every input is handed in. The loader is in
// unitEconomics.js.
import { CATEGORY_BY_PRODUCT_ID, LOSS_CATEGORY_BY_MATERIAL_ID, getMeatCategory } from '../core/meatConfig.js';
import { weekStartOf } from './weeklyLedger.js';

const round2 = (value) => Math.round(value * 100) / 100;
const round0 = (value) => Math.round(value);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 'id:name;id:name', as readSessions rebuilds it from smoking_session_order.
function linkedOrderIds(row) {
  return String(row.fed_order_refs || '')
    .split(';')
    .map((ref) => Number(ref.split(':')[0]))
    .filter((id) => Number.isFinite(id) && id > 0);
}

// Which smoked product a session made. output_product_id when it was set;
// otherwise the product the cut is bought for, off meatConfig — every session
// on file today leaves the column blank, and the cut is always recorded.
function productOf(row) {
  if (row.output_product_id) return row.output_product_id;
  const category = LOSS_CATEGORY_BY_MATERIAL_ID[row.source_material_id];
  return category ? getMeatCategory(category)?.productIds?.[0] || null : null;
}

// What the session's meat cost per kilo, and where that number came from.
//
// Only a cut bought by weight has a rate per kilo — a whole chicken bought per
// bird needs a weight per bird before it has one, and that is a gap, not a
// conversion to guess at.
function meatRate(row, { materialCosts, purchasesById }) {
  const material = materialCosts.get(row.source_material_id);
  if (!material) return { perKg: null, gap: 'cut is not in the material catalogue' };
  if (!material.basis) return { perKg: null, gap: material.gap || 'no pack size on file' };
  if (material.basis.unit !== 'g')
    return {
      perKg: null,
      gap: 'bought by the piece — no weight per piece on file',
    };
  const toPerKg = (perUnit) => (perUnit / material.basis.bomUnits) * 1000;

  const own = row.source_purchase_id ? purchasesById.get(row.source_purchase_id) : null;
  if (own && own.material_id === row.source_material_id) {
    const unitPrice = num(own.unit_price);
    const total = num(own.total_cost);
    const quantity = num(own.quantity_purchased);
    const perUnit = unitPrice && unitPrice > 0 ? unitPrice : total && quantity ? total / quantity : null;
    if (perUnit) {
      return {
        perKg: toPerKg(perUnit),
        source: "this cook's purchase",
        ref: own.purchase_id,
        asOf: own.purchase_date || '',
      };
    }
  }
  if (material.perBomUnit != null) {
    return {
      perKg: material.perBomUnit * 1000,
      source: material.price?.source === 'purchase' ? 'latest purchase' : 'standard cost',
      ref: material.price?.ref || '',
      asOf: material.price?.asOf || '',
    };
  }
  return { perKg: null, gap: material.gap || 'no price on file' };
}

// The weight that went out of the kitchen. Pulled meat is served off the bone,
// so its boneless weight is the finished one; ribs and a whole bird go out on
// it, so theirs is the with-bone weight. Either falls back to the other.
function finishedKgOf(row) {
  const boneless = num(row.finished_weight_without_bone_kg);
  const withBone = num(row.finished_weight_with_bone_kg);
  return (row.output_type || 'Pulled') === 'Pulled' ? (boneless ?? withBone) : (withBone ?? boneless);
}

// sessions         readSessions() rows
// purchases        readPurchases() rows
// materialCosts    priceMaterials() output (unitCost.js)
// orderLines       B2C lines as fetchSoldItems returns them
// dishes           Map of menu item id -> cost book row
// productGrams     Map of menu item id -> Map of smoked product id -> finished grams per plate
function costSessions({ sessions, purchases, materialCosts, orderLines, dishes, productGrams }) {
  const purchasesById = new Map((purchases || []).map((row) => [row.purchase_id, row]));
  const ordersById = new Map();
  for (const line of orderLines || []) {
    if (!ordersById.has(line.orderId)) ordersById.set(line.orderId, []);
    ordersById.get(line.orderId).push(line);
  }

  // ---- Pass 1: each session on its own ------------------------------------
  const rows = (sessions || []).map((row) => {
    const productId = productOf(row);
    const category = productId
      ? CATEGORY_BY_PRODUCT_ID[productId]
      : LOSS_CATEGORY_BY_MATERIAL_ID[row.source_material_id];
    const config = category ? getMeatCategory(category) : null;
    const rawKg = num(row.raw_weight_kg);
    const rate = meatRate(row, { materialCosts, purchasesById });
    const meatCost = rate.perKg != null && rawKg != null ? rawKg * rate.perKg : null;

    // Everything else logged against this cook, minus the meat itself — the
    // meat is already priced above, and its purchase line tagged here too
    // would count it twice.
    const otherSpend = (purchases || [])
      .filter(
        (purchase) =>
          purchase.smoking_session_id === row.session_id &&
          purchase.material_id !== row.source_material_id &&
          purchase.purchase_id !== row.source_purchase_id,
      )
      .map((purchase) => {
        const total = num(purchase.total_cost);
        const unitPrice = num(purchase.unit_price);
        const quantity = num(purchase.quantity_purchased);
        return {
          purchaseId: purchase.purchase_id,
          name: purchase.item_name,
          cost: round2(total ?? (unitPrice != null && quantity != null ? unitPrice * quantity : 0)),
        };
      });
    const otherSpendTotal = otherSpend.reduce((total, entry) => total + entry.cost, 0);

    const plannedYieldPct = config ? 100 - config.lossPct : null;
    const recordedKg = finishedKgOf(row);
    const recordedYield = num(row.yield_pct);
    const actualYieldPct =
      recordedKg != null && rawKg ? round2((recordedKg / rawKg) * 100) : recordedYield != null ? recordedYield : null;
    // Not weighed yet (still in the smoker, or nobody filled it in): the plan
    // stands in, and the row says so. Every per-kilo and per-plate figure off
    // it is then the planned one, not a measurement.
    const finishedKg =
      recordedKg != null
        ? recordedKg
        : actualYieldPct != null && rawKg
          ? (rawKg * actualYieldPct) / 100
          : plannedYieldPct != null && rawKg
            ? (rawKg * plannedYieldPct) / 100
            : null;
    const finishedSource =
      recordedKg != null || recordedYield != null ? 'recorded' : finishedKg != null ? 'planned' : null;

    const perFinishedKg = meatCost != null && finishedKg ? meatCost / finishedKg : null;
    const plannedPerFinishedKg = rate.perKg != null && plannedYieldPct ? rate.perKg / (plannedYieldPct / 100) : null;

    // The dishes this product goes into, and what the meat on each one costs
    // at this cook's yield against the plan's. The comparison the lens exists
    // for: a cook that yielded badly shows up here as a burger that cost more.
    const portions = [];
    for (const [dishId, grams] of productGrams) {
      const perPlate = grams.get(productId);
      if (!perPlate) continue;
      const dish = dishes.get(dishId);
      if (!dish) continue;
      portions.push({
        itemId: dishId,
        name: dish.name,
        price: dish.price,
        grams: perPlate,
        portionsPossible: finishedKg ? Math.floor((finishedKg * 1000) / perPlate) : null,
        meatCostEach: perFinishedKg != null ? round2((perPlate / 1000) * perFinishedKg) : null,
        plannedMeatCostEach: plannedPerFinishedKg != null ? round2((perPlate / 1000) * plannedPerFinishedKg) : null,
      });
    }
    portions.sort((a, b) => a.grams - b.grams || a.name.localeCompare(b.name));

    const purpose = row.session_purpose || 'Order';
    const earns = row.channel === 'B2C' && purpose === 'Order';
    const linked = linkedOrderIds(row);
    const attribution = !earns ? 'none' : linked.length ? 'linked' : 'week';

    return {
      sessionId: row.session_id,
      date: row.session_date,
      week: row.session_date ? weekStartOf(row.session_date) : null,
      channel: row.channel,
      purpose,
      clientName: row.client_name || '',
      stage: row.stage,
      pitmaster: row.pitmaster || '',
      materialId: row.source_material_id,
      materialName: row.source_material_name || row.source_material_id,
      productId,
      productName: config?.productName || productId || '',
      category: category || null,
      categoryLabel: config?.label || row.source_material_name || 'Other',
      outputType: row.output_type || '',
      rawKg,
      rate:
        rate.perKg != null
          ? {
              perKg: round2(rate.perKg),
              source: rate.source,
              ref: rate.ref,
              asOf: rate.asOf,
            }
          : null,
      rateGap: rate.perKg != null ? null : rate.gap,
      meatCost: meatCost == null ? null : round2(meatCost),
      otherSpend,
      otherSpendTotal: round2(otherSpendTotal),
      // What is known of the cook's cost. Null only when the meat itself could
      // not be priced — then there is no honest total to show.
      knownCost: meatCost == null ? null : round2(meatCost + otherSpendTotal),
      plannedYieldPct,
      actualYieldPct,
      finishedKg: finishedKg == null ? null : round2(finishedKg),
      finishedSource,
      costPerFinishedKg: perFinishedKg == null ? null : round2(perFinishedKg),
      plannedCostPerFinishedKg: plannedPerFinishedKg == null ? null : round2(plannedPerFinishedKg),
      portions,
      rubRecipe: row.rub_recipe_name || '',
      brineRecipe: row.brine_recipe_name || '',
      attribution,
      attributionNote: !earns
        ? row.channel === 'B2B'
          ? 'Wholesale cook — billed by the kilo on the invoice book, not by the plate'
          : `${purpose} cook — nothing was sold from it`
        : '',
      linkedOrderIds: linked,
    };
  });

  // ---- Pass 2: who claims which order line ---------------------------------
  //
  // One claim per (order, product): every session that could have fed it.
  // Linked claims beat inferred ones outright; what is left is split by raw
  // weight.
  const claims = new Map();
  const claim = (orderId, productId, session, explicit) => {
    const key = `${orderId}|${productId}`;
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push({ session, explicit });
  };
  for (const session of rows) {
    if (session.attribution === 'none' || !session.productId) continue;
    if (session.attribution === 'linked') {
      for (const orderId of session.linkedOrderIds) claim(orderId, session.productId, session, true);
    } else {
      for (const [orderId, lines] of ordersById) {
        if (weekStartOf(lines[0].promisedDay || lines[0].day) === session.week)
          claim(orderId, session.productId, session, false);
      }
    }
  }

  const credit = new Map(
    rows.map((session) => [
      session.sessionId,
      { orders: new Set(), plates: 0, grams: 0, revenue: 0, dishes: new Map() },
    ]),
  );
  const sessionsByOrder = new Map();
  for (const [key, list] of claims) {
    const [orderIdText, productId] = key.split('|');
    const orderId = Number(orderIdText);
    const lines = ordersById.get(orderId);
    if (!lines) continue; // linked to an order outside the range read
    const winners = list.some((entry) => entry.explicit) ? list.filter((entry) => entry.explicit) : list;
    const weight = winners.reduce((total, entry) => total + (entry.session.rawKg || 0), 0);

    for (const line of lines) {
      const grams = line.itemId ? productGrams.get(line.itemId)?.get(productId) : null;
      if (!grams) continue;
      // A dish with two smoked products on it (none today) gives each of them
      // its share of the line by weight, so the line is not credited twice.
      const allGrams = [...(productGrams.get(line.itemId)?.values() || [])].reduce((total, value) => total + value, 0);
      const lineShare = grams / allGrams;
      for (const entry of winners) {
        const share = weight > 0 ? (entry.session.rawKg || 0) / weight : 1 / winners.length;
        const target = credit.get(entry.session.sessionId);
        target.orders.add(orderId);
        target.plates += line.quantity * share;
        target.grams += line.quantity * grams * share;
        target.revenue += line.revenue * lineShare * share;
        const dishName = dishes.get(line.itemId)?.name || line.productName;
        const dish = target.dishes.get(line.itemId) || {
          itemId: line.itemId,
          name: dishName,
          plates: 0,
          revenue: 0,
        };
        dish.plates += line.quantity * share;
        dish.revenue += line.revenue * lineShare * share;
        target.dishes.set(line.itemId, dish);
        if (!sessionsByOrder.has(orderId)) sessionsByOrder.set(orderId, []);
        if (!sessionsByOrder.get(orderId).includes(entry.session.sessionId)) {
          sessionsByOrder.get(orderId).push(entry.session.sessionId);
        }
      }
    }
  }

  const sessionRows = rows
    .map(({ linkedOrderIds: _linked, ...session }) => {
      const earned = credit.get(session.sessionId);
      const finishedGrams = session.finishedKg ? session.finishedKg * 1000 : null;
      return {
        ...session,
        orders: earned.orders.size,
        plates: round2(earned.plates),
        gramsSold: round0(earned.grams),
        // How much of what came out of the smoker went into an order. Under
        // 100% is leftover, staff food or waste; over 100% means the orders
        // were fed from more than this one cook, or the finished weight is off.
        sellThroughPct: finishedGrams ? pct(earned.grams, finishedGrams) : null,
        revenue: round0(earned.revenue),
        knownCostPct: session.knownCost != null ? pct(session.knownCost, earned.revenue) : null,
        // The cook's whole meat bill over the plates it actually fed —
        // leftover included, which is the point. Against the plan's meat cost
        // per plate this is what yield and waste cost, in rupees a plate.
        meatCostPerPlate:
          session.meatCost != null && earned.plates > 0 ? round2(session.meatCost / earned.plates) : null,
        dishes: [...earned.dishes.values()]
          .map((dish) => ({
            ...dish,
            plates: round2(dish.plates),
            revenue: round0(dish.revenue),
          }))
          .sort((a, b) => b.plates - a.plates),
      };
    })
    .sort(
      (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.sessionId).localeCompare(String(a.sessionId)),
    );

  return {
    sessions: sessionRows,
    sessionsByOrder,
    summary: summarise(sessionRows),
  };
}

// ---- The consolidated view ---------------------------------------------------
//
// Totals across every session in the range, and the same again per meat. Per
// meat because a kilo of ribs and a kilo of pork shoulder are different
// economics — an average cost per finished kilo across both would describe
// neither.
function summarise(sessions) {
  const sum = (list, field) => list.reduce((total, session) => total + (session[field] || 0), 0);
  const priced = sessions.filter((session) => session.meatCost != null);

  const byMeat = new Map();
  for (const session of sessions) {
    const key = session.category || session.materialId || 'other';
    if (!byMeat.has(key)) byMeat.set(key, []);
    byMeat.get(key).push(session);
  }

  const meatRows = [...byMeat.entries()].map(([key, list]) => {
    const pricedList = list.filter((session) => session.meatCost != null && session.finishedKg);
    const recorded = list.filter((session) => session.finishedSource === 'recorded' && session.rawKg);
    const rawKg = sum(list, 'rawKg');
    const meatCost = sum(pricedList, 'meatCost');
    const finishedKg = sum(pricedList, 'finishedKg');
    const plates = sum(list, 'plates');
    const revenue = sum(list, 'revenue');
    const pricedRaw = sum(pricedList, 'rawKg');
    // Per-plate figures over the priced sessions' plates only: an unpriced
    // cook's plates on the bottom of the fraction with none of its rupees on
    // top would make the meat look cheaper than it was.
    const pricedPlates = sum(pricedList, 'plates');
    return {
      key,
      label: list[0].categoryLabel,
      material: list[0].materialName,
      sessions: list.length,
      rawKg: round2(rawKg),
      meatCost: round2(meatCost),
      // Weighted by kilo, not averaged across sessions — a 5 kg cook bought at
      // one rate and a 1 kg cook at another did not cost the average of the two.
      avgRatePerKg: pricedRaw > 0 ? round2(meatCost / pricedRaw) : null,
      plannedYieldPct: list[0].plannedYieldPct,
      realisedYieldPct: recorded.length ? round2((sum(recorded, 'finishedKg') / sum(recorded, 'rawKg')) * 100) : null,
      sessionsWeighed: recorded.length,
      costPerFinishedKg: finishedKg > 0 ? round2(meatCost / finishedKg) : null,
      plates: round2(plates),
      revenue: round0(revenue),
      meatCostPerPlate: pricedPlates > 0 ? round2(meatCost / pricedPlates) : null,
      unpriced: list.length - pricedList.length,
    };
  });
  meatRows.sort((a, b) => b.meatCost - a.meatCost || a.label.localeCompare(b.label));

  const revenue = sum(sessions, 'revenue');
  const knownCost = sum(priced, 'knownCost');
  // Same rule as the per-plate figures: the share is over the revenue of the
  // cooks whose cost is known, not all of it.
  const pricedRevenue = sum(priced, 'revenue');
  return {
    sessions: sessions.length,
    sessionsPriced: priced.length,
    sessionsWeighed: sessions.filter((session) => session.finishedSource === 'recorded').length,
    sessionsEarning: sessions.filter((session) => session.attribution !== 'none').length,
    rawKg: round2(sum(sessions, 'rawKg')),
    meatCost: round2(sum(priced, 'meatCost')),
    otherSpend: round2(sum(sessions, 'otherSpendTotal')),
    knownCost: round2(knownCost),
    finishedKg: round2(sum(priced, 'finishedKg')),
    plates: round2(sum(sessions, 'plates')),
    revenue: round0(revenue),
    knownCostPct: pct(knownCost, pricedRevenue),
    byMeat: meatRows,
  };
}

export { costSessions, meatRate, productOf, finishedKgOf, linkedOrderIds };
