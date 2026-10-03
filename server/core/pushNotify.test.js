// The Android app's half of sendToAll: tokens registered by the app get the
// same payload as browsers, through FCM, and are pruned by the same rules.
// fcmSend is mocked, so this is about pushNotify's bookkeeping only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, removeTestDb } from './testDb.js';

const fcm = vi.hoisted(() => ({ configured: true, results: new Map(), sent: [] }));

vi.mock('./fcmSend.js', () => ({
  isFcmConfigured: () => fcm.configured,
  sendFcm: async (token, payload) => {
    fcm.sent.push({ token, payload });
    return fcm.results.get(token) || { ok: true };
  },
}));

let dir;
let repo;
let push;

beforeAll(async () => {
  ({ dir } = createTestDb());
  repo = await import('./repo.js');
  push = await import('./pushNotify.js');
});

afterAll(() => removeTestDb(dir));

beforeEach(() => {
  repo.select('push_app_token').forEach((row) => repo.remove('push_app_token', { token: row.token }));
  repo.select('push_subscription').forEach((row) => repo.remove('push_subscription', { endpoint: row.endpoint }));
  fcm.configured = true;
  fcm.results.clear();
  fcm.sent.length = 0;
  // No VAPID keys in the test environment: only the app half is live.
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('app tokens', () => {
  it('registers, lists as kind "app", counts, and unregisters', () => {
    push.saveAppToken({ token: 'token-for-the-pixel-0001', label: 'Android app' });
    // Re-registering the same token refreshes the row rather than failing.
    push.saveAppToken({ token: 'token-for-the-pixel-0001', label: 'Android app' });

    expect(push.subscriptionCount()).toBe(1);
    expect(push.listSubscriptions()).toEqual([
      expect.objectContaining({ id: 'e-pixel-0001', kind: 'app', label: 'Android app' }),
    ]);

    expect(push.deleteAppToken('token-for-the-pixel-0001')).toEqual({ removed: 1 });
    expect(push.subscriptionCount()).toBe(0);
  });

  it('refuses a registration with no token', () => {
    expect(() => push.saveAppToken({})).toThrow(/token/);
  });
});

describe('sendToAll to the app', () => {
  it('sends the payload to every app token even with no VAPID keys', async () => {
    push.saveAppToken({ token: 'one' });
    push.saveAppToken({ token: 'two' });
    const payload = { title: 'Ravi', body: 'Hi', tag: 'whatsapp-7', alarm: 'whatsapp' };

    expect(await push.sendToAll(payload)).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(fcm.sent.map((call) => call.token).sort()).toEqual(['one', 'two']);
    expect(fcm.sent[0].payload).toEqual(payload);
    expect(repo.selectOne('push_app_token', { token: 'one' }).last_sent_at).toBeTruthy();
  });

  it('drops a token FCM says is gone, and only counts a transient failure', async () => {
    push.saveAppToken({ token: 'uninstalled' });
    push.saveAppToken({ token: 'flaky' });
    fcm.results.set('uninstalled', { ok: false, gone: true, error: 'UNREGISTERED' });
    fcm.results.set('flaky', { ok: false, gone: false, error: 'Unavailable' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await push.sendToAll({ title: 'x' })).toEqual({ sent: 0, failed: 1, removed: 1 });
    expect(repo.selectOne('push_app_token', { token: 'uninstalled' })).toBeFalsy();
    expect(repo.selectOne('push_app_token', { token: 'flaky' }).failure_count).toBe(1);
  });

  it('gives up on a token after MAX_CONSECUTIVE_FAILURES in a row', async () => {
    push.saveAppToken({ token: 'flaky' });
    repo.update('push_app_token', { token: 'flaky' }, { failure_count: push.MAX_CONSECUTIVE_FAILURES - 1 });
    fcm.results.set('flaky', { ok: false, gone: false, error: 'Unavailable' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await push.sendToAll({ title: 'x' })).toEqual({ sent: 0, failed: 1, removed: 1 });
    expect(push.subscriptionCount()).toBe(0);
  });

  it('reports "not configured" with neither VAPID nor Firebase, and leaves tokens alone', async () => {
    fcm.configured = false;
    push.saveAppToken({ token: 'one' });
    expect(await push.sendToAll({ title: 'x' })).toMatchObject({ sent: 0, skipped: 'not configured' });
    expect(fcm.sent).toEqual([]);
  });

  it('reports "no subscriptions" when Firebase is set up but nothing is registered', async () => {
    expect(await push.sendToAll({ title: 'x' })).toMatchObject({ sent: 0, skipped: 'no subscriptions' });
  });
});
