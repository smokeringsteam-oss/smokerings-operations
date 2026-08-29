import React, { useEffect, useMemo, useState } from 'react';

// Smoking Session — a 6-touchpoint sequential flow against
// smoking_session_stages.csv (see server/smoking.js), one row per session
// moving through: rub (created as "brining") -> ready_to_smoke -> smoking ->
// resting -> shredding -> completed. Brining/Rub/Resting/Shredding are each
// logged in one pass (their own start+end together); Smoking is logged
// twice (start, then finish) since a smoke genuinely spans hours. Recipe
// choices for Brining/Rub come from rub_recipes.csv (see /api/smoking/recipes).

type MeatItem = { material_id: string; item_name: string; unit_of_measure: string };
type Recipe = { recipe_id: string; recipe_name: string; category: string };

type Session = {
  session_id: string;
  material_id: string;
  meat_item: string;
  pitmaster: string;
  brine_recipe: string;
  brine_start: string;
  brine_end: string;
  rub_recipe: string;
  rub_start: string;
  rub_end: string;
  raw_weight_kg: string;
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
  stage: string;
};

type StepId = 'marinate' | 'rub' | 'smoke' | 'rest' | 'shred';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'marinate', label: '1. Brining' },
  { id: 'rub', label: '2. Rub' },
  { id: 'smoke', label: '3. Smoking' },
  { id: 'rest', label: '4. Resting' },
  { id: 'shred', label: '5. Shredding' },
];

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

