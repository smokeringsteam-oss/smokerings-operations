import { useCallback, useEffect, useState } from 'react';

// The WhatsApp inbox, fetched once for the whole app.
//
// Two things want this data at the same time and must never disagree: the
// notification bubble in the sidebar, which is mounted for the entire session,
// and the WhatsApp Inbox screen itself. A plain useEffect fetch in each would
// mean two timers drifting apart — the badge saying 2 while the list it points
// at shows 3 — and twice the polling, forever, on a tab that is often left
// open all weekend on the kitchen tablet.
//
// So the fetch lives here, module-scoped: one request, one timer, one copy of
// the answer, and every subscriber re-renders off it together. The hook is
// just a window onto that store.
//
// Refreshes on a timer and again whenever the tab is brought back to the
// front, which is the case that actually matters — a phone suspends a
// background tab and its timers with it, so coming back to the dashboard has
// to re-check rather than show whatever was true when it was put down.

export type WhatsappMessage = {
  id: number;
  at: string | null;
  from: 'customer' | 'us';
  author: string | null;
  text: string;
  state: string | null;
  failureReason: string | null;
};

export type WhatsappThread = {
  channelId: number;
  customer: string;
  phone: string | null;
  partnerId: number | null;
  odooUrl: string | null;
  lastMessageAt: string | null;
  lastMessageFrom: 'customer' | 'us' | null;
  lastMessagePreview: string;
  awaitingReply: boolean;
  waitingMinutes: number | null;
  unreadCount: number;
  failedSend: { at: string | null; reason: string | null } | null;
  replyWindow: { expiresAt: string | null; open: boolean; minutesLeft: number };
  needsAttention: boolean;
  messages: WhatsappMessage[];
};

export type WhatsappCounts = {
  threads: number;
  needsAttention: number;
  awaitingReply: number;
  failedSend: number;
  unread: number;
};

export type WhatsappInbox = {
  configured: boolean;
  available: boolean;
  reason?: string;
  fetchedAt: string | null;
  counts: WhatsappCounts;
  threads: WhatsappThread[];
};

type Store = {
  data: WhatsappInbox | null;
  error: string | null;
  loading: boolean;
};

const EMPTY_COUNTS: WhatsappCounts = { threads: 0, needsAttention: 0, awaitingReply: 0, failedSend: 0, unread: 0 };

// One minute. Fast enough that a message landing mid-service is noticed within
// the time it takes to walk back to the counter, slow enough to be nothing at
// all against Odoo — the endpoint is four search_reads over a handful of rows.
const POLL_MS = 60_000;

let store: Store = { data: null, error: null, loading: false };
const subscribers = new Set<(next: Store) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
// Guards against a focus refresh landing on top of an in-flight poll and the
// slower of the two winning.
let inFlight: Promise<void> | null = null;

function publish(next: Store) {
  store = next;
  for (const notify of subscribers) notify(store);
}

async function load(): Promise<void> {
  if (inFlight) return inFlight;
  publish({ ...store, loading: true });
  inFlight = (async () => {
    try {
      const resp = await fetch('/api/odoo/whatsapp/threads');
      const body = await resp.json();
      if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
      publish({ data: body as WhatsappInbox, error: null, loading: false });
    } catch (err) {
      // The last good answer is deliberately kept on screen. A dropped Wi-Fi
      // poll should not blank a badge into looking like "all caught up".
      publish({ ...store, error: err instanceof Error ? err.message : String(err), loading: false });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// The timer and the focus listener only exist while something is watching,
// so a session that never opens the dashboard costs nothing.
function startPolling() {
  if (timer) return;
  timer = setInterval(load, POLL_MS);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onVisibility);
}

function onFocus() {
  void load();
}

function onVisibility() {
  if (!document.hidden) void load();
}

export function useWhatsappInbox() {
  const [state, setState] = useState<Store>(store);

  useEffect(() => {
    subscribers.add(setState);
    startPolling();
    // First subscriber pays for the initial fetch; the second one arrives to
    // an answer already in the store.
    if (!store.data && !inFlight) void load();
    return () => {
      subscribers.delete(setState);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  const refresh = useCallback(() => load(), []);

  return {
    inbox: state.data,
    counts: state.data?.counts ?? EMPTY_COUNTS,
    threads: state.data?.threads ?? [],
    error: state.error,
    // Only "loading" before there is anything to show — a background poll must
    // not put a spinner over a list you are reading.
    loading: state.loading && !state.data,
    refreshing: state.loading,
    refresh,
  };
}

// What the sidebar bubble needs, and nothing else, so the badge doesn't
// re-render on every field of every thread.
export function useWhatsappAttentionCount(): number {
  const { counts } = useWhatsappInbox();
  return counts.needsAttention;
}
