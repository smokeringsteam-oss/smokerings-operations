import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The screen, and the sidebar bubble that points at it.
//
// What's pinned here is what the two of them promise each other: the number in
// the bubble is the number of rows the screen shows under "Needs attention",
// and both come from one fetch. They are read from opposite ends of the app —
// the bubble while you're on the packing board, the list once you've walked
// over — and a bubble saying 2 over a list showing 3 would be worse than no
// bubble at all, so it is a test rather than a convention.

const NOW = new Date('2026-09-06T12:00:00Z');

function thread(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 10,
    customer: 'Eric Savage',
    phone: '919886751428',
    partnerId: 57,
    odooUrl: 'https://smokerings.odoo.com/odoo/discuss/10',
    lastMessageAt: '2026-09-06T11:15:00.000Z',
    lastMessageFrom: 'customer',
    lastMessagePreview: 'Is my order out for delivery?',
    awaitingReply: true,
    waitingMinutes: 45,
    unreadCount: 0,
    failedSend: null,
    replyWindow: { expiresAt: '2026-09-07T11:15:00.000Z', open: true, minutesLeft: 1395 },
    needsAttention: true,
    messages: [
      { id: 1, at: '2026-09-06T10:00:00.000Z', from: 'us', author: 'us', text: 'Order confirmed!', state: 'read', failureReason: null },
      { id: 2, at: '2026-09-06T11:15:00.000Z', from: 'customer', author: 'Eric Savage', text: 'Is my order out for delivery?', state: 'received', failureReason: null },
    ],
    ...overrides,
  };
}

function inbox(threads: ReturnType<typeof thread>[]) {
  return {
    configured: true,
    available: true,
    fetchedAt: NOW.toISOString(),
    counts: {
      threads: threads.length,
      needsAttention: threads.filter((t) => t.needsAttention).length,
      awaitingReply: threads.filter((t) => t.awaitingReply).length,
      failedSend: threads.filter((t) => t.failedSend).length,
      unread: threads.reduce((total, t) => total + (t.unreadCount as number), 0),
    },
    threads,
  };
}

// Only the inbox endpoint is answered. The bubble tests render the whole App,
// which lands on Daily View and fetches its own things — those have to fail
// the way an unreachable API fails, which is what they already do under
// App.test.tsx, rather than being handed a WhatsApp payload they can't read.
function serve(payload: unknown, replyStatus = 200, replyBody: unknown = { messageId: 99, state: 'sent', failureReason: null, queued: true }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      const reply = (status: number, body: unknown) =>
        ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
      if (path === '/api/odoo/whatsapp/threads') return reply(200, payload);
      const history = path.match(/^\/api\/odoo\/whatsapp\/threads\/(\d+)\/messages$/);
      if (history) {
        const found = (payload as { threads?: { channelId: number; messages: unknown[] }[] }).threads?.find(
          (t) => t.channelId === Number(history[1]),
        );
        return reply(200, { channelId: Number(history[1]), messages: found?.messages ?? [], truncated: false });
      }
      if (/^\/api\/odoo\/whatsapp\/threads\/\d+\/reply$/.test(path)) return reply(replyStatus, replyBody);
      throw new Error('not stubbed');
    }),
  );
}

// The polling store in useWhatsappAttention.ts is module-scoped by design —
// one fetch for the whole app — so each test needs a module that hasn't
// fetched yet, and the components that close over it re-imported alongside.
async function mount(payload: unknown, ...reply: [number?, unknown?]) {
  serve(payload, ...(reply as [number, unknown]));
  vi.resetModules();
  const { default: WhatsAppInbox } = await import('./WhatsAppInbox');
  return render(<WhatsAppInbox />);
}

