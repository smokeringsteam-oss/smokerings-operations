// OAuth2 against a Google account, for the one thing a service account
// cannot do: upload to YouTube.
//
// Every other Google call in this project uses the service account
// (googleServiceAccount.js) and needs no human in the loop. YouTube is the
// exception, and not by oversight — the Data API refuses service accounts
// outright, because a video has to be owned by a channel and a service
// account has no channel. So this is the one credential that requires
// somebody to sit down once and click "Allow".
//
// What that leaves behind is a refresh token: a long-lived string that buys a
// fresh hour-long access token whenever one is needed, without asking again.
// It goes in .env as GOOGLE_OAUTH_REFRESH_TOKEN. It does not expire on a
// timer, but it *is* revoked by changing the account password, by removing
// the app in the Google account's security settings, and — the one that
// catches people — by leaving the OAuth consent screen in "Testing" mode,
// where Google expires refresh tokens after seven days. Publishing the
// consent screen (even without verification) is what makes it durable.
//
// Run `npm run youtube:login` to mint one; server/scripts/youtubeLogin.js
// drives the flow and prints what to paste.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// The upload scope, and nothing else. youtube.upload can insert a video and
// cannot read the channel's analytics, edit other videos, or touch playlists
// — which is the whole of what this feature does.
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

// Drive, as two scopes that do two different jobs, because the feature reads
// footage it did not create and writes masters it did.
//
//   * drive.file is per-file access to files this app itself created. It is
//     what uploads a finished reel and what keeps owning it afterwards. On
//     its own it can neither read nor even see anything else in the account.
//
//   * drive.readonly is what makes the source library possible at all. The
//     clips and the songs a reel is built from are put in the folder by hand
//     — dropped in from a phone after a cook — and a file this app did not
//     create is invisible to drive.file no matter which folder it sits in.
//     There is no folder-scoped Drive scope; Google does not offer one. The
//     narrowing is done in code instead: every read in googleDrive.js pins
//     `'<GOOGLE_DRIVE_FOLDER_ID>' in parents`, so the token could reach the
//     rest of the account but nothing in this app ever asks it to.
//
// readonly rather than the full `drive` scope is the part that is load-
// bearing: the source library is only ever read, so a bug in here cannot
// rewrite or delete a file somebody put in that folder. Writing is confined
// to drive.file, which can only touch this app's own renders.
//
// Both are Drive scopes and Google grants them in one consent screen — unlike
// the YouTube pairing described below, which it refuses.
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
];

// Space-separated is the wire format for a multi-scope request, and the
// single string is what the rest of the flow passes around.
export const DRIVE_SCOPE = DRIVE_SCOPES.join(' ');

// TWO SIGN-INS, NOT ONE, AND NOT BY CHOICE.
//
// The obvious design is one consent screen granting both scopes and one
// refresh token carrying both. Google refuses it outright:
//
//   Error 400: invalid_request
//   ...contains scopes that cannot be requested together:
//   [.../auth/youtube.upload, .../auth/drive.file]
//
// YouTube's scopes cannot be combined with another Google API's in a single
// authorisation request. So each product gets its own sign-in and its own
// refresh token, entirely independent of one another — which at least means
// re-authorising Drive cannot disturb YouTube.
//
// Everything else about the flow is shared, so this table is the only place
// the difference lives: which script mints it, which variable holds it, and
// what to call it when it is missing.
export const OAUTH_PRODUCTS = {
  youtube: {
    label: 'YouTube',
    scope: YOUTUBE_SCOPE,
    env: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    command: 'npm run youtube:login',
  },
  drive: {
    label: 'Drive',
    scope: DRIVE_SCOPE,
    env: 'GOOGLE_DRIVE_REFRESH_TOKEN',
    command: 'npm run drive:login',
  },
};

const productSpec = (product) => OAUTH_PRODUCTS[product] || OAUTH_PRODUCTS.youtube;

