import React, { useCallback, useEffect, useState } from 'react';

type SprintItem = {
  id: string;
  issueId: string | null;
  status: string | null;
  assignedTo: string;
  sprintTitle: string | null;
  day: string | null;
  isDraft: boolean;
  title: string;
  body?: string;
  number: number | null;
  url: string | null;
  state: string | null;
  assignees: string[];
  parentNumber: number | null;
  parentTitle: string | null;
};

type SprintInfo = { title: string; startDate: string; endDate: string } | null;

type GithubStatus = {
  configured: boolean;
  repoConfigured: boolean;
  owner: string;
  repo: string;
  projectNumber: number;
};

type MigrateResult = { title: string; ok: boolean; error?: string };

const STATUS_COLUMNS = ['Backlog', 'In Progress', 'Done'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The board's top-level epics — the only issues a new task should be filed as a
// sub-issue of. Pinned explicitly (rather than "no parent") so a stray top-level
// item added to the project later doesn't silently clutter this dropdown.
const EPIC_ISSUE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 54];

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || resp.statusText || 'Request failed');
  return data as T;
}

const formatDateRange = (sprint: SprintInfo) => {
  if (!sprint) return '';
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(sprint.startDate)} – ${fmt(sprint.endDate)}`;
};

const SprintDashboard: React.FC = () => {
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [sprint, setSprint] = useState<SprintInfo>(null);
  const [items, setItems] = useState<SprintItem[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<string[]>([]);
  const [parentOptions, setParentOptions] = useState<SprintItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [migrateResults, setMigrateResults] = useState<MigrateResult[] | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});

  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [newStatus, setNewStatus] = useState(STATUS_COLUMNS[0]);
  const [newAssignee, setNewAssignee] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const status = await fetchJSON<GithubStatus>('/api/github/status');
      setGithubStatus(status);
      if (status.configured) {
        const [board, assignable, allItems] = await Promise.all([
          fetchJSON<{ sprint: SprintInfo; items: SprintItem[] }>('/api/github/sprint-board'),
          fetchJSON<{ users: string[] }>('/api/github/assignable-users').catch(() => ({ users: [] })),
          fetchJSON<{ items: SprintItem[] }>('/api/github/board-items').catch(() => ({ items: [] })),
        ]);
        setSprint(board.sprint);
        setItems(board.items);
        setAssignableUsers(assignable.users);
        setParentOptions(
          allItems.items
            .filter((item) => !item.isDraft && item.issueId && item.number && EPIC_ISSUE_NUMBERS.includes(item.number))
            .sort((a, b) => (a.number || 0) - (b.number || 0)),
        );
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markSaving = (id: string, value: boolean) =>
    setSavingIds((current) => ({ ...current, [id]: value }));

  const handleStatusChange = async (item: SprintItem, nextStatus: string) => {
    const previous = item.status;
    setItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: nextStatus } : it)));
    markSaving(item.id, true);
    try {
      await fetchJSON(`/api/github/sprint-board/${encodeURIComponent(item.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (err) {
      setItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: previous } : it)));
      setError(`Couldn't move "${item.title}": ${String((err as Error).message || err)}`);
    } finally {
      markSaving(item.id, false);
    }
  };

  const handleDayChange = async (item: SprintItem, nextDay: string) => {
    const previous = item.day;
    setItems((current) => current.map((it) => (it.id === item.id ? { ...it, day: nextDay || null } : it)));
    markSaving(item.id, true);
    try {
      await fetchJSON(`/api/github/sprint-board/${encodeURIComponent(item.id)}/day`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: nextDay }),
      });
    } catch (err) {
      setItems((current) => current.map((it) => (it.id === item.id ? { ...it, day: previous } : it)));
      setError(`Couldn't set a day for "${item.title}": ${String((err as Error).message || err)}`);
    } finally {
      markSaving(item.id, false);
    }
  };

  const handleAssigneeChange = async (item: SprintItem, nextLogin: string) => {
    if (!item.number) return;
    const previous = item.assignees;
    const nextAssignees = nextLogin ? [nextLogin] : [];
    setItems((current) => current.map((it) => (it.id === item.id ? { ...it, assignees: nextAssignees } : it)));
    markSaving(item.id, true);
    try {
      await fetchJSON(`/api/github/sprint-board/${encodeURIComponent(item.id)}/assignees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: item.number, assignees: nextAssignees }),
      });
    } catch (err) {
      setItems((current) => current.map((it) => (it.id === item.id ? { ...it, assignees: previous } : it)));
      setError(`Couldn't update assignee for "${item.title}": ${String((err as Error).message || err)}`);
    } finally {
      markSaving(item.id, false);
    }
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setMigrateResults(null);
    setError('');
    try {
      const data = await fetchJSON<{ results: MigrateResult[] }>('/api/github/migrate-backlog', { method: 'POST' });
      setMigrateResults(data.results);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setMigrating(false);
    }
  };

  const handleAddTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newTitle.trim() || !newParentId) return;
    setAdding(true);
    setError('');
    try {
      await fetchJSON('/api/github/sprint-board/sub-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentIssueId: newParentId,
          title: newTitle.trim(),
          status: newStatus,
          assignee: newAssignee,
        }),
      });
      setNewTitle('');
      setNewParentId('');
      setNewStatus(STATUS_COLUMNS[0]);
      setNewAssignee('');
      setShowAddForm(false);
      await load();
    } catch (err) {
      setError(`Couldn't add task: ${String((err as Error).message || err)}`);
    } finally {
      setAdding(false);
    }
  };

  if (loading && !githubStatus) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <h3>Loading sprint board…</h3>
      </div>
    );
  }

  if (githubStatus && !githubStatus.configured) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <h3>GitHub isn't configured yet</h3>
        <p>
          Set <code>GITHUB_TOKEN</code>, <code>GITHUB_OWNER</code> and <code>GITHUB_PROJECT_NUMBER</code> in the
          server's <code>.env</code>, then restart the server and refresh this page.
        </p>
      </div>
    );
  }

  const draftCount = items.filter((item) => item.isDraft).length;
  const addDisabledReason = !githubStatus?.repoConfigured
    ? 'Set GITHUB_REPO in the server .env to create tasks'
    : !sprint
      ? "No Sprint iteration covers today — add one on the project's \"Sprint\" field first"
      : '';

  return (
    <div>
      <div className="sprint-board-toolbar">
        <div>
          {sprint ? (
            <span className="prep-paste-hint">
              <strong style={{ color: 'var(--color-ember-dark)' }}>{sprint.title}</strong> · {formatDateRange(sprint)}
            </span>
          ) : (
            githubStatus && (
              <span className="prep-paste-hint">
                No Sprint iteration covers today — add one on the project's "Sprint" field to see tasks here.
              </span>
            )
          )}
        </div>
        <div className="sprint-board-toolbar-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => setShowAddForm((current) => !current)}
            disabled={Boolean(addDisabledReason)}
            title={addDisabledReason || undefined}
          >
            {showAddForm ? 'Cancel' : '+ Add Task'}
          </button>
          <button type="button" className="secondary-button small" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {githubStatus?.repoConfigured && draftCount > 0 && (
            <button type="button" className="primary-button" onClick={handleMigrate} disabled={migrating}>
              {migrating ? 'Migrating…' : `Migrate ${draftCount} draft card${draftCount > 1 ? 's' : ''} to Issues`}
            </button>
          )}
        </div>
      </div>

      {showAddForm && (
        <form className="sprint-add-form" onSubmit={handleAddTask}>
          <div className="sprint-add-form-row">
            <input
              type="text"
              placeholder="Task title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              disabled={adding}
              autoFocus
              required
            />
            <select
              value={newParentId}
              onChange={(event) => setNewParentId(event.target.value)}
              disabled={adding}
              required
            >
              <option value="">Sub-issue of…</option>
              {parentOptions.map((option) => (
                <option key={option.issueId!} value={option.issueId!}>
                  {option.title} #{option.number}
                </option>
              ))}
            </select>
          </div>
          <div className="sprint-add-form-row">
            <select value={newStatus} onChange={(event) => setNewStatus(event.target.value)} disabled={adding}>
              {STATUS_COLUMNS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select value={newAssignee} onChange={(event) => setNewAssignee(event.target.value)} disabled={adding}>
              <option value="">Unassigned</option>
              {assignableUsers.map((login) => (
                <option key={login} value={login}>
                  {login}
                </option>
              ))}
            </select>
            <button type="submit" className="primary-button" disabled={adding || !newTitle.trim() || !newParentId}>
              {adding ? 'Adding…' : 'Add to current sprint'}
            </button>
          </div>
        </form>
      )}

      {error && <p className="chat-error">{error}</p>}

      {migrateResults && (
        <div className="status-message" style={{ marginBottom: 16 }}>
          Migrated {migrateResults.filter((r) => r.ok).length} of {migrateResults.length} cards.
          {migrateResults.some((r) => !r.ok) && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {migrateResults
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.title}>
                    {r.title}: {r.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {sprint && items.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🗓️</div>
          <h3>Nothing in {sprint.title} yet</h3>
          <p>
            Set an item's "Sprint" field to <strong>{sprint.title}</strong> on the project board to pull it in
            here.
          </p>
        </div>
      )}

      <div className="sprint-board-columns">
        {STATUS_COLUMNS.map((column) => {
          const columnItems = items.filter((item) => (item.status || 'Backlog') === column);
          return (
            <div className="sprint-column" key={column}>
              <div className="sprint-column-header">
                <span>{column}</span>
                <span className="sprint-column-count">{columnItems.length}</span>
              </div>

              {columnItems.map((item) => (
                <div className="sprint-card" key={item.id}>
                  {item.isDraft && <span className="sprint-draft-badge">Draft — not yet an issue</span>}
                  <div className="sprint-card-title">{item.title}</div>
                  {item.url && (
                    <a className="sprint-card-link" href={item.url} target="_blank" rel="noreferrer">
                      #{item.number} on GitHub ↗
                    </a>
                  )}
                  {item.parentNumber && (
                    <a
                      className="sprint-card-parent"
                      href={`https://github.com/${githubStatus?.owner}/${githubStatus?.repo}/issues/${item.parentNumber}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ↳ Sub-issue of {item.parentTitle} #{item.parentNumber}
                    </a>
                  )}

                  <div className="sprint-card-field">
                    <span className="sprint-card-field-label">Status</span>
                    <select
                      value={item.status || 'Backlog'}
                      disabled={savingIds[item.id]}
                      onChange={(event) => handleStatusChange(item, event.target.value)}
                    >
                      {STATUS_COLUMNS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sprint-card-field">
                    <span className="sprint-card-field-label">Day</span>
                    <select
                      value={item.day || ''}
                      disabled={savingIds[item.id]}
                      onChange={(event) => handleDayChange(item, event.target.value)}
                    >
                      <option value="">Unscheduled</option>
                      {WEEKDAYS.map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sprint-card-field">
                    <span className="sprint-card-field-label">Assigned to</span>
                    <select
                      value={item.assignees[0] || ''}
                      disabled={savingIds[item.id] || !item.number}
                      onChange={(event) => handleAssigneeChange(item, event.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {assignableUsers.map((login) => (
                        <option key={login} value={login}>
                          {login}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SprintDashboard;
