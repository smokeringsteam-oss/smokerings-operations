import React, { useEffect, useMemo, useState } from 'react';

// Smoking Session — a sequential flow against smoking_log.csv
// (see server/ops/shared/smoking.js), one row per session moving through: rub (created
// as "brining") -> ready_to_smoke -> smoking -> resting -> shredding ->
// completed. Brining/Rub/Resting/Shredding are each logged in one pass
// (their own start+end together); Smoking is logged twice (start, then
// finish) since a smoke genuinely spans hours. Recipe choices for
// Brining/Rub come from recipes.csv (see /api/smoking/recipes).
// Shredding only happens for sessions whose final output is "Pulled" (set
// in the Brining step) — everything else (whole chicken served bone-in,
// ribs, burnt ends, ...) completes straight off of Resting.

type MeatItem = { material_id: string; item_name: string; unit_of_measure: string };
type Recipe = { recipe_id: string; recipe_name: string; kind: string };

type Session = {
  session_id: string;
  channel: string;
  session_purpose: string;
  // Which B2B account this cook is for — blank on B2C, and blank on a
  // speculative B2B sample nobody's asked for yet. Purchases tagged to the
  // session inherit it, which is how meat spend reaches the client book.
  client_id: string;
  client_name: string;
  source_material_id: string;
  source_material_name: string;
  output_type: string;
  pitmaster: string;
  brine_recipe_name: string;
  brine_start: string;
  brine_end: string;
  rub_recipe_name: string;
  rub_start: string;
  rub_end: string;
  raw_weight_kg: string;
  source_purchase_id: string;
  smoking_start: string;
  smoking_end: string;
  finished_weight_with_bone_kg: string;
  finished_weight_without_bone_kg: string;
  rest_start: string;
  rest_end: string;
  shred_start: string;
  shred_end: string;
  tenderness_notes: string;
  smoke_rings_formed: string;
  bark_notes: string;
  juiciness: string;
  fed_order_refs: string;
  stage: string;
};

// A purchase_log.csv lot available to source a session's raw weight from — see
// GET /api/smoking/purchases-for-material (server/ops/shared/smoking.js
// getAvailablePurchasesForMaterial). `remaining` already nets out whatever
// other sessions have claimed from that same lot.
type Purchase = {
  purchase_id: string;
  purchase_date: string;
  vendor_name: string;
  quantity_purchased: number;
  unit_of_measure: string;
  remaining: number;
};

// A purchase_log.csv line this cook could be charged with — see
// GET /api/smoking/sessions/:id/taggable-purchases (server/ops/shared/smoking.js
// getTaggablePurchases). Wider than Purchase above on purpose: that list
// answers "where did the raw weight come from" so it's one meat item only,
// this one answers "what did this cook cost" and so includes the rub spices
// and the packaging bought on the same run.
type TaggablePurchase = {
  purchase_id: string;
  purchase_date: string;
  vendor_name: string;
  item_name: string;
  quantity_purchased: number;
  unit_of_measure: string;
  total_cost: number | null;
  client_name: string;
  tagged: boolean;
  isSessionMaterial: boolean;
};

// One wholesale/corporate account, as GET /api/b2b/clients returns it.
type B2BClient = { id: string; name: string; stage: string };

// An Odoo confirmed order, as offered by the "Fed to these orders" picker —
// see GET /api/odoo/recent-orders (server/integrations/odoo.js fetchRecentOrders).
type RecentOrder = {
  id: number;
  name: string;
  customer: string;
  dateOrder: string;
  itemsSummary: string;
};

// Parses a session's fed_order_refs ("id:name;id:name") back into the shape
// the "Fed to these orders" picker works with — same round-trip
// setFedOrders() on the server writes.
const parseFedOrders = (raw: string): { id: number; name: string }[] =>
  (raw || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, ...rest] = s.split(':');
      return { id: Number(id), name: rest.join(':') };
    })
    .filter((o) => Number.isFinite(o.id) && o.name);

type StepId = 'marinate' | 'rub' | 'smoke' | 'rest' | 'shred';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'marinate', label: '1. Brining' },
  { id: 'rub', label: '2. Rub' },
  { id: 'smoke', label: '3. Smoking' },
  { id: 'rest', label: '4. Resting' },
  { id: 'shred', label: '5. Shredding' },
];

// What each step's tab is called, for the "done — go to the next step"
// banner that shows up once that step's log action succeeds — same wording
// whether the user gets there by clicking the banner's button or by
// clicking the next tab directly.
const STEP_LABEL: Record<StepId, string> = {
  marinate: 'Brining',
  rub: 'Rub',
  smoke: 'Smoking',
  rest: 'Resting',
  shred: 'Shredding',
};

// Replaces the plain "status-message" paragraph after a log action succeeds
// — pairs the confirmation text with an unmissable primary-styled button
// straight to the next step, instead of a small button underneath that's
// easy to read past. The user can still click the next tab directly too;
// both land on the same place.
const StepDoneBanner: React.FC<{ message: string; next: StepId; label?: string; onAdvance: (id: StepId) => void }> = ({
  message,
  next,
  label,
  onAdvance,
}) => (
  <div className="step-next-banner">
    <p>✅ {message}</p>
    <button type="button" className="primary-button" onClick={() => onAdvance(next)}>
      {label || `Go to ${STEP_LABEL[next]} step →`}
    </button>
  </div>
);

const STAGE_LABELS: Record<string, string> = {
  rub: 'Waiting for rub',
  ready_to_smoke: 'Rubbed — ready to smoke',
  smoking: 'On the smoker',
  resting: 'Resting',
  shredding: 'Waiting to shred',
  completed: 'Completed',
};

const SMOKE_RINGS_OPTIONS = ['Yes', 'Partial', 'No'];
const JUICINESS_OPTIONS = ['Very juicy', 'Juicy', 'Balanced', 'Slightly dry', 'Dry'];
// Which side of the business the cook is for, and why it's being cooked —
// two separate fields (see the CHANNELS/SESSION_PURPOSES note in
// server/ops/shared/smoking.js). B2B runs the exact same stage flow as B2C; the pair of
// values is what tells a weekend service cook apart from a sample tray for a
// wholesale account or a pure practice run.
const CHANNEL_OPTIONS = ['B2C', 'B2B'] as const;
type Channel = (typeof CHANNEL_OPTIONS)[number];
const PURPOSE_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'Order', label: 'Order', hint: 'Feeding real orders.' },
  { value: 'Sample', label: 'Sample', hint: 'A tasting tray for an account to try — no order behind it yet.' },
  { value: 'Practice', label: 'Practice', hint: 'Skill practice or recipe testing. Feeds nobody.' },
];
// What the purpose picker starts on per channel — mirrors
// DEFAULT_PURPOSE_BY_CHANNEL in server/ops/shared/smoking.js.
const DEFAULT_PURPOSE: Record<Channel, string> = { B2C: 'Order', B2B: 'Sample' };
// Pre-split rows put "Practising Session" in the channel column and had no
// purpose of their own — same fallback as purposeOf() on the server.
const purposeOf = (s: Session) => s.session_purpose || (s.channel === 'Practising Session' ? 'Practice' : 'Order');
// How a session is labelled everywhere it's listed: "B2B · Sample", or
// "B2B · Sample · Taj Hotel" once there's an account behind it. Appended
// rather than swapped in, because which side of the business and which
// account are both worth seeing in a dropdown of half a dozen cooks.
const channelTag = (s: Session) =>
  [s.channel || '—', purposeOf(s), ...(s.client_name ? [s.client_name] : [])].join(' · ');

