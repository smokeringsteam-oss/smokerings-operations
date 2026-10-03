// Web Push: getting a message onto the pitmaster's phone when the dashboard
// isn't open.
//
// The dashboard is a Chrome home-screen shortcut on
// https://legion.tail946602.ts.net, which Tailscale serves under a real
// certificate — a secure context, which is the only thing a service worker and
// a push subscription actually require. It does NOT have to be an installed
// PWA: notification permission is granted per origin, so the shortcut receives
// these exactly as an install would.
//
// The path a notification takes is worth holding on to, because it explains
// both the strength and the limit of this:
//
//     legion (this process) -> the browser's push service -> the handset
//
// Nothing goes over the tailnet, so a reminder arrives on mobile data, at a
// market, anywhere. But this process has to be running to send it — legion
// asleep means no reminder — and tapping one opens the dashboard, which does
// need the tailnet.
//
// Keys are VAPID, generated once by `npm run push:keys` and pasted into .env.
// They identify this server to the push service; regenerating them silently
// invalidates every existing subscription, so every phone would have to turn
// notifications on again.
//
// The Android app (Smoke Rings Ops, built in native mode) can't use web push:
// it is a WebView, not Chrome. It registers a Firebase token instead
// (push_app_token), and sendToAll() delivers to those through fcmSend.js
// alongside the browser subscriptions.
import webpush from 'web-push';
import { isFcmConfigured, sendFcm } from './fcmSend.js';
import { count, remove, select, update, upsert } from './repo.js';

// Rows in push_delivery older than this are dropped on startup. They exist to
// stop a reminder firing twice in one day, so anything from a previous week is
// only taking up space — but a few weeks are kept so the table can still
// answer "did that actually go out?" when a missed reminder is disputed.
const DELIVERY_RETENTION_DAYS = 21;

// Consecutive non-fatal failures before a subscription is dropped. A push
// service returning 500s for an afternoon shouldn't cost a real phone its
// subscription; one that has genuinely gone away answers 404/410 and is
// removed on the first try regardless of this.
const MAX_CONSECUTIVE_FAILURES = 10;

let configured = null;

// Reads the VAPID keys out of the environment and hands them to web-push.
// Memoised on first call rather than done at import: server/index.js imports
// this module whether or not push is set up, and an unconfigured server should
// still start and serve everything else normally.
function ensureConfigured() {
  if (configured !== null) return configured;
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!publicKey || !privateKey) {
    configured = false;
    return configured;
  }
  // The subject is a contact address the push service can use if this server
  // starts misbehaving. It has to be a mailto: or https: URL — a bare address
  // is rejected by web-push — so it is normalised here rather than in .env.
  const subject = (process.env.VAPID_SUBJECT || '').trim() || 'mailto:smokerings.team@gmail.com';
  webpush.setVapidDetails(
    /^(mailto:|https:)/.test(subject) ? subject : `mailto:${subject}`,
    publicKey,
    privateKey,
  );
  configured = true;
  return configured;
}

function isConfigured() {
  return ensureConfigured();
}

// The public half, which the browser needs in order to create a subscription.
// Safe to serve to anyone — it is public by design, and useless without the
// private half that never leaves this machine.
function getPublicKey() {
  return ensureConfigured() ? (process.env.VAPID_PUBLIC_KEY || '').trim() : '';
}

// ---- Subscriptions ------------------------------------------------------

// Upsert rather than insert: a phone that re-subscribes usually comes back on
// the same endpoint, and that should refresh its keys rather than fail on the
// primary key. created_at is deliberately not in the patch, so a returning
// phone keeps the date it first subscribed.
function saveSubscription({ endpoint, keys, label } = {}) {
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    const err = new Error('A push subscription needs an endpoint and both keys.');
    err.status = 400;
    throw err;
  }
  upsert('push_subscription', ['endpoint'], {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    label: label || null,
    // Any successful re-subscribe clears whatever failure history the old row
    // had: this is a live browser telling us it is listening again.
    failure_count: 0,
  });
  return { endpoint, label: label || '' };
}

function deleteSubscription(endpoint) {
  if (!endpoint) return { removed: 0 };
  // required:false — unsubscribing a phone the server has never heard of is
  // a no-op, not a 404. The browser calls this on every 'turn it off', and it
  // has no way of knowing whether its endpoint ever reached us.
  return { removed: remove('push_subscription', { endpoint }, { required: false }) };
}

// ---- Android app tokens -------------------------------------------------

// Whether the server can push to the Android app at all (a Firebase service
// account is configured). Separate from isConfigured(), which is web push.
function isAppConfigured() {
  return isFcmConfigured();
}

// Same upsert-and-reset as saveSubscription: the app re-registers its token
// every time the page loads with reminders on, and that should refresh the row,
// not fail on the key.
function saveAppToken({ token, label } = {}) {
  if (!token || typeof token !== 'string') {
    const err = new Error('An app registration needs a token.');
    err.status = 400;
    throw err;
  }
  upsert('push_app_token', ['token'], { token, label: label || null, failure_count: 0 });
  return { id: token.slice(-12), label: label || '' };
}

function deleteAppToken(token) {
  if (!token) return { removed: 0 };
  return { removed: remove('push_app_token', { token }, { required: false }) };
}

