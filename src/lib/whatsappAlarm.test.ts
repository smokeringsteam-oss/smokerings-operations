// The alarm's rules, exercised without a real push service or a real speaker.
//
// Three of these matter more than the rest, because each is a way the feature
// could fail in the one situation it was built for — the phone in a pocket at
// a market — and fail SILENTLY, which is the only unacceptable outcome for
// something whose entire job is to be impossible to ignore:
//
//   - a second message must not restart the loop (it would stutter);
//   - a refresh must not re-sound an alarm that was dealt with hours ago;
//   - a browser refusing autoplay must say so, not just go quiet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getState, listen, retry, start, stop, subscribe, __audio, __reset } from './whatsappAlarm';

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
// jsdom's HTMLMediaElement has no real playback, so `paused` never changes on
// its own — and `paused` is exactly what start() consults to decide whether
// the loop is already running. Driven by hand here.
let paused = true;
let vibrate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  paused = true;
  play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    paused = true;
  });

  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(play as never);
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(pause as never);
  Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => paused,
  });

  vibrate = vi.fn(() => true);
  Object.defineProperty(window.navigator, 'vibrate', {
    configurable: true,
    writable: true,
    value: vibrate,
  });

  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  __reset();
  vi.restoreAllMocks();
});

describe('start and stop', () => {
  it('sounds the alarm and reports who it is for', async () => {
    start({ channelId: 10, customer: 'Eric Savage', body: 'Is the brisket ready?' });

    expect(play).toHaveBeenCalledTimes(1);
    expect(getState()).toMatchObject({
      active: true,
      customer: 'Eric Savage',
      body: 'Is the brisket ready?',
      channelId: 10,
    });
  });

  it('loops at full volume rather than playing once', () => {
    start({ customer: 'Eric Savage' });

    const audio = __audio();
    // "Loop until dismissed" is the whole behaviour that was asked for, and
    // it is one property assignment away from silently becoming "plays a
    // two-second laugh once, from a pocket, unheard".
    expect(audio?.loop).toBe(true);
    expect(audio?.volume).toBe(1);
    expect(audio?.getAttribute('src')).toBe('/whatsapp-alert.mp3');
  });

  it('does not restart the audio when a second message arrives mid-alarm', () => {
    start({ channelId: 10, customer: 'Eric Savage' });
    start({ channelId: 11, customer: 'Priya R' });

    // One play, because the loop was already running — a second call would
    // jump the laugh back to the start each time someone typed.
    expect(play).toHaveBeenCalledTimes(1);
    // ...but the banner now names the customer who messaged most recently.
    expect(getState().customer).toBe('Priya R');
    expect(getState().channelId).toBe(11);
  });

  it('stops and resets', () => {
    start({ customer: 'Eric Savage' });
    stop();

    expect(pause).toHaveBeenCalled();
    expect(getState()).toMatchObject({ active: false, customer: '', channelId: null });
  });

  it('can be started again after being stopped', () => {
    start({ customer: 'Eric Savage' });
    stop();
    start({ customer: 'Priya R' });

    expect(play).toHaveBeenCalledTimes(2);
    expect(getState().active).toBe(true);
  });
});

describe('when the browser refuses to autoplay', () => {
  it('still shows the alarm, and says it needs a tap', async () => {
    const refusal = Object.assign(new Error('play() failed'), { name: 'NotAllowedError' });
    play.mockImplementation(() => Promise.reject(refusal));

    start({ customer: 'Eric Savage' });
    // The rejection is handled asynchronously; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    const state = getState();
    // Silence with no explanation is the failure this guards against: the
    // banner has to appear either way.
    expect(state.active).toBe(true);
    expect(state.blocked).toContain('Tap to sound the alarm');
  });

  it('clears the warning once the retry succeeds', async () => {
    const refusal = Object.assign(new Error('play() failed'), { name: 'NotAllowedError' });
    play.mockImplementationOnce(() => Promise.reject(refusal));

    start({ customer: 'Eric Savage' });
    await Promise.resolve();
    await Promise.resolve();
    expect(getState().blocked).not.toBe('');

    retry();
    await Promise.resolve();
    await Promise.resolve();

    expect(getState().blocked).toBe('');
    expect(getState().active).toBe(true);
  });
});

describe('a cold start from a notification tap', () => {
  it('sounds the alarm from ?alarm=whatsapp', () => {
    window.history.replaceState({}, '', '/?alarm=whatsapp&channel=42');

    listen();

    expect(play).toHaveBeenCalledTimes(1);
    expect(getState()).toMatchObject({ active: true, channelId: 42 });
  });

  it('strips the query, so a refresh does not sound it again', () => {
    window.history.replaceState({}, '', '/?alarm=whatsapp&channel=42&test=1');

    listen();

    expect(window.location.search).toBe('');
  });

  it('leaves unrelated query parameters alone', () => {
    window.history.replaceState({}, '', '/?alarm=whatsapp&channel=42&debug=1');

    listen();

    expect(window.location.search).toBe('?debug=1');
  });

  it('ignores a URL with no alarm on it', () => {
    window.history.replaceState({}, '', '/?debug=1');

    listen();

    expect(play).not.toHaveBeenCalled();
    expect(getState().active).toBe(false);
    expect(window.location.search).toBe('?debug=1');
  });

  it('survives a non-numeric channel rather than alarming with a bad id', () => {
    window.history.replaceState({}, '', '/?alarm=whatsapp&channel=nonsense');

    listen();

    expect(getState().active).toBe(true);
    expect(getState().channelId).toBeNull();
  });
});

describe('subscribers', () => {
  it('are told the current state immediately and on every change', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribe((next) => seen.push(next.active));

    start({ customer: 'Eric Savage' });
    stop();
    unsubscribe();
    start({ customer: 'Priya R' });

    // Initial false, then true, then false — and nothing after unsubscribing.
    expect(seen).toEqual([false, true, false]);
  });
});

// The half that survives a phone on silent — and, since the shortcut is
// usually closed, the half most likely to be the only signal there is.
describe('vibration', () => {
  it('buzzes as soon as the alarm starts', () => {
    start({ customer: 'Eric Savage' });
    expect(vibrate).toHaveBeenCalledWith([600, 200, 600, 200, 600]);
  });

  it('keeps buzzing, because a pattern does not loop on its own', () => {
    vi.useFakeTimers();
    try {
      start({ customer: 'Eric Savage' });
      const initial = vibrate.mock.calls.length;
      vi.advanceTimersByTime(7300);
      expect(vibrate.mock.calls.length).toBeGreaterThan(initial + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the buzz on Stop rather than letting the last pattern run out', () => {
    start({ customer: 'Eric Savage' });
    vibrate.mockClear();

    stop();

    // vibrate(0) is the documented cancel. Without it, Stop looks broken for
    // another second and a half.
    expect(vibrate).toHaveBeenCalledWith(0);
  });

  it('buzzes even when the browser refuses to play the audio', async () => {
    const refusal = Object.assign(new Error('play() failed'), { name: 'NotAllowedError' });
    play.mockImplementation(() => Promise.reject(refusal));

    start({ customer: 'Eric Savage' });
    await Promise.resolve();

    expect(vibrate).toHaveBeenCalled();
  });
});