// Only sessions whose final product is "Pulled" (pulled chicken/pork for
// burgers, tacos, quesadillas) go through the Shredding step — everything
// else (whole chicken served bone-in, ribs, burnt ends, ...) completes
// straight off of Resting instead. See needsShredding() in server/ops/shared/smoking.js.
const OUTPUT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Pulled', label: 'Pulled (needs shredding)' },
  { value: 'Whole/Sliced', label: 'Whole / sliced (no shredding)' },
];

// Best-guess default so the dropdown doesn't start empty. The brine/rub
// recipe is the stronger signal where one's picked — e.g. "Chicken fillet
// rub/brine" means it's headed for pulled chicken, "Chicken leg rub/brine"
// means it's going out bone-in — so that wins when it names either prep.
// Falls back to the meat item otherwise (ribs/belly are never shredded,
// everything else defaults to Pulled). Either way it's just a default —
// the pitmaster can still switch the Final output dropdown by hand.
const guessOutputType = (itemName: string, recipeName?: string) => {
  const recipe = (recipeName || '').toLowerCase();
  if (recipe.includes('fillet')) return 'Pulled';
  if (recipe.includes('leg')) return 'Whole/Sliced';
  const item = itemName.toLowerCase();
  return item.includes('rib') || item.includes('belly') ? 'Whole/Sliced' : 'Pulled';
};

const outputTag = (s: Session) => (s.output_type === 'Whole/Sliced' ? ' · whole/sliced' : ' · pulled');

