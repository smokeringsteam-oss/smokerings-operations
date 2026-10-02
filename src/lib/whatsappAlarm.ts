import { useEffect, useState } from 'react';

// The alarm itself: the one place in this app that makes a noise.
//
// A service worker cannot play audio — no <audio>, no AudioContext, and Chrome
// ignores the Notification `sound` option. A PAGE can. So the worker's job is
// only to notice and shout; this module's job is to actually sound, and it
// gets woken in three different ways depending on where the dashboard is:
//
//   1. postMessage from the worker, while a tab is open (the kitchen tablet
//      left on the dashboard all weekend — the case this was written for);
//   2. postMessage again when a notification is tapped on an already-open
//      window (the worker deliberately does not navigate, because a reload
//      would tear the <audio> element down mid-laugh);
//   3. ?alarm=whatsapp in the URL, when the tap had to cold-start the app.
//
// All three land on start(). It loops until somebody stops it, which is the
// behaviour that was asked for: a customer message mid-service is worth being
// unable to ignore.
//
// Module-scoped rather than per-component, for the same reason
// useWhatsappAttention.ts is: two mounted copies would be two overlapping
// laughs, and the alarm has to outlive whichever screen happens to be open.

const AUDIO_URL = '/whatsapp-alert.mp3';

// The query the service worker puts on a cold-start URL.
const ALARM_PARAM = 'alarm';
const CHANNEL_PARAM = 'channel';

export type AlarmState = {
  active: boolean;
  customer: string;
  body: string;
  channelId: number | null;
  // Set when the browser refused to autoplay. The banner turns this into a
  // button, because a blocked alarm is one tap from working and silence with
  // no explanation is the worst possible outcome for this feature.
  blocked: string;
};

const IDLE: AlarmState = { active: false, customer: '', body: '', channelId: null, blocked: '' };

let state: AlarmState = IDLE;
const subscribers = new Set<(next: AlarmState) => void>();

function publish(next: AlarmState) {
  state = next;
  for (const notify of subscribers) notify(state);
}

// ---- The element --------------------------------------------------------

let audio: HTMLAudioElement | null = null;

// Created on demand, never in module scope: this module is imported by tests
// and by SSR-shaped tooling where there is no document, and an <audio> built
// at import time would throw there before anything could catch it.
function getAudio(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  if (audio) return audio;
  audio = new Audio(AUDIO_URL);
  audio.loop = true;
  audio.preload = 'auto';
  // Full scale. The actual loudness is the device's media volume, which is
  // why the banner says so rather than pretending this controls it.
  audio.volume = 1;
  return audio;
}

// Chrome will not play unmuted audio on a page the user has never touched.
//
// Three things satisfy it, and this app has all three available: a launch from
// the home-screen shortcut counts on its own, a notification tap is a gesture,
// and — for an ordinary tab left open — any click at all. That last one is
// what this primes: the first interaction of the session plays the file muted
// for a moment, which is enough for the browser to treat later unmuted play()
// calls on the same element as allowed.
//
// Without it, the kitchen-tablet case (a tab opened on Friday, a message on
// Sunday) is exactly the one that would fail, and it would fail silently.
let unlocked = false;

function unlock() {
  if (unlocked) return;
  const element = getAudio();
  if (!element) return;
  unlocked = true;
  const wasMuted = element.muted;
  element.muted = true;
  element
    .play()
    .then(() => {
      element.pause();
      element.currentTime = 0;
      element.muted = wasMuted;
    })
    .catch(() => {
      // Nothing to do and nothing worth reporting — the real play() below
      // reports for itself, where there is a banner to say it on.
      element.muted = wasMuted;
    });
}

// ---- Vibration ----------------------------------------------------------

// The page's own buzzing, which is a different mechanism from the one the
// service worker asks for and has different limits.
//
// The worker's `vibrate` option is a one-shot request attached to a
// notification, and on Android 8+ the notification channel can overrule it.
// navigator.vibrate() is not a notification at all — it is the page driving
// the motor directly, so nothing overrules it, but it only exists while a page
// is open. The two cover each other: the notification's pattern is what buzzes
// a pocketed phone, and this is what keeps buzzing once the alarm is on
// screen and still unanswered.
//
// Repeated on a timer because a vibration pattern cannot loop on its own.
const VIBRATE_PATTERN = [600, 200, 600, 200, 600];
const VIBRATE_REPEAT_MS = 2400;

let vibrateTimer: ReturnType<typeof setInterval> | null = null;

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function startVibrating(): void {
  if (!canVibrate() || vibrateTimer) return;
  navigator.vibrate(VIBRATE_PATTERN);
  vibrateTimer = setInterval(() => navigator.vibrate(VIBRATE_PATTERN), VIBRATE_REPEAT_MS);
}

function stopVibrating(): void {
  if (vibrateTimer) clearInterval(vibrateTimer);
  vibrateTimer = null;
  // vibrate(0) is the documented way to cancel one already running — without
  // it the last pattern plays out after Stop is pressed, which reads as the
  // button not having worked.
  if (canVibrate()) navigator.vibrate(0);
}

// ---- Start and stop -----------------------------------------------------

type AlarmDetail = { channelId?: number | null; customer?: string; body?: string };

