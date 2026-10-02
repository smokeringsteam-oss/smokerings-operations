import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  sendWhatsappReply,
  useWhatsappConversation,
  useWhatsappInbox,
  type WhatsappAccount,
  type WhatsappMessage,
  type WhatsappThread,
} from '../../../lib/useWhatsappAttention';
import { usePersistedChoice } from '../../../lib/usePersistedChoice';

// The WhatsApp conversations in Odoo, laid out like a chat app: the
// conversation list on the left, the open chat on the right, and a composer
// that sends the reply through Odoo's own WhatsApp module (see
// sendWhatsappReply in server/integrations/odooWhatsapp.js). On a phone the two
// panes stack — the list, then the chat full-screen with a back button.
//
// Still a triage screen first: the list is ordered by the server with needs
// attention first and the longest wait at the top, so it reads top-to-bottom
// as the order to work through. Anything this screen can't send — an approved
// template once the 24h window has closed — links out to Odoo Discuss.
//
// MORE THAN ONE BUSINESS NUMBER. The server hands back every WhatsApp thread
// regardless of which of our numbers it came to, each tagged with its
// `account`. This screen shows them in ONE list — the whole point is a single
// place that answers "who is still waiting", and splitting it per number
// would put that answer in two places and let one of them go unread. The
// number is a label on the row and an optional filter, nothing more.
//
// All of that is hidden while there is only one account, because a badge
// saying the same thing on every row is noise. It appears by itself the first
// time a second number has a conversation.

type Filter = 'attention' | 'all';
const FILTERS: Filter[] = ['attention', 'all'];

// The number filter, as "all" or a stringified whatsapp.account id.
const ALL_ACCOUNTS = 'all';

// A reply typed here that Odoo hasn't handed back in the conversation yet.
type PendingMessage = {
  key: number;
  channelId: number;
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  messageId?: number | null;
};

