// One-time sign-in to the Google account the reel studio uploads to.
//
//   npm run youtube:login     the YouTube channel
//   npm run drive:login       the Drive the masters go to
//
// Two commands rather than one, and not for tidiness: Google rejects a
// consent request that asks for YouTube's scope alongside another API's —
// "contains scopes that cannot be requested together" — so each product is
// authorised separately and stores its own refresh token. See the comment
// above OAUTH_PRODUCTS in googleOAuth.js.
//
// Opens Google's consent screen in the default browser, catches the redirect
// on a loopback port, swaps the code for a refresh token and prints the line
// to paste into .env. Nothing is written to .env automatically — that file
// holds every other secret this project has, and a script that rewrites it is
// a script that can corrupt it.
//
// Why this exists at all: the YouTube Data API refuses service accounts, so a
// human has to approve once. See server/integrations/googleOAuth.js.
import 'dotenv/config';
import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';
import {
  LOOPBACK_PORT,
  OAUTH_PRODUCTS,
  REDIRECT_URI,
  browserOpenCommand,
  buildConsentUrl,
  exchangeCode,
  getOAuthConfig,
} from '../integrations/googleOAuth.js';

const product = process.argv[2] || 'youtube';
const spec = OAUTH_PRODUCTS[product];
if (!spec) {
  console.error(`Unknown product "${product}". Expected one of: ${Object.keys(OAUTH_PRODUCTS).join(', ')}.`);
  process.exit(1);
}

const { clientId, clientSecret } = getOAuthConfig(product);
if (!clientId || !clientSecret) {
  console.error(`
No OAuth client is configured, so there is nothing to sign in to yet.

  1. Google Cloud console > APIs & Services > Library > enable "YouTube Data API v3"
     on the same project the service account lives in.
  2. APIs & Services > OAuth consent screen > External. Add your own Google
     account under "Test users". Publish it when you are done — a consent
     screen left in Testing expires the refresh token every seven days.
  3. APIs & Services > Credentials > Create credentials > OAuth client ID >
     Desktop app.
  4. Put the two values in .env:

     GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
     GOOGLE_OAUTH_CLIENT_SECRET=...

Then run this again.
`);
  process.exit(1);
}

// Guards against another process on this machine hitting the loopback
// endpoint with a code of its own — the state has to come back unchanged.
const state = crypto.randomBytes(16).toString('hex');
const consentUrl = buildConsentUrl({ state, scope: spec.scope });

// Resolves once the reply is actually on the wire, so the teardown below
// cannot cut the browser off mid-page.
const reply = (res, code, message) =>
  new Promise((resolve) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Smoke Rings — YouTube sign-in</title>
<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">
<h1 style="font-size:1.3rem">${message}</h1>
<p style="color:#666">You can close this tab and go back to the terminal.</p>`,
      resolve,
    );
  });

// How this script ends, and why it is not process.exit().
//
// It used to call server.close() and process.exit() back to back from inside
// the request handler. On Windows that tore the loop down while the server's
// handle was still closing, and libuv aborted the process:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
//
// after every word of output had already been printed. A sign-in that had in
// fact worked — the token was minted, exchanged and printed — exited 127,
// which reads as a failed login and sends you round the whole loop again.
//
// So nothing is killed. The reply is flushed, the listener stops, the
// browser's keep-alive socket is dropped (it is idle by then, and without
// this the process would sit there waiting on it), and node exits on its own
// once there is nothing left to wait for. process.exitCode carries the
// verdict out without forcing the exit.
const finish = async (res, code, message, status) => {
  await reply(res, code, message);
  process.exitCode = status;
  server.close();
  server.closeAllConnections?.();
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${LOOPBACK_PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    console.error(`\nSign-in was refused: ${error}`);
    await finish(res, 400, `Google said: ${error}`, 1);
    return;
  }

  if (url.searchParams.get('state') !== state) {
    // Not fatal, and deliberately not an exit: something else on this machine
    // hit the port. Keep waiting for the real redirect.
    await reply(res, 400, 'That sign-in did not come from this script.');
    console.error('\nThe state did not match — ignoring that redirect.');
    return;
  }

  try {
    const { refreshToken } = await exchangeCode(url.searchParams.get('code'));
    console.log(`
Signed in to ${spec.label}. Put this in .env and restart the server:

${spec.env}=${refreshToken}

It does not expire on a timer — but it IS revoked by changing the account
password, by removing the app at https://myaccount.google.com/permissions,
and by leaving the OAuth consent screen in "Testing", where Google expires
these after seven days. Publish the consent screen to avoid that last one.
`);
    await finish(res, 200, 'Signed in. ✅', 0);
  } catch (err) {
    console.error(`\n${err.message || err}`);
    await finish(res, 500, 'Could not complete the sign-in.', 1);
  }
});

// The loopback port is fixed, because Google will only redirect to a URI that
// was registered with the OAuth client. So a login left running — or one
// killed in a way that left its node process behind — blocks the next one,
// and node's default behaviour for that is to throw an unhandled 'error'
// event and print a stack trace about `listenInCluster`, which says nothing
// about sign-ins, ports held by an earlier run, or what to do next.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
Port ${LOOPBACK_PORT} is already in use, so this sign-in cannot listen for
Google's redirect.

That port is almost always held by an earlier run of this script that is still
waiting, or was killed without its node process going with it. Close the other
terminal, or end that process, and run this again. The port is fixed and
cannot simply be changed here — Google only redirects to the exact URI
registered on the OAuth client.
`);
  } else {
    console.error(`\nCould not start the sign-in listener: ${err.message}`);
  }
  process.exitCode = 1;
});

server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
  console.log(`
Opening Google's consent screen for ${spec.label}.
${
  product === 'youtube'
    ? 'Sign in as the account that owns the YouTube channel — not necessarily the\none that owns the Cloud project.'
    : 'Sign in as the account whose Drive the finished reels should live in. The\nfiles will be owned by it and count against its storage.'
}

If the browser does not open, paste this in yourself:

${consentUrl}

Waiting for the redirect to ${REDIRECT_URI} …
`);

  // Quoting the URL for cmd is load-bearing on Windows and the failure is
  // silent — see browserOpenCommand in googleOAuth.js, where it is tested.
  const opener = browserOpenCommand(consentUrl);
  try {
    spawn(opener.command, opener.args, { ...opener.options, detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The URL is printed above; an opener that isn't there is not a failure.
  }
});