const nowLocal = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function readJson<T>(resp: Response): Promise<T> {
  try {
    return await resp.json();
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
}

// `channel` sets which side of the business new sessions default to — the
// B2C dashboard renders this as-is, the B2B one passes channel="B2B" (same
// prop pattern as <MenuItems channel="b2c" />). It's a default, not a filter:
// every stage list and the sessions table still show both channels' cooks,
// because one smoker runs both and a session hidden from the board is a
// session that gets forgotten mid-cook. Each row is tagged instead.
const SmokingSession: React.FC<{ channel?: Channel }> = ({ channel: defaultChannel = 'B2C' }) => {
  const [step, setStep] = useState<StepId>('marinate');

  const [meatItems, setMeatItems] = useState<MeatItem[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState('');

  // ---- Step 1: Brining (creates the session) ---------------------------------
  // materialId/outputType hold the meat currently being picked; adding it to
  // the batch stashes it in brineCart and clears these so another meat can
  // be picked. Submitting sends brineCart plus whatever's still in the
  // pickers (so a single-meat session doesn't require an extra click).
  const [materialId, setMaterialId] = useState('');
  const [outputType, setOutputType] = useState('Pulled');
  const [brineCart, setBrineCart] = useState<{ key: string; materialId: string; itemName: string; outputType: string }[]>([]);
  const [channel, setChannel] = useState<Channel>(defaultChannel);
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE[defaultChannel]);
  // Only fetched and only offered for B2B cooks — B2C has no account book.
  const [clients, setClients] = useState<B2BClient[]>([]);
  const [clientId, setClientId] = useState('');
  const [pitmaster, setPitmaster] = useState('Adarsh');
  const [brineRecipe, setBrineRecipe] = useState('');
  const [brineStart, setBrineStart] = useState(nowLocal());
  const [brineEnd, setBrineEnd] = useState(nowLocal());
  const [marinateBusy, setMarinateBusy] = useState(false);
  const [marinateStatus, setMarinateStatus] = useState('');
  const [marinateError, setMarinateError] = useState('');

  // ---- Step 2: Rub -----------------------------------------------------------
  const [rubSessionId, setRubSessionId] = useState('');
  const [rubRecipe, setRubRecipe] = useState('');
  const [rubStart, setRubStart] = useState(nowLocal());
  const [rubEnd, setRubEnd] = useState(nowLocal());
  const [rubBusy, setRubBusy] = useState(false);
  const [rubStatus, setRubStatus] = useState('');
  const [rubError, setRubError] = useState('');

  // ---- Step 3: Smoking (start, then finish) ---------------------------------
  const [smokeStartSessionId, setSmokeStartSessionId] = useState('');
  const [rawWeightKg, setRawWeightKg] = useState('');
  const [smokingStart, setSmokingStart] = useState(nowLocal());
  const [smokeStartBusy, setSmokeStartBusy] = useState(false);
  const [smokeStartStatus, setSmokeStartStatus] = useState('');
  const [smokeStartError, setSmokeStartError] = useState('');
  // Which purchase_log.csv lot this session's raw weight is being sourced from
  // — reloaded every time the selected session changes, since it's keyed off
  // that session's meat item.
  const [availablePurchases, setAvailablePurchases] = useState<Purchase[]>([]);
  const [purchasesLoading, setPurchasesLoading] = useState(false);
  const [purchasesError, setPurchasesError] = useState('');
  const [sourcePurchaseId, setSourcePurchaseId] = useState('');
  // The separate cost-attribution pick: which buys this cook was for. Kept
  // apart from sourcePurchaseId above because they answer different questions
  // — see the comment on TaggablePurchase.
  const [taggable, setTaggable] = useState<TaggablePurchase[]>([]);
  const [taggedIds, setTaggedIds] = useState<string[]>([]);
  const [taggableLoading, setTaggableLoading] = useState(false);
  const [taggableError, setTaggableError] = useState('');

  const [smokeFinishSessionId, setSmokeFinishSessionId] = useState('');
  const [smokingEnd, setSmokingEnd] = useState(nowLocal());
  const [finishedWithBone, setFinishedWithBone] = useState('');
  const [finishedWithoutBone, setFinishedWithoutBone] = useState('');
  const [smokeFinishBusy, setSmokeFinishBusy] = useState(false);
  const [smokeFinishStatus, setSmokeFinishStatus] = useState('');
  const [smokeFinishError, setSmokeFinishError] = useState('');

  // ---- Step 4: Resting --------------------------------------------------------
  const [restSessionId, setRestSessionId] = useState('');
  const [restStart, setRestStart] = useState(nowLocal());
  const [restEnd, setRestEnd] = useState(nowLocal());
  // Only asked for sessions that skip Shredding (output_type !== 'Pulled') —
  // for those, resting is the last touchpoint, so the tasting notes normally
  // captured at Shredding are captured here instead.
  const [restTendernessNotes, setRestTendernessNotes] = useState('');
  const [restSmokeRingsFormed, setRestSmokeRingsFormed] = useState('');
  const [restBarkNotes, setRestBarkNotes] = useState('');
  const [restJuiciness, setRestJuiciness] = useState('');
  const [restBusy, setRestBusy] = useState(false);
  const [restStatus, setRestStatus] = useState('');
  const [restError, setRestError] = useState('');
  // Whether the session that was just rested still has a Shredding step
  // ahead of it, or completed right here — decides what the "Next step"
  // button (if any) offers, since resting itself no longer tells us once
  // the session has moved on to the next stage.
  const [restJustCompleted, setRestJustCompleted] = useState(false);

  // ---- Step 5: Shredding (completes the session) -----------------------------
  const [shredSessionId, setShredSessionId] = useState('');
  const [shredStart, setShredStart] = useState(nowLocal());
  const [shredEnd, setShredEnd] = useState(nowLocal());
  const [tendernessNotes, setTendernessNotes] = useState('');
  const [smokeRingsFormed, setSmokeRingsFormed] = useState('');
  const [barkNotes, setBarkNotes] = useState('');
  const [juiciness, setJuiciness] = useState('');
  const [shredBusy, setShredBusy] = useState(false);
  const [shredStatus, setShredStatus] = useState('');
  const [shredError, setShredError] = useState('');

  // ---- Delete a session --------------------------------------------------
  const [deletingId, setDeletingId] = useState('');
  const [deleteError, setDeleteError] = useState('');

  // ---- "Fed to these orders" — link a session to what it fed -------------
  // Not tied to any stage — usually filled in once packing happens, which is
  // often well after the session itself completed, so this opens from the
  // "All sessions" table rather than one of the wizard steps. `linkingId`
  // holds which session's panel is open (only one at a time).
  const [linkingId, setLinkingId] = useState('');
  const [linkFrom, setLinkFrom] = useState('');
  const [linkTo, setLinkTo] = useState('');
  const [linkOrders, setLinkOrders] = useState<RecentOrder[]>([]);
  const [linkChecked, setLinkChecked] = useState<Set<number>>(new Set());
  const [linkFetchBusy, setLinkFetchBusy] = useState(false);
  const [linkSaveBusy, setLinkSaveBusy] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkFetched, setLinkFetched] = useState(false);

  const loadMeatItems = async () => {
    try {
      const resp = await fetch('/api/smoking/meat-items');
      const data = await readJson<{ items?: MeatItem[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to load meat items.');
      setMeatItems(data.items || []);
    } catch (err) {
      setLoadError(String((err as Error).message || err));
    }
  };

  const loadSessions = async () => {
    try {
      const resp = await fetch('/api/smoking/sessions');
      const data = await readJson<{ sessions?: Session[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to load smoking sessions.');
      setSessions(data.sessions || []);
    } catch (err) {
      setLoadError(String((err as Error).message || err));
    }
  };

  const loadRecipes = async () => {
    try {
      const resp = await fetch('/api/smoking/recipes');
      const data = await readJson<{ recipes?: Recipe[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to load recipes.');
      setRecipes(data.recipes || []);
    } catch (err) {
      setLoadError(String((err as Error).message || err));
    }
  };

  useEffect(() => {
    loadMeatItems();
    loadSessions();
    loadRecipes();
  }, []);

  // The B2B account list, for tagging a cook to the client it's for. An
  // optional extra on top of the cook itself, so a failed load just hides the
  // picker rather than blocking the whole screen.
  useEffect(() => {
    fetch('/api/b2b/clients')
      .then((resp) => (resp.ok ? resp.json() : Promise.reject(new Error('failed'))))
      .then((data: { clients?: B2BClient[] }) => setClients(data.clients || []))
      .catch(() => setClients([]));
  }, []);

  const brineRecipes = useMemo(() => recipes.filter((r) => r.kind === 'Brine'), [recipes]);
  const rubRecipes = useMemo(() => recipes.filter((r) => r.kind === 'Rub'), [recipes]);

  const byStage = (stageName: string) => sessions.filter((s) => s.stage === stageName);
  const awaitingRub = useMemo(() => byStage('rub'), [sessions]);
  const readyToSmoke = useMemo(() => byStage('ready_to_smoke'), [sessions]);
  // The session the Start-smoking step is pointed at, for the bits of the
  // form that need more than its id (the client it's for).
  const smokeStartSession = useMemo(
    () => readyToSmoke.find((s) => s.session_id === smokeStartSessionId),
    [readyToSmoke, smokeStartSessionId],
  );
  const onSmoker = useMemo(() => byStage('smoking'), [sessions]);
  const resting = useMemo(() => byStage('resting'), [sessions]);
  const awaitingShred = useMemo(() => byStage('shredding'), [sessions]);

  // Shredding only applies to sessions whose Brining-step output type is
  // "Pulled" (see needsShredding() in server/ops/shared/smoking.js) — if nothing
  // logged so far needs it, the Shredding tab/step is just noise, so it
  // only shows up once at least one session actually needs it.
  const anySessionNeedsShred = useMemo(() => sessions.some((s) => s.output_type !== 'Whole/Sliced'), [sessions]);
  const visibleSteps = useMemo(() => STEPS.filter((s) => s.id !== 'shred' || anySessionNeedsShred), [anySessionNeedsShred]);

  // If the step in view stops being relevant (e.g. that one Pulled session
  // got deleted), bounce back to Resting rather than leaving the user on a
  // step whose tab just disappeared.
  useEffect(() => {
    if (step === 'shred' && !anySessionNeedsShred) setStep('rest');
  }, [step, anySessionNeedsShred]);

  // Keep each step's selected session valid as the underlying lists change.
  useEffect(() => {
    if (rubSessionId && !awaitingRub.some((s) => s.session_id === rubSessionId)) setRubSessionId('');
  }, [awaitingRub, rubSessionId]);
  useEffect(() => {
    if (smokeStartSessionId && !readyToSmoke.some((s) => s.session_id === smokeStartSessionId)) setSmokeStartSessionId('');
  }, [readyToSmoke, smokeStartSessionId]);
  useEffect(() => {
    if (smokeFinishSessionId && !onSmoker.some((s) => s.session_id === smokeFinishSessionId)) setSmokeFinishSessionId('');
  }, [onSmoker, smokeFinishSessionId]);

  // Reloads the purchase-lot picker every time the session picked in "Start
  // smoking" changes — it's keyed off that session's meat item, and the
  // remaining-quantity numbers shift as other sessions claim lots.
  useEffect(() => {
    setSourcePurchaseId('');
    if (!smokeStartSessionId) {
      setAvailablePurchases([]);
      return;
    }
    const session = readyToSmoke.find((s) => s.session_id === smokeStartSessionId);
    if (!session) {
      setAvailablePurchases([]);
      return;
    }
    let cancelled = false;
    setPurchasesLoading(true);
    setPurchasesError('');
    fetch(
      `/api/smoking/purchases-for-material?materialId=${encodeURIComponent(session.source_material_id)}&excludeSessionId=${encodeURIComponent(smokeStartSessionId)}`,
    )
      .then((resp) => readJson<{ purchases?: Purchase[]; error?: string }>(resp).then((data) => ({ resp, data })))
      .then(({ resp, data }) => {
        if (!resp.ok) throw new Error(data.error || 'Failed to load purchases for this meat item.');
        if (!cancelled) setAvailablePurchases(data.purchases || []);
      })
      .catch((err) => {
        if (!cancelled) setPurchasesError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setPurchasesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smokeStartSessionId]);

  // The other purchase list for the same session — the "what did this cook
  // cost" checklist. Anything the server already has tagged to this session
  // starts ticked, so re-opening the step doesn't look like the tags were
  // never made.
  useEffect(() => {
    setTaggedIds([]);
    if (!smokeStartSessionId) {
      setTaggable([]);
      return;
    }
    let cancelled = false;
    setTaggableLoading(true);
    setTaggableError('');
    fetch(`/api/smoking/sessions/${encodeURIComponent(smokeStartSessionId)}/taggable-purchases`)
      .then((resp) => readJson<{ purchases?: TaggablePurchase[]; error?: string }>(resp).then((data) => ({ resp, data })))
      .then(({ resp, data }) => {
        if (!resp.ok) throw new Error(data.error || 'Failed to load purchases to tag.');
        if (cancelled) return;
        const rows = data.purchases || [];
        setTaggable(rows);
        setTaggedIds(rows.filter((p) => p.tagged).map((p) => p.purchase_id));
      })
      .catch((err) => {
        if (!cancelled) setTaggableError(String((err as Error).message || err));
      })
      .finally(() => {
        if (!cancelled) setTaggableLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [smokeStartSessionId]);

  // Picking the sourced-from lot ticks it in the cost checklist too: a lot
  // this cook is literally eating is a cost of this cook, and the server
  // folds it in anyway (see startSmoking) — so showing it unticked would just
  // be the UI lying about what's about to be written.
  useEffect(() => {
    if (!sourcePurchaseId) return;
    setTaggedIds((current) => (current.includes(sourcePurchaseId) ? current : [...current, sourcePurchaseId]));
  }, [sourcePurchaseId]);

  useEffect(() => {
    if (restSessionId && !resting.some((s) => s.session_id === restSessionId)) setRestSessionId('');
  }, [resting, restSessionId]);
  useEffect(() => {
    if (shredSessionId && !awaitingShred.some((s) => s.session_id === shredSessionId)) setShredSessionId('');
  }, [awaitingShred, shredSessionId]);

  // Stashes the currently-picked meat into the batch and clears the pickers
  // so another one can be picked next.
  const handleAddMeatToBatch = () => {
    if (!materialId) return;
    const meat = meatItems.find((m) => m.material_id === materialId);
    if (!meat) return;
    setBrineCart((current) => [
      ...current,
      { key: `${materialId}-${Date.now()}-${Math.random()}`, materialId, itemName: meat.item_name, outputType },
    ]);
    setMaterialId('');
    setOutputType('Pulled');
  };

  const handleRemoveMeatFromBatch = (key: string) => {
    setBrineCart((current) => current.filter((line) => line.key !== key));
  };

  // Batch + whatever's still sitting in the pickers (unadded) — lets a
  // single-meat session skip the "+ Add another meat" click entirely.
  const pendingBatchCount = brineCart.length + (materialId ? 1 : 0);

  const handleMarinate = async () => {
    const lines = [
      ...brineCart.map(({ materialId: id, outputType: ot }) => ({ materialId: id, outputType: ot })),
      ...(materialId ? [{ materialId, outputType }] : []),
    ];
    if (!lines.length || marinateBusy) return;
    setMarinateBusy(true);
    setMarinateError('');
    setMarinateStatus('');
    try {
      const resp = await fetch('/api/smoking/sessions/marinate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Id only — the server resolves the account name off b2b_clients.csv,
        // and drops the tag entirely on a B2C cook.
        body: JSON.stringify({ lines, pitmaster, brineRecipe, brineStart, brineEnd, channel, purpose, clientId }),
      });
      const data = await readJson<{ sessions?: Session[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to start brining.');
      const started = data.sessions || [];
      setMarinateStatus(
        started.length > 1
          ? `Started ${started.length} sessions (${started.map((s) => s.session_id).join(', ')}) — on to the rub step.`
          : `Started session ${started[0]?.session_id} — on to the rub step.`,
      );
      setMaterialId('');
      setOutputType('Pulled');
      setBrineCart([]);
      setChannel(defaultChannel);
      setPurpose(DEFAULT_PURPOSE[defaultChannel]);
      setClientId('');
      setPitmaster('Adarsh');
      setBrineRecipe('');
      setBrineStart(nowLocal());
      setBrineEnd(nowLocal());
      await loadSessions();
    } catch (err) {
      setMarinateError(String((err as Error).message || err));
    } finally {
      setMarinateBusy(false);
    }
  };

  const handleRub = async () => {
    if (!rubSessionId || rubBusy) return;
    setRubBusy(true);
    setRubError('');
    setRubStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${rubSessionId}/rub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rubRecipe, rubStart, rubEnd }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to log the rub step.');
      setRubStatus(`Rub logged for ${data.session?.session_id} — ready to smoke.`);
      setRubRecipe('');
      setRubStart(nowLocal());
      setRubEnd(nowLocal());
      await loadSessions();
    } catch (err) {
      setRubError(String((err as Error).message || err));
    } finally {
      setRubBusy(false);
    }
  };

  const handleSmokeStart = async () => {
    if (!smokeStartSessionId || !rawWeightKg || smokeStartBusy) return;
    if (availablePurchases.length > 0 && !sourcePurchaseId) return;
    setSmokeStartBusy(true);
    setSmokeStartError('');
    setSmokeStartStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${smokeStartSessionId}/smoke-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawWeightKg, smokingStart, sourcePurchaseId, taggedPurchaseIds: taggedIds }),
      });
      const data = await readJson<{
        session?: Session;
        inventoryAdjustment?: { item_name: string; newQuantity: number; wentNegative: boolean } | null;
        purchaseWarning?: string | null;
        purchaseTags?: { tagged: string[]; untagged: string[]; skipped: { purchase_id: string; taggedTo: string }[] } | null;
        purchaseTagError?: string | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to start smoking.');
      let note = '';
      if (data.inventoryAdjustment) {
        note = data.inventoryAdjustment.wentNegative
          ? ` ⚠️ ${data.inventoryAdjustment.item_name} on-hand is now ${data.inventoryAdjustment.newQuantity}kg — check the purchase log.`
          : ` ${data.inventoryAdjustment.item_name} on-hand now ${data.inventoryAdjustment.newQuantity}kg.`;
      }
      if (data.purchaseWarning) note += ` ⚠️ ${data.purchaseWarning}`;
      const tagged = data.purchaseTags?.tagged?.length || 0;
      if (tagged) {
        note += ` ${tagged} purchase${tagged === 1 ? '' : 's'} tagged to this cook${
          data.session?.client_name ? ` for ${data.session.client_name}` : ''
        }.`;
      }
      // A line already claimed by an earlier cook is left alone rather than
      // stolen (see tagPurchasesToSession) — say so, since silently dropping
      // a tick the pitmaster deliberately made would be worse than the gap.
      const skipped = data.purchaseTags?.skipped || [];
      if (skipped.length) {
        note += ` ⚠️ Left alone (already tagged elsewhere): ${skipped
          .map((sk) => `${sk.purchase_id} → ${sk.taggedTo}`)
          .join(', ')}.`;
      }
      // The cook still started — say what didn't get recorded rather than
      // letting the pitmaster assume the spend was attributed.
      if (data.purchaseTagError) note += ` ⚠️ The cook started but its purchases weren't tagged: ${data.purchaseTagError}`;
      setSmokeStartStatus(`${data.session?.session_id} is on the smoker.${note}`);
      setRawWeightKg('');
      setSmokingStart(nowLocal());
      await loadSessions();
    } catch (err) {
      setSmokeStartError(String((err as Error).message || err));
    } finally {
      setSmokeStartBusy(false);
    }
  };

  const handleSmokeFinish = async () => {
    if (!smokeFinishSessionId || smokeFinishBusy) return;
    setSmokeFinishBusy(true);
    setSmokeFinishError('');
    setSmokeFinishStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${smokeFinishSessionId}/smoke-finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smokingEnd,
          finishedWeightWithBoneKg: finishedWithBone,
          finishedWeightWithoutBoneKg: finishedWithoutBone,
        }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to finish smoking.');
      setSmokeFinishStatus(`${data.session?.session_id} is off the smoker — on to resting.`);
      setSmokingEnd(nowLocal());
      setFinishedWithBone('');
      setFinishedWithoutBone('');
      await loadSessions();
    } catch (err) {
      setSmokeFinishError(String((err as Error).message || err));
    } finally {
      setSmokeFinishBusy(false);
    }
  };

  const restSelected = resting.find((s) => s.session_id === restSessionId);
  const restNeedsShred = !restSelected || restSelected.output_type !== 'Whole/Sliced';

  const handleRest = async () => {
    if (!restSessionId || restBusy) return;
    setRestBusy(true);
    setRestError('');
    setRestStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${restSessionId}/rest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restStart,
          restEnd,
          tendernessNotes: restTendernessNotes,
          smokeRingsFormed: restSmokeRingsFormed,
          barkNotes: restBarkNotes,
          juiciness: restJuiciness,
        }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to log resting.');
      const completed = data.session?.stage === 'completed';
      setRestJustCompleted(completed);
      setRestStatus(
        completed
          ? `Session ${data.session?.session_id} completed 🎉`
          : `Resting logged for ${data.session?.session_id} — ready to shred.`,
      );
      setRestStart(nowLocal());
      setRestEnd(nowLocal());
      setRestTendernessNotes('');
      setRestSmokeRingsFormed('');
      setRestBarkNotes('');
      setRestJuiciness('');
      await loadSessions();
    } catch (err) {
      setRestError(String((err as Error).message || err));
    } finally {
      setRestBusy(false);
    }
  };

  const handleShred = async () => {
    if (!shredSessionId || shredBusy) return;
    setShredBusy(true);
    setShredError('');
    setShredStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${shredSessionId}/shred`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shredStart, shredEnd, tendernessNotes, smokeRingsFormed, barkNotes, juiciness }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to complete the session.');
      setShredStatus(`Session ${data.session?.session_id} completed 🎉`);
      setShredStart(nowLocal());
      setShredEnd(nowLocal());
      setTendernessNotes('');
      setSmokeRingsFormed('');
      setBarkNotes('');
      setJuiciness('');
      await loadSessions();
    } catch (err) {
      setShredError(String((err as Error).message || err));
    } finally {
      setShredBusy(false);
    }
  };

  // Deletes a smoking_log.csv row entirely and — if the session
  // had already reached the smoking stage — reverses the inventory it
  // consumed (see server/ops/shared/smoking.js deleteSession).
  const handleDeleteSession = async (sessionId: string) => {
    if (deletingId) return;
    if (!window.confirm(`Delete session ${sessionId}? This also reverses any inventory it already consumed.`)) {
      return;
    }
    setDeletingId(sessionId);
    setDeleteError('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${sessionId}`, { method: 'DELETE' });
      const data = await readJson<{
        deleted?: Session;
        inventoryReversal?: { item_name: string; newQuantity: number } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to delete session.');
      await loadSessions();
    } catch (err) {
      setDeleteError(String((err as Error).message || err));
    } finally {
      setDeletingId('');
    }
  };

  // Shows every session, not just in-flight ones, so a completed session can
  // still be deleted (e.g. to correct a logging mistake). Already sorted
  // newest-first by getSessions().
  const allSessions = sessions;

  // Opens the "Fed to these orders" panel for one session — defaults the
  // date range to the last 14 days (batches are often smoked well ahead of
  // the orders that end up claiming them) and pre-checks whatever's already
  // linked so re-opening reads as "edit", not "start over".
  const handleOpenLinkOrders = (session: Session) => {
    setLinkingId(session.session_id);
    setLinkError('');
    setLinkOrders([]);
    setLinkFetched(false);
    setLinkChecked(new Set(parseFedOrders(session.fed_order_refs).map((o) => o.id)));
    const today = new Date();
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(today.getDate() - 14);
    setLinkTo(nowLocal().slice(0, 10));
    setLinkFrom(
      `${twoWeeksAgo.getFullYear()}-${String(twoWeeksAgo.getMonth() + 1).padStart(2, '0')}-${String(twoWeeksAgo.getDate()).padStart(2, '0')}`,
    );
  };

  const handleCloseLinkOrders = () => {
    setLinkingId('');
    setLinkOrders([]);
    setLinkError('');
  };

  const handleFetchLinkOrders = async () => {
    const session = allSessions.find((s) => s.session_id === linkingId);
    if (!session || !linkFrom || !linkTo || linkFetchBusy) return;
    setLinkFetchBusy(true);
    setLinkError('');
    try {
      const isCompany = session.channel === 'B2B';
      const resp = await fetch(`/api/odoo/recent-orders?from=${linkFrom}&to=${linkTo}&isCompany=${isCompany}`);
      const data = await readJson<{ orders?: RecentOrder[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to fetch orders from Odoo.');
      setLinkOrders(data.orders || []);
      setLinkFetched(true);
    } catch (err) {
      setLinkError(String((err as Error).message || err));
    } finally {
      setLinkFetchBusy(false);
    }
  };

  const handleToggleLinkOrder = (orderId: number) => {
    setLinkChecked((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const handleSaveLinkOrders = async () => {
    if (!linkingId || linkSaveBusy) return;
    setLinkSaveBusy(true);
    setLinkError('');
    try {
      // linkOrders only holds the last fetch's results — a checked order from
      // an earlier fetch (different date range) still needs to round-trip, so
      // fall back to its saved name for anything checked but not in view.
      const savedById = new Map(parseFedOrders(allSessions.find((s) => s.session_id === linkingId)?.fed_order_refs || '').map((o) => [o.id, o.name]));
      const byId = new Map(linkOrders.map((o) => [o.id, o.name]));
      const orders = Array.from(linkChecked).map((id) => ({ id, name: byId.get(id) || savedById.get(id) || `#${id}` }));
      const resp = await fetch(`/api/smoking/sessions/${linkingId}/fed-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to save linked orders.');
      handleCloseLinkOrders();
      await loadSessions();
    } catch (err) {
      setLinkError(String((err as Error).message || err));
    } finally {
      setLinkSaveBusy(false);
    }
  };

  return (
    <div className="wizard-page smoke-page">
      <div className="wizard-header">
        <h1>Smoking Session</h1>
        <p>Walk one batch through the full flow — brine, rub, smoke, rest, shred — a step at a time.</p>
      </div>

      {loadError && (
        <div className="prep-unmatched">
          <strong>Couldn't load the smoking catalog:</strong>
          <p>{loadError}</p>
        </div>
      )}

      <div className="wizard-steps smoke-steps">
        {visibleSteps.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`wizard-step ${step === s.id ? 'active' : ''}`}
            onClick={() => setStep(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="wizard-card">
        {step === 'marinate' && (
          <div>
            <h2>Start a session — Brining</h2>
            <p>
              Picks the meat, commits it against on-hand inventory, and opens a session for the Rub step. Brining
              several meats together? Add each one to the batch below — they'll share the pitmaster/brine
              recipe/timing, but move through Rub, Smoking, Resting and Shredding as their own sessions.
            </p>

            <div className="purch-form-row">
              <label>
                Meat item
                <select
                  value={materialId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setMaterialId(id);
                    const meat = meatItems.find((m) => m.material_id === id);
                    if (meat) setOutputType(guessOutputType(meat.item_name, brineRecipe));
                  }}
                >
                  <option value="">Select a cut…</option>
                  {meatItems.map((m) => (
                    <option key={m.material_id} value={m.material_id}>
                      {m.item_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Final output
                <select value={outputType} onChange={(e) => setOutputType(e.target.value)}>
                  {OUTPUT_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="wizard-actions-bottom">
              <button type="button" className="secondary-button small" onClick={handleAddMeatToBatch} disabled={!materialId}>
                + Add another meat to this batch
              </button>
            </div>

            {brineCart.length > 0 && (
              <div className="prep-table-wrap purch-cart-wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th className="prep-item-col">Item</th>
                      <th>Final output</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {brineCart.map((line) => (
                      <tr key={line.key}>
                        <td className="prep-item-col">{line.itemName}</td>
                        <td>{OUTPUT_TYPE_OPTIONS.find((o) => o.value === line.outputType)?.label || line.outputType}</td>
                        <td className="purch-remove-cell">
                          <button type="button" className="purch-remove-btn" onClick={() => handleRemoveMeatFromBatch(line.key)}>
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="purch-form-row">
              <label>
                Pitmaster
                <input value={pitmaster} onChange={(e) => setPitmaster(e.target.value)} placeholder="Pitmaster name" />
              </label>
              <label>
                Channel
                <select
                  value={channel}
                  onChange={(e) => {
                    const next = e.target.value as Channel;
                    setChannel(next);
                    // Switching side of the business resets the purpose to
                    // that side's normal case (B2C feeds orders, B2B starts
                    // with samples) rather than carrying the old one over.
                    setPurpose(DEFAULT_PURPOSE[next]);
                    // B2C cooks have no account to point at, and the server
                    // drops the tag anyway — clear it so the form doesn't
                    // show a client it isn't going to save.
                    if (next !== 'B2B') setClientId('');
                  }}
                >
                  {CHANNEL_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Purpose
                <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  {PURPOSE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="inv-section-hint">{PURPOSE_OPTIONS.find((o) => o.value === purpose)?.hint}</p>

            {channel === 'B2B' && clients.length > 0 && (
              <label>
                For client (optional)
                <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                  <option value="">Not for a specific account yet</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="inv-section-hint">
                  Who this cook is for. Purchases tagged to it at Start Smoking pick up the same account, which is
                  what puts the meat spend on their line of the book.
                </span>
              </label>
            )}

            <label>
              Brine recipe
              <select
                value={brineRecipe}
                onChange={(e) => {
                  const recipeName = e.target.value;
                  setBrineRecipe(recipeName);
                  const meat = meatItems.find((m) => m.material_id === materialId);
                  setOutputType(guessOutputType(meat?.item_name || '', recipeName));
                }}
              >
                <option value="">Select what was done…</option>
                {brineRecipes.map((r) => (
                  <option key={r.recipe_id} value={r.recipe_name}>
                    {r.recipe_name}
                  </option>
                ))}
              </select>
            </label>

            <div className="purch-form-row">
              <label>
                Brine start
                <input type="datetime-local" value={brineStart} onChange={(e) => setBrineStart(e.target.value)} />
              </label>
              <label>
                Brine end
                <input type="datetime-local" value={brineEnd} onChange={(e) => setBrineEnd(e.target.value)} />
              </label>
            </div>

            <div className="wizard-actions-bottom">
              <button
                type="button"
                className="primary-button"
                onClick={handleMarinate}
                disabled={(!materialId && brineCart.length === 0) || marinateBusy}
              >
                {marinateBusy
                  ? 'Starting…'
                  : pendingBatchCount > 1
                    ? `Start ${pendingBatchCount} sessions`
                    : 'Start session'}
              </button>
            </div>
            {marinateError && <p className="chat-error">{marinateError}</p>}
            {marinateStatus && !marinateError && (
              <StepDoneBanner message={marinateStatus} next="rub" onAdvance={setStep} />
            )}
          </div>
        )}

        {step === 'rub' && (
          <div>
            <h2>Rub</h2>
            <p>Log the rub for a session that's finished brining.</p>

            {awaitingRub.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🧂</div>
                <h3>Nothing waiting for a rub</h3>
                <p>Start a session in the Brining step first.</p>
              </div>
            ) : (
              <>
                <label>
                  Session
                  <select value={rubSessionId} onChange={(e) => setRubSessionId(e.target.value)}>
                    <option value="">Select a session…</option>
                    {awaitingRub.map((s) => (
                      <option key={s.session_id} value={s.session_id}>
                        {s.session_id} — {s.source_material_name}
                        {outputTag(s)} ({channelTag(s)}) — brined with {s.brine_recipe_name || 'unknown'}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Rub recipe
                  <select value={rubRecipe} onChange={(e) => setRubRecipe(e.target.value)}>
                    <option value="">Select what was done…</option>
                    {rubRecipes.map((r) => (
                      <option key={r.recipe_id} value={r.recipe_name}>
                        {r.recipe_name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="purch-form-row">
                  <label>
                    Rub start
                    <input type="datetime-local" value={rubStart} onChange={(e) => setRubStart(e.target.value)} />
                  </label>
                  <label>
                    Rub end
                    <input type="datetime-local" value={rubEnd} onChange={(e) => setRubEnd(e.target.value)} />
                  </label>
                </div>

                <div className="wizard-actions-bottom">
                  <button type="button" className="primary-button" onClick={handleRub} disabled={!rubSessionId || rubBusy}>
                    {rubBusy ? 'Saving…' : 'Log rub & move to smoking'}
                  </button>
                </div>
                {rubError && <p className="chat-error">{rubError}</p>}
                {rubStatus && !rubError && (
                  <StepDoneBanner message={rubStatus} next="smoke" onAdvance={setStep} />
                )}
              </>
            )}
          </div>
        )}

        {step === 'smoke' && (
          <div>
            <h2>Smoking</h2>
            <p>Two touchpoints — start it when the meat goes on, come back and finish it once it's off.</p>

            <h3 className="inv-section-title">Start smoking</h3>
            {readyToSmoke.length === 0 ? (
              <p className="inv-note">Nothing rubbed and ready yet — finish the Rub step first.</p>
            ) : (
              <>
                <div className="purch-form-row">
                  <label>
                    Session
                    <select value={smokeStartSessionId} onChange={(e) => setSmokeStartSessionId(e.target.value)}>
                      <option value="">Select a session…</option>
                      {readyToSmoke.map((s) => (
                        <option key={s.session_id} value={s.session_id}>
                          {s.session_id} — {s.source_material_name}
                          {outputTag(s)} ({channelTag(s)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Pre-smoked weight (kg)
                    <input type="number" min="0" step="any" value={rawWeightKg} onChange={(e) => setRawWeightKg(e.target.value)} />
                  </label>
                </div>

                {smokeStartSessionId && (
                  <label>
                    Sourced from purchase
                    {purchasesLoading ? (
                      <p className="inv-note">Loading purchases…</p>
                    ) : availablePurchases.length === 0 ? (
                      <p className="inv-note">
                        No purchase on file yet for this meat item — log one in Weekly Purchasing, or continue
                        without one (leaves this session unlinked to a purchase).
                      </p>
                    ) : (
                      <select value={sourcePurchaseId} onChange={(e) => setSourcePurchaseId(e.target.value)}>
                        <option value="">Select which purchase this came from…</option>
                        {availablePurchases.map((p) => (
                          <option key={p.purchase_id} value={p.purchase_id}>
                            {p.purchase_id} — {p.vendor_name || 'unknown vendor'} — {p.purchase_date} ({p.remaining}
                            {p.unit_of_measure || 'kg'} left)
                          </option>
                        ))}
                      </select>
                    )}
                    {purchasesError && <p className="chat-error">{purchasesError}</p>}
                  </label>
                )}

                {/* The cost side, kept separate from the lot picker above:
                    that one says where the raw weight came from, this one
                    says which buys this cook is answerable for — including
                    the rub spices and the packaging that never had a weight
                    of their own. Optional throughout; an untagged purchase is
                    general overhead, which is a real answer. */}
                {smokeStartSessionId && (
                  <div className="smoke-tag-panel">
                    <h3 className="inv-section-title">Tag purchases to this cook</h3>
                    {taggableLoading ? (
                      <p className="inv-note">Loading purchases…</p>
                    ) : taggable.length === 0 ? (
                      <p className="inv-note">
                        No untagged purchases logged in the three weeks before this session — nothing to attribute.
                      </p>
                    ) : (
                      <>
                        <p className="inv-section-hint">
                          What was bought for this cook. Ticked lines get stamped with {smokeStartSessionId}
                          {smokeStartSession?.client_name ? ` and attributed to ${smokeStartSession.client_name}` : ''}.
                        </p>
                        <ul className="smoke-tag-list">
                          {taggable.map((p) => (
                            <li key={p.purchase_id}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={taggedIds.includes(p.purchase_id)}
                                  onChange={(e) =>
                                    setTaggedIds((current) =>
                                      e.target.checked
                                        ? [...current, p.purchase_id]
                                        : current.filter((id) => id !== p.purchase_id),
                                    )
                                  }
                                />
                                <span>
                                  {p.item_name} — {p.quantity_purchased}
                                  {p.unit_of_measure} · {p.vendor_name || 'unknown vendor'} · {p.purchase_date}
                                  {p.total_cost != null ? ` · ₹${p.total_cost.toLocaleString('en-IN')}` : ''}
                                  {p.client_name ? ` · ${p.client_name}` : ''}
                                  {p.isSessionMaterial ? ' · this cook’s meat' : ''}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        <p className="inv-section-hint">
                          Tagged total:{' '}
                          ₹
                          {taggable
                            .filter((p) => taggedIds.includes(p.purchase_id))
                            .reduce((sum, p) => sum + (p.total_cost || 0), 0)
                            .toLocaleString('en-IN')}
                        </p>
                      </>
                    )}
                    {taggableError && <p className="chat-error">{taggableError}</p>}
                  </div>
                )}

                <label>
                  Smoking start
                  <input type="datetime-local" value={smokingStart} onChange={(e) => setSmokingStart(e.target.value)} />
                </label>
                <div className="wizard-actions-bottom">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleSmokeStart}
                    disabled={
                      !smokeStartSessionId ||
                      !rawWeightKg ||
                      smokeStartBusy ||
                      (availablePurchases.length > 0 && !sourcePurchaseId)
                    }
                  >
                    {smokeStartBusy ? 'Starting…' : 'Put it on the smoker'}
                  </button>
                </div>
                {smokeStartError && <p className="chat-error">{smokeStartError}</p>}
                {smokeStartStatus && !smokeStartError && <p className="status-message">{smokeStartStatus}</p>}
              </>
            )}

            <h3 className="inv-section-title">🔥 Currently smoking</h3>
            {onSmoker.length === 0 ? (
              <p className="inv-note">Nothing on the smoker right now.</p>
            ) : (
              <div className="prep-table-wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th className="prep-item-col">Item</th>
                      <th>Raw weight</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {onSmoker.map((s) => (
                      <tr key={s.session_id}>
                        <td className="prep-item-col">{s.source_material_name}</td>
                        <td className="prep-total-cell">{s.raw_weight_kg}kg</td>
                        <td>{s.smoking_start}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="inv-section-title">Finish smoking</h3>
            {onSmoker.length === 0 ? (
              <p className="inv-note">Nothing to finish yet.</p>
            ) : (
              <>
                <label>
                  Session
                  <select value={smokeFinishSessionId} onChange={(e) => setSmokeFinishSessionId(e.target.value)}>
                    <option value="">Select a session…</option>
                    {onSmoker.map((s) => (
                      <option key={s.session_id} value={s.session_id}>
                        {s.session_id} — {s.source_material_name}
                        {outputTag(s)} ({channelTag(s)}) — {s.raw_weight_kg}kg since {s.smoking_start}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="purch-form-row">
                  <label>
                    Smoking end
                    <input type="datetime-local" value={smokingEnd} onChange={(e) => setSmokingEnd(e.target.value)} />
                  </label>
                </div>
                <div className="purch-form-row">
                  <label>
                    Finished weight — with bone (kg)
                    <input type="number" min="0" step="any" value={finishedWithBone} onChange={(e) => setFinishedWithBone(e.target.value)} />
                  </label>
                  <label>
                    Finished weight — without bone (kg)
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={finishedWithoutBone}
                      onChange={(e) => setFinishedWithoutBone(e.target.value)}
                    />
                  </label>
                </div>
                <div className="wizard-actions-bottom">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleSmokeFinish}
                    disabled={!smokeFinishSessionId || smokeFinishBusy}
                  >
                    {smokeFinishBusy ? 'Saving…' : 'Take it off & move to resting'}
                  </button>
                </div>
                {smokeFinishError && <p className="chat-error">{smokeFinishError}</p>}
                {smokeFinishStatus && !smokeFinishError && (
                  <StepDoneBanner message={smokeFinishStatus} next="rest" onAdvance={setStep} />
                )}
              </>
            )}
          </div>
        )}

        {step === 'rest' && (
          <div>
            <h2>Resting</h2>
            <p>Log how long a session rested after coming off the smoker.</p>

            {resting.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🛌</div>
                <h3>Nothing resting</h3>
                <p>Finish a smoke in the Smoking step first.</p>
              </div>
            ) : (
              <>
                <label>
                  Session
                  <select value={restSessionId} onChange={(e) => setRestSessionId(e.target.value)}>
                    <option value="">Select a session…</option>
                    {resting.map((s) => (
                      <option key={s.session_id} value={s.session_id}>
                        {s.session_id} — {s.source_material_name}
                        {outputTag(s)} ({channelTag(s)}) — off the smoker at {s.smoking_end}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="purch-form-row">
                  <label>
                    Rest start
                    <input type="datetime-local" value={restStart} onChange={(e) => setRestStart(e.target.value)} />
                  </label>
                  <label>
                    Rest end
                    <input type="datetime-local" value={restEnd} onChange={(e) => setRestEnd(e.target.value)} />
                  </label>
                </div>

                {!restNeedsShred && (
                  <>
                    <p className="inv-note">
                      This session's final output doesn't get shredded — log how it turned out here to complete it.
                    </p>
                    <label>
                      Tenderness notes
                      <textarea rows={2} value={restTendernessNotes} onChange={(e) => setRestTendernessNotes(e.target.value)} />
                    </label>
                    <div className="purch-form-row">
                      <label>
                        Smoke rings formed
                        <select value={restSmokeRingsFormed} onChange={(e) => setRestSmokeRingsFormed(e.target.value)}>
                          <option value="">—</option>
                          {SMOKE_RINGS_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Juiciness
                        <select value={restJuiciness} onChange={(e) => setRestJuiciness(e.target.value)}>
                          <option value="">—</option>
                          {JUICINESS_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      Bark notes
                      <textarea rows={2} value={restBarkNotes} onChange={(e) => setRestBarkNotes(e.target.value)} />
                    </label>
                  </>
                )}

                <div className="wizard-actions-bottom">
                  <button type="button" className="primary-button" onClick={handleRest} disabled={!restSessionId || restBusy}>
                    {restBusy ? 'Saving…' : restNeedsShred ? 'Log rest & move to shredding' : 'Log rest & complete session'}
                  </button>
                </div>
                {restError && <p className="chat-error">{restError}</p>}
                {restStatus && !restError && (
                  restJustCompleted ? (
                    <StepDoneBanner message={restStatus} next="marinate" label="Start another session →" onAdvance={setStep} />
                  ) : (
                    <StepDoneBanner message={restStatus} next="shred" onAdvance={setStep} />
                  )
                )}
              </>
            )}
          </div>
        )}

        {step === 'shred' && (
          <div>
            <h2>Shredding</h2>
            <p>Final step for "Pulled" sessions — log shredding time and how the batch turned out.</p>

            {awaitingShred.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🍖</div>
                <h3>Nothing waiting to shred</h3>
                <p>Log a rest for a "Pulled" session in the Resting step first — other outputs complete there directly.</p>
              </div>
            ) : (
              <>
                <label>
                  Session
                  <select value={shredSessionId} onChange={(e) => setShredSessionId(e.target.value)}>
                    <option value="">Select a session…</option>
                    {awaitingShred.map((s) => (
                      <option key={s.session_id} value={s.session_id}>
                        {s.session_id} — {s.source_material_name} ({channelTag(s)})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="purch-form-row">
                  <label>
                    Shredding start
                    <input type="datetime-local" value={shredStart} onChange={(e) => setShredStart(e.target.value)} />
                  </label>
                  <label>
                    Shredding end
                    <input type="datetime-local" value={shredEnd} onChange={(e) => setShredEnd(e.target.value)} />
                  </label>
                </div>

                <label>
                  Tenderness notes
                  <textarea rows={2} value={tendernessNotes} onChange={(e) => setTendernessNotes(e.target.value)} />
                </label>

                <div className="purch-form-row">
                  <label>
                    Smoke rings formed
                    <select value={smokeRingsFormed} onChange={(e) => setSmokeRingsFormed(e.target.value)}>
                      <option value="">—</option>
                      {SMOKE_RINGS_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Juiciness
                    <select value={juiciness} onChange={(e) => setJuiciness(e.target.value)}>
                      <option value="">—</option>
                      {JUICINESS_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label>
                  Bark notes
                  <textarea rows={2} value={barkNotes} onChange={(e) => setBarkNotes(e.target.value)} />
                </label>

                <div className="wizard-actions-bottom">
                  <button type="button" className="primary-button" onClick={handleShred} disabled={!shredSessionId || shredBusy}>
                    {shredBusy ? 'Saving…' : 'Complete session'}
                  </button>
                </div>
                {shredError && <p className="chat-error">{shredError}</p>}
                {shredStatus && !shredError && (
                  <StepDoneBanner message={shredStatus} next="marinate" label="Start another session →" onAdvance={setStep} />
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="wizard-card">
        <h3 className="inv-section-title">📋 All sessions</h3>
        {deleteError && <p className="chat-error">{deleteError}</p>}
        {allSessions.length === 0 ? (
          <p className="inv-note">Nothing logged yet — start one in the Marinating step.</p>
        ) : (
          <div className="prep-table-wrap">
            <table className="prep-table">
              <thead>
                <tr>
                  <th className="prep-item-col">Item</th>
                  <th>Stage</th>
                  <th>Output</th>
                  <th>Channel · purpose</th>
                  <th>Pitmaster</th>
                  <th>Raw → Finished</th>
                  <th>Sourced from</th>
                  <th>Fed to</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {allSessions.map((s) => {
                  const fedOrders = parseFedOrders(s.fed_order_refs);
                  return (
                    <tr key={s.session_id}>
                      <td className="prep-item-col">
                        {s.session_id} — {s.source_material_name}
                      </td>
                      <td>
                        <span className="smoke-stage-badge">{STAGE_LABELS[s.stage] || s.stage}</span>
                      </td>
                      <td>{s.output_type || 'Pulled'}</td>
                      <td>{channelTag(s)}</td>
                      <td>{s.pitmaster || '—'}</td>
                      <td className="prep-total-cell">
                        {s.raw_weight_kg ? `${s.raw_weight_kg}kg` : '—'}
                        {s.finished_weight_with_bone_kg ? ` → ${s.finished_weight_with_bone_kg}kg (bone)` : ''}
                      </td>
                      <td>{s.source_purchase_id || '—'}</td>
                      <td>
                        {fedOrders.length > 0 ? fedOrders.map((o) => o.name).join(', ') : '—'}
                        {/* Only Order sessions feed a real order — sample trays
                            and practice cooks have nothing to link to. */}
                        {purposeOf(s) === 'Order' &&
                          s.stage !== 'rub' &&
                          s.stage !== 'ready_to_smoke' &&
                          s.stage !== 'smoking' && (
                          <>
                            {' '}
                            <button type="button" className="secondary-button small" onClick={() => handleOpenLinkOrders(s)}>
                              {fedOrders.length > 0 ? 'Edit' : 'Link orders'}
                            </button>
                          </>
                        )}
                      </td>
                      <td className="purch-remove-cell">
                        <button
                          type="button"
                          className="purch-remove-btn"
                          onClick={() => handleDeleteSession(s.session_id)}
                          disabled={deletingId === s.session_id}
                          title="Delete this session"
                        >
                          {deletingId === s.session_id ? '…' : '×'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {linkingId && (
          <div className="wizard-card smoke-link-orders-panel">
            <h3 className="inv-section-title">🔗 Fed to these orders — {linkingId}</h3>
            <p className="inv-section-hint">
              Fetch confirmed {allSessions.find((s) => s.session_id === linkingId)?.channel || 'B2C'} orders in
              a date range and check off which one(s) this batch's output went to.
            </p>
            <div className="purch-form-row">
              <label>
                From
                <input type="date" value={linkFrom} onChange={(e) => setLinkFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={linkTo} onChange={(e) => setLinkTo(e.target.value)} />
              </label>
            </div>
            <div className="wizard-actions-bottom">
              <button
                type="button"
                className="secondary-button"
                onClick={handleFetchLinkOrders}
                disabled={!linkFrom || !linkTo || linkFetchBusy}
              >
                {linkFetchBusy ? 'Fetching…' : 'Fetch orders'}
              </button>
            </div>
            {linkError && <p className="chat-error">{linkError}</p>}
            {linkFetched && linkOrders.length === 0 && !linkError && (
              <p className="inv-note">No confirmed orders found in that range.</p>
            )}
            {linkOrders.length > 0 && (
              <div className="prep-table-wrap purch-cart-wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th />
                      <th>Order</th>
                      <th>Customer</th>
                      <th>Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linkOrders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={linkChecked.has(o.id)}
                            onChange={() => handleToggleLinkOrder(o.id)}
                          />
                        </td>
                        <td className="prep-item-col">{o.name}</td>
                        <td>{o.customer}</td>
                        <td>{o.itemsSummary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="wizard-actions-bottom">
              <button type="button" className="primary-button" onClick={handleSaveLinkOrders} disabled={linkSaveBusy}>
                {linkSaveBusy ? 'Saving…' : `Save (${linkChecked.size} selected)`}
              </button>
              <button type="button" className="secondary-button" onClick={handleCloseLinkOrders}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmokingSession;
