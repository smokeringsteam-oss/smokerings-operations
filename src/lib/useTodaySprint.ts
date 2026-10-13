import { useCallback, useEffect, useState } from 'react';

// Today's items from the GitHub sprint board, for the note bubble — so the
// board and the bubble agree on what is still to do. An item moved to Done on
// the board drops out of the bubble on the next fetch; one ticked in the
// bubble is moved to Done on the board, by the same status write the board's
// own dropdown and Daily View make. Nothing is copied: the board is the record.
//
// Only fetched while the panel is open. Each read is a GitHub API call, and
// nobody needs the sprint refreshed behind a closed bubble.

export type SprintItem = {
  id: string;
  status: string | null;
  assignedTo: string;
  day: string | null;
  isDraft: boolean;
  title: string;
  number: number | null;
  url: string | null;
  assignees: string[];
};

export const SPRINT_DONE = 'Done';

const POLL_MS = 60_000;

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data as T;
}

export function useTodaySprint(active: boolean, weekday: string) {
  const [items, setItems] = useState<SprintItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await fetchJSON<{ configured: boolean }>('/api/github/status');
      // No GitHub set up is not an error — the bubble just has no sprint rows.
      if (!status.configured) {
        setItems([]);
        return;
      }
      const board = await fetchJSON<{ items: SprintItem[] }>('/api/github/sprint-board');
      setItems(board.items || []);
      setError(null);
    } catch (err) {
      // Last good answer stays on screen, same as the notes and the cadence.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  // Moves the box first and puts it back if GitHub refuses.
  const setStatus = useCallback(async (item: SprintItem, status: string) => {
    setItems((current) => current.map((it) => (it.id === item.id ? { ...it, status } : it)));
    try {
      await fetchJSON(`/api/github/sprint-board/${encodeURIComponent(item.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      setItems((current) => current.map((it) => (it.id === item.id ? { ...it, status: item.status } : it)));
      throw err;
    }
  }, []);

  return {
    items: items.filter((item) => item.day === weekday),
    error,
    setStatus,
  };
}
