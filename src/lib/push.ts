// Turning notifications on and off from the browser.
//
// The flow has four steps and every one of them can fail on its own, which is
// why this returns explanatory strings rather than booleans: when the toggle in
// Daily View doesn't work, the answer needs to be on screen, on the phone,
// where the console isn't.
//
//   1. the browser must support service workers and push at all;
//   2. the page must be on a secure origin;
//   3. the user must grant notification permission;
//   4. the subscription must reach the server, which needs VAPID keys set.
//
// On the tailnet URL (https://legion.tail946602.ts.net) 2 is satisfied by the
// certificate Tailscale serves. On http://127.0.0.1:5173 it is satisfied too —
// localhost is treated as secure — so this is testable from the desktop
// without going through the phone.

export type PushState = {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  // Set when something is standing in the way, phrased for a person.
  blockedReason: string;
};

const SW_URL = '/sw.js';

// ---- Inside the Android app ------------------------------------------------
//
// The Smoke Rings Ops app (Website-Hoster's native build) shows this page in a
// WebView, which has no service worker push and no Notification API. It hands
// the page a `NativePush` bridge instead: ask it for the state, get back the
// app's Firebase token, and register that with the server, which pushes to it
// through FCM (server/core/fcmSend.js). Everything below the native branch in
// each function is the browser path, unchanged.

type NativeState = {
  type: 'state';
  available: boolean;
  permission: 'granted' | 'denied' | 'default';
  token: string;
  error?: string;
};

type NativeBridge = {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
};

// Remembers that reminders were turned on in the app, so a rotated Firebase
// token is re-registered on the next load instead of silently going quiet.
const NATIVE_ON_KEY = 'nativePushOn';

function nativeBridge(): NativeBridge | null {
  return (window as unknown as { NativePush?: NativeBridge }).NativePush ?? null;
}

export function isNativeApp(): boolean {
  return nativeBridge() !== null;
}

let nativeWaiting: Array<(state: NativeState) => void> = [];

// Every request gets a state reply, in order, so whoever is waiting gets the
// latest one.
function askNative(type: 'state' | 'enable'): Promise<NativeState> {
  const bridge = nativeBridge();
  if (!bridge) return Promise.reject(new Error('Not running in the app.'));
  bridge.onmessage = (event) => {
    let state: NativeState;
    try {
      state = JSON.parse(event.data);
    } catch {
      return;
    }
    if (state?.type !== 'state') return;
    const waiting = nativeWaiting;
    nativeWaiting = [];
    waiting.forEach((resolve) => resolve(state));
  };
  return new Promise((resolve) => {
    nativeWaiting.push(resolve);
    bridge.postMessage(JSON.stringify({ type }));
  });
}

function rememberNativeOn(on: boolean) {
  try {
    if (on) localStorage.setItem(NATIVE_ON_KEY, '1');
    else localStorage.removeItem(NATIVE_ON_KEY);
  } catch {
    // Storage unavailable: the only cost is no automatic re-register.
  }
}

function wasNativeOn(): boolean {
  try {
    return localStorage.getItem(NATIVE_ON_KEY) === '1';
  } catch {
    return false;
  }
}

async function registerAppToken(token: string): Promise<void> {
  const resp = await fetch('/api/push/app/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, label: 'Android app' }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || 'The server refused the app registration.');
  }
}

const NATIVE_DENIED =
  'Notifications are off for this app — turn them on in Android Settings → Apps → Smoke Rings Ops → Notifications, then try again.';

async function getNativePushState(): Promise<PushState> {
  const [state, status] = await Promise.all([
    askNative('state'),
    fetch('/api/push/status')
      .then((r) => r.json())
      .catch(() => ({})),
  ]);
  if (!state.available) {
    return {
      supported: false,
      permission: 'unsupported',
      subscribed: false,
      blockedReason: state.error || "This build of the app can't receive notifications.",
    };
  }
  const tail = state.token ? state.token.slice(-12) : '';
  let subscribed = !!tail && (status.subscriptions || []).some(
    (sub: { kind?: string; id?: string }) => sub.kind === 'app' && sub.id === tail,
  );
  // Firebase rotates tokens now and then. If reminders were on, register the
  // new one rather than showing the switch as off for no visible reason.
  if (!subscribed && tail && state.permission === 'granted' && status.appConfigured && wasNativeOn()) {
    try {
      await registerAppToken(state.token);
      subscribed = true;
    } catch {
      // Shown as off; tapping the switch will surface the actual error.
    }
  }
  return {
    supported: true,
    permission: state.permission,
    subscribed,
    blockedReason: state.permission === 'denied' ? NATIVE_DENIED : state.error || '',
  };
}

