import { useMemo, useState } from 'react';
import { useWhatsappInbox, type WhatsappThread } from '../../../lib/useWhatsappAttention';
import { usePersistedChoice } from '../../../lib/usePersistedChoice';

// The WhatsApp conversations in Odoo that are still waiting on us.
//
// A triage screen, not a chat client: it answers "who have we left hanging,
// and for how long", then hands off to Odoo Discuss to actually reply. Sending
// from here would mean this dashboard could put a message in front of a paying
// customer, which is a different and much heavier thing than showing that one
// is owed — so the reply button opens the real conversation instead.
//
// Ordering is the server's (see server/integrations/odooWhatsapp.js): needs
// attention first, longest wait at the top, so the list reads top-to-bottom as
// the order to work through.

type Filter = 'attention' | 'all';
const FILTERS: Filter[] = ['attention', 'all'];

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

// The one-line verdict on a row, and the colour that goes with it. Order
// matters: a failed send outranks a wait, because there the customer doesn't
// even know we tried.
function statusOf(thread: WhatsappThread): { label: string; tone: 'failed' | 'waiting' | 'clear' } {
  if (thread.failedSend) return { label: 'Send failed', tone: 'failed' };
  if (thread.awaitingReply) return { label: `Waiting ${formatDuration(thread.waitingMinutes)}`, tone: 'waiting' };
  return { label: 'Replied', tone: 'clear' };
}

const WhatsAppInbox = () => {
  const { inbox, counts, threads, error, loading, refreshing, refresh } = useWhatsappInbox();
  const [filter, setFilter] = usePersistedChoice<Filter>('smokerings.whatsapp.filter', 'attention', FILTERS);
  // Which threads are expanded to their conversation tail. Ids rather than
  // indexes, so a refresh that reorders the list can't collapse the one being
  // read or expand someone else's.
  const [openThreads, setOpenThreads] = useState<number[]>([]);

  const visible = useMemo(
    () => (filter === 'attention' ? threads.filter((thread) => thread.needsAttention) : threads),
    [threads, filter],
  );

  const toggleThread = (channelId: number) =>
    setOpenThreads((open) =>
      open.includes(channelId) ? open.filter((id) => id !== channelId) : [...open, channelId],
    );

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
          Customer conversations from Odoo that are still waiting on us — longest wait first. Replies are written in
          Odoo Discuss.
        </p>
      </header>

      <div className="marketing-content wa-inbox">
        {error ? <p className="wa-error">Couldn’t reach Odoo: {error}</p> : null}
        {unavailable ? <p className="wa-notice">{inbox?.reason}</p> : null}

        {unavailable ? null : (
          <>
            <div className="wa-summary">
              <div className={`wa-stat${counts.awaitingReply ? ' is-hot' : ''}`}>
                <span className="wa-stat-value">{counts.awaitingReply}</span>
                <span className="wa-stat-label">Awaiting reply</span>
              </div>
              <div className={`wa-stat${counts.failedSend ? ' is-bad' : ''}`}>
                <span className="wa-stat-value">{counts.failedSend}</span>
                <span className="wa-stat-label">Send failed</span>
              </div>
              <div className="wa-stat">
                <span className="wa-stat-value">{counts.threads}</span>
                <span className="wa-stat-label">Conversations</span>
              </div>
            </div>

            <div className="wa-toolbar">
              <div className="wa-filter">
                <button
                  type="button"
                  className={`wa-filter-pill${filter === 'attention' ? ' is-on' : ''}`}
                  onClick={() => setFilter('attention')}
                >
                  Needs attention{counts.needsAttention ? ` (${counts.needsAttention})` : ''}
                </button>
                <button
                  type="button"
                  className={`wa-filter-pill${filter === 'all' ? ' is-on' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  All conversations{counts.threads ? ` (${counts.threads})` : ''}
                </button>
              </div>

              <div className="wa-inbox-actions">
                {inbox?.fetchedAt ? <span className="wa-fetched">Updated {formatTime(inbox.fetchedAt)}</span> : null}
                <button type="button" className="wa-refresh" onClick={() => void refresh()} disabled={refreshing}>
                  {refreshing ? 'Refreshing…' : '↻ Refresh'}
                </button>
              </div>
            </div>

            {loading ? <p className="wa-notice">Loading conversations…</p> : null}

            {!loading && visible.length === 0 ? (
              <div className="wa-empty">
                <span aria-hidden="true">✅</span>
                <p>
                  {filter === 'attention'
                    ? 'All caught up — every customer has had a reply.'
                    : 'No WhatsApp conversations in Odoo yet.'}
                </p>
              </div>
            ) : null}

            <ul className="wa-thread-list">
              {visible.map((thread) => {
                const status = statusOf(thread);
                const isOpen = openThreads.includes(thread.channelId);
                return (
                  <li key={thread.channelId} className={`wa-thread wa-thread-${status.tone}`}>
                    <div className="wa-thread-main">
                      <div className="wa-thread-who">
                        <span className="wa-thread-name">{thread.customer}</span>
                        {thread.phone ? <span className="wa-thread-phone">+{thread.phone}</span> : null}
                      </div>

                      <div className="wa-thread-tags">
                        <span className={`wa-status wa-status-${status.tone}`}>{status.label}</span>
                        {/* The 24h rule decides whether a reply can be typed at
                            all or has to go out as an approved template, so it
                            belongs on the row you decide from — not buried in
                            Odoo, where you'd find out after writing one. */}
                        {thread.replyWindow.open ? (
                          <span className="wa-window wa-window-open">
                            Free reply for {formatDuration(thread.replyWindow.minutesLeft)}
                          </span>
                        ) : (
                          <span className="wa-window wa-window-shut">24h window closed — template only</span>
                        )}
                        {thread.unreadCount > 0 ? <span className="wa-unread">{thread.unreadCount} unread</span> : null}
                      </div>

                      <p className="wa-thread-preview">
                        <span className="wa-thread-from" aria-hidden="true">
                          {thread.lastMessageFrom === 'customer' ? '💬' : '↩'}
                        </span>
                        {thread.lastMessagePreview || <em>No message text</em>}
                      </p>

                      {thread.failedSend ? (
                        <p className="wa-thread-failure">
                          Last send failed{thread.failedSend.reason ? `: ${thread.failedSend.reason}` : ''}
                        </p>
                      ) : null}

                      <div className="wa-thread-foot">
                        <span className="wa-thread-time">{formatTime(thread.lastMessageAt)}</span>
                        <button
                          type="button"
                          className="wa-thread-toggle"
                          onClick={() => toggleThread(thread.channelId)}
                        >
                          {isOpen ? 'Hide conversation' : 'Show conversation'}
                        </button>
                        {thread.odooUrl ? (
                          <a className="wa-thread-open" href={thread.odooUrl} target="_blank" rel="noreferrer">
                            Reply in Odoo →
                          </a>
                        ) : null}
                      </div>
                    </div>

                    {isOpen ? (
                      <ol className="wa-messages">
                        {thread.messages.map((message) => (
                          <li key={message.id} className={`wa-message wa-message-${message.from}`}>
                            <span className="wa-message-text">{message.text || <em>(no text)</em>}</span>
                            <span className="wa-message-meta">
                              {message.from === 'customer' ? thread.customer : message.author || 'Us'} ·{' '}
                              {formatTime(message.at)}
                              {message.state === 'error' ? ' · failed' : ''}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};

export default WhatsAppInbox;
