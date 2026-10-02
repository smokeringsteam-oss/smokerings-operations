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

// One of our own WhatsApp business numbers, as Odoo's whatsapp.account models
// it. Null on a thread when Odoo left the channel unattached, or on an Odoo
// without the column at all — see accountOf() in odooWhatsapp.js.
export type WhatsappAccount = {
  id: number;
  name: string;
};

export type WhatsappAccountSummary = WhatsappAccount & {
  threads: number;
  needsAttention: number;
};

export type WhatsappThread = {
  channelId: number;
  customer: string;
  phone: string | null;
  partnerId: number | null;
  account: WhatsappAccount | null;
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
  // Every business number that actually has conversations, for the number
  // filter. Optional so a client running against an older server (or a cached
  // response from before this existed) degrades to "no filter" rather than
  // throwing on a map over undefined.
  accounts?: WhatsappAccountSummary[];
  threads: WhatsappThread[];
};

type Store = {
  data: WhatsappInbox | null;
  error: string | null;
  loading: boolean;
};

const EMPTY_COUNTS: WhatsappCounts = { threads: 0, needsAttention: 0, awaitingReply: 0, failedSend: 0, unread: 0 };
// Frozen module constant rather than a fresh [] per render: this is a
// dependency of the useMemo that builds the filtered list, and a new array
// identity every time would rebuild it on every poll.
const EMPTY_ACCOUNTS: WhatsappAccountSummary[] = [];

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
    accounts: state.data?.accounts ?? EMPTY_ACCOUNTS,
    threads: state.data?.threads ?? [],
    error: state.error,
    // Only "loading" before there is anything to show — a background poll must
    // not put a spinner over a list you are reading.
    loading: state.loading && !state.data,
    refreshing: state.loading,
    refresh,
  };
}

// ---- One open conversation ------------------------------------------------
// The polled inbox only carries a short tail per thread. The chat pane fetches
// the longer history for the one thread on screen, and fetches it again
// whenever the inbox poll shows that thread has moved (`lastMessageAt`
// changed) — so a customer's new message lands in the open chat on the same
// one-minute beat as the badge, without a second timer.

export type WhatsappConversation = {
  channelId: number;
  messages: WhatsappMessage[];
  truncated: boolean;
};

export function useWhatsappConversation(channelId: number | null, lastMessageAt: string | null) {
  const [conversation, setConversation] = useState<WhatsappConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (channelId === null) {
      setConversation(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const resp = await fetch(`/api/odoo/whatsapp/threads/${channelId}/messages`);
        const body = await resp.json();
        if (!resp.ok) throw new Error(body?.error || `Request failed (${resp.status})`);
        if (!cancelled) {
          setConversation(body as WhatsappConversation);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, lastMessageAt, reloadKey]);

  // Switching threads must never flash the previous customer's messages.
  const current = conversation && conversation.channelId === channelId ? conversation : null;

  return {
    conversation: current,
    error,
    loading: loading && !current,
    reload: useCallback(() => setReloadKey((key) => key + 1), []),
  };
}

export type WhatsappSendResult = {
  messageId: number | null;
  state: string | null;
  failureReason: string | null;
  queued: boolean;
};

// Sends a reply, then re-polls the shared inbox so the badge and the list
// clear straight away rather than on the next tick.
export async function sendWhatsappReply(channelId: number, text: string): Promise<WhatsappSendResult> {
  const resp = await fetch(`/api/odoo/whatsapp/threads/${channelId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body?.error || `Send failed (${resp.status})`);
  void load();
  return body as WhatsappSendResult;
}

// What the sidebar bubble needs, and nothing else, so the badge doesn't
// re-render on every field of every thread.
export function useWhatsappAttentionCount(): number {
  const { counts } = useWhatsappInbox();
  return counts.needsAttention;
}