async function enableNativePush(): Promise<void> {
  const state = await askNative('enable');
  if (!state.available) throw new Error(state.error || "This build of the app can't receive notifications.");
  if (state.permission !== 'granted') {
    throw new Error(
      state.permission === 'denied'
        ? NATIVE_DENIED
        : 'The permission prompt closed without an answer — tap the button again.',
    );
  }
  if (!state.token) {
    throw new Error(state.error || 'The app has no push token yet — check the phone is online and try again.');
  }
  await registerAppToken(state.token);
  rememberNativeOn(true);
}

async function disableNativePush(): Promise<void> {
  rememberNativeOn(false);
  const state = await askNative('state');
  if (!state.token) return;
  await fetch('/api/push/app/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: state.token }),
  }).catch(() => undefined);
}

// VAPID keys travel as base64url text and the subscribe() call wants bytes.
//
// The ArrayBuffer is allocated explicitly rather than letting Uint8Array.from
// pick one: from() is typed as ArrayBufferLike, which admits SharedArrayBuffer,
// and applicationServerKey will not accept that. Backing the view with a plain
// ArrayBuffer is what makes this a BufferSource.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Whether an existing subscription was made against the key the server is
// using now. `options.applicationServerKey` comes back as an ArrayBuffer, and
// is null on browsers that don't expose it — in which case the honest answer
// is "assume it still matches", since dropping a working subscription on a
// guess is the worse outcome of the two.
function sameKey(stored: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!stored) return true;
  const bytes = new Uint8Array(stored);
  if (bytes.length !== expected.length) return false;
  return bytes.every((byte, i) => byte === expected[i]);
}

// A name for this device, so a stale subscription in the list is recognisable
// as "the old phone" rather than as a URL fragment. Best-effort by design —
// the useful cases are Android and Windows, and anything else falls back to a
// label that is at least honest.
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android phone';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
  if (/Windows/i.test(ua)) return 'Windows desktop';
  if (/Mac/i.test(ua)) return 'Mac';
  return 'Browser';
}

function isSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  // `ready` rather than the register() result: a worker that has only just
  // been registered is still installing, and subscribing against it throws.
  if (existing) return navigator.serviceWorker.ready;
  await navigator.serviceWorker.register(SW_URL);
  return navigator.serviceWorker.ready;
}

// What the toggle should be showing right now. Never throws — a broken state
// still has to render something.
export async function getPushState(): Promise<PushState> {
  if (isNativeApp()) {
    try {
      return await getNativePushState();
    } catch (err) {
      return {
        supported: true,
        permission: 'default',
        subscribed: false,
        blockedReason: (err as Error).message || 'Could not read the notification state.',
      };
    }
  }
  if (!isSupported()) {
    return {
      supported: false,
      permission: 'unsupported',
      subscribed: false,
      // The one case that is worth naming, because it is silent and confusing:
      // a page served over plain http (a bare tailnet IP, say) has no service
      // worker API at all, and looks like an unsupported browser.
      blockedReason: window.isSecureContext
        ? "This browser doesn't support push notifications."
        : 'Notifications need an https:// address — open the dashboard on its tailnet URL.',
    };
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_URL);
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: !!subscription,
      blockedReason:
        Notification.permission === 'denied'
          ? 'Notifications are blocked for this site — allow them in the browser’s site settings, then try again.'
          : '',
    };
  } catch (err) {
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: false,
      blockedReason: (err as Error).message || 'Could not read the notification state.',
    };
  }
}

