// The one place that knows how a Google service account key is spelled, and
// the one place that turns it into an access token.
//
// This was inside googleAnalytics.js until Drive uploads needed the same
// credential. Two copies of the key parsing would have been two sets of error
// messages for the same paste mistake, and — worse — two token caches, so a
// key edited in .env could be live on one screen and stale on the other.
//
// Raw fetch and node:crypto rather than the googleapis client, for the reason
// googleAnalytics.js gives: the whole Google client stack is a large
// dependency tree for two HTTP calls, one of which is a signature this file
// does in nine lines.
//
// Credentials are configuration, not a file to mount. A service account is
// two strings; requiring a path to the downloaded JSON means a second secret
// to keep in step with .env on every machine this runs on, and it breaks the
// moment the file is moved. The whole-JSON forms (GOOGLE_SERVICE_ACCOUNT_KEY,
// raw or base64) and the file form (GOOGLE_SERVICE_ACCOUNT_KEY_FILE) still
// work for hosts that mount secrets that way, but the two plain fields are
// the route to document.
import crypto from 'crypto';
import fs from 'fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const base64url = (input) => Buffer.from(input).toString('base64url');

// \n arrives escaped whenever the PEM came through an environment variable
// rather than a file; createSign needs the real newlines. Surrounding quotes
// are stripped too — a .env value is already unquoted by dotenv, so a pair
// still present means they were pasted as part of the value.
const normalisePem = (pem) =>
  String(pem)
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .replace(/\\n/g, '\n');

// NOTE: the returned `key` carries the raw private key. Never hand it to a
// route — the describe* helpers in the callers pick the safe fields out.
export function loadServiceAccountKey() {
  // The two credential fields, straight out of the JSON Google hands over.
  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim();
  // Whole-JSON forms, for pasting the downloaded file's contents in one go:
  // raw JSON, or the same base64-encoded (which survives a .env, a CI secret
  // and a copy-paste without any quoting to get wrong).
  const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  // Still honoured for anyone already set up this way, and for hosts that
  // mount a secret as a file. No longer the documented route.
  const keyFile = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '').trim();

  const keySource = email || privateKey ? 'config' : inline ? 'inline' : keyFile ? 'file' : '';

  let key = null;
  let keyError = '';

  if (keySource === 'config') {
    if (!email) {
      keyError =
        'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is set but GOOGLE_SERVICE_ACCOUNT_EMAIL is not. Both come from the service account JSON: client_email and private_key.';
    } else if (!privateKey) {
      keyError =
        'GOOGLE_SERVICE_ACCOUNT_EMAIL is set but GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not. The private key is the "private_key" field of the service account JSON, the whole BEGIN/END block.';
    } else if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(normalisePem(privateKey))) {
      // The easy mistake, named rather than left to fail at signing time:
      // pasting the private_key_id (a 40-character hex string) into the
      // variable that wants the key itself. The id is not a credential and
      // cannot be turned back into one — Google shows the private key exactly
      // once, when the key is created.
      keyError = /^[0-9a-f]{40}$/i.test(privateKey)
        ? `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is set to "${privateKey}", which is the private_key_id, not the key. It needs the "private_key" field of the service account JSON — the block starting "-----BEGIN PRIVATE KEY-----". If that JSON is gone, make a new key: Cloud console > IAM > Service Accounts > Keys > Add key > JSON.`
        : 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY does not look like a PEM private key: it should start with "-----BEGIN PRIVATE KEY-----".';
    } else {
      key = { email, privateKey: normalisePem(privateKey) };
    }
  } else if (inline || keyFile) {
    try {
      let raw = keyFile ? fs.readFileSync(keyFile, 'utf8') : inline;
      // Base64 of the JSON is accepted wherever the JSON is. A service
      // account key is never itself base64, so this cannot misread a real
      // one — and a JSON document always starts with "{".
      if (raw.trim()[0] !== '{' && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      }
      const parsed = JSON.parse(raw);
      if (!parsed.client_email || !parsed.private_key) {
        keyError =
          'The service account JSON has no client_email/private_key — is it an OAuth client secret rather than a service account key?';
      } else {
        key = { email: parsed.client_email, privateKey: normalisePem(parsed.private_key) };
      }
    } catch (err) {
      // Same 40-hex mistake as above, in the variable it used to be made in.
      const looksLikeKeyId = /^[0-9a-f]{40}$/i.test(keyFile);
      keyError = looksLikeKeyId
        ? `GOOGLE_SERVICE_ACCOUNT_KEY_FILE is set to "${keyFile}", which is the private_key_id, not a file path — and no file is needed. Clear it and set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY from the service account JSON instead.`
        : keyFile
          ? `Could not read GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${keyFile}): ${err.message}`
          : `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`;
    }
  }

  return { key, keyError, keySource };
}

// One access token per scope, reused until it is nearly expired. Google's are
// good for an hour, and the ROI screen makes several reports per load —
// minting a token per report would triple the round trips for nothing.
//
// Keyed on the service account email *and* the scope: editing .env and
// restarting must not serve a token signed by the previous key, and a
// read-only Analytics token must never be handed to a Drive upload, which
// would fail with an insufficient-scope error pointing at the wrong file.
const tokenCache = new Map();

export async function mintAccessToken(scope) {
  const { key, keyError } = loadServiceAccountKey();
  if (!key) {
    const err = new Error(keyError || 'No Google service account credentials are configured.');
    err.status = 400;
    throw err;
  }

  const cacheKey = `${key.email}\n${scope}`;
  const cached = tokenCache.get(cacheKey);
  // 60s of slack, so a token that expires mid-call is refreshed before the
  // call rather than failing it.
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const issuedAt = Math.floor(Date.now() / 1000);
  const claim = { iss: key.email, scope, aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;

  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.privateKey, 'base64url');
  } catch (err) {
    // A truncated or re-wrapped PEM fails here rather than at Google, which
    // is worth saying plainly — the error crypto raises on its own ("error:
    // 1E08010C:DECODER routines") tells nobody anything.
    const wrapped = new Error(
      `The service account private key could not be used to sign: ${err.message}. Check the key was copied whole, including the BEGIN/END lines.`,
    );
    wrapped.status = 500;
    throw wrapped;
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    // Google's own description is the useful one here: "invalid_grant" for a
    // clock skew or a deleted key, "invalid_scope" for an API not enabled.
    const err = new Error(
      `Google refused the service account: ${json.error_description || json.error || `HTTP ${resp.status}`}`,
    );
    err.status = 502;
    throw err;
  }

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  });
  return json.access_token;
}
