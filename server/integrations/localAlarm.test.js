// The alarm that does not need a browser — its rules, without spawning a real
// PowerShell or making a real noise.
//
// Everything worth testing here is policy rather than sound: whether a second
// message restarts the loop (it must not — that is an audible gap mid-alarm),
// whether an unattended alarm ends on its own (it must — nobody is there to
// press Stop), and whether the thing is off when it cannot work at all. The
// one part that genuinely touches the operating system is swapped out through
// __setPlayer, which is the only reason these can run anywhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLocalAlarmEnabled,
  localAlarmState,
  startLocalAlarm,
  stopLocalAlarm,
  __setPlayer,
  __reset,
  DEFAULT_MAX_MINUTES,
} from './localAlarm.js';

// Stands in for the PowerShell process: records what it was asked for and
// whether anybody killed it.
function fakePlayer() {
  const calls = [];
  const player = (seconds) => {
    const handle = { seconds, stopped: false, sound: 'file' };
    handle.stop = () => {
      handle.stopped = true;
    };
    calls.push(handle);
    return handle;
  };
  player.calls = calls;
  return player;
}

const realPlatform = process.platform;

function pretendPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

let player;

beforeEach(() => {
  // These tests must behave the same on the Windows box this runs on and on
  // anything else, so the platform is stated rather than inherited.
  pretendPlatform('win32');
  delete process.env.LOCAL_ALARM;
  delete process.env.LOCAL_ALARM_MAX_MINUTES;
  player = fakePlayer();
  __setPlayer(player);
});

afterEach(() => {
  __reset();
  pretendPlatform(realPlatform);
  delete process.env.LOCAL_ALARM;
  delete process.env.LOCAL_ALARM_MAX_MINUTES;
  vi.useRealTimers();
});

describe('whether it runs at all', () => {
  it('is on by default on Windows', () => {
    expect(isLocalAlarmEnabled()).toBe(true);
    expect(localAlarmState().reason).toBe('');
  });

  it('is off when LOCAL_ALARM=off, and says so', () => {
    process.env.LOCAL_ALARM = 'off';

    expect(isLocalAlarmEnabled()).toBe(false);
    expect(startLocalAlarm({ customer: 'Eric' })).toMatchObject({ started: false, reason: 'LOCAL_ALARM=off' });
    // The important half: nothing was spawned, so a machine with this off is
    // silent rather than quietly failing at something.
    expect(player.calls).toHaveLength(0);
  });

  it('is off away from Windows, and names the platform', () => {
    pretendPlatform('darwin');

    expect(isLocalAlarmEnabled()).toBe(false);
    // Surfaced in /api/push/status, so "why is legion silent" is answerable
    // from the dashboard rather than by reading the module.
    expect(localAlarmState().reason).toBe('no local audio on darwin');
    expect(startLocalAlarm({}).started).toBe(false);
  });
});

describe('starting and stopping', () => {
  it('sounds, and reports who it is for', () => {
    const result = startLocalAlarm({ customer: 'Eric Savage', body: 'Is the brisket ready?' });

    expect(result).toMatchObject({ started: true, sound: 'file' });
    expect(player.calls).toHaveLength(1);
    expect(localAlarmState()).toMatchObject({ running: true, customer: 'Eric Savage', sound: 'file' });
  });

  it('does not restart for a second customer mid-alarm', () => {
    startLocalAlarm({ customer: 'Eric Savage' });
    const second = startLocalAlarm({ customer: 'Priya R' });

    // One player, still the original one. Killing it and spawning another
    // would be a gap in the middle of an alarm, which reads as the alarm
    // stopping just as a second person is trying to reach you.
    expect(second).toMatchObject({ started: true, already: true });
    expect(player.calls).toHaveLength(1);
    expect(player.calls[0].stopped).toBe(false);
    // ...but it is now for the person who most recently messaged.
    expect(localAlarmState().customer).toBe('Priya R');
  });

  it('stops', () => {
    startLocalAlarm({ customer: 'Eric Savage' });

    expect(stopLocalAlarm('test')).toEqual({ stopped: true });
    expect(player.calls[0].stopped).toBe(true);
    expect(localAlarmState().running).toBe(false);
  });

  it('is a no-op when nothing is playing', () => {
    // The callers — the banner's Stop button, opening the conversation, the
    // shutdown hook — have no way of knowing whether anything is sounding.
    expect(stopLocalAlarm()).toEqual({ stopped: false });
  });

  it('can be started again after being stopped', () => {
    startLocalAlarm({ customer: 'Eric Savage' });
    stopLocalAlarm();
    startLocalAlarm({ customer: 'Eric Savage' });

    expect(player.calls).toHaveLength(2);
    expect(localAlarmState().running).toBe(true);
  });
});

describe('how long it runs', () => {
  it('defaults to the ceiling', () => {
    startLocalAlarm({});
    expect(player.calls[0].seconds).toBe(DEFAULT_MAX_MINUTES * 60);
  });

  it('honours LOCAL_ALARM_MAX_MINUTES', () => {
    process.env.LOCAL_ALARM_MAX_MINUTES = '2';
    startLocalAlarm({});
    expect(player.calls[0].seconds).toBe(120);
  });

  it('lets a caller ask for less', () => {
    // What the test button does: a test nobody can hear the end of is a test
    // that gets pressed once and then avoided.
    startLocalAlarm({ seconds: 20 });
    expect(player.calls[0].seconds).toBe(20);
  });

  it('never lets a caller ask for more than the ceiling', () => {
    process.env.LOCAL_ALARM_MAX_MINUTES = '1';
    startLocalAlarm({ seconds: 9999 });
    // The ceiling is what stops an unattended alarm running all afternoon, so
    // it is a cap rather than a default a caller can talk its way past.
    expect(player.calls[0].seconds).toBe(60);
  });

  it('stops itself when nobody presses Stop', () => {
    vi.useFakeTimers();
    process.env.LOCAL_ALARM_MAX_MINUTES = '1';

    startLocalAlarm({ customer: 'Eric Savage' });
    expect(localAlarmState().running).toBe(true);

    vi.advanceTimersByTime(60 * 1000);

    // The case this exists for: a message arrives at a kitchen with nobody in
    // it. Without this the laugh is still going when somebody gets back.
    expect(localAlarmState().running).toBe(false);
    expect(player.calls[0].stopped).toBe(true);
  });

  it('extends its deadline when a second message lands', () => {
    vi.useFakeTimers();
    process.env.LOCAL_ALARM_MAX_MINUTES = '1';

    startLocalAlarm({ customer: 'Eric Savage' });
    vi.advanceTimersByTime(45 * 1000);
    startLocalAlarm({ customer: 'Priya R' });

    // 45s past the first start: the original deadline would have fired here.
    vi.advanceTimersByTime(30 * 1000);
    expect(localAlarmState().running).toBe(true);

    vi.advanceTimersByTime(31 * 1000);
    expect(localAlarmState().running).toBe(false);
  });
});

describe('when the player itself fails', () => {
  it('reports rather than throwing', () => {
    // This runs from a setInterval in server/index.js. An exception escaping
    // here takes the whole server down, and with it the dashboard, the daily
    // reminders and the alarm it was trying to sound.
    __setPlayer(() => {
      throw new Error('powershell.exe not found');
    });

    const result = startLocalAlarm({ customer: 'Eric Savage' });

    expect(result).toMatchObject({ started: false, reason: 'powershell.exe not found' });
    expect(localAlarmState().running).toBe(false);
  });
});