// Registers the worker, asks for permission, subscribes, and hands the
// subscription to the server. Throws with a readable message on any failure —
// the caller shows it verbatim.
export async function enablePush(): Promise<void> {
  if (isNativeApp()) return enableNativePush();
  if (!isSupported()) throw new Error('This browser cannot receive push notifications.');

  // FIRST, before anything that awaits.
  //
  // Requesting a permission requires transient activation — the browser has to
  // still be able to see the tap that led here. An `await` in front of this
  // spends that activation, and Chrome for Android then resolves the request as
  // dismissed no matter which button is actually pressed: the prompt appears,
  // Allow is tapped, and this comes back 'default'. Fetching the server's
  // status first is exactly that mistake, so the fetch now happens below.
  const asked = await Notification.requestPermission();

  // Trust the live value over what the call returned. These disagree in
  // practice — a prompt answered while the activation had lapsed reports
  // 'default' even though the browser did record the grant — and the property
  // is the browser's actual state, so it is the one worth believing.
  const permission = Notification.permission === 'granted' ? 'granted' : asked;
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.'
        : 'The permission prompt closed without an answer — tap the button again.',
    );
  }

  const status = await fetch('/api/push/status').then((r) => r.json());
  if (!status.configured) {
    throw new Error('The server has no VAPID keys set — run `npm run push:keys` and add them to .env.');
  }

  const registration = await getRegistration();
  const serverKey = urlBase64ToUint8Array(status.publicKey);

  // Reuse whatever this browser already has — but only if it was created
  // against the key the server is currently signing with.
  //
  // A subscription outlives the keys it was made with, and one made against an
  // old pair is the worst kind of broken: the browser still reports itself as
  // subscribed, the toggle still says on, and every push is rejected at the
  // push service where nobody sees it. So a stale one is dropped and replaced
  // rather than reused. This only comes up after `npm run push:keys --force`,
  // which is exactly when nobody remembers to re-enable anything by hand.
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, serverKey)) {
    // Tell the server before dropping it locally. Once unsubscribe() has run,
    // the endpoint is gone from this browser and nothing can ever name it
    // again — so a row left behind here is unreachable, un-cleanable except by
    // the push service eventually 404ing it, and in the meantime it inflates
    // every "sent to N devices" with a device that received nothing.
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      // Required to be true by Chrome: every push must show a notification.
      userVisibleOnly: true,
      applicationServerKey: serverKey,
    });
  }

  const resp = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: deviceLabel() }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || 'The server refused the subscription.');
  }
}

// Unsubscribes this browser and tells the server to forget it.
//
// The server is told first. If the order were reversed, a failed unsubscribe
// would leave a row the server still pushes to for a browser that has already
// dropped the subscription — notifications from a switch that says Off.
export async function disablePush(): Promise<void> {
  if (isNativeApp()) return disableNativePush();
  if (!isSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (!subscription) return;

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);

  await subscription.unsubscribe();
}

