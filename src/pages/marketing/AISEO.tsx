import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// AI SEO — tracking whether AI assistants name Smoke Rings when someone asks
// them where to get BBQ, and what they read to decide.
//
// The tracked unit is a *prompt*, not a keyword: "Best BBQ in Bengaluru?" is
// the thing a customer actually types, and the measurement is the prose
// answer that comes back. Every check is one row in the history — named or
// not, how early in the list, alongside whom, citing which sources.
//
// Checks against Gemini run from here (grounded in live Google Search — see
// server/marketing/aiSeo.js); ChatGPT/Perplexity/Copilot answers get pasted in and are
// scored by the same pass, so the two are comparable in one history.

type Prompt = {
  id: string;
  text: string;
  intent: string;
  isActive: boolean;
  createdAt: string;
};

type Run = {
  id: string;
  promptId: string;
  promptText: string;
  engine: string;
  source: 'auto' | 'manual';
  ranAt: string;
  mentioned: boolean;
  position: number | null;
  totalBrands: number | null;
  sentiment: string;
  framing: string;
  competitors: string[];
  citationDomains: string[];
  citationUrls: string[];
  recommendation: string;
  answerExcerpt: string;
};

type Status = {
  dataDir: string;
  dataDirPresent: boolean;
  autoRunAvailable: boolean;
  model: string;
  brand: { name: string; aliases: string[]; city: string; site: string };
  engines: string[];
};

const TIMEFRAMES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 0, label: 'All time' },
];

const ENGINE_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  copilot: 'Copilot',
  claude: 'Claude',
  other: 'Other',
};

const INTENT_HINT = 'discovery / preorder / brand / comparison / b2b';

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

const formatWhen = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || '—';
  return new Date(t).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const formatDay = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || '—';
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