beforeEach(() => {
  // The filter choice is persisted, so a test that switched to "All" would
  // otherwise decide where the next one starts.
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the inbox screen', () => {
  it('lists a customer waiting on a reply, with how long they have waited', async () => {
    await mount(inbox([thread()]));

    expect(await screen.findByText('Eric Savage')).toBeInTheDocument();
    expect(screen.getByText('Waiting 45m')).toBeInTheDocument();
    expect(screen.getByText('Is my order out for delivery?')).toBeInTheDocument();
  });

  function openChat() {
    fireEvent.click(screen.getByRole('button', { name: /Eric Savage/ }));
  }

  it('says a long wait in hours rather than counting minutes past sixty', async () => {
    await mount(inbox([thread({ waitingMinutes: 200 })]));

    expect(await screen.findByText('Waiting 3h 20m')).toBeInTheDocument();
  });

  it('shows the 24h window as time left in the open chat', async () => {
    await mount(inbox([thread({ replyWindow: { expiresAt: null, open: true, minutesLeft: 95 } })]));
    await screen.findByText('Eric Savage');
    openChat();

    expect(await screen.findByText(/Free reply for 1h 35m/)).toBeInTheDocument();
  });

  it('offers no typing box once the window shuts, only the way to a template in Odoo', async () => {
    const { unmount } = await mount(inbox([thread({ replyWindow: { expiresAt: null, open: false, minutesLeft: 0 } })]));
    await screen.findByText('Eric Savage');
    expect(screen.getByText('Template only')).toBeInTheDocument();
    openChat();

    expect(screen.getByText(/24h window closed/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /send a template in odoo/i })).toHaveAttribute(
      'href',
      'https://smokerings.odoo.com/odoo/discuss/10',
    );
    unmount();
  });

  it('calls out a send that failed, with the reason from Odoo', async () => {
    await mount(
      inbox([
        thread({
          awaitingReply: false,
          waitingMinutes: null,
          lastMessageFrom: 'us',
          failedSend: { at: NOW.toISOString(), reason: 'Account not registered' },
        }),
      ]),
    );

    expect(await screen.findByText('Send failed')).toBeInTheDocument();
  });

  it('opens a conversation as a chat, each side on its own side', async () => {
    const { container } = await mount(inbox([thread()]));
    await screen.findByText('Eric Savage');
    expect(screen.getByText(/Pick a conversation/)).toBeInTheDocument();

    openChat();

    const chat = await screen.findByRole('region', { name: /conversation with eric savage/i });
    expect(within(chat).getByText('Order confirmed!')).toBeInTheDocument();
    expect(container.querySelectorAll('.wa-message-customer')).toHaveLength(1);
    expect(container.querySelectorAll('.wa-message-us')).toHaveLength(1);
    expect(within(chat).getByRole('link', { name: /open in odoo/i })).toHaveAttribute(
      'href',
      'https://smokerings.odoo.com/odoo/discuss/10',
    );
  });

  it('sends a reply from the composer and shows it in the chat', async () => {
    await mount(inbox([thread()]));
    await screen.findByText('Eric Savage');
    openChat();

    const box = screen.getByRole('textbox', { name: /reply to eric savage/i });
    fireEvent.change(box, { target: { value: 'Yes — out now, 15 mins away!' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText('Yes — out now, 15 mins away!')).toBeInTheDocument();
    const call = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([url]) =>
      String(url).endsWith('/reply'),
    );
    expect(call?.[0]).toBe('/api/odoo/whatsapp/threads/10/reply');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'Yes — out now, 15 mins away!' });
    expect(box).toHaveValue('');
  });

  it('keeps a refused reply on screen with the reason, and puts it back to edit', async () => {
    await mount(inbox([thread()]), 409, { error: 'The 24h reply window has closed' });
    await screen.findByText('Eric Savage');
    openChat();

    const box = screen.getByRole('textbox', { name: /reply to eric savage/i });
    fireEvent.change(box, { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/reply window has closed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /edit & retry/i }));
    expect(box).toHaveValue('Hello?');
  });

  it('hides handled threads by default and shows them on the All filter', async () => {
    const handled = thread({
      channelId: 11,
      customer: 'Manjunath D K',
      awaitingReply: false,
      needsAttention: false,
      waitingMinutes: null,
      lastMessageFrom: 'us',
    });
    await mount(inbox([thread(), handled]));

    expect(await screen.findByText('Eric Savage')).toBeInTheDocument();
    expect(screen.queryByText('Manjunath D K')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /all conversations/i }));
    expect(screen.getByText('Manjunath D K')).toBeInTheDocument();
  });

  it('says so plainly when nothing is owed a reply', async () => {
    await mount(inbox([thread({ awaitingReply: false, needsAttention: false, waitingMinutes: null })]));

    expect(await screen.findByText(/All caught up/)).toBeInTheDocument();
  });

  it('explains itself instead of showing an empty list when the WhatsApp module is missing', async () => {
    await mount({
      configured: true,
      available: false,
      reason: "Odoo's WhatsApp module isn't installed on this database, so there are no conversations to read.",
      fetchedAt: NOW.toISOString(),
      counts: { threads: 0, needsAttention: 0, awaitingReply: 0, failedSend: 0, unread: 0 },
      threads: [],
    });

    expect(await screen.findByText(/WhatsApp module isn't installed/)).toBeInTheDocument();
    // Not the "all caught up" tick — nothing was actually checked.
    expect(screen.queryByText(/All caught up/)).not.toBeInTheDocument();
  });
});

describe('the sidebar bubble', () => {
  it('carries the same count the inbox lists, from the one shared fetch', async () => {
    serve(inbox([thread(), thread({ channelId: 11, customer: 'Manjunath D K' })]));
    vi.resetModules();
    const { default: App } = await import('../../../App');

    const { container } = render(<App />);

    // Two of them by design: the sidebar entry, and the mobile top bar, where
    // the sidebar is off-canvas and the count would otherwise be invisible.
    const bubbles = await screen.findAllByLabelText(/2 WhatsApp conversations needing attention/i);
    expect(bubbles).toHaveLength(2);
    for (const bubble of bubbles) expect(bubble).toHaveTextContent('2');
    expect(container.querySelector('.app-sidebar .wa-bubble')).toBeInTheDocument();
    expect(container.querySelector('.wa-bubble-topbar')).toBeInTheDocument();
    // Both readers share one request — the whole reason the store is
    // module-scoped rather than a hook-local useEffect in each.
    const inboxCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([url]) => String(url) === '/api/odoo/whatsapp/threads',
    );
    expect(inboxCalls).toHaveLength(1);
  });

  it('is absent when nothing needs attention, rather than showing a zero', async () => {
    serve(inbox([thread({ awaitingReply: false, needsAttention: false, waitingMinutes: null })]));
    vi.resetModules();
    const { default: App } = await import('../../../App');

    const { container } = render(<App />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector('.wa-bubble')).toBeNull();
  });
});