// Google's out-of-band redirect was switched off in 2022, so the loopback
// address is the only redirect a desktop client can use. The login script
// listens on this port for the one request Google makes to it.
export const LOOPBACK_PORT = 47623;
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/oauth2callback`;

// The client is shared by both products — one OAuth app, authorised twice —
// so only the refresh token varies.
export function getOAuthConfig(product = 'youtube') {
  const spec = productSpec(product);
  return {
    clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env[spec.env] || '').trim(),
    spec,
  };
}

export function describeOAuthConfig(product = 'youtube') {
  const { clientId, clientSecret, refreshToken, spec } = getOAuthConfig(product);
  const hasClient = Boolean(clientId && clientSecret);
  return {
    // Signed in, as opposed to merely having an app registered. Both halves
    // are needed and they fail differently, so the message says which.
    configured: Boolean(hasClient && refreshToken),
    hasClient,
    signedIn: Boolean(refreshToken),
    // Safe to show: the client id is public by design (it travels in the
    // browser URL of the consent screen). The secret and the refresh token
    // never leave this module.
    clientId,
    error: !hasClient
      ? 'No Google OAuth client: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env (Cloud console > APIs & Services > Credentials > OAuth client ID > Desktop app).'
      : !refreshToken
        ? `Not signed in to ${spec.label} yet — run "${spec.command}" and paste the token it prints into ${spec.env}. Each product signs in separately because Google will not grant YouTube and Drive scopes in one request.`
        : '',
  };
}

// The consent URL the login script opens.
//
// access_type=offline is what asks for a refresh token at all, and
// prompt=consent forces one to be issued even when this account has already
// approved the app — without it a second run comes back with an access token
// only, and the script would have nothing to print.
// How the consent URL is handed to a browser, per platform.
//
// Split out from the login script and exported for one reason: the Windows
// branch has to quote the URL, getting it wrong is silent, and the symptom
// points somewhere else entirely.
//
// `cmd /c` splits its command line on `&` before anything downstream sees it,
// and a consent URL is nothing but `&`. Unquoted, the browser is handed only
//
//   https://accounts.google.com/o/oauth2/v2/auth?client_id=...
//
// and cmd tries to run `response_type=code` as a command. Google answers
//
//   Error 400: invalid_request
//   Required parameter is missing: response_type
//
// which reads as a bug in how the URL was built — and it is not, because the
// same URL pasted by hand works perfectly. That gap between the two is what
// makes it expensive to find, and it is why this is a tested function rather
// than four lines inside a script that cannot be imported.
//
// `windowsVerbatimArguments` is what lets the quotes survive to cmd: without
// it Node applies its own quoting rules on the way out and re-escapes them.
// The empty `""` ahead of the URL is `start`'s window-title argument — drop it
// and start reads the quoted URL as a title and opens nothing at all.
export function browserOpenCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '""', `"${url}"`], options: { windowsVerbatimArguments: true } };
  }
  // Neither of these goes through a shell, so the URL needs no quoting and
  // must not have any: a literal quote would become part of the address.
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [url], options: {} };
}

export function buildConsentUrl({ state, scope = YOUTUBE_SCOPE }) {
  const { clientId } = getOAuthConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params, what) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // invalid_grant is the one worth naming: for an exchange it means the
    // code was already used or has expired (they last minutes); for a refresh
    // it means the token was revoked, or the consent screen is still in
    // Testing mode and Google expired it after seven days.
    const detail = json.error_description || json.error || `HTTP ${resp.status}`;
    const err = new Error(
      json.error === 'invalid_grant'
        ? `Google rejected the ${what}: ${detail}. If this used to work, the refresh token has been revoked — re-run \`npm run youtube:login\`. A consent screen left in "Testing" expires them every seven days; publishing it stops that.`
        : `Google rejected the ${what}: ${detail}`,
    );
    err.status = 502;
    throw err;
  }
  return json;
}

// Swaps the one-time code from the consent redirect for the durable refresh
// token. Only the login script calls this.
export async function exchangeCode(code) {
  const { clientId, clientSecret } = getOAuthConfig();
  const json = await tokenRequest(
    {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    },
    'sign-in code',
  );
  if (!json.refresh_token) {
    const err = new Error(
      'Google returned an access token but no refresh token, so nothing durable to save. That happens when the account has already approved this app — revoke it at https://myaccount.google.com/permissions and run this again.',
    );
    err.status = 502;
    throw err;
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

// One access token per refresh token, reused until nearly expired — the same
// bargain googleServiceAccount.js makes, and for the same reason: an upload
// is several calls and minting a token per call is round trips for nothing.
//
// Keyed on the refresh token rather than on the product, which covers two
// things at once: two products cannot serve each other a token minted from
// the wrong sign-in, and editing .env and restarting cannot serve one minted
// from a previous sign-in of the same product.
const cache = new Map();

export async function googleAccessToken(product = 'youtube') {
  const { clientId, clientSecret, refreshToken, spec } = getOAuthConfig(product);
  if (!clientId || !clientSecret || !refreshToken) {
    const err = new Error(describeOAuthConfig(product).error);
    err.status = 400;
    throw err;
  }

  const hit = cache.get(refreshToken);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;

  const json = await tokenRequest(
    { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
    `saved ${spec.label} sign-in`,
  );
  cache.set(refreshToken, {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  });
  return json.access_token;
}
