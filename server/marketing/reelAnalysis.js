// Measuring a clip so something else can edit it.
//
// The Insta Reel editor asks you to watch every upload end to end and decide
// where the usable footage starts, where the shot changes, and which stretch
// is the camera being carried across the kitchen. All four of those questions
// are answerable by ffmpeg, exactly, in one pass over the file, and none of
// them need a model — which is why this file exists before anything cleverer
// does. What comes out of here is the raw material for roughCut.js, and later
// for anything that wants to look at footage without downloading it.
//
// One pass, not four
// ------------------
// blackdetect, freezedetect and the scene-change select all sit in the same
// -vf chain and silencedetect in -af, so a clip is decoded once. Decoding is
// the expensive part — running the four detectors separately costs four times
// as much for exactly the same answers.
//
// The chain is ordered, and the order matters. blackdetect and freezedetect
// pass every frame through and only log, so they go first and see the whole
// clip; `select` DROPS frames, so anything after it would only ever see the
// scene changes. And the scale down to 240p goes at the very front: none of
// these detectors need pixels, a phone shoots 4K, and decoding at 240p is
// several times quicker for identical timestamps.
//
// Everything is reported in seconds from the start of the source file, on the
// same ruler as a TimelineClip's in/out — see the note at the top of
// src/pages/marketing/reelTimeline.ts. That is what lets a rough cut be
// applied to the timeline without a single conversion.
import { execFile } from 'child_process';
import fs from 'fs';
import { FFMPEG_PATH, probeMedia } from './reelStudio.js';

// How much of the frame has to change before it counts as a cut rather than
// as movement. 0.3 is ffmpeg's own usual figure and it is about right for
// handheld phone footage: a pan across a smoker does not trip it, pointing
// the camera at something else does. Too low and every wobble becomes a shot
// boundary; too high and two different shots in one file read as one.
const SCENE_THRESHOLD = 0.3;

// A stretch has to be this dark for this long before it is black rather than
// a dim frame. 0.15s is under a fifth of a second — shorter than any shot
// worth keeping, so a lens cap or a hand over the phone at the start of a
// recording is caught while a dark bit of a real shot is not.
const BLACK_MIN_SECONDS = 0.15;
const BLACK_PIXEL_THRESHOLD = 0.1;

// Frozen means the picture stopped changing — a phone left recording on a
// counter, or the pause at the end before somebody remembers to stop it. Half
// a second of it, at 60dB below "identical", which tolerates sensor noise.
const FREEZE_MIN_SECONDS = 0.5;
const FREEZE_NOISE_DB = '-60dB';

// Quiet enough for long enough to be nothing happening. -32dB rather than
// silence proper: a kitchen is never actually silent, and the thing being
// looked for is "no sizzle, no voice", not "no signal".
const SILENCE_NOISE_DB = '-32dB';
const SILENCE_MIN_SECONDS = 0.4;

// Detection is a decode, and a decode of a long 4K clip is not instant. Two
// minutes is far past any single clip this screen is meant for; a file that
// takes longer than that is a file something is wrong with.
const ANALYSIS_TIMEOUT_MS = 120000;

const round3 = (value) => Math.round(value * 1000) / 1000;

// Analyses are cached by file identity — path, size and mtime — because the
// clips directory is write-once (an upload gets a fresh timestamped name) and
// re-deriving a clip's shots on every press of the button would mean decoding
// the same unchanged file again. Keyed on mtime rather than path alone so
// that a file replaced under the same name is still re-read.
const cache = new Map();

const cacheKeyOf = (filePath) => {
  const stat = fs.statSync(filePath);
  return `${filePath}|${stat.size}|${stat.mtimeMs}`;
};

// ---------------------------------------------------------------------------
// Parsing what ffmpeg says
// ---------------------------------------------------------------------------
// All four detectors report on stderr as plain lines. They are parsed with
// regexes rather than with -progress or a metadata muxer because that is the
// only interface they have: these filters log, they do not emit.

// blackdetect: "black_start:12.3 black_end:13.1 black_duration:0.8"
function parseBlack(text) {
  const ranges = [];
  const pattern = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g;
  let match = pattern.exec(text);
  while (match) {
    ranges.push({ start: round3(Number(match[1])), end: round3(Number(match[2])) });
    match = pattern.exec(text);
  }
  return ranges;
}

// freezedetect: a "freeze_start", then a "freeze_end" (or nothing at all, if
// the clip ends still frozen — which is the common case, since the freeze is
// usually somebody forgetting to stop the recording). An unclosed freeze runs
// to the end of the clip, and saying so is the whole point of catching it.
function parseFreeze(text, duration) {
  const ranges = [];
  const pattern = /freeze_(start|end|duration):\s*([0-9.-]+)/g;
  let open = null;
  let match = pattern.exec(text);
  while (match) {
    const [, kind, raw] = match;
    if (kind === 'start') open = Number(raw);
    else if (kind === 'end' && open !== null) {
      ranges.push({ start: round3(open), end: round3(Number(raw)) });
      open = null;
    }
    match = pattern.exec(text);
  }
  if (open !== null && duration > open) ranges.push({ start: round3(open), end: round3(duration) });
  return ranges;
}

// silencedetect: "silence_start: 4.2" / "silence_end: 6.7 | silence_duration: 2.5".
// Same open-ended case as freeze, and the same reading of it.
function parseSilence(text, duration) {
  const ranges = [];
  const pattern = /silence_(start|end):\s*([0-9.-]+)/g;
  let open = null;
  let match = pattern.exec(text);
  while (match) {
    const [, kind, raw] = match;
    if (kind === 'start') open = Number(raw);
    else if (open !== null) {
      ranges.push({ start: round3(open), end: round3(Number(raw)) });
      open = null;
    }
    match = pattern.exec(text);
  }
  if (open !== null && duration > open) ranges.push({ start: round3(open), end: round3(duration) });
  return ranges;
}