// "45m" / "3h 20m" / "2d 4h" — a duration you read at a glance from across the
// kitchen, not a timestamp you have to subtract from now in your head.
function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes < 0) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatClock(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// The list's time column: a clock time today, a weekday this week, a date
// beyond that — the same scale every messaging app uses.
function formatListTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return formatClock(iso);
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays < 6) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatDaySeparator(date: Date): string {
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// The one-line verdict on a row, and the colour that goes with it. Order
// matters: a failed send outranks a wait, because there the customer doesn't
// even know we tried.
function statusOf(thread: WhatsappThread): { label: string; tone: 'failed' | 'waiting' | 'clear' } {
  if (thread.failedSend) return { label: 'Send failed', tone: 'failed' };
  if (thread.awaitingReply) return { label: `Waiting ${formatDuration(thread.waitingMinutes)}`, tone: 'waiting' };
  return { label: 'Replied', tone: 'clear' };
}

// Which of our numbers the customer wrote to. Deliberately silent unless
// there is more than one — with a single business line it would be the same
// word on every row, and a badge that is always there stops being read.
function AccountTag({ account, show }: { account: WhatsappAccount | null; show: boolean }) {
  if (!show || !account) return null;
  return (
    <span className="wa-account" title={`Sent to ${account.name}`}>
      {account.name}
    </span>
  );
}

// WhatsApp's own delivery ticks, so the state of a sent message needs no words.
function DeliveryTick({ state }: { state: string | null }) {
  if (!state) return null;
  if (state === 'error') return <span className="wa-tick wa-tick-error" aria-label="failed">!</span>;
  if (state === 'read') return <span className="wa-tick wa-tick-read" aria-label="read">✓✓</span>;
  if (state === 'delivered') return <span className="wa-tick" aria-label="delivered">✓✓</span>;
  if (state === 'sent') return <span className="wa-tick" aria-label="sent">✓</span>;
  return <span className="wa-tick" aria-label="queued">🕓</span>;
}

type ChatProps = {
  thread: WhatsappThread;
  onBack: () => void;
  draft: string;
  onDraftChange: (text: string) => void;
  // True once a second business number has conversations — see AccountTag.
  showAccount: boolean;
};

const ChatPane = ({ thread, onBack, draft, onDraftChange, showAccount }: ChatProps) => {
  const { conversation, error, loading, reload } = useWhatsappConversation(thread.channelId, thread.lastMessageAt);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status = statusOf(thread);

  // Until the longer history arrives, the tail from the inbox poll is already
  // enough to show the chat instantly.
  const messages: WhatsappMessage[] = conversation?.messages ?? thread.messages;

  // A pending bubble retires once Odoo hands the real message back.
  const knownIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const shownPending = pending.filter(
    (item) =>
      item.channelId === thread.channelId &&
      !(item.status === 'sending' && item.messageId && knownIds.has(item.messageId)),
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, shownPending.length, thread.channelId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [thread.channelId]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const key = Date.now();
    setPending((items) => [...items, { key, channelId: thread.channelId, text, status: 'sending' }]);
    onDraftChange('');
    try {
      const result = await sendWhatsappReply(thread.channelId, text);
      if (result.messageId && !result.queued) {
        // Posted into Odoo but never queued for WhatsApp. Not retryable from
        // here — the post already exists, and a retry would duplicate it.
        setPending((items) =>
          items.map((item) =>
            item.key === key
              ? { ...item, status: 'failed', messageId: result.messageId, error: 'Odoo saved it but did not hand it to WhatsApp — check in Odoo.' }
              : item,
          ),
        );
      } else {
        // Sent, or errored at WhatsApp — either way the real message (with its
        // tick or its failure reason) replaces this bubble on reload.
        setPending((items) => items.map((item) => (item.key === key ? { ...item, messageId: result.messageId } : item)));
      }
      reload();
    } catch (err) {
      setPending((items) =>
        items.map((item) =>
          item.key === key
            ? { ...item, status: 'failed', error: err instanceof Error ? err.message : String(err) }
            : item,
        ),
      );
    }
  };

  const retry = (item: PendingMessage) => {
    setPending((items) => items.filter((other) => other.key !== item.key));
    onDraftChange(item.text);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  let lastDay = '';

  return (
    <section className="wa-chat" aria-label={`Conversation with ${thread.customer}`}>
      <div className="wa-chat-head">
        <button type="button" className="wa-chat-back" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <span className="wa-avatar" aria-hidden="true">
          {initialsOf(thread.customer)}
        </span>
        <div className="wa-chat-who">
          <span className="wa-chat-name">{thread.customer}</span>
          <span className="wa-chat-sub">
            {thread.phone ? `+${thread.phone}` : ''}
            {/* Which line they reached us on. It matters here more than on the
                row: the reply you are about to type goes back out from this
                number, and Odoo picks it from the channel, not from you. */}
            <AccountTag account={thread.account} show={showAccount} />
            {thread.replyWindow.open ? (
              <span className="wa-window wa-window-open">Free reply for {formatDuration(thread.replyWindow.minutesLeft)}</span>
            ) : (
              <span className="wa-window wa-window-shut">24h window closed — template only</span>
            )}
            {status.tone !== 'clear' ? <span className={`wa-status wa-status-${status.tone}`}>{status.label}</span> : null}
          </span>
        </div>
        {thread.odooUrl ? (
          <a className="wa-thread-open" href={thread.odooUrl} target="_blank" rel="noreferrer">
            Open in Odoo ↗
          </a>
        ) : null}
      </div>

      <div className="wa-chat-scroll" ref={scrollRef}>
        {error ? <p className="wa-error">Couldn’t load the full conversation: {error}</p> : null}
        {conversation?.truncated ? (
          <p className="wa-chat-note">
            Older messages are in{' '}
            {thread.odooUrl ? (
              <a href={thread.odooUrl} target="_blank" rel="noreferrer">
                Odoo
              </a>
            ) : (
              'Odoo'
            )}
            .
          </p>
        ) : null}
        {loading && !messages.length ? <p className="wa-chat-note">Loading messages…</p> : null}

        <ol className="wa-messages">
          {messages.map((message) => {
            const date = message.at ? new Date(message.at) : null;
            const key = date ? dayKey(date) : '';
            const separator = date && key !== lastDay ? formatDaySeparator(date) : null;
            if (date) lastDay = key;
            return (
              <li key={message.id} className="wa-message-row">
                {separator ? <div className="wa-day">{separator}</div> : null}
                <div className={`wa-message wa-message-${message.from}${message.state === 'error' ? ' is-error' : ''}`}>
                  <span className="wa-message-text">{message.text || <em>(no text)</em>}</span>
                  <span className="wa-message-meta">
                    {/* A login email as the author is noise in a bubble; a
                        teammate's real name is worth showing. */}
                    {message.from === 'us' && message.author && !message.author.includes('@') ? <span className="wa-message-author">{message.author}</span> : null}
                    {formatClock(message.at)}
                    {message.from === 'us' ? <DeliveryTick state={message.state} /> : null}
                  </span>
                  {message.state === 'error' ? (
                    <span className="wa-message-failure">Not delivered{message.failureReason ? `: ${message.failureReason}` : ''}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
          {shownPending.map((item) => (
            <li key={`pending-${item.key}`} className="wa-message-row">
              <div className={`wa-message wa-message-us is-pending${item.status === 'failed' ? ' is-error' : ''}`}>
                <span className="wa-message-text">{item.text}</span>
                <span className="wa-message-meta">
                  {item.status === 'sending' ? (item.messageId ? 'Sent' : 'Sending…') : 'Not sent'}
                </span>
                {item.status === 'failed' ? (
                  <span className="wa-message-failure">
                    {item.error}{' '}
                    {item.messageId ? null : (
                      <button type="button" className="wa-retry" onClick={() => retry(item)}>
                        Edit &amp; retry
                      </button>
                    )}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {thread.replyWindow.open ? (
        <form
          className="wa-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={inputRef}
            className="wa-composer-input"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${thread.customer}`}
            aria-label={`Reply to ${thread.customer}`}
            rows={Math.min(5, Math.max(1, draft.split('\n').length))}
            maxLength={4096}
          />
          <button type="submit" className="wa-composer-send" disabled={!draft.trim()} aria-label="Send">
            ➤
          </button>
        </form>
      ) : (
        // Meta refuses free text once the window shuts, so there is no box to
        // type into — only the way to what does work.
        <div className="wa-composer wa-composer-closed">
          <span>The 24h window has closed — WhatsApp only accepts an approved template now.</span>
          {thread.odooUrl ? (
            <a className="wa-thread-open" href={thread.odooUrl} target="_blank" rel="noreferrer">
              Send a template in Odoo ↗
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
};

const WhatsAppInbox = () => {
  const { inbox, counts, accounts, threads, error, loading, refreshing, refresh } = useWhatsappInbox();
  const [filter, setFilter] = usePersistedChoice<Filter>('smokerings.whatsapp.filter', 'attention', FILTERS);
  // Which business number, or all of them. Deliberately NOT persisted, unlike
  // the attention filter beside it: the safe state to come back to is seeing
  // everything. A narrowed number remembered from last week would hide a
  // waiting customer behind a pill nobody remembers pressing.
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  // The open chat, by id rather than index, so a refresh that reorders the
  // list can't swap the customer you are typing to.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Unsent text per conversation, so hopping to another chat and back keeps it.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  // One number is not a choice, so there is nothing to show or filter by.
  const showAccounts = accounts.length > 1;
  // Resolved rather than stored: an account whose last conversation aged out
  // of the list would otherwise leave the filter pointing at nothing and the
  // list empty, with the pill that caused it no longer on screen.
  const activeAccount =
    showAccounts && accounts.some((account) => String(account.id) === accountFilter) ? accountFilter : ALL_ACCOUNTS;
  const activeAccountName = accounts.find((account) => String(account.id) === activeAccount)?.name ?? null;

  const inScope = useMemo(
    () =>
      activeAccount === ALL_ACCOUNTS
        ? threads
        : threads.filter((thread) => String(thread.account?.id) === activeAccount),
    [threads, activeAccount],
  );

  // The attention/all pills count what they would actually show, which is the
  // number-filtered set — a pill reading "Needs attention (7)" that lands on
  // two rows is worse than no count.
  const scopedCounts = useMemo(
    () => ({ threads: inScope.length, needsAttention: inScope.filter((thread) => thread.needsAttention).length }),
    [inScope],
  );

  const visible = useMemo(
    () => (filter === 'attention' ? inScope.filter((thread) => thread.needsAttention) : inScope),
    [inScope, filter],
  );
  // Looked up in every thread, not just the filtered ones — replying clears
  // "needs attention", and the chat must not vanish mid-conversation. Same
  // reason it ignores the number filter: narrowing the list is not a reason to
  // shut a chat you are halfway through typing into.
  const selected = threads.find((thread) => thread.channelId === selectedId) || null;

  const unavailable = Boolean(inbox && !inbox.available);

  return (
    // Same shell as the B2C and B2B dashboards it sits beside in the sidebar:
    // the dark header strip, then the content well below it.
    <div className="marketing-dashboard">
      <header>
        <h2>
          WhatsApp Inbox
          {counts.needsAttention > 0 ? (
            <span className="wa-bubble wa-bubble-inline" aria-label={`${counts.needsAttention} needing attention`}>
              {counts.needsAttention}
            </span>
          ) : null}
        </h2>
        <p>
          Customer conversations from Odoo — longest wait first. Reply right here; it goes out from{' '}
          {showAccounts ? 'whichever of our numbers the customer wrote to' : 'the business number'}.
        </p>
      </header>

      <div className="marketing-content wa-inbox">
        {error ? <p className="wa-error">Couldn’t reach Odoo: {error}</p> : null}
        {unavailable ? <p className="wa-notice">{inbox?.reason}</p> : null}

        {unavailable ? null : (
          <div className={`wa-layout${selected ? ' has-selection' : ''}`}>
            <aside className="wa-list-pane">
              <div className="wa-toolbar">
                <div className="wa-filter">
                  <button
                    type="button"
                    className={`wa-filter-pill${filter === 'attention' ? ' is-on' : ''}`}
                    onClick={() => setFilter('attention')}
                  >
                    Needs attention{scopedCounts.needsAttention ? ` (${scopedCounts.needsAttention})` : ''}
                  </button>
                  <button
                    type="button"
                    className={`wa-filter-pill${filter === 'all' ? ' is-on' : ''}`}
                    onClick={() => setFilter('all')}
                  >
                    All conversations{scopedCounts.threads ? ` (${scopedCounts.threads})` : ''}
                  </button>
                </div>
                <button
                  type="button"
                  className="wa-refresh"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  title={inbox?.fetchedAt ? `Updated ${formatTime(inbox.fetchedAt)}` : undefined}
                  aria-label="Refresh"
                >
                  {refreshing ? '…' : '↻'}
                </button>
              </div>

              {/* The second row, and only once there is a second number. "All
                  numbers" leads and is the default, so the combined inbox is
                  what you get without choosing anything. */}
              {showAccounts ? (
                <div className="wa-filter wa-filter-accounts" role="group" aria-label="Filter by business number">
                  <button
                    type="button"
                    className={`wa-filter-pill wa-filter-pill-account${activeAccount === ALL_ACCOUNTS ? ' is-on' : ''}`}
                    onClick={() => setAccountFilter(ALL_ACCOUNTS)}
                    aria-pressed={activeAccount === ALL_ACCOUNTS}
                  >
                    All numbers{counts.threads ? ` (${counts.threads})` : ''}
                  </button>
                  {accounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      className={`wa-filter-pill wa-filter-pill-account${
                        activeAccount === String(account.id) ? ' is-on' : ''
                      }`}
                      onClick={() => setAccountFilter(String(account.id))}
                      aria-pressed={activeAccount === String(account.id)}
                    >
                      {account.name}
                      {account.needsAttention ? (
                        <span className="wa-filter-flag" aria-label={`${account.needsAttention} needing attention`}>
                          {account.needsAttention}
                        </span>
                      ) : (
                        ` (${account.threads})`
                      )}
                    </button>
                  ))}
                </div>
              ) : null}

              {loading ? <p className="wa-notice">Loading conversations…</p> : null}

              {!loading && visible.length === 0 ? (
                <div className="wa-empty">
                  <span aria-hidden="true">✅</span>
                  <p>
                    {filter === 'attention'
                      ? `All caught up${activeAccountName ? ` on ${activeAccountName}` : ''} — every customer has had a reply.`
                      : activeAccountName
                        ? `No conversations on ${activeAccountName} yet.`
                        : 'No WhatsApp conversations in Odoo yet.'}
                  </p>
                </div>
              ) : null}

              <ul className="wa-thread-list">
                {visible.map((thread) => {
                  const status = statusOf(thread);
                  const isOpen = thread.channelId === selectedId;
                  return (
                    <li key={thread.channelId}>
                      <button
                        type="button"
                        className={`wa-thread wa-thread-${status.tone}${isOpen ? ' is-open' : ''}`}
                        onClick={() => setSelectedId(thread.channelId)}
                        aria-current={isOpen ? 'true' : undefined}
                      >
                        <span className="wa-avatar" aria-hidden="true">
                          {initialsOf(thread.customer)}
                        </span>
                        <span className="wa-thread-body">
                          <span className="wa-thread-top">
                            <span className="wa-thread-name">{thread.customer}</span>
                            <span className="wa-thread-time">{formatListTime(thread.lastMessageAt)}</span>
                          </span>
                          <span className="wa-thread-preview">
                            {thread.lastMessageFrom === 'us' ? <span className="wa-thread-you">You: </span> : null}
                            {thread.lastMessagePreview || <em>No message text</em>}
                          </span>
                          <span className="wa-thread-tags">
                            {status.tone !== 'clear' ? (
                              <span className={`wa-status wa-status-${status.tone}`}>{status.label}</span>
                            ) : null}
                            {/* Only while the number filter is off: inside a
                                single number the badge repeats the pill above
                                it on every row. */}
                            <AccountTag
                              account={thread.account}
                              show={showAccounts && activeAccount === ALL_ACCOUNTS}
                            />
                            {!thread.replyWindow.open ? <span className="wa-window wa-window-shut">Template only</span> : null}
                            {thread.unreadCount > 0 ? <span className="wa-unread">{thread.unreadCount}</span> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {selected ? (
              <ChatPane
                key={selected.channelId}
                thread={selected}
                onBack={() => setSelectedId(null)}
                draft={drafts[selected.channelId] || ''}
                onDraftChange={(text) => setDrafts((all) => ({ ...all, [selected.channelId]: text }))}
                showAccount={showAccounts}
              />
            ) : (
              <section className="wa-chat wa-chat-empty">
                <span aria-hidden="true">💬</span>
                <p>Pick a conversation to read it and reply.</p>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default WhatsAppInbox;
