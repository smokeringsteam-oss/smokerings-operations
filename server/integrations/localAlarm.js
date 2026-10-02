// The alarm that does not need a browser.
//
// Everything else in this feature ends at a push notification, and a push
// notification is delivered BY THE BROWSER PROCESS — not by the OS. Chrome
// closed on the desktop, or swiped away and battery-restricted on the phone,
// means the push is never received, `sw.js` is never woken, and no page ever
// gets the postMessage that plays the file. There is no code that fixes that
// from this side: it is the push model working as designed.
//
// So this is the one path that depends on nothing but this process being
// alive — which it has to be anyway, or there is nothing to alarm about.
// legion notices the message and shouts through its OWN speakers.
//
//   legion -> Windows audio         (this file: works with every browser shut)
//   legion -> push service -> phone (pushNotify.js: needs a live browser)
//
// The two run together rather than one falling back to the other. Which of
// them actually reaches somebody depends on where they are standing, and this
// process cannot know that.
//
// ---- Why PowerShell and not Node ---------------------------------------
//
// Node has no audio output. Every option is a native module that has to be
// rebuilt per platform, which on a Windows box with no build tools is a
// dependency that breaks on the next `npm ci`. Windows already ships a sound
// player that can loop a file forever; spawning it costs one process and
// nothing to maintain.
//
// System.Media.SoundPlayer specifically, and NOT System.Windows.Media
// .MediaPlayer, which is the obvious choice and does not work here: WPF's
// MediaPlayer opens asynchronously and raises MediaOpened on a dispatcher
// that a plain PowerShell host never pumps, so Play() returns having played
// nothing and HasAudio stays false. Verified on this machine before this file
// existed. SoundPlayer loads synchronously and PlayLooping() loops in the OS,
// which is exactly the shape wanted.
//
// The cost is that SoundPlayer is WAV-only, hence the conversion below, and
// that it has no volume control — the loudness is Windows' own output volume.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// The same file the page loops, so the alarm sounds identical wherever it
// comes from. public/ rather than dist/: it is served from there in dev and
// copied verbatim on build, so this path is right in both.
const MP3_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/whatsapp-alert.mp3',
);

// Converted once and cached. tmpdir rather than anywhere in the repo, because
// this is a derived artifact that must never be committed and must survive
// being deleted — if it is gone, the next alarm just rebuilds it.
const WAV_PATH = path.join(os.tmpdir(), 'smokerings-whatsapp-alert.wav');

// The hard stop.
//
// The page's alarm loops until somebody presses Stop, and that is right for a
// page: there is a button on screen and a person looking at it. This one has
// neither. An alarm nobody is present for must not still be going when they
// get back two hours later, so it always ends on its own, and the only
// question is how long a head start it gets.
const DEFAULT_MAX_MINUTES = 5;

// ---- Is it available at all ---------------------------------------------

function maxSeconds() {
  const raw = Number(process.env.LOCAL_ALARM_MAX_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MINUTES;
  return Math.round(minutes * 60);
}

/**
 * Whether legion can make a noise of its own right now.
 *
 * Opt-out rather than opt-in (`LOCAL_ALARM=off`), matching PUSH_REMINDERS and
 * WHATSAPP_ALERTS. The reasoning is theirs too: the failure this prevents is a
 * missed message, and a default that has to be discovered and switched on is a
 * default that is off on the one machine that needed it.
 */
function isEnabled() {
  if (process.env.LOCAL_ALARM === 'off') return false;
  // PowerShell and SoundPlayer are both Windows-only. Rather than pretend
  // otherwise on a Mac, say so — `reason` is surfaced in /api/push/status, so
  // "why is legion silent" has an answer without reading this file.
  return process.platform === 'win32';
}

function unavailableReason() {
  if (process.env.LOCAL_ALARM === 'off') return 'LOCAL_ALARM=off';
  if (process.platform !== 'win32') return `no local audio on ${process.platform}`;
  return '';
}

// ---- The sound file -----------------------------------------------------

// ffmpeg-static is already a dependency (the reel pipeline uses it), so the
// conversion costs nothing new. Resolved lazily and defensively: a missing or
// broken ffmpeg must degrade to the beeps below rather than throw inside an
// alarm, because the whole point of this path is that it is the one that
// cannot fail quietly.
function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static');
  } catch {
    return '';
  }
}

