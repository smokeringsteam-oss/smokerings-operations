// Pushing to the Android app through FCM: the service-account handshake, the
// message shape the app expects, and how a dead token is told apart from a bad
// afternoon. fetch is stubbed throughout, so nothing here reaches Google.
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { isFcmConfigured, resetFcmForTests, sendFcm, toData } from './fcmSend.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT = {
  type: 'service_account',
  project_id: 'smokerings-test',
  client_email: 'push@smokerings-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

let dir;
let accountPath;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fcm-'));
  accountPath = join(dir, 'service-account.json');
  writeFileSync(accountPath, JSON.stringify(ACCOUNT));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resetFcmForTests();
  process.env.FIREBASE_SERVICE_ACCOUNT = accountPath;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Answers the token exchange, then whatever `send` returns for the FCM call.
function stubGoogle(send) {
  const calls = [];
  const fetchStub = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      return json(200, { access_token: 'ya29.test', expires_in: 3600 });
    }
    return send(url, init);
  });
  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

describe('configuration', () => {
  it('is off without FIREBASE_SERVICE_ACCOUNT', () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    expect(isFcmConfigured()).toBe(false);
  });

  it('is off, not crashing, when the file is missing or is not a service account', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FIREBASE_SERVICE_ACCOUNT = join(dir, 'nope.json');
    expect(isFcmConfigured()).toBe(false);

    resetFcmForTests();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ project_id: 'x' }));
    process.env.FIREBASE_SERVICE_ACCOUNT = bad;
    expect(isFcmConfigured()).toBe(false);
    spy.mockRestore();
  });

  it('is on with a readable service account', () => {
    expect(isFcmConfigured()).toBe(true);
  });
});

describe('toData', () => {
  it('turns every value into a string and drops empty ones', () => {
    expect(
      toData({ title: 'Ravi', channelId: 42, alarm: 'whatsapp', extra: { a: 1 }, none: null, gone: undefined }),
    ).toEqual({ title: 'Ravi', channelId: '42', alarm: 'whatsapp', extra: '{"a":1}' });
  });
});

describe('sendFcm', () => {
  it('signs a JWT the service account key verifies, and sends a high-priority data message', async () => {
    const calls = stubGoogle(() => json(200, { name: 'projects/smokerings-test/messages/1' }));

    const result = await sendFcm('device-token', { title: 'Ravi', body: 'Hi', tag: 'whatsapp-7', channelId: 7 });
    expect(result).toEqual({ ok: true });

    // The token exchange: a JWT bearer grant, signed with the account's key.
    const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, signature, 'base64url');
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: ACCOUNT.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });

    // The send: the project's v1 endpoint, the bearer token, data-only.
    expect(calls[1].url).toBe('https://fcm.googleapis.com/v1/projects/smokerings-test/messages:send');
    expect(calls[1].init.headers.Authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(calls[1].init.body)).toEqual({
      message: {
        token: 'device-token',
        data: { title: 'Ravi', body: 'Hi', tag: 'whatsapp-7', channelId: '7' },
        android: { priority: 'HIGH', ttl: '43200s' },
      },
    });
  });

  it('reuses the access token instead of signing in for every push', async () => {
    const calls = stubGoogle(() => json(200, {}));
    await sendFcm('a', { title: 'one' });
    await sendFcm('b', { title: 'two' });
    expect(calls.filter((call) => call.url.includes('oauth2')).length).toBe(1);
  });

  it('marks an uninstalled app (404 / UNREGISTERED) as gone', async () => {
    stubGoogle(() =>
      json(404, {
        error: {
          message: 'Requested entity was not found.',
          details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
        },
      }),
    );
    expect(await sendFcm('dead', { title: 'x' })).toMatchObject({ ok: false, gone: true, status: 404 });
  });

  it('treats a server error or a network failure as transient, not gone', async () => {
    stubGoogle(() => json(503, { error: { message: 'Unavailable' } }));
    expect(await sendFcm('t', { title: 'x' })).toMatchObject({ ok: false, gone: false, error: 'Unavailable' });

    resetFcmForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (url.includes('oauth2')) return json(200, { access_token: 'ya29', expires_in: 3600 });
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    expect(await sendFcm('t', { title: 'x' })).toMatchObject({ ok: false, gone: false });
  });

  it('does nothing when not configured', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    expect(await sendFcm('t', { title: 'x' })).toMatchObject({ ok: false, gone: false });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
