// Firebase Cloud Messaging: push to the Smoke Rings Ops Android app.
//
// Web push reaches a phone through Chrome, which only works while Chrome is
// running and only shows notifications as the app if Google can verify the
// site, and Google cannot see the tailnet. The Android app built in "native"
// mode (Website-Hoster) is a WebView with its own push, so this is the second
// delivery path next to web-push:
//
//     legion (this process) -> FCM -> the app on the handset
//
// Like web push, nothing goes over the tailnet, so it arrives on mobile data.
// Unlike web push, Chrome doesn't have to be running.
//
// Auth is a Firebase service account: Project settings -> Service accounts ->
// Generate new private key, saved somewhere on legion that is not committed,
// with FIREBASE_SERVICE_ACCOUNT pointing at the file. The OAuth exchange is
// done here with node's own crypto rather than pulling in firebase-admin: it
// is one signed JWT and one POST, and the token is reused for its hour.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// undefined = not read yet, null = not configured (or unreadable).
let account;
let cachedToken = null;

// Read once, on first use, like the VAPID keys: an unconfigured server should
// still start and serve everything else.
function loadServiceAccount() {
  if (account !== undefined) return account;
  const path = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!path) {
    account = null;
    return account;
  }
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    if (!json.client_email || !json.private_key || !json.project_id) {
      throw new Error('not a service account key (needs client_email, private_key, project_id)');
    }
    account = json;
  } catch (err) {
    // Said once, loudly, rather than on every send: a typo in the path is the
    // likely cause and it should be visible in the startup log.
    console.error(`[push] FIREBASE_SERVICE_ACCOUNT (${path}) is unusable — ${err.message}`);
    account = null;
  }
  return account;
}

function isFcmConfigured() {
  return !!loadServiceAccount();
}

function signedAssertion(acct, nowSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: acct.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(acct.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

// An OAuth access token for FCM, reused until a minute before it expires.
async function accessToken(acct, now = Date.now()) {
  if (cachedToken && cachedToken.expiresAt - 60000 > now) return cachedToken.value;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(acct, Math.floor(now / 1000)),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google refused the service account: ${data.error_description || data.error || resp.status}`);
  }
  cachedToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) * 1000 };
  return cachedToken.value;
}

// FCM data values must all be strings. The payload is the same object web push
// sends (title, body, tag, url, alarm, channelId…), so it is flattened as-is
// and the app reads the keys it knows.
function toData(payload = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

// Sends one payload to one app token.
//
// Resolves to { ok: true } or { ok: false, gone, error } and never throws for a
// per-token failure, so one dead phone can't stop the others. `gone` means the
// token will never work again (app uninstalled, data cleared) and should be
// dropped, the FCM equivalent of web push's 404/410.
async function sendFcm(token, payload) {
  const acct = loadServiceAccount();
  if (!acct) return { ok: false, gone: false, error: 'FCM is not configured' };

  let resp;
  try {
    resp = await fetch(`https://fcm.googleapis.com/v1/projects/${acct.project_id}/messages:send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken(acct)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          // Data-only, so the app builds the notification itself and picks the
          // channel (and so the alarm sound) whether it is open or not.
          data: toData(payload),
          // HIGH wakes a phone in Doze; the TTL matches web push's half day.
          android: { priority: 'HIGH', ttl: '43200s' },
        },
      }),
    });
  } catch (err) {
    return { ok: false, gone: false, error: err.message || String(err) };
  }
  if (resp.ok) return { ok: true };

  const body = await resp.json().catch(() => ({}));
  const codes = (body?.error?.details || []).map((detail) => detail.errorCode).filter(Boolean);
  const message = body?.error?.message || `HTTP ${resp.status}`;
  const gone =
    resp.status === 404 ||
    codes.includes('UNREGISTERED') ||
    (codes.includes('INVALID_ARGUMENT') && /registration token/i.test(message));
  return { ok: false, gone, status: resp.status, error: message };
}

// Tests swap the environment between cases; this forgets what was read.
function resetFcmForTests() {
  account = undefined;
  cachedToken = null;
}

export { isFcmConfigured, resetFcmForTests, sendFcm, toData };