const AISEO: React.FC = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [days, setDays] = useState(30);
  const [engineFilter, setEngineFilter] = useState('all');

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  // A sweep walks the prompt list one at a time so progress is visible and a
  // failure part-way through keeps everything already logged.
  const [sweep, setSweep] = useState<{ done: number; total: number; current: string } | null>(null);
  const abortSweep = useRef(false);
  const [runningPromptId, setRunningPromptId] = useState<string | null>(null);

  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftIntent, setDraftIntent] = useState('discovery');

  const [isLogOpen, setIsLogOpen] = useState(false);
  const [logPromptId, setLogPromptId] = useState('');
  const [logEngine, setLogEngine] = useState('chatgpt');
  const [logAnswer, setLogAnswer] = useState('');
  const [logCitations, setLogCitations] = useState('');
  const [isLogging, setIsLogging] = useState(false);

  const load = useCallback(async (windowDays: number) => {
    setIsLoading(true);
    setError('');
    try {
      const [statusResp, promptsResp, runsResp] = await Promise.all([
        fetch('/api/aiseo/status'),
        fetch('/api/aiseo/prompts'),
        fetch(`/api/aiseo/runs${windowDays ? `?days=${windowDays}` : ''}`),
      ]);
      const statusJson = await readJson<Status & { error?: string }>(statusResp, 'Could not read the AI SEO config.');
      const promptsJson = await readJson<{ prompts: Prompt[]; error?: string }>(
        promptsResp,
        'Could not load tracked prompts.',
      );
      const runsJson = await readJson<{ runs: Run[]; error?: string }>(runsResp, 'Could not load the check history.');
      setStatus(statusJson);
      setPrompts(promptsJson.prompts || []);
      setRuns(runsJson.runs || []);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [load, days]);

  // Only the run list depends on the window, but a sweep can also add prompts'
  // first-ever runs, so both are refetched after any write.
  const refreshRuns = useCallback(async () => {
    const resp = await fetch(`/api/aiseo/runs${days ? `?days=${days}` : ''}`);
    const json = await readJson<{ runs: Run[]; error?: string }>(resp, 'Could not load the check history.');
    setRuns(json.runs || []);
  }, [days]);

  const visibleRuns = useMemo(
    () => (engineFilter === 'all' ? runs : runs.filter((r) => r.engine === engineFilter)),
    [runs, engineFilter],
  );

  const runsByPrompt = useMemo(() => {
    const map = new Map<string, Run[]>();
    visibleRuns.forEach((run) => {
      const key = run.promptId || `adhoc:${run.promptText}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(run);
    });
    // Newest first, so "last check" is just [0].
    map.forEach((list) => list.sort((a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt)));
    return map;
  }, [visibleRuns]);

  const stats = useMemo(() => {
    const total = visibleRuns.length;
    const named = visibleRuns.filter((r) => r.mentioned);
    const ranked = named.filter((r) => r.position != null);
    const avgPosition = ranked.length
      ? ranked.reduce((sum, r) => sum + (r.position || 0), 0) / ranked.length
      : null;

    // Share of voice counts brand *mentions*, not answers: an answer naming
    // five rivals and us is one visibility win but a sixth of the voice.
    const competitorMentions = visibleRuns.reduce((sum, r) => sum + r.competitors.length, 0);
    const ourMentions = named.length;
    const shareOfVoice = pct(ourMentions, ourMentions + competitorMentions);

    const lastRun = visibleRuns.reduce<Run | null>(
      (latest, r) => (!latest || Date.parse(r.ranAt) > Date.parse(latest.ranAt) ? r : latest),
      null,
    );

    return {
      total,
      namedCount: named.length,
      visibility: pct(named.length, total),
      avgPosition,
      shareOfVoice,
      competitorMentions,
      lastRunAt: lastRun?.ranAt || '',
    };
  }, [visibleRuns]);

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    visibleRuns.forEach((run) => {
      // Per run, not per citation: a source cited three times in one answer
      // is still one answer that leaned on it.
      new Set(run.citationDomains).forEach((domain) => {
        counts.set(domain, (counts.get(domain) || 0) + 1);
      });
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [visibleRuns]);

  const competitors = useMemo(() => {
    const counts = new Map<string, number>();
    visibleRuns.forEach((run) => {
      new Set(run.competitors.map((c) => c.trim())).forEach((name) => {
        if (name) counts.set(name, (counts.get(name) || 0) + 1);
      });
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [visibleRuns]);

  const recentRuns = useMemo(
    () => [...visibleRuns].sort((a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt)).slice(0, 20),
    [visibleRuns],
  );

  const ourSite = (status?.brand.site || '').replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();

  const runOne = async (promptId: string) => {
    const resp = await fetch('/api/aiseo/runs/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId }),
    });
    await readJson<{ run: Run; error?: string }>(resp, 'The check failed.');
  };

  const handleRunOne = async (prompt: Prompt) => {
    if (runningPromptId || sweep) return;
    setRunningPromptId(prompt.id);
    setActionError('');
    try {
      await runOne(prompt.id);
      await refreshRuns();
    } catch (err) {
      setActionError(`Check failed for "${prompt.text}": ${String((err as Error).message || err)}`);
    } finally {
      setRunningPromptId(null);
    }
  };

  const handleRunAll = async () => {
    const active = prompts.filter((p) => p.isActive);
    if (!active.length || sweep) return;
    abortSweep.current = false;
    setActionError('');
    setSweep({ done: 0, total: active.length, current: active[0].text });

    const failures: string[] = [];
    for (let i = 0; i < active.length; i += 1) {
      if (abortSweep.current) break;
      const prompt = active[i];
      setSweep({ done: i, total: active.length, current: prompt.text });
      try {
        await runOne(prompt.id);
      } catch (err) {
        // One prompt failing (a quota blip, a flaky grounding call) shouldn't
        // abandon the rest of the sweep — collect and report at the end.
        failures.push(`${prompt.text}: ${String((err as Error).message || err)}`);
      }
    }

    setSweep(null);
    await refreshRuns();
    if (failures.length) {
      setActionError(`${failures.length} of ${active.length} checks failed — ${failures[0]}`);
    }
  };

  const handleSeed = async () => {
    setActionError('');
    try {
      const resp = await fetch('/api/aiseo/prompts/seed', { method: 'POST' });
      const json = await readJson<{ prompts: Prompt[]; error?: string }>(resp, 'Could not add the starter prompts.');
      setPrompts(json.prompts || []);
    } catch (err) {
      setActionError(String((err as Error).message || err));
    }
  };

  const handleAddPrompt = async () => {
    const text = draftText.trim();
    if (!text) return;
    setActionError('');
    try {
      const resp = await fetch('/api/aiseo/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, intent: draftIntent }),
      });
      const json = await readJson<{ prompt: Prompt; error?: string }>(resp, 'Could not add that prompt.');
      setPrompts((prev) => [...prev, json.prompt]);
      setDraftText('');
      setIsAddOpen(false);
    } catch (err) {
      setActionError(String((err as Error).message || err));
    }
  };

  const handleToggleActive = async (prompt: Prompt) => {
    setActionError('');
    try {
      const resp = await fetch('/api/aiseo/prompts/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: prompt.id, isActive: !prompt.isActive }),
      });
      const json = await readJson<{ prompt: Prompt; error?: string }>(resp, 'Could not update that prompt.');
      setPrompts((prev) => prev.map((p) => (p.id === json.prompt.id ? json.prompt : p)));
    } catch (err) {
      setActionError(String((err as Error).message || err));
    }
  };

  const handleDeletePrompt = async (prompt: Prompt) => {
    setActionError('');
    try {
      const resp = await fetch(`/api/aiseo/prompts/${prompt.id}`, { method: 'DELETE' });
      await readJson<{ deleted: string; error?: string }>(resp, 'Could not remove that prompt.');
      setPrompts((prev) => prev.filter((p) => p.id !== prompt.id));
    } catch (err) {
      setActionError(String((err as Error).message || err));
    }
  };

  const handleLogManual = async () => {
    if (!logAnswer.trim() || isLogging) return;
    setIsLogging(true);
    setActionError('');
    try {
      const resp = await fetch('/api/aiseo/runs/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promptId: logPromptId,
          engine: logEngine,
          answerText: logAnswer,
          citationUrls: logCitations,
        }),
      });
      await readJson<{ run: Run; error?: string }>(resp, 'Could not score that answer.');
      await refreshRuns();
      setLogAnswer('');
      setLogCitations('');
      setIsLogOpen(false);
    } catch (err) {
      setActionError(String((err as Error).message || err));
    } finally {
      setIsLogging(false);
    }
  };

  const renderResultChip = (run: Run | undefined) => {
    if (!run) return <span className="seo-chip is-idle">Never checked</span>;
    if (!run.mentioned) return <span className="seo-chip is-miss">Not named</span>;
    return (
      <span className={`seo-chip is-hit${run.sentiment === 'negative' ? ' is-negative' : ''}`}>
        {run.position ? `Named #${run.position}` : 'Named'}
        {run.totalBrands ? ` of ${run.totalBrands}` : ''}
      </span>
    );
  };

  if (isLoading && !status) {
    return <p className="status-message">Loading the AI SEO tracker…</p>;
  }

  if (error) {
    return (
      <div className="seo-page">
        <p className="chat-error">{error}</p>
        <button type="button" className="secondary-button small" onClick={() => load(days)}>
          Try again
        </button>
      </div>
    );
  }

  const activeCount = prompts.filter((p) => p.isActive).length;

  return (
    <div className="seo-page">
      <div className="seo-head">
        <div>
          <h3 className="inv-section-title">AI SEO — assistant visibility</h3>
          <p className="inv-section-hint">
            Do ChatGPT, Gemini and Perplexity name {status?.brand.name || 'us'} when someone asks them where to eat in{' '}
            {status?.brand.city || 'town'} — and which sources are they reading to decide?
          </p>
        </div>
        <div className="seo-head-actions">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={Boolean(sweep)}>
            {TIMEFRAMES.map((t) => (
              <option key={t.days} value={t.days}>
                {t.label}
              </option>
            ))}
          </select>
          <select value={engineFilter} onChange={(e) => setEngineFilter(e.target.value)}>
            <option value="all">All engines</option>
            {(status?.engines || []).map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_LABELS[engine] || engine}
              </option>
            ))}
          </select>
          <button type="button" className="secondary-button small" onClick={() => load(days)} disabled={Boolean(sweep)}>
            Refresh
          </button>
        </div>
      </div>

      {status && !status.dataDirPresent && (
        <p className="chat-error">
          The knowledge-base Data folder isn't at {status.dataDir}. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env and
          restart it — nothing can be saved until then.
        </p>
      )}
      {status && !status.autoRunAvailable && (
        <p className="status-message">
          No GEMINI_API_KEY on the server, so checks can't be run automatically. You can still paste answers in by hand
          with “Log an answer”.
        </p>
      )}
      {actionError && <p className="chat-error">{actionError}</p>}

      <div className="seo-stat-row">
        <div className="seo-stat">
          <span className="seo-stat-label">Visibility</span>
          <span className="seo-stat-value">{stats.total ? `${stats.visibility}%` : '—'}</span>
          <span className="seo-stat-sub">
            named in {stats.namedCount} of {stats.total} checks
          </span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat-label">Avg position</span>
          <span className="seo-stat-value">{stats.avgPosition ? `#${stats.avgPosition.toFixed(1)}` : '—'}</span>
          <span className="seo-stat-sub">where in the list we land, when named</span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat-label">Share of voice</span>
          <span className="seo-stat-value">{stats.total ? `${stats.shareOfVoice}%` : '—'}</span>
          <span className="seo-stat-sub">
            our mentions vs {stats.competitorMentions} competitor mention{stats.competitorMentions === 1 ? '' : 's'}
          </span>
        </div>
        <div className="seo-stat">
          <span className="seo-stat-label">Last checked</span>
          <span className="seo-stat-value is-small">{stats.lastRunAt ? formatDay(stats.lastRunAt) : '—'}</span>
          <span className="seo-stat-sub">
            {activeCount} prompt{activeCount === 1 ? '' : 's'} tracked
          </span>
        </div>
      </div>

      <div className="seo-toolbar">
        <button
          type="button"
          className="primary-button small"
          onClick={handleRunAll}
          disabled={!activeCount || Boolean(sweep) || Boolean(runningPromptId) || !status?.autoRunAvailable}
        >
          {sweep ? `Checking ${sweep.done + 1}/${sweep.total}…` : `Run all checks (${activeCount})`}
        </button>
        {sweep && (
          <button type="button" className="secondary-button small" onClick={() => { abortSweep.current = true; }}>
            Stop after this one
          </button>
        )}
        <button
          type="button"
          className="secondary-button small"
          onClick={() => setIsLogOpen((open) => !open)}
          disabled={Boolean(sweep)}
        >
          {isLogOpen ? 'Close' : 'Log an answer'}
        </button>
        <button
          type="button"
          className="secondary-button small"
          onClick={() => setIsAddOpen((open) => !open)}
          disabled={Boolean(sweep)}
        >
          {isAddOpen ? 'Close' : 'Add prompt'}
        </button>
        {sweep && <span className="seo-sweep-current">asking: “{sweep.current}”</span>}
      </div>

      {isAddOpen && (
        <div className="seo-form-panel">
          <label className="svc-week-field is-wide">
            <span>Prompt — the question a customer would type</span>
            <input
              type="text"
              value={draftText}
              placeholder={`Best BBQ in ${status?.brand.city || 'Bengaluru'}?`}
              onChange={(e) => setDraftText(e.target.value)}
            />
          </label>
          <label className="svc-week-field">
            <span>Intent</span>
            <input
              type="text"
              value={draftIntent}
              placeholder={INTENT_HINT}
              onChange={(e) => setDraftIntent(e.target.value)}
            />
          </label>
          <div className="svc-week-form-actions">
            <button type="button" className="primary-button small" onClick={handleAddPrompt} disabled={!draftText.trim()}>
              Track this prompt
            </button>
          </div>
        </div>
      )}

      {isLogOpen && (
        <div className="seo-form-panel">
          <p className="inv-section-hint">
            Ran the prompt in ChatGPT or Perplexity yourself? Paste what it said and it gets scored the same way an
            automatic check is, so the two sit side by side in the history.
          </p>
          <div className="seo-form-row">
            <label className="svc-week-field is-wide">
              <span>Prompt</span>
              <select value={logPromptId} onChange={(e) => setLogPromptId(e.target.value)}>
                <option value="">Pick a tracked prompt…</option>
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.text}
                  </option>
                ))}
              </select>
            </label>
            <label className="svc-week-field">
              <span>Engine</span>
              <select value={logEngine} onChange={(e) => setLogEngine(e.target.value)}>
                {(status?.engines || []).map((engine) => (
                  <option key={engine} value={engine}>
                    {ENGINE_LABELS[engine] || engine}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="svc-week-field is-wide">
            <span>The answer it gave</span>
            <textarea rows={7} value={logAnswer} onChange={(e) => setLogAnswer(e.target.value)} />
          </label>
          <label className="svc-week-field is-wide">
            <span>Sources it cited (optional — one URL per line)</span>
            <textarea rows={3} value={logCitations} onChange={(e) => setLogCitations(e.target.value)} />
          </label>
          <div className="svc-week-form-actions">
            <button
              type="button"
              className="primary-button small"
              onClick={handleLogManual}
              disabled={!logPromptId || !logAnswer.trim() || isLogging}
            >
              {isLogging ? 'Scoring…' : 'Score & log this answer'}
            </button>
          </div>
        </div>
      )}

      {!prompts.length ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <h3>No prompts tracked yet</h3>
          <p>
            Start with a set of questions a hungry customer in {status?.brand.city || 'town'} would actually ask an AI
            assistant, then check them weekly to see whether we show up.
          </p>
          <button type="button" className="primary-button small" onClick={handleSeed}>
            Add 12 starter prompts
          </button>
        </div>
      ) : (
        <div className="prep-table-wrap">
          <table className="prep-table seo-table">
            <thead>
              <tr>
                <th>Prompt</th>
                <th>Intent</th>
                <th>Latest result</th>
                <th>How to improve</th>
                <th>Visibility</th>
                <th>Last checked</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {prompts.map((prompt) => {
                const history = runsByPrompt.get(prompt.id) || [];
                const latest = history[0];
                const named = history.filter((r) => r.mentioned).length;
                const isExpanded = expandedPromptId === prompt.id;
                const busy = runningPromptId === prompt.id;

                return (
                  <React.Fragment key={prompt.id}>
                    <tr className={prompt.isActive ? '' : 'seo-row-paused'}>
                      <td>
                        <button
                          type="button"
                          className="seo-prompt-cell"
                          onClick={() => setExpandedPromptId(isExpanded ? null : prompt.id)}
                        >
                          <span className="seo-prompt-text">{prompt.text}</span>
                          <span className="seo-prompt-meta">
                            {history.length} check{history.length === 1 ? '' : 's'} · {isExpanded ? 'hide' : 'history'}
                          </span>
                        </button>
                      </td>
                      <td>{prompt.intent && <span className="seo-intent">{prompt.intent}</span>}</td>
                      <td>{renderResultChip(latest)}</td>
                      <td>
                        {latest?.recommendation ? (
                          // title too: the cell clamps to two lines, and the
                          // advice is often one clause longer than that.
                          <span className="seo-advice" title={latest.recommendation}>
                            {latest.recommendation}
                          </span>
                        ) : (
                          <span className="seo-advice is-empty">
                            {latest ? 'No action suggested' : 'Run a check to get one'}
                          </span>
                        )}
                      </td>
                      <td>
                        {history.length ? (
                          <span className="seo-visibility">
                            {pct(named, history.length)}%<em>{named}/{history.length}</em>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="seo-when">{latest ? formatWhen(latest.ranAt) : '—'}</td>
                      <td>
                        <div className="seo-row-actions">
                          <button
                            type="button"
                            className="svc-week-menu-edit"
                            onClick={() => handleRunOne(prompt)}
                            disabled={busy || Boolean(sweep) || Boolean(runningPromptId) || !status?.autoRunAvailable}
                          >
                            {busy ? 'Checking…' : 'Check'}
                          </button>
                          <button
                            type="button"
                            className="svc-week-menu-edit"
                            onClick={() => handleToggleActive(prompt)}
                            disabled={Boolean(sweep)}
                          >
                            {prompt.isActive ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            type="button"
                            className="svc-week-menu-edit is-danger"
                            onClick={() => handleDeletePrompt(prompt)}
                            disabled={Boolean(sweep)}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr className="seo-history-row">
                        <td colSpan={7}>
                          {!history.length ? (
                            <p className="seo-empty-line">No checks logged for this prompt yet.</p>
                          ) : (
                            <ul className="seo-history">
                              {history.map((run) => (
                                <li key={run.id}>
                                  <div className="seo-history-line">
                                    <span className="seo-history-when">{formatWhen(run.ranAt)}</span>
                                    <span className={`seo-engine is-${run.engine}`}>
                                      {ENGINE_LABELS[run.engine] || run.engine}
                                    </span>
                                    {renderResultChip(run)}
                                    <span className="seo-history-framing">{run.framing}</span>
                                  </div>
                                  {run.recommendation && (
                                    <p className="seo-history-advice">→ {run.recommendation}</p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="seo-panels">
        <section className="seo-panel">
          <h4>Sources the assistants read</h4>
          <p className="inv-section-hint">
            What they cite is what you can influence. A domain high on this list is worth a post, a review, or a
            correction.
          </p>
          {!sources.length ? (
            <p className="seo-empty-line">No citations captured yet — run some checks.</p>
          ) : (
            <ul className="seo-bars">
              {sources.map(([domain, count]) => (
                <li key={domain}>
                  <span className="seo-bar-label">
                    {domain}
                    {ourSite && domain === ourSite && <em className="seo-tag">ours</em>}
                  </span>
                  <span className="seo-bar-track">
                    <span
                      className="seo-bar-fill"
                      style={{ width: `${pct(count, sources[0][1])}%` }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="seo-bar-count">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="seo-panel">
          <h4>Who else gets named</h4>
          <p className="inv-section-hint">
            Every business the assistants put in front of the same customer — in {stats.total} check
            {stats.total === 1 ? '' : 's'}.
          </p>
          {!competitors.length ? (
            <p className="seo-empty-line">No competitors captured yet — run some checks.</p>
          ) : (
            <ul className="seo-bars">
              {competitors.map(([name, count]) => (
                <li key={name}>
                  <span className="seo-bar-label">{name}</span>
                  <span className="seo-bar-track">
                    <span
                      className="seo-bar-fill is-rival"
                      style={{ width: `${pct(count, competitors[0][1])}%` }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="seo-bar-count">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="seo-panel">
        <h4>Recent checks</h4>
        {!recentRuns.length ? (
          <p className="seo-empty-line">Nothing logged in this window yet.</p>
        ) : (
          <ul className="seo-runs">
            {recentRuns.map((run) => {
              const open = expandedRunId === run.id;
              return (
                <li key={run.id} className="seo-run">
                  <button type="button" className="seo-run-head" onClick={() => setExpandedRunId(open ? null : run.id)}>
                    <span className={`seo-engine is-${run.engine}`}>{ENGINE_LABELS[run.engine] || run.engine}</span>
                    {renderResultChip(run)}
                    <span className="seo-run-prompt">{run.promptText}</span>
                    <span className="seo-run-when">{formatWhen(run.ranAt)}</span>
                  </button>
                  {open && (
                    <div className="seo-run-body">
                      {run.framing && <p className="seo-run-framing">{run.framing}</p>}
                      {run.recommendation && (
                        <p className="seo-run-advice">
                          <strong>Do next:</strong> {run.recommendation}
                        </p>
                      )}
                      {run.competitors.length > 0 && (
                        <p className="seo-run-line">
                          <strong>Also named:</strong> {run.competitors.join(', ')}
                        </p>
                      )}
                      {run.citationUrls.length > 0 && (
                        <div className="seo-run-line">
                          <strong>Cited:</strong>
                          <span className="seo-cite-list">
                            {run.citationUrls.map((url, idx) => (
                              <a key={url} href={url} target="_blank" rel="noreferrer">
                                {run.citationDomains[idx] || url}
                              </a>
                            ))}
                          </span>
                        </div>
                      )}
                      {run.answerExcerpt && <pre className="seo-run-answer">{run.answerExcerpt}</pre>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

export default AISEO;