// Endpoints and tokens are long and reveal which push service a device uses,
// so the list the UI gets back is trimmed to what it needs to show: a label,
// when it was added, and enough of a fingerprint to tell two phones apart.
// `kind` lets the page tell a browser subscription from the app's.
function listSubscriptions() {
  const describe = (row, key, kind) => ({
    id: row[key].slice(-12),
    kind,
    label: row.label || '',
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at || '',
    failureCount: row.failure_count || 0,
  });
  return [
    ...select('push_subscription').map((row) => describe(row, 'endpoint', 'browser')),
    ...select('push_app_token').map((row) => describe(row, 'token', 'app')),
  ].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// Everything that can receive a push: browsers and app installs alike, so the
// timers' "is anyone listening?" check counts the app too.
function subscriptionCount() {
  return count('push_subscription') + count('push_app_token');
}

// ---- Sending ------------------------------------------------------------

// Sends one payload to every subscribed browser and every registered app.
//
// Returns a summary rather than throwing: the caller is usually a timer, which
// wants to know what happened, and one dead phone must not stop the others
// being told. The payload is JSON the service worker reads — see public/sw.js
// for the shape it expects — and the app receives the same keys as FCM data.
async function sendToAll(payload) {
  const webReady = ensureConfigured();
  const appReady = isFcmConfigured();
  if (!webReady && !appReady) return { sent: 0, failed: 0, removed: 0, skipped: 'not configured' };
  const rows = webReady ? select('push_subscription') : [];
  const appRows = appReady ? select('push_app_token') : [];
  if (!rows.length && !appRows.length) return { sent: 0, failed: 0, removed: 0, skipped: 'no subscriptions' };

  const body = JSON.stringify(payload);
  const now = new Date().toISOString();
  let sent = 0;
  let failed = 0;
  let removed = 0;

  const toApps = appRows.map(async (row) => {
    const result = await sendFcm(row.token, payload);
    if (result.ok) {
      sent += 1;
      update('push_app_token', { token: row.token }, { last_sent_at: now, failure_count: 0 }, { required: false });
      return;
    }
    // Same rules as a browser: gone for good is dropped at once, anything else
    // is counted and only dropped after MAX_CONSECUTIVE_FAILURES in a row.
    const next = (row.failure_count || 0) + 1;
    if (result.gone || next >= MAX_CONSECUTIVE_FAILURES) {
      remove('push_app_token', { token: row.token }, { required: false });
      removed += 1;
      if (!result.gone) failed += 1;
      return;
    }
    failed += 1;
    console.error(`[push] app push failed (${next}/${MAX_CONSECUTIVE_FAILURES}) — ${result.error}`);
    update('push_app_token', { token: row.token }, { failure_count: next }, { required: false });
  });

  await Promise.all([
    ...toApps,
    ...rows.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        // Half a day of TTL: a phone that was off overnight should still get
        // this morning's reminder when it comes back, but yesterday's is not
        // worth delivering.
        await webpush.sendNotification(subscription, body, { TTL: 60 * 60 * 12 });
        sent += 1;
        // required:false throughout this loop: rows are read up front, and a
        // subscription can be deleted by an /unsubscribe call while the sends
        // are in flight. That is a no-op, not an error worth failing a tick.
        update(
          'push_subscription',
          { endpoint: row.endpoint },
          { last_sent_at: now, failure_count: 0 },
          { required: false },
        );
      } catch (err) {
        // 404 and 410 are the push service saying this subscription is gone
        // for good — the shortcut was removed, or permission was revoked.
        // Anything else (a timeout, a 500) is treated as transient.
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          remove('push_subscription', { endpoint: row.endpoint }, { required: false });
          removed += 1;
          return;
        }
        failed += 1;
        const next = (row.failure_count || 0) + 1;
        if (next >= MAX_CONSECUTIVE_FAILURES) {
          remove('push_subscription', { endpoint: row.endpoint }, { required: false });
          removed += 1;
        } else {
          update('push_subscription', { endpoint: row.endpoint }, { failure_count: next }, { required: false });
        }
      }
    }),
  ]);

  return { sent, failed, removed };
}

// ---- Delivery log -------------------------------------------------------

// True the first time it is called with a given key, false every time after.
//
// This is what makes a one-minute timer safe: the tick that finds a task due
// claims it here, and the fifty-nine ticks behind it find it already claimed.
// The claim is written BEFORE the send, so a push service that hangs cannot
// produce a second notification while the first is still in flight. The cost
// is that a genuinely failed send is not retried — which, for a reminder about
// something that is sitting in Daily View anyway, is the better way round.
function claimDelivery(notifyKey) {
  if (!notifyKey) return false;
  if (count('push_delivery', { notify_key: notifyKey })) return false;
  upsert('push_delivery', ['notify_key'], {
    notify_key: notifyKey,
    sent_at: new Date().toISOString(),
  });
  return true;
}

function pruneDeliveries(now = new Date()) {
  const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86400000).toISOString();
  const stale = select('push_delivery').filter((row) => (row.sent_at || '') < cutoff);
  stale.forEach((row) => remove('push_delivery', { notify_key: row.notify_key }, { required: false }));
  return stale.length;
}

export {
  claimDelivery,
  deleteAppToken,
  deleteSubscription,
  getPublicKey,
  isAppConfigured,
  isConfigured,
  listSubscriptions,
  pruneDeliveries,
  saveAppToken,
  saveSubscription,
  sendToAll,
  subscriptionCount,
  MAX_CONSECUTIVE_FAILURES,
};
