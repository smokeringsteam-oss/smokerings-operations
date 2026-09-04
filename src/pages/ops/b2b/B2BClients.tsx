import React, { useCallback, useEffect, useMemo, useState } from 'react';

// B2B Clients — the account book behind the B2B Dashboard's Clients box.
//
// One card per account, ordered by pipeline stage (Lead → Sampling →
// Onboarding → Active), and everything about an account lives on its card:
// contact details, the meat it wants each week, how the sample tray landed,
// and the onboarding checklist. The two middle stages get their own panels
// because they're the ones with work attached — a card sitting in Sampling
// should be able to tell you what went out, when, and what came back without
// anyone opening a chat thread.
//
// Backend is server/ops/b2b/b2bClients.js (two knowledge-base CSVs). Meat categories
// are the same keys the prep planner uses, so the kg/week rollup at the top
// is directly comparable to the B2C "meat needed" tiles.

type Demand = {
  id: string;
  category: string;
  categoryLabel: string;
  qtyKg: number;
  cadence: string;
  kgPerWeek: number;
  notes: string;
};

type Client = {
  id: string;
  name: string;
  businessType: string;
  stage: string;
  contactName: string;
  contactRole: string;
  phone: string;
  email: string;
  area: string;
  address: string;
  gstin: string;
  leadSource: string;
  orderDay: string;
  notes: string;
  sampleSentOn: string;
  sampleItems: string[];
  sampleFeedback: string;
  sampleOutcome: string;
  onboardingSteps: string[];
  onboardingDone: number;
  onboardingTotal: number;
  priceList: string;
  paymentTerms: string;
  // The numeric half of the terms: how many days after delivery an invoice
  // for this account falls due. Sales & Payments computes every due date off
  // it, so a change here only affects invoices raised from now on — the ones
  // already on the book keep the date they were written with.
  paymentTermsDays: number;
  // The Odoo pricelist this account's rates come from. Sales & Payments
  // prices every invoice line off it; with none attached, lines fall back
  // to Odoo's list prices.
  odooPricelistId: string;
  odooPricelistName: string;
  odooPartnerId: string;
  onboardedOn: string;
  lostReason: string;
  demands: Demand[];
  kgPerWeek: number;
  adhocKg: number;
  updatedAt: string;
};

type Stage = { key: string; label: string; description: string };
type Step = { key: string; label: string; hint: string };
type Option = { key: string; label: string };
type Cadence = { key: string; label: string; perWeek: number };
type CategorySummary = {
  category: string;
  label: string;
  committedKgPerWeek: number;
  pipelineKgPerWeek: number;
  adhocKg: number;
  clients: number;
};

type ClientsResponse = {
  clients: Client[];
  summary: {
    byCategory: CategorySummary[];
    committedKgPerWeek: number;
    pipelineKgPerWeek: number;
    byStage: Record<string, number>;
  };
  stages: Stage[];
  onboardingSteps: Step[];
  sampleOutcomes: Option[];
  cadences: Cadence[];
  businessTypes: string[];
  categories: Option[];
  error?: string;
};

// Draft rows for the meat demand editor. qtyKg is a string while it's being
// typed so a half-typed "1." doesn't get coerced to 1 under the cursor.
type DemandDraft = { category: string; qtyKg: string; cadence: string; notes: string };