/**
 * The WAV, building it if it isn't there yet. Returns '' if it cannot be made.
 *
 * Rebuilt when the mp3 is newer, so replacing the laugh with a different sound
 * is a matter of dropping in a new file — no cache to remember to clear, which
 * is exactly the sort of step that gets skipped and then looks like the new
 * file "not working".
 */
function ensureWav() {
  try {
    const mp3 = fs.statSync(MP3_PATH);
    const wav = fs.existsSync(WAV_PATH) ? fs.statSync(WAV_PATH) : null;
    if (wav && wav.size > 0 && wav.mtimeMs >= mp3.mtimeMs) return WAV_PATH;
  } catch {
    return '';
  }

  const ffmpeg = ffmpegPath();
  if (!ffmpeg || !fs.existsSync(ffmpeg)) return '';

  // 16-bit PCM is the only thing SoundPlayer reliably accepts; handing it a
  // float or compressed WAV fails at Load() with an unhelpful message.
  const done = spawnSync(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-i', MP3_PATH, '-ac', '2', '-ar', '44100', '-acodec', 'pcm_s16le', WAV_PATH],
    { windowsHide: true },
  );
  if (done.status !== 0 || !fs.existsSync(WAV_PATH)) return '';
  return WAV_PATH;
}

// ---- The scripts --------------------------------------------------------