const SmokingSession: React.FC = () => {
  const [step, setStep] = useState<StepId>('marinate');

  const [meatItems, setMeatItems] = useState<MeatItem[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState('');

  // ---- Step 1: Brining (creates the session) ---------------------------------
  const [materialId, setMaterialId] = useState('');
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
  const [restBusy, setRestBusy] = useState(false);
  const [restStatus, setRestStatus] = useState('');
  const [restError, setRestError] = useState('');

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

  const brineRecipes = useMemo(() => recipes.filter((r) => r.category === 'Brine'), [recipes]);
  const rubRecipes = useMemo(() => recipes.filter((r) => r.category === 'Rub'), [recipes]);

  const byStage = (stageName: string) => sessions.filter((s) => s.stage === stageName);
  const awaitingRub = useMemo(() => byStage('rub'), [sessions]);
  const readyToSmoke = useMemo(() => byStage('ready_to_smoke'), [sessions]);
  const onSmoker = useMemo(() => byStage('smoking'), [sessions]);
  const resting = useMemo(() => byStage('resting'), [sessions]);
  const awaitingShred = useMemo(() => byStage('shredding'), [sessions]);

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
  useEffect(() => {
    if (restSessionId && !resting.some((s) => s.session_id === restSessionId)) setRestSessionId('');
  }, [resting, restSessionId]);
  useEffect(() => {
    if (shredSessionId && !awaitingShred.some((s) => s.session_id === shredSessionId)) setShredSessionId('');
  }, [awaitingShred, shredSessionId]);

  const handleMarinate = async () => {
    if (!materialId || marinateBusy) return;
    setMarinateBusy(true);
    setMarinateError('');
    setMarinateStatus('');
    try {
      const resp = await fetch('/api/smoking/sessions/marinate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materialId, pitmaster, brineRecipe, brineStart, brineEnd }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to start brining.');
      setMarinateStatus(`Started session ${data.session?.session_id} — on to the rub step.`);
      setMaterialId('');
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
    setSmokeStartBusy(true);
    setSmokeStartError('');
    setSmokeStartStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${smokeStartSessionId}/smoke-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawWeightKg, smokingStart }),
      });
      const data = await readJson<{
        session?: Session;
        inventoryAdjustment?: { item_name: string; newQuantity: number; wentNegative: boolean } | null;
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to start smoking.');
      let note = '';
      if (data.inventoryAdjustment) {
        note = data.inventoryAdjustment.wentNegative
          ? ` ⚠️ ${data.inventoryAdjustment.item_name} on-hand is now ${data.inventoryAdjustment.newQuantity}kg — check the purchase log.`
          : ` ${data.inventoryAdjustment.item_name} on-hand now ${data.inventoryAdjustment.newQuantity}kg.`;
      }
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

  const handleRest = async () => {
    if (!restSessionId || restBusy) return;
    setRestBusy(true);
    setRestError('');
    setRestStatus('');
    try {
      const resp = await fetch(`/api/smoking/sessions/${restSessionId}/rest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restStart, restEnd }),
      });
      const data = await readJson<{ session?: Session; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Failed to log resting.');
      setRestStatus(`Resting logged for ${data.session?.session_id} — ready to shred.`);
      setRestStart(nowLocal());
      setRestEnd(nowLocal());
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

  const activeSessions = sessions.filter((s) => s.stage !== 'completed');

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
        {STEPS.map((s) => (
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
            <p>Picks the meat, commits it against on-hand inventory, and opens a session for the Rub step.</p>

            <div className="purch-form-row">
              <label>
                Meat item
                <select value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                  <option value="">Select a cut…</option>
                  {meatItems.map((m) => (
                    <option key={m.material_id} value={m.material_id}>
                      {m.item_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Pitmaster
                <input value={pitmaster} onChange={(e) => setPitmaster(e.target.value)} placeholder="Pitmaster name" />
              </label>
            </div>

            <label>
              Brine recipe
              <select value={brineRecipe} onChange={(e) => setBrineRecipe(e.target.value)}>
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
              <button type="button" className="primary-button" onClick={handleMarinate} disabled={!materialId || marinateBusy}>
                {marinateBusy ? 'Starting…' : 'Start session'}
              </button>
            </div>
            {marinateError && <p className="chat-error">{marinateError}</p>}
            {marinateStatus && !marinateError && <p className="status-message">{marinateStatus}</p>}
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
                        {s.session_id} — {s.meat_item} — brined with {s.brine_recipe || 'unknown'}
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
                {rubStatus && !rubError && <p className="status-message">{rubStatus}</p>}
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
                          {s.session_id} — {s.meat_item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Pre-smoked weight (kg)
                    <input type="number" min="0" step="any" value={rawWeightKg} onChange={(e) => setRawWeightKg(e.target.value)} />
                  </label>
                </div>
                <label>
                  Smoking start
                  <input type="datetime-local" value={smokingStart} onChange={(e) => setSmokingStart(e.target.value)} />
                </label>
                <div className="wizard-actions-bottom">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleSmokeStart}
                    disabled={!smokeStartSessionId || !rawWeightKg || smokeStartBusy}
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
                        <td className="prep-item-col">{s.meat_item}</td>
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
                        {s.session_id} — {s.meat_item} — {s.raw_weight_kg}kg since {s.smoking_start}
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
                {smokeFinishStatus && !smokeFinishError && <p className="status-message">{smokeFinishStatus}</p>}
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
                        {s.session_id} — {s.meat_item} — off the smoker at {s.smoking_end}
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
                <div className="wizard-actions-bottom">
                  <button type="button" className="primary-button" onClick={handleRest} disabled={!restSessionId || restBusy}>
                    {restBusy ? 'Saving…' : 'Log rest & move to shredding'}
                  </button>
                </div>
                {restError && <p className="chat-error">{restError}</p>}
                {restStatus && !restError && <p className="status-message">{restStatus}</p>}
              </>
            )}
          </div>
        )}

        {step === 'shred' && (
          <div>
            <h2>Shredding</h2>
            <p>Final step — log shredding time and how the batch turned out.</p>

            {awaitingShred.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🍖</div>
                <h3>Nothing waiting to shred</h3>
                <p>Log a rest in the Resting step first.</p>
              </div>
            ) : (
              <>
                <label>
                  Session
                  <select value={shredSessionId} onChange={(e) => setShredSessionId(e.target.value)}>
                    <option value="">Select a session…</option>
                    {awaitingShred.map((s) => (
                      <option key={s.session_id} value={s.session_id}>
                        {s.session_id} — {s.meat_item}
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
                {shredStatus && !shredError && <p className="status-message">{shredStatus}</p>}
              </>
            )}
          </div>
        )}
      </div>

      <div className="wizard-card">
        <h3 className="inv-section-title">📋 All sessions in flight</h3>
        {activeSessions.length === 0 ? (
          <p className="inv-note">Nothing in progress — start one in the Marinating step.</p>
        ) : (
          <div className="prep-table-wrap">
            <table className="prep-table">
              <thead>
                <tr>
                  <th className="prep-item-col">Item</th>
                  <th>Stage</th>
                  <th>Pitmaster</th>
                  <th>Raw → Finished</th>
                </tr>
              </thead>
              <tbody>
                {activeSessions.map((s) => (
                  <tr key={s.session_id}>
                    <td className="prep-item-col">
                      {s.session_id} — {s.meat_item}
                    </td>
                    <td>
                      <span className="smoke-stage-badge">{STAGE_LABELS[s.stage] || s.stage}</span>
                    </td>
                    <td>{s.pitmaster || '—'}</td>
                    <td className="prep-total-cell">
                      {s.raw_weight_kg ? `${s.raw_weight_kg}kg` : '—'}
                      {s.finished_weight_with_bone_kg ? ` → ${s.finished_weight_with_bone_kg}kg (bone)` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmokingSession;