// Everything about this device that decides whether push can work, gathered so
// a phone can report its own state.
//
// This exists because the failure that matters happens on a handset, where
// there is no console and no way to inspect anything. A permission that will
// not stick has several possible causes that look identical from the outside —
// Chrome lacking Android's own notification permission, an insecure origin, a
// service worker that never activated — and they need different fixes.
export async function getDiagnostics(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (isNativeApp()) {
    out.surface = 'Android app (Firebase push)';
    out.origin = window.location.origin;
    try {
      const state = await askNative('state');
      out.pushAvailable = String(state.available);
      out.permission = state.permission;
      out.token = state.token ? `yes (${state.token.slice(-12)})` : 'none';
      if (state.error) out.error = state.error;
      const status = await fetch('/api/push/status').then((r) => r.json());
      out.serverAppPush = status.appConfigured ? 'configured' : 'NOT configured (FIREBASE_SERVICE_ACCOUNT)';
      out.serverKnowsToken = String(
        (status.subscriptions || []).some(
          (sub: { kind?: string; id?: string }) => sub.kind === 'app' && sub.id === state.token.slice(-12),
        ),
      );
    } catch (err) {
      out.error = (err as Error).message;
    }
    out.browser = navigator.userAgent;
    return out;
  }
  out.permission = 'Notification' in window ? Notification.permission : 'no Notification API';
  out.origin = window.location.origin;
  out.secureContext = String(window.isSecureContext);
  out.serviceWorkerAPI = 'serviceWorker' in navigator ? 'yes' : 'NO';
  out.pushAPI = 'PushManager' in window ? 'yes' : 'NO';
  // Standalone means it was launched from the home screen rather than a tab.
  // Not required for push, but it tells us which surface is being tested.
  out.displayMode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser tab';

  try {
    const registration = await navigator.serviceWorker?.getRegistration(SW_URL);
    if (!registration) {
      out.serviceWorker = 'not registered';
    } else {
      out.serviceWorker = registration.active
        ? 'active'
        : registration.installing
          ? 'installing'
          : registration.waiting
            ? 'waiting'
            : 'registered, no worker';
      const subscription = await registration.pushManager.getSubscription();
      out.subscription = subscription ? `yes (${subscription.endpoint.slice(-12)})` : 'none';

      // Whether this subscription still matches the key the server signs with.
      // A mismatch means every tap of the toggle silently replaces the
      // subscription with a new one, which looks like it worked and leaves a
      // trail of dead endpoints behind it.
      if (subscription) {
        const status = await fetch('/api/push/status').then((r) => r.json());
        out.keyMatchesServer = status.publicKey
          ? String(sameKey(subscription.options.applicationServerKey, urlBase64ToUint8Array(status.publicKey)))
          : 'server has no key';
      }
    }
  } catch (err) {
    out.serviceWorker = `error: ${(err as Error).message}`;
  }

  out.browser = navigator.userAgent;
  return out;
}

// Shows a notification straight from the service worker, with no push service
// involved at all.
//
// This is the test that splits the problem in half. If this appears, the
// permission and the worker are both fine and the fault is in delivery; if it
// does not, nothing server-side is worth investigating yet.
export async function showLocalTestNotification(): Promise<string> {
  if (isNativeApp()) throw new Error('Not available in the app — use "Send now" to test a real push.');
  if (Notification.permission !== 'granted') {
    throw new Error(`Permission is "${Notification.permission}" — nothing can be shown until it is granted.`);
  }
  const registration = await getRegistration();
  const stamp = new Date().toLocaleTimeString();
  await registration.showNotification(`Local test ${stamp}`, {
    body: 'No push service involved — this came straight from the service worker.',
    icon: '/notification-icon.png',
    badge: '/notification-badge.png',
    tag: 'local-test',
  });

  // Ask the worker whether the notification actually exists now.
  //
  // showNotification() resolving proves only that the request was accepted, not
  // that anything was displayed — Android can swallow it silently for a muted
  // channel, Do Not Disturb, or a per-site block. This is the one way to tell
  // "the page never asked" apart from "the phone declined to show it", and
  // those have completely different fixes.
  const live = await registration.getNotifications({ tag: 'local-test' });
  return live.length
    ? `Created OK at ${stamp}. If nothing is visible, Android is hiding it — check Do Not Disturb and Chrome's notification settings for this site.`
    : `The phone accepted the request but kept no notification — notifications are being suppressed at the Android level for this site.`;
}

// Fires today's pending-task notification immediately, so the toggle can be
// proved to work without waiting until 07:00 tomorrow.
export async function sendTestPush(): Promise<string> {
  const resp = await fetch('/api/push/test', { method: 'POST' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Could not send the test notification.');
  return data.message || 'Sent.';
}

// Fires a WhatsApp-alarm push immediately — the noisy kind, with the vibrate
// pattern and the flag that makes an open page start the audio loop.
//
// Separate from sendTestPush() because it proves a different half of the
// system. That one proves delivery; this one proves the noise, which depends
// on things no server can see: the Android notification channel's sound, the
// handset's media volume, and whether a page was open to play the file at all.
// When the alarm is "not loud enough", this is the button that narrows down
// which of those it is.
export async function sendAlarmTest(): Promise<string> {
  const resp = await fetch('/api/push/alarm-test', { method: 'POST' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Could not send the test alarm.');
  return data.message || 'Sent.';
}