const ORDER_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function readJson<T extends { error?: string }>(resp: Response, fallbackMessage: string): Promise<T> {
  let json: T;
  try {
    json = (await resp.json()) as T;
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
  if (!resp.ok) throw new Error(json.error || fallbackMessage);
  return json;
}

const formatKg = (kg: number) => (Number.isInteger(kg) ? String(kg) : kg.toFixed(2).replace(/0$/, ''));

const formatDate = (value: string) => {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const B2BClients: React.FC = () => {
  const [data, setData] = useState<ClientsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  // Which card's write is in flight — one at a time per card, so a slow save
  // can't be raced by a second click on the same account.
  const [savingId, setSavingId] = useState<string | null>(null);

  const [stageFilter, setStageFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  // "Add client" form.
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', businessType: '', contactName: '', phone: '', email: '', area: '' });
  const [isCreating, setIsCreating] = useState(false);

  // Per-card drafts, only ever populated for the open card.
  const [details, setDetails] = useState<Partial<Client>>({});
  // Odoo's pricelists, for the picker on the commercials panel. Fetched once
  // — they change about as often as the price list itself does — and through
  // the sales catalogue endpoint, which already returns them, rather than a
  // route of its own.
  const [pricelists, setPricelists] = useState<{ id: number; name: string }[]>([]);
  const [demandDraft, setDemandDraft] = useState<DemandDraft[]>([]);
  const [sample, setSample] = useState({ sampleSentOn: '', sampleItems: '', sampleOutcome: '', sampleFeedback: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/b2b/sales/catalogue');
        const json = (await resp.json()) as { pricelists?: { id: number; name: string }[] };
        // Odoo being unreachable just means no picker — every other field on
        // the card still saves, so this stays quiet rather than raising an
        // error over the whole page.
        if (!cancelled && resp.ok) setPricelists(json.pricelists || []);
      } catch {
        /* no picker, no problem */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/b2b/clients');
      setData(await readJson<ClientsResponse>(resp, 'Could not load the B2B client list.'));
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clients = data?.clients || [];
  const stages = data?.stages || [];
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (stageFilter !== 'all' && c.stage !== stageFilter) return false;
      if (!needle) return true;
      return [c.name, c.businessType, c.contactName, c.area, c.phone].join(' ').toLowerCase().includes(needle);
    });
  }, [clients, stageFilter, search]);

  // Opening a card seeds every draft from the client as it stands, so an
  // abandoned edit is discarded simply by collapsing the card.
  const openCard = (client: Client) => {
    if (openId === client.id) {
      setOpenId(null);
      return;
    }
    setSaveError('');
    setOpenId(client.id);
    setDetails({
      name: client.name,
      businessType: client.businessType,
      contactName: client.contactName,
      contactRole: client.contactRole,
      phone: client.phone,
      email: client.email,
      area: client.area,
      address: client.address,
      gstin: client.gstin,
      leadSource: client.leadSource,
      orderDay: client.orderDay,
      priceList: client.priceList,
      paymentTerms: client.paymentTerms,
      paymentTermsDays: client.paymentTermsDays,
      odooPricelistId: client.odooPricelistId,
      odooPricelistName: client.odooPricelistName,
      odooPartnerId: client.odooPartnerId,
      notes: client.notes,
    });
    setDemandDraft(
      client.demands.map((d) => ({ category: d.category, qtyKg: String(d.qtyKg), cadence: d.cadence, notes: d.notes })),
    );
    setSample({
      sampleSentOn: client.sampleSentOn.slice(0, 10),
      sampleItems: client.sampleItems.join(', '),
      sampleOutcome: client.sampleOutcome,
      sampleFeedback: client.sampleFeedback,
    });
  };

  // Every write goes through here: it keeps one card's save in flight at a
  // time and re-reads the whole list afterwards, because a stage change or a
  // demand edit moves the rollup tiles and the card's position in the list.
  const save = async (id: string, url: string, body: unknown) => {
    setSavingId(id);
    setSaveError('');
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...(body as object) }),
      });
      await readJson<{ error?: string }>(resp, 'Could not save that change.');
      await load();
      return true;
    } catch (err) {
      setSaveError(String((err as Error).message || err));
      return false;
    } finally {
      setSavingId(null);
    }
  };

  const createClient = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsCreating(true);
    setSaveError('');
    try {
      const resp = await fetch('/api/b2b/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      await readJson<{ error?: string }>(resp, 'Could not add that client.');
      setForm({ name: '', businessType: '', contactName: '', phone: '', email: '', area: '' });
      setShowForm(false);
      await load();
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setIsCreating(false);
    }
  };

  const removeClient = async (client: Client) => {
    if (!window.confirm(`Delete ${client.name} and its meat demand lines? This can't be undone.`)) return;
    setSavingId(client.id);
    setSaveError('');
    try {
      const resp = await fetch(`/api/b2b/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE' });
      await readJson<{ error?: string }>(resp, 'Could not delete that client.');
      if (openId === client.id) setOpenId(null);
      await load();
    } catch (err) {
      setSaveError(String((err as Error).message || err));
    } finally {
      setSavingId(null);
    }
  };

  const changeStage = async (client: Client, stage: string) => {
    // A lost account without a reason is the one thing worth interrupting
    // for — it's the only field that makes the row useful six months later.
    let lostReason;
    if (stage === 'lost') {
      lostReason = window.prompt(`Why did ${client.name} not go ahead?`, client.lostReason) ?? '';
    }
    await save(client.id, '/api/b2b/clients/stage', { stage, lostReason });
  };

  const saveDetails = (client: Client) => save(client.id, '/api/b2b/clients/update', details);

  const saveSample = (client: Client) =>
    save(client.id, '/api/b2b/clients/update', {
      ...sample,
      // Typed with commas on screen; the backend takes an array and joins it
      // with semicolons for the CSV.
      sampleItems: sample.sampleItems
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });

  const toggleStep = (client: Client, stepKey: string) => {
    const next = client.onboardingSteps.includes(stepKey)
      ? client.onboardingSteps.filter((k) => k !== stepKey)
      : [...client.onboardingSteps, stepKey];
    return save(client.id, '/api/b2b/clients/update', { onboardingSteps: next });
  };

  const saveDemands = (client: Client) =>
    save(client.id, '/api/b2b/clients/demands', {
      demands: demandDraft.map((d) => ({
        category: d.category,
        qtyKg: Number(d.qtyKg) || 0,
        cadence: d.cadence,
        notes: d.notes,
      })),
    });

  const setDemandField = (index: number, field: keyof DemandDraft, value: string) =>
    setDemandDraft((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const addDemandRow = (category: string) => {
    if (!category) return;
    setDemandDraft((rows) =>
      rows.some((r) => r.category === category) ? rows : [...rows, { category, qtyKg: '', cadence: 'weekly', notes: '' }],
    );
  };

  const detailField = (label: string, key: keyof Client, placeholder = '', type = 'text') => (
    <label className="b2b-field">
      <span>{label}</span>
      <input
        type={type}
        value={String(details[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => setDetails((d) => ({ ...d, [key]: e.target.value }))}
      />
    </label>
  );

  const summary = data?.summary;
  const categories = data?.categories || [];
  const cadences = data?.cadences || [];

  if (isLoading) return <p className="status-message">Loading B2B clients…</p>;
  if (error) return <p className="status-message error">{error}</p>;

  return (
    <div className="b2b-clients">
      {summary && (
        <section className="b2b-summary">
          <div className="b2b-summary-tiles">
            <div className="b2b-stat">
              <span className="b2b-stat-label">Committed meat</span>
              <span className="b2b-stat-value">{formatKg(summary.committedKgPerWeek)} kg</span>
              <span className="b2b-stat-sub">per week, active accounts</span>
            </div>
            <div className="b2b-stat">
              <span className="b2b-stat-label">In the pipeline</span>
              <span className="b2b-stat-value">{formatKg(summary.pipelineKgPerWeek)} kg</span>
              <span className="b2b-stat-sub">per week if every lead lands</span>
            </div>
            {stages
              .filter((s) => ['sampling', 'onboarding', 'active'].includes(s.key))
              .map((s) => (
                <div className="b2b-stat" key={s.key}>
                  <span className="b2b-stat-label">{s.label}</span>
                  <span className="b2b-stat-value">{summary.byStage[s.key] || 0}</span>
                  <span className="b2b-stat-sub">{s.key === 'active' ? 'accounts ordering' : 'accounts in stage'}</span>
                </div>
              ))}
          </div>

          {summary.byCategory.length > 0 && (
            <div className="b2b-demand-roll">
              <span className="b2b-demand-roll-title">Meat demand by cut</span>
              <div className="b2b-demand-roll-grid">
                {summary.byCategory.map((c) => (
                  <div className="b2b-demand-tile" key={c.category}>
                    <span className="b2b-demand-tile-name">{c.label}</span>
                    <span className="b2b-demand-tile-value">{formatKg(c.committedKgPerWeek)} kg/wk</span>
                    {c.pipelineKgPerWeek > 0 && (
                      <span className="b2b-demand-tile-sub">+{formatKg(c.pipelineKgPerWeek)} kg/wk in pipeline</span>
                    )}
                    {c.adhocKg > 0 && <span className="b2b-demand-tile-sub">{formatKg(c.adhocKg)} kg ad hoc</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="b2b-toolbar">
        <div className="b2b-stage-filters">
          <button
            type="button"
            className={`b2b-chip${stageFilter === 'all' ? ' is-active' : ''}`}
            onClick={() => setStageFilter('all')}
          >
            All <span className="b2b-chip-count">{clients.length}</span>
          </button>
          {stages.map((s) => (
            <button
              key={s.key}
              type="button"
              title={s.description}
              className={`b2b-chip b2b-stage-${s.key}${stageFilter === s.key ? ' is-active' : ''}`}
              onClick={() => setStageFilter(s.key)}
            >
              {s.label} <span className="b2b-chip-count">{summary?.byStage[s.key] || 0}</span>
            </button>
          ))}
        </div>
        <div className="b2b-toolbar-right">
          <input
            className="b2b-search"
            type="search"
            value={search}
            placeholder="Search name, contact, area…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="primary-button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ Add client'}
          </button>
        </div>
      </div>

      {saveError && <p className="status-message error">{saveError}</p>}

      {showForm && (
        <form className="b2b-add-form" onSubmit={createClient}>
          <div className="b2b-form-row">
            <label className="b2b-field">
              <span>Business name *</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="b2b-field">
              <span>Type</span>
              <select value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value })}>
                <option value="">—</option>
                {(data?.businessTypes || []).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="b2b-field">
              <span>Area</span>
              <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder="Indiranagar" />
            </label>
          </div>
          <div className="b2b-form-row">
            <label className="b2b-field">
              <span>Contact</span>
              <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </label>
            <label className="b2b-field">
              <span>Phone</span>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <label className="b2b-field">
              <span>Email</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
          </div>
          <div className="b2b-form-actions">
            <button type="submit" className="primary-button" disabled={isCreating}>
              {isCreating ? 'Adding…' : 'Add as a lead'}
            </button>
          </div>
        </form>
      )}

      {visible.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">🤝</span>
          <p>
            {clients.length === 0
              ? 'No B2B accounts yet. Add the first restaurant, cafe or corporate account and it starts as a lead.'
              : 'No accounts match this filter.'}
          </p>
        </div>
      ) : (
        <div className="b2b-client-list">
          {visible.map((client) => {
            const isOpen = openId === client.id;
            const isSaving = savingId === client.id;
            return (
              <article
                key={client.id}
                className={`b2b-client-card b2b-stage-${client.stage}${isOpen ? ' is-open' : ''}`}
              >
                {/* A plain div, not a <header>: .marketing-dashboard header is
                    the dashboard's dark hero banner, and it would swallow
                    every card. */}
                <div className="b2b-client-head">
                  <button type="button" className="b2b-client-title" onClick={() => openCard(client)}>
                    <span className="b2b-client-chevron" aria-hidden="true">
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="b2b-client-titles">
                      <span className="b2b-client-name">{client.name}</span>
                      <span className="b2b-client-meta">
                        {[client.businessType, client.area, client.contactName, client.phone]
                          .filter(Boolean)
                          .join(' · ') || 'No details yet'}
                      </span>
                    </span>
                  </button>

                  <div className="b2b-client-head-right">
                    {(client.kgPerWeek > 0 || client.adhocKg > 0) && (
                      <span className="b2b-client-kg">
                        {client.kgPerWeek > 0 ? `${formatKg(client.kgPerWeek)} kg/wk` : `${formatKg(client.adhocKg)} kg ad hoc`}
                      </span>
                    )}
                    {client.stage === 'sampling' && client.sampleOutcome && (
                      <span className={`b2b-sample-badge is-${client.sampleOutcome}`}>
                        {data?.sampleOutcomes.find((o) => o.key === client.sampleOutcome)?.label}
                      </span>
                    )}
                    {client.stage === 'onboarding' && (
                      <span className="b2b-onboard-badge">
                        {client.onboardingDone}/{client.onboardingTotal} done
                      </span>
                    )}
                    <select
                      className={`b2b-stage-select b2b-stage-${client.stage}`}
                      value={client.stage}
                      disabled={isSaving}
                      onChange={(e) => changeStage(client, e.target.value)}
                    >
                      {stages.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {isOpen && (
                  <div className="b2b-client-body">
                    <section className="b2b-panel">
                      <h4>Client details</h4>
                      <div className="b2b-form-row">
                        {detailField('Business name', 'name')}
                        <label className="b2b-field">
                          <span>Type</span>
                          <select
                            value={String(details.businessType ?? '')}
                            onChange={(e) => setDetails((d) => ({ ...d, businessType: e.target.value }))}
                          >
                            <option value="">—</option>
                            {(data?.businessTypes || []).map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                        {detailField('Area', 'area', 'Indiranagar')}
                      </div>
                      <div className="b2b-form-row">
                        {detailField('Contact person', 'contactName')}
                        {detailField('Their role', 'contactRole', 'Owner / Chef / F&B manager')}
                        {detailField('Phone', 'phone')}
                        {detailField('Email', 'email', '', 'email')}
                      </div>
                      <div className="b2b-form-row">
                        {detailField('Delivery address', 'address')}
                        {detailField('GSTIN', 'gstin')}
                        {detailField('Lead source', 'leadSource', 'Referral / Instagram / walk-in')}
                        <label className="b2b-field">
                          <span>Order day</span>
                          <select
                            value={String(details.orderDay ?? '')}
                            onChange={(e) => setDetails((d) => ({ ...d, orderDay: e.target.value }))}
                          >
                            <option value="">—</option>
                            {ORDER_DAYS.map((day) => (
                              <option key={day} value={day}>
                                {day}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="b2b-form-row">
                        {detailField('Agreed pricing', 'priceList', '₹/kg or per-portion rate')}
                        {detailField('Payment terms', 'paymentTerms', 'Net 15 / on delivery')}
                        <label className="b2b-field">
                          <span>Payment cycle (days)</span>
                          <input
                            type="number"
                            min={0}
                            value={String(details.paymentTermsDays ?? '')}
                            placeholder="15"
                            onChange={(e) =>
                              setDetails((d) => ({ ...d, paymentTermsDays: Number(e.target.value) }))
                            }
                          />
                        </label>
                        {detailField('Odoo customer id', 'odooPartnerId')}
                        <label className="b2b-field">
                          <span>Odoo pricelist</span>
                          <select
                            value={String(details.odooPricelistId ?? '')}
                            onChange={(e) => {
                              const id = e.target.value;
                              // The name rides along with the id so the sales
                              // screen can say which pricelist it priced from
                              // without asking Odoo again.
                              const picked = pricelists.find((p) => String(p.id) === id);
                              setDetails((d) => ({
                                ...d,
                                odooPricelistId: id,
                                odooPricelistName: picked ? picked.name : '',
                              }));
                            }}
                          >
                            <option value="">None — use Odoo list prices</option>
                            {pricelists.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                            {/* A pricelist that has since been deleted in Odoo
                                would otherwise vanish from the select and read
                                as "None". */}
                            {details.odooPricelistId &&
                              !pricelists.some((p) => String(p.id) === String(details.odooPricelistId)) && (
                                <option value={String(details.odooPricelistId)}>
                                  {details.odooPricelistName || `Pricelist ${details.odooPricelistId}`} (not in Odoo)
                                </option>
                              )}
                          </select>
                        </label>
                      </div>
                      <label className="b2b-field b2b-field-wide">
                        <span>Notes</span>
                        <textarea
                          rows={2}
                          value={String(details.notes ?? '')}
                          onChange={(e) => setDetails((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </label>
                      <div className="b2b-panel-actions">
                        <button type="button" className="primary-button" disabled={isSaving} onClick={() => saveDetails(client)}>
                          {isSaving ? 'Saving…' : 'Save details'}
                        </button>
                        <button type="button" className="secondary-button is-danger" onClick={() => removeClient(client)}>
                          Delete client
                        </button>
                      </div>
                    </section>

                    <section className="b2b-panel">
                      <h4>Meat demand</h4>
                      <p className="b2b-panel-hint">
                        What this account wants, per cut. Weekly figures roll into the tiles at the top and use the same
                        categories as the kitchen's prep planner. Set a line to 0 to drop it.
                      </p>
                      {demandDraft.length === 0 ? (
                        <p className="b2b-empty-line">No meat demand recorded yet.</p>
                      ) : (
                        <table className="b2b-demand-table">
                          <thead>
                            <tr>
                              <th>Cut</th>
                              <th>Qty (kg)</th>
                              <th>Cadence</th>
                              <th>Per week</th>
                              <th>Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {demandDraft.map((row, index) => {
                              const perWeek = cadences.find((c) => c.key === row.cadence)?.perWeek ?? 0;
                              return (
                                <tr key={row.category}>
                                  <td>{categories.find((c) => c.key === row.category)?.label || row.category}</td>
                                  <td>
                                    <input
                                      className="b2b-qty-input"
                                      type="number"
                                      min="0"
                                      step="0.5"
                                      value={row.qtyKg}
                                      onChange={(e) => setDemandField(index, 'qtyKg', e.target.value)}
                                    />
                                  </td>
                                  <td>
                                    <select value={row.cadence} onChange={(e) => setDemandField(index, 'cadence', e.target.value)}>
                                      {cadences.map((c) => (
                                        <option key={c.key} value={c.key}>
                                          {c.label}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="b2b-demand-week">
                                    {perWeek ? `${formatKg(Math.round((Number(row.qtyKg) || 0) * perWeek * 100) / 100)} kg` : '—'}
                                  </td>
                                  <td>
                                    <input
                                      value={row.notes}
                                      placeholder="Cut, spice level, packing…"
                                      onChange={(e) => setDemandField(index, 'notes', e.target.value)}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                      <div className="b2b-panel-actions">
                        <select
                          className="b2b-add-meat"
                          value=""
                          onChange={(e) => addDemandRow(e.target.value)}
                        >
                          <option value="">+ Add a cut…</option>
                          {categories
                            .filter((c) => !demandDraft.some((d) => d.category === c.key))
                            .map((c) => (
                              <option key={c.key} value={c.key}>
                                {c.label}
                              </option>
                            ))}
                        </select>
                        <button type="button" className="primary-button" disabled={isSaving} onClick={() => saveDemands(client)}>
                          {isSaving ? 'Saving…' : 'Save demand'}
                        </button>
                      </div>
                    </section>

                    <section className="b2b-panel">
                      <h4>
                        Sampling
                        <span className="b2b-panel-stage">Stage 2</span>
                      </h4>
                      <p className="b2b-panel-hint">
                        What went out on the sample tray, and what came back. This is the stage that decides the account —
                        keep the feedback verbatim.
                      </p>
                      <div className="b2b-form-row">
                        <label className="b2b-field">
                          <span>Sample sent on</span>
                          <input
                            type="date"
                            value={sample.sampleSentOn}
                            onChange={(e) => setSample({ ...sample, sampleSentOn: e.target.value })}
                          />
                        </label>
                        <label className="b2b-field b2b-field-wide">
                          <span>Items sampled</span>
                          <input
                            value={sample.sampleItems}
                            placeholder="Pulled pork, Beef ribs, Burnt ends"
                            onChange={(e) => setSample({ ...sample, sampleItems: e.target.value })}
                          />
                        </label>
                        <label className="b2b-field">
                          <span>Outcome</span>
                          <select
                            value={sample.sampleOutcome}
                            onChange={(e) => setSample({ ...sample, sampleOutcome: e.target.value })}
                          >
                            {(data?.sampleOutcomes || []).map((o) => (
                              <option key={o.key} value={o.key}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className="b2b-field b2b-field-wide">
                        <span>Feedback</span>
                        <textarea
                          rows={2}
                          value={sample.sampleFeedback}
                          placeholder="What they said — cut, smoke level, portion size, price reaction…"
                          onChange={(e) => setSample({ ...sample, sampleFeedback: e.target.value })}
                        />
                      </label>
                      <div className="b2b-panel-actions">
                        <button type="button" className="primary-button" disabled={isSaving} onClick={() => saveSample(client)}>
                          {isSaving ? 'Saving…' : 'Save sampling'}
                        </button>
                        {client.stage === 'sampling' && client.sampleOutcome === 'liked' && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={isSaving}
                            onClick={() => changeStage(client, 'onboarding')}
                          >
                            Move to onboarding →
                          </button>
                        )}
                        {client.stage === 'lead' && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={isSaving}
                            onClick={() => changeStage(client, 'sampling')}
                          >
                            Move to sampling →
                          </button>
                        )}
                      </div>
                    </section>

                    <section className="b2b-panel">
                      <h4>
                        Business onboarding
                        <span className="b2b-panel-stage">Stage 3</span>
                      </h4>
                      <p className="b2b-panel-hint">
                        Everything that has to be true before the first real delivery. Ticks save as you click.
                      </p>
                      <ul className="b2b-checklist">
                        {(data?.onboardingSteps || []).map((step) => {
                          const done = client.onboardingSteps.includes(step.key);
                          return (
                            <li key={step.key} className={done ? 'is-done' : ''}>
                              <label>
                                <input type="checkbox" checked={done} disabled={isSaving} onChange={() => toggleStep(client, step.key)} />
                                <span className="b2b-check-label">{step.label}</span>
                                <span className="b2b-check-hint">{step.hint}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="b2b-panel-actions">
                        <span className="b2b-onboard-progress">
                          {client.onboardingDone}/{client.onboardingTotal} done
                          {client.onboardedOn && ` · live since ${formatDate(client.onboardedOn)}`}
                        </span>
                        {client.stage !== 'active' && client.onboardingDone === client.onboardingTotal && (
                          <button
                            type="button"
                            className="primary-button"
                            disabled={isSaving}
                            onClick={() => changeStage(client, 'active')}
                          >
                            Mark account active →
                          </button>
                        )}
                      </div>
                      {client.stage === 'lost' && client.lostReason && (
                        <p className="b2b-lost-reason">Lost: {client.lostReason}</p>
                      )}
                    </section>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default B2BClients;