/**
 * Sound the alarm, and keep sounding it.
 *
 * Safe to call while already sounding: a second customer messaging during the
 * first alarm updates who it is for without restarting the audio, so the loop
 * stays continuous rather than stuttering back to the top.
 */
export function start(detail: AlarmDetail = {}): void {
  const next: AlarmState = {
    active: true,
    customer: detail.customer || '',
    body: detail.body || '',
    channelId: typeof detail.channelId === 'number' ? detail.channelId : null,
    blocked: '',
  };

  // Vibration first, and unconditionally. It is the half that survives a
  // phone on silent, and it must not be gated on the audio element existing
  // or on play() being allowed — those are exactly the cases where the buzz
  // is the only signal left.
  startVibrating();

  const element = getAudio();
  if (!element) {
    publish(next);
    return;
  }

  if (element.paused) {
    element.currentTime = 0;
    element.play().catch((err: Error) => {
      // Autoplay refused. The notification still arrived and the banner still
      // appears — it just needs one tap to become audible.
      publish({
        ...next,
        blocked: err?.name === 'NotAllowedError' ? 'Tap to sound the alarm — the browser blocked autoplay.' : err.message,
      });
    });
  }

  publish(next);
}

// Legion may be sounding through its own speakers as well as through this
// page — see server/integrations/localAlarm.js. That half cannot hear a
// button in a browser, so Stop has to go and tell it.
//
// Fire-and-forget, and swallowing everything: the local alarm stops by itself
// after a few minutes regardless, so a failed request here is at worst a noise
// that outlives the button by a little. Blocking the page's own silence on a
// network round trip would be a far worse trade — Stop has to feel immediate.
function silenceLegion(): void {
  try {
    void fetch('/api/push/alarm-stop', { method: 'POST' }).catch(() => undefined);
  } catch {
    // No fetch, or a relative URL with no origin to resolve against (jsdom
    // under test). Nothing to do — the page half has already stopped.
  }
}

/** Stop and reset. The banner's Stop button, and anything that resolves the
 * message — opening the conversation counts. */
export function stop(): void {
  stopVibrating();
  const element = getAudio();
  if (element) {
    element.pause();
    element.currentTime = 0;
  }
  silenceLegion();
  publish(IDLE);
}

/** The retry behind a blocked alarm's banner: this one IS inside a click, so
 * the autoplay policy has nothing left to object to. */
export function retry(): void {
  const element = getAudio();
  if (!element) return;
  unlocked = true;
  element
    .play()
    .then(() => publish({ ...state, active: true, blocked: '' }))
    .catch((err: Error) => publish({ ...state, blocked: err.message }));
}

// ---- Wiring -------------------------------------------------------------

let listening = false;

/**
 * Connect the alarm to the three things that can trigger it. Idempotent —
 * React 18's double-invoked effects call this twice in development, and two
 * sets of listeners would mean two laughs.
 */
export function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;

  // 1 and 2: the service worker, both for a live push and for a tap on an
  // already-open window.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type !== 'whatsapp-alarm') return;
      start({
        channelId: event.data.channelId,
        customer: event.data.customer,
        body: event.data.body,
      });
    });
  }

  // Prime the element on the first interaction of the session, whatever it is.
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });

  // 3: a cold start from a notification tap.
  consumeUrlAlarm();
}

// Reads ?alarm=whatsapp&channel=N and then removes it from the address bar.
//
// Stripping it is not cosmetic. This app persists nothing about the URL, but a
// browser restoring its tabs — or anyone hitting refresh — would replay the
// query and set the alarm off again for a message dealt with hours ago.
function consumeUrlAlarm(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get(ALARM_PARAM) !== 'whatsapp') return;

  const raw = params.get(CHANNEL_PARAM);
  const channelId = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  params.delete(ALARM_PARAM);
  params.delete(CHANNEL_PARAM);
  params.delete('test');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);

  // The tap that opened this window is the gesture the autoplay policy wants,
  // so this one is allowed even on a browser with no history for the site.
  unlocked = true;
  start({ channelId, customer: 'WhatsApp', body: 'A customer is waiting.' });
}

/**
 * The banner's window onto the alarm.
 *
 * Calling listen() from here rather than from App's own effect keeps the
 * wiring with the thing it wires: whatever mounts the banner gets the
 * listeners, and nothing else has to remember to.
 */
export function useWhatsappAlarm(): AlarmState {
  const [current, setCurrent] = useState<AlarmState>(state);

  useEffect(() => {
    listen();
    subscribers.add(setCurrent);
    setCurrent(state);
    return () => {
      subscribers.delete(setCurrent);
    };
  }, []);

  return current;
}

export function subscribe(listener: (next: AlarmState) => void): () => void {
  subscribers.add(listener);
  listener(state);
  return () => {
    subscribers.delete(listener);
  };
}

export function getState(): AlarmState {
  return state;
}

// Exposed for tests: the element is otherwise unreachable from outside, and
// "does it loop" is the single most important property it has.
export function __audio(): HTMLAudioElement | null {
  return audio;
}

// Exposed for tests, which need each case to start from silence.
export function __reset(): void {
  stopVibrating();
  if (audio) {
    audio.pause();
    audio = null;
  }
  unlocked = false;
  listening = false;
  state = IDLE;
  subscribers.clear();
}