// Doubling is how a single-quoted PowerShell string escapes a quote. The repo
// lives under "D:\Personal GIT\..." and tmpdir is under a username, so neither
// path is guaranteed to be free of characters worth escaping.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function loopScript(wav, seconds) {
  // Load() before PlayLooping() so a file the player cannot read fails here,
  // where the exit code is visible, rather than looking like silence.
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$player = New-Object System.Media.SoundPlayer ${psQuote(wav)}`,
    `$player.Load()`,
    `$player.PlayLooping()`,
    `Start-Sleep -Seconds ${seconds}`,
    `$player.Stop()`,
  ].join('; ');
}

// The last resort, when there is no WAV to play — no ffmpeg, or a sound file
// that has gone missing.
//
// Not a nice noise, and deliberately not skipped in favour of silence: a crude
// alarm is the difference between noticing a customer and not, and the
// situation where this fires is precisely the one where nothing else in the
// chain is working either.
function beepScript(seconds) {
  return [
    `$deadline = (Get-Date).AddSeconds(${seconds})`,
    `while ((Get-Date) -lt $deadline) {`,
    `[console]::Beep(880, 500); Start-Sleep -Milliseconds 120;`,
    `[console]::Beep(660, 500); Start-Sleep -Milliseconds 400`,
    `}`,
  ].join(' ');
}

// PowerShell's own documented way of taking a command that contains quotes,
// semicolons and braces without any of it being re-parsed by the shell that
// launched it. Cheaper than writing a .ps1 to disk and far harder to get
// subtly wrong.
function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// ---- The mechanism, kept swappable for tests ----------------------------
//
// Tests must not spawn a real PowerShell or make a real noise on whatever
// machine is running them. Everything above this line is decided by the policy
// below; this is the only part that touches the operating system, so it is the
// only part that has to be replaced.

function windowsPlayer(seconds) {
  const wav = ensureWav();
  const script = wav ? loopScript(wav, seconds) : beepScript(seconds);
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
    // No window, no stdio to drain, and NOT detached: an orphaned loop that
    // outlives this server is a laugh nobody can turn off without Task
    // Manager, which is worse than the silence it was fixing.
    { windowsHide: true, stdio: 'ignore', detached: false },
  );
  child.on('error', (err) => console.error('[local-alarm] could not start —', err.message));
  return {
    sound: wav ? 'file' : 'beep',
    stop: () => {
      try {
        child.kill();
      } catch {
        // Already gone — it ran its full length, or died with the server.
        // Either way there is nothing left to silence.
      }
    },
  };
}

let player = windowsPlayer;

// ---- State --------------------------------------------------------------

let current = null;

/**
 * Start the noise, and keep it going.
 *
 * Idempotent in the same way the page's alarm is: a second customer arriving
 * mid-alarm updates who it is for and extends the deadline, rather than
 * killing the process and starting a fresh one — which would be an audible gap
 * in the middle of an alarm, and reads as the alarm stopping.
 */
function startLocalAlarm(detail = {}) {
  if (!isEnabled()) return { started: false, reason: unavailableReason() };

  const customer = detail.customer || '';
  const body = detail.body || '';
  // A caller may ask for a shorter run than the configured ceiling — the test
  // button does, because a test nobody can hear the end of is a test that gets
  // pressed once and then avoided. Never longer: the ceiling is what stops an
  // unattended alarm running all afternoon, so it is a cap, not a default.
  const requested = Number(detail.seconds);
  const seconds = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), maxSeconds())
    : maxSeconds();

  if (current) {
    current.customer = customer || current.customer;
    current.body = body || current.body;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => stopLocalAlarm('ran its full length'), seconds * 1000);
    current.timer.unref?.();
    return { started: true, already: true, sound: current.sound };
  }

  let handle;
  try {
    handle = player(seconds);
  } catch (err) {
    console.error('[local-alarm] failed —', err.message);
    return { started: false, reason: err.message };
  }

  current = {
    customer,
    body,
    since: new Date().toISOString(),
    sound: handle.sound,
    stop: handle.stop,
    // Belt and braces with the Start-Sleep inside the script: if PowerShell is
    // somehow still going, this ends it from out here. unref so a pending
    // alarm never holds the process open on Ctrl-C.
    timer: setTimeout(() => stopLocalAlarm('ran its full length'), seconds * 1000),
  };
  current.timer.unref?.();

  console.log(`[local-alarm] sounding on legion${customer ? ` — ${customer}` : ''} (${handle.sound})`);
  return { started: true, sound: handle.sound };
}

/**
 * Silence it. Safe to call when nothing is playing, which matters because the
 * things that call it — the banner's Stop button, opening the conversation,
 * the server shutting down — have no way of knowing whether it is.
 */
function stopLocalAlarm(reason = '') {
  if (!current) return { stopped: false };
  clearTimeout(current.timer);
  try {
    current.stop();
  } catch {
    // Nothing worth reporting: the goal was silence and the process is gone.
  }
  current = null;
  console.log(`[local-alarm] stopped${reason ? ` — ${reason}` : ''}`);
  return { stopped: true };
}

/** What /api/push/status reports, so "why is legion silent" is answerable from
 * the dashboard rather than from this file. */
function localAlarmState() {
  return {
    enabled: isEnabled(),
    reason: unavailableReason(),
    running: Boolean(current),
    since: current?.since || '',
    customer: current?.customer || '',
    sound: current?.sound || '',
    maxMinutes: maxSeconds() / 60,
  };
}

// A restart must not leave the laugh running.
//
// This server runs under `node --watch` and restarts on every backend edit, so
// without this a single save during an alarm would strand a PowerShell process
// looping forever with no way left to reach it.
for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopLocalAlarm('server shutting down'));
}

// Exposed for tests, which must never spawn a real shell or make a real noise.
function __setPlayer(next) {
  player = next || windowsPlayer;
}

function __reset() {
  if (current) {
    clearTimeout(current.timer);
    current = null;
  }
  player = windowsPlayer;
}

export {
  isEnabled as isLocalAlarmEnabled,
  localAlarmState,
  startLocalAlarm,
  stopLocalAlarm,
  __setPlayer,
  __reset,
  DEFAULT_MAX_MINUTES,
};