// The scene-change select prints one metadata block per frame that passed it,
// with the frame's presentation time on the "pts_time" line above the score.
function parseSceneCuts(text) {
  const cuts = [];
  const pattern = /pts_time:([0-9.]+)/g;
  let match = pattern.exec(text);
  while (match) {
    const at = round3(Number(match[1]));
    // The filter can report the same instant twice on an interlaced or
    // duplicated frame; a shot boundary is an instant, not a pair.
    if (!cuts.length || at - cuts[cuts.length - 1] > 0.05) cuts.push(at);
    match = pattern.exec(text);
  }
  return cuts;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function buildAnalysisArgs(filePath, { hasAudio }) {
  const video = [
    // Detection needs timestamps, not detail. See the note at the top.
    'scale=-2:240',
    `blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=${BLACK_PIXEL_THRESHOLD}`,
    `freezedetect=n=${FREEZE_NOISE_DB}:d=${FREEZE_MIN_SECONDS}`,
    // Last, because it drops every frame that is not a cut.
    `select='gt(scene,${SCENE_THRESHOLD})'`,
    'metadata=print',
  ].join(',');

  const args = ['-hide_banner', '-nostats', '-i', filePath, '-vf', video];
  if (hasAudio) args.push('-af', `silencedetect=n=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_SECONDS}`);
  else args.push('-an');
  // No encoding, no file: everything wanted here is on stderr.
  args.push('-f', 'null', '-');
  return args;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG_PATH,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: ANALYSIS_TIMEOUT_MS },
      (err, stdout, stderr) => {
        // ffmpeg exits non-zero for a file it could not read, which is worth
        // failing on — but the detectors' own output is on stderr either way,
        // so a clip that decoded far enough to report is still usable.
        const text = `${stderr || ''}${stdout || ''}`;
        if (err && !text.includes('pts_time') && !text.includes('Duration')) {
          reject(new Error(`ffmpeg could not read this clip: ${(err.message || '').split('\n')[0]}`));
          return;
        }
        resolve(text);
      },
    );
  });
}

// Everything measurable about one clip, in seconds from its own start.
//
// `shots` is the useful shape and the rest is the evidence behind it: the
// scene cuts split the clip, and any part of it that is black or frozen is
// not a shot at all. Silence is reported but never removes footage — a shot
// of a rack coming out of the smoker with no sound is still the best shot in
// the reel, and cutting on quiet alone would drop exactly those.
async function analyseClip(filePath, { probe } = {}) {
  const key = cacheKeyOf(filePath);
  const cached = cache.get(key);
  if (cached) return cached;

  const media = probe || (await probeMedia(filePath));
  const duration = media.duration || 0;
  if (!(duration > 0)) {
    const err = new Error('That clip has no duration ffmpeg can read.');
    err.status = 400;
    throw err;
  }

  const text = await runFfmpeg(buildAnalysisArgs(filePath, { hasAudio: media.hasAudio }));

  const analysis = {
    duration: round3(duration),
    hasAudio: Boolean(media.hasAudio),
    width: media.width,
    height: media.height,
    sceneCuts: parseSceneCuts(text),
    black: parseBlack(text),
    frozen: parseFreeze(text, duration),
    silent: media.hasAudio ? parseSilence(text, duration) : [],
  };
  analysis.shots = shotsOf(analysis);

  cache.set(key, analysis);
  return analysis;
}

// ---------------------------------------------------------------------------
// From detections to shots
// ---------------------------------------------------------------------------

// Merges overlapping or touching ranges, so "unusable" can be subtracted in
// one pass instead of range by range.
function mergeRanges(ranges) {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.001) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// What is left of [0, duration) once the unusable ranges are taken out.
function subtractRanges(duration, ranges) {
  const kept = [];
  let cursor = 0;
  for (const range of mergeRanges(ranges)) {
    if (range.start > cursor) kept.push({ start: round3(cursor), end: round3(Math.min(range.start, duration)) });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) kept.push({ start: round3(cursor), end: round3(duration) });
  return kept.filter((range) => range.end > range.start);
}

// The clip cut into shots: the usable footage, split wherever the picture
// changed enough to be a different shot.
//
// `quiet` rides along per shot rather than removing it, because it is a
// ranking signal and not a verdict — see the note on analyseClip. A shot is
// quiet when most of it is silent, which is a different thing from containing
// a pause.
function shotsOf({ duration, sceneCuts, black, frozen, silent }) {
  const usable = subtractRanges(duration, [...black, ...frozen]);
  const silence = mergeRanges(silent);

  const shots = [];
  for (const region of usable) {
    const bounds = [region.start, ...sceneCuts.filter((cut) => cut > region.start && cut < region.end), region.end];
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const start = bounds[index];
      const end = bounds[index + 1];
      const length = end - start;
      if (length <= 0) continue;
      const quietSeconds = silence.reduce(
        (sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(start, range.start)),
        0,
      );
      shots.push({
        start: round3(start),
        end: round3(end),
        seconds: round3(length),
        quiet: quietSeconds > length * 0.6,
      });
    }
  }
  return shots;
}

function clearAnalysisCache() {
  cache.clear();
}

export {
  analyseClip,
  shotsOf,
  mergeRanges,
  subtractRanges,
  parseBlack,
  parseFreeze,
  parseSilence,
  parseSceneCuts,
  buildAnalysisArgs,
  clearAnalysisCache,
  SCENE_THRESHOLD,
};
