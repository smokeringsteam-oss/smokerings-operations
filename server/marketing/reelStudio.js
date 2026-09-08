// The Insta Reel Generator's render engine: a pile of phone clips in, one
// 1080x1920 H.264 file out, ready to hand to the Instagram Graph API.
//
// The whole reason this exists on the server rather than in the browser is
// that the clips it is fed are never uniform. A reel is shot across a smoking
// session on whatever was in someone's hand — one clip is 1920x1080 from a
// DSLR at 24fps with no audio track at all, the next is 1080x2400 from a
// phone at 30fps, the third was already cropped by someone's gallery app.
// Concatenating those as-is does not produce a short film; it produces a file
// whose second clip is stretched, whose third is silent for its whole length
// because the audio stream count changed mid-stream, and which Instagram
// rejects outright. So every clip is normalized to the same grid before
// anything is joined:
//
//   * scaled to fit inside 1080x1920 preserving aspect, then padded with
//     black to exactly 1080x1920. Never cropped on its own initiative, because
//     cropping decides for the user which half of their shot to throw away —
//     but a clip carrying a zoom above 1 was cropped deliberately, on the
//     editor screen, against a preview doing the same arithmetic, and that is
//     how a landscape shot gets to fill a phone screen instead of sitting in
//     a letterbox;
//   * resampled to a constant 30fps with square pixels (setsar=1), because a
//     non-square SAR surviving into concat skews everything after it;
//   * given a real audio track at 48kHz stereo whether or not the source had
//     one — a clip with no audio gets silence from anullsrc, padded to
//     exactly its own video length. concat with v=1:a=1 requires every
//     segment to carry both streams, and a clip that is merely *missing*
//     audio desynchronises every clip after it rather than failing loudly.
//
// Two escaping decisions are load-bearing on Windows and should not be
// "simplified" away:
//
//   * Overlay text is written to .txt files and referenced with drawtext's
//     textfile= option, never inlined as text=. drawtext's own parser treats
//     ':' and '\' as syntax, filtergraph parsing eats another layer, and a
//     caption reading "Ready at 6:30 — don't miss it" would otherwise have to
//     survive two rounds of escaping to reach the screen intact. A file has
//     no such parser.
//
//   * The font is copied into the per-render work directory as font.ttf and
//     the whole ffmpeg process runs with that directory as its cwd, so every
//     path inside the filtergraph is a bare relative filename. The
//     alternative is spelling C:\Windows\Fonts\arialbd.ttf inside a
//     filtergraph, where the drive-letter colon has to be backslash-escaped
//     and the backslashes then have to be escaped again. Copying 700KB per
//     render is the cheaper of the two.
//
// The filtergraph likewise goes to disk and is passed as
// -filter_complex_script rather than an argv string: a ten-clip reel with
// captions builds a graph several kilobytes long, and Windows argv limits are
// a bad thing to discover on the render that mattered.
//
// buildRenderPlan, buildSegmentCommand and buildJoinCommand below are pure and
// are what reelStudio.test.js exercises. Everything that actually spawns a
// process is kept underneath them, because a test can honestly assert the
// shape of a filtergraph and cannot honestly assert that a video looks right.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE_PATH = process.env.FFPROBE_PATH || ffprobeStatic.path;

// The vertical canvas, which is still what most of these are. A target that
// wants a different shape says so in REEL_TARGETS below; these two stay as the
// default and as what the browser preview assumes before a target is picked.
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_FPS = 30;
export const AUDIO_RATE = 48000;

// Where a reel is going decides two things about the file, not one: how long
// it may be, and what shape it is. Those had been a single 'story' | 'reel'
// flag that only moved the length limit, because every destination then was
// vertical. A YouTube video is not, so the shape moved in here beside the
// limit rather than staying a constant the encoder reached for directly.
//
// maxSeconds of 0 means "no limit worth warning about" — YouTube's real cap is
// twelve hours, and a reel that ran up against it has a different problem.
//
// caption is whether the destination has a caption/description field at all.
// A Story does not, so asking for one before an export that is going to a
// Story is asking for something that has nowhere to go.
export const REEL_TARGETS = [
  {
    id: 'ig-story',
    label: 'Instagram Story',
    short: 'Story',
    width: 1080,
    height: 1920,
    maxSeconds: 60,
    caption: false,
    captionBottom: 0.2,
    hint: 'Vertical. Gone in 24 hours, and it carries no caption.',
  },
  {
    id: 'ig-reel',
    label: 'Instagram Reel',
    short: 'Reel',
    width: 1080,
    height: 1920,
    maxSeconds: 90,
    caption: true,
    captionBottom: 0.2,
    hint: 'Vertical. Stays on the profile, with a caption.',
  },
  {
    id: 'yt-short',
    label: 'YouTube Short',
    short: 'Short',
    width: 1080,
    height: 1920,
    maxSeconds: 180,
    caption: true,
    captionBottom: 0.2,
    hint: 'Vertical and under three minutes, which is all it takes to be a Short.',
  },
  {
    id: 'yt-video',
    label: 'YouTube Video',
    short: 'Video',
    width: 1920,
    height: 1080,
    maxSeconds: 0,
    caption: true,
    captionBottom: 0.08,
    hint: 'Landscape 16:9. No length limit — the ordinary YouTube upload.',
  },
];

export const DEFAULT_TARGET = 'ig-story';

// The two ids the target flag used to have. A draft saved in a tab that was
// open before the four targets existed still says 'story', and it means what
// it always meant.
const LEGACY_TARGET_IDS = { story: 'ig-story', reel: 'ig-reel' };

// Anything unrecognised — an older client, a hand-made request — lands on the
// Story rather than throwing: it is the tightest of the four, so a target that
// got lost in transit produces a file every destination can take.
export function resolveTarget(target) {
  const id = LEGACY_TARGET_IDS[target] || target;
  return REEL_TARGETS.find((candidate) => candidate.id === id)
    || REEL_TARGETS.find((candidate) => candidate.id === DEFAULT_TARGET);
}

// Kept because instagramGraph.js and the publish route still speak in these
// two, and because a limit named once is a limit two files cannot disagree on.
// ---- Colour grade ---------------------------------------------------------
// A named look applied to every clip in a reel, so ten phone clips shot on
// four cameras across a day and a night come out as one piece of film rather
// than as ten. That is the whole job: consistency first, mood second.
//
// One look per reel, not one per clip. A grade that changes shot to shot is
// the exact thing it exists to fix, and a per-clip override would be a way to
// reintroduce the problem a control at a time.
//
// The chain runs AFTER the zoom crop and BEFORE the captions, which is the
// only order that works: grading before the crop would grade pixels that get
// thrown away (and put the vignette's dark corners in the middle of the
// frame), and grading after the captions would drag the caption's white down
// with everything else and dim the one thing that has to stay legible.
//
// Filters are limited to what every ffmpeg build carries — curves, eq,
// colorbalance, vignette, unsharp. No LUT files: a .cube is another asset to
// ship, find at render time and get wrong on someone else's machine.
export const REEL_LOOKS = [
  {
    id: 'none',
    label: 'None (as shot)',
    hint: 'No grade. What the camera recorded.',
    filters: null,
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Gentle lift for food. Barely there, and safe on everything.',
    filters: 'eq=contrast=1.06:saturation=1.10,colorbalance=rm=0.03:rh=0.04:bh=-0.03',
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    hint: 'Warm highlights, cool shadows, soft vignette. Best for fire and smoke.',
    filters:
      'curves=preset=medium_contrast,colorbalance=rh=0.06:bs=0.06:bh=-0.05,eq=saturation=0.96:contrast=1.05,vignette=PI/5',
  },
  {
    id: 'punch',
    label: 'Punchy',
    hint: 'Hard contrast and a sharpen. Helps low-resolution phone clips.',
    filters: 'eq=contrast=1.14:saturation=1.18,unsharp=5:5:0.5',
  },
];

export const DEFAULT_LOOK = 'none';

// Unrecognised ids land on 'none' rather than throwing, for the same reason
// resolveTarget falls back: a look that got lost in transit should cost the
// render its grade, not the render itself.
export function resolveLook(look) {
  return REEL_LOOKS.find((candidate) => candidate.id === look)
    || REEL_LOOKS.find((candidate) => candidate.id === DEFAULT_LOOK);
}

export const STORY_MAX_SECONDS = resolveTarget('ig-story').maxSeconds;
export const REEL_MAX_SECONDS = resolveTarget('ig-reel').maxSeconds;
export const YOUTUBE_SHORT_MAX_SECONDS = resolveTarget('yt-short').maxSeconds;

// How long an upload survives before pruneOldMedia sweeps it. Named here
// rather than left as a default argument because the editor tells the operator
// the number, and a retention window the screen and the sweep disagree about
// is worse than one nobody mentions.
export const MEDIA_MAX_AGE_DAYS = 7;

// A phone shoots roughly 100MB/minute at 4K. 512MB is a generous single clip
// while still being a number that stops a mis-drop of a feature film.
export const MAX_CLIP_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

const mediaRoot = path.join(__dirname, '..', 'uploads', 'reels');
export const CLIPS_DIR = path.join(mediaRoot, 'clips');
export const RENDERS_DIR = path.join(mediaRoot, 'renders');

export function ensureMediaDirs() {
  for (const dir of [CLIPS_DIR, RENDERS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return { clipsDir: CLIPS_DIR, rendersDir: RENDERS_DIR };
}

// Bold beats regular for a caption burnt over moving video. Overridable
// because the font list on a machine that is not this one may not include any
// of these.
const FONT_CANDIDATES = [
  process.env.REEL_FONT_FILE,
  'C:\\Windows\\Fonts\\arialbd.ttf',
  'C:\\Windows\\Fonts\\segoeuib.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].filter(Boolean);

export function findFontFile() {
  return FONT_CANDIDATES.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const round3 = (value) => Math.round(value * 1000) / 1000;

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

// Caption text is wrapped here rather than by drawtext, which has no word wrap
// at all: a long caption would otherwise render as one line running off both
// edges of the frame. Lines are capped so a pasted paragraph cannot cover the
// video it is captioning.
export function wrapCaption(text, { maxCharsPerLine = 24, maxLines = 4 } = {}) {
  const words = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxCharsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    // A single word longer than the line budget still has to break somewhere.
    while (current.length > maxCharsPerLine) {
      lines.push(current.slice(0, maxCharsPerLine));
      current = current.slice(maxCharsPerLine);
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+\S*$/, '')}\u2026`;
  return kept;
}

// Turns what the editor screen sent — an ordered list of clip ids with trim
// points — into a fully resolved plan against the clips actually on disk.
// `sources` is id -> { path, duration, hasAudio }, i.e. the probe results.
//
// Trim points are clamped rather than rejected: the browser's currentTime is a
// float that can land a few milliseconds past a clip's real duration, and
// failing a whole render over that would be theatre. A clip trimmed to nothing
// at all is a different matter and is an error, because it means the timeline
// on screen does not describe the video that would come out.
export function buildRenderPlan({ clips = [], sources = {}, music = null, target = DEFAULT_TARGET, look = DEFAULT_LOOK } = {}) {
  const spec = resolveTarget(target);
  const lookSpec = resolveLook(look);
  if (!Array.isArray(clips) || clips.length === 0) {
    const err = new Error('Add at least one clip before rendering.');
    err.status = 400;
    throw err;
  }

  const warnings = [];
  const planned = clips.map((clip, index) => {
    const source = sources[clip.id];
    if (!source) {
      const err = new Error(`Clip ${index + 1} is no longer on the server — re-upload it.`);
      err.status = 400;
      throw err;
    }

    const sourceDuration = Number(source.duration) || 0;
    const rawIn = Number.isFinite(Number(clip.in)) ? Math.max(0, Number(clip.in)) : 0;
    const rawOut =
      Number.isFinite(Number(clip.out)) && Number(clip.out) > 0 ? Number(clip.out) : sourceDuration;

    const inPoint = round3(Math.min(rawIn, Math.max(0, sourceDuration - 0.1)));
    const outPoint = round3(Math.min(Math.max(rawOut, inPoint), sourceDuration));
    const duration = round3(outPoint - inPoint);

    if (duration < 0.1) {
      const err = new Error(`Clip ${index + 1} is trimmed down to nothing — widen its trim or remove it.`);
      err.status = 400;
      throw err;
    }

    return {
      id: clip.id,
      path: source.path,
      name: source.name || clip.id,
      in: inPoint,
      out: outPoint,
      duration,
      hasAudio: Boolean(source.hasAudio),
      zoom: clampZoom(clip.zoom),
      captions: planCaptions(clip, inPoint, duration),
    };
  });

  const totalDuration = round3(planned.reduce((sum, clip) => sum + clip.duration, 0));

  if (spec.maxSeconds && totalDuration > spec.maxSeconds) {
    warnings.push(
      `This is ${totalDuration.toFixed(1)}s long. ${spec.label} caps out at ${spec.maxSeconds}s — it will export fine but the publish step will refuse it.`,
    );
  }
  if (planned.every((clip) => !clip.hasAudio) && !music) {
    warnings.push('None of these clips have an audio track and no music was added — the export will be silent.');
  }

  let plannedMusic = null;
  if (music && music.path) {
    const mode = music.mode === 'mix' ? 'mix' : 'replace';
    plannedMusic = {
      path: music.path,
      name: music.name || 'music',
      mode,
      volume: clampVolume(music.volume, 1),
      originalVolume: mode === 'mix' ? clampVolume(music.originalVolume, 0.35) : 0,
      // A hard cut on the last frame sounds like a fault. 1.5s out, or a
      // quarter of the reel if the reel is shorter than six seconds.
      fadeOut: round3(Math.min(1.5, totalDuration / 4)),
    };
  }

  return {
    clips: planned,
    music: plannedMusic,
    totalDuration,
    target: spec.id,
    // Carried on the plan rather than read from module constants by the
    // encoder, because the canvas is now the target's business and the
    // filtergraph should not have to know which target it is building for.
    width: spec.width,
    height: spec.height,
    maxSeconds: spec.maxSeconds,
    captionBottom: spec.captionBottom,
    // Carried the same way as the canvas, and for the same reason: the
    // filtergraph should be told what to apply, not have to look it up.
    look: lookSpec.id,
    lookFilters: lookSpec.filters,
    warnings,
  };
}

// A clip's captions, resolved against its trim and moved onto the clock the
// filtergraph actually counts in.
//
// The editor sends caption times on the same ruler as `in` and `out` —
// seconds into the source file — because that is the only ruler on which a
// caption stays glued to the frames it was written for through a trim, a
// split and a reorder. By the time drawtext sees a clip, though, trim and
// setpts have restarted its clock at zero, so every caption window is shifted
// by the in-point and clipped to what survives the trim here, in one place.
//
// A caption trimmed entirely out of shot is dropped rather than clamped to a
// sliver: the frames it was written for are not in the reel, so neither is it.
// An older client that sends a bare `text` on the clip still works and means
// what it always meant — one caption, the whole clip.
function planCaptions(clip, inPoint, duration) {
  const raw = Array.isArray(clip.captions)
    ? clip.captions
    : [{ text: clip.text, position: clip.textPosition, start: inPoint, end: inPoint + duration }];

  const planned = [];
  for (const caption of raw) {
    if (!caption) continue;
    const lines = wrapCaption(caption.text);
    if (!lines.length) continue;

    const rawStart = Number.isFinite(Number(caption.start)) ? Number(caption.start) : inPoint;
    const rawEnd = Number.isFinite(Number(caption.end)) ? Number(caption.end) : inPoint + duration;
    const start = round3(Math.min(Math.max(rawStart - inPoint, 0), duration));
    const end = round3(Math.min(Math.max(rawEnd - inPoint, 0), duration));
    // Two frames at 30fps. Below that a caption is a flicker, and one that has
    // been trimmed down to nothing is not a caption at all.
    if (end - start < 0.07) continue;

    const position = ['top', 'center', 'bottom'].includes(caption.position ?? caption.textPosition)
      ? (caption.position ?? caption.textPosition)
      : 'bottom';

    planned.push({ lines, position, start, end, wholeClip: start <= 0.001 && end >= duration - 0.001 });
  }
  return planned;
}

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.round(Math.min(4, Math.max(1, numeric)) * 100) / 100;
}

function clampVolume(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(2, Math.max(0, numeric)) * 100) / 100;
}

// Where a caption sits in the frame, as a drawtext y-expression. The bottom
// margin is the one that varies by target: on a Story or a Short it has to
// clear the app's own reply bar and buttons, which cover roughly the last
// fifth of the screen, while a landscape YouTube video has nothing down there
// to clear and a fifth of the frame would just be wasted.
export const DEFAULT_CAPTION_BOTTOM = 0.2;

function captionY(position, bottom = DEFAULT_CAPTION_BOTTOM) {
  if (position === 'top') return 'h*0.12';
  if (position === 'center') return '(h-text_h)/2';
  return `h-text_h-h*${bottom}`;
}

// A reel is encoded one clip at a time and the pieces are joined afterwards,
// rather than as the one big filtergraph this used to be. The old shape read
// better and was wrong in a way that only showed up on real footage:
//
//   ffmpeg demuxes every -i input as it goes, but concat only consumes one
//   segment at a time, so the frames of every clip that is not the one being
//   written pile up in the filtergraph. They pile up *after* the scale, at the
//   full canvas size — 1080x1920 yuv420p is 3.1MB a frame — so the peak is
//   roughly (everything except the longest clip) x 30fps x 3.1MB. Sixteen
//   seconds of phone video took 1.4GB. A full-length Story would want five,
//   and on a machine with other things open it does not get them: x264 fails
//   its first allocation, ffmpeg reports "Cannot allocate memory", and the
//   export fails with nothing on screen to say why.
//
// So each clip becomes its own encode — one input, one linear chain, frames
// streaming straight through to a file — and the joining is done by the concat
// *demuxer*, which reads one segment at a time and copies the video through
// untouched. Peak memory stops depending on how long the reel is.
//
// The per-clip chain itself is unchanged: same trim, same fps, same scale/pad,
// same zoom crop, same drawtext. What was one graph is now n graphs of one
// clip each.

// x264 keeps a working frame in flight per thread and defaults to one and a
// half per core, so on a sixteen-core machine the encoder alone reserves the
// best part of a gigabyte for a 1080x1920 frame size. Eight threads costs
// about 40% on the encode and saves about 350MB of that, which is the right
// trade on a laptop that is also running the browser this was started from.
const ENCODE_THREADS = Math.max(2, Math.min(8, os.cpus().length || 4));

// Everything every segment and the final file agree on. Segments have to match
// exactly or the concat demuxer cannot copy the video through.
const encodeArgs = () => [
  '-threads',
  String(ENCODE_THREADS),
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  '-profile:v',
  'high',
  '-level',
  '4.1',
  '-pix_fmt',
  'yuv420p',
  '-r',
  String(REEL_FPS),
  // Instagram re-encodes anyway but wants a keyframe cadence it can seek;
  // 2s at 30fps is the interval Meta's own publishing guide asks for.
  '-g',
  String(REEL_FPS * 2),
];

const audioArgs = () => ['-c:a', 'aac', '-b:a', '128k', '-ar', String(AUDIO_RATE), '-ac', '2'];

export const segmentName = (index) => `seg-${index}.mp4`;
export const segmentFilterName = (index) => `filters-${index}.txt`;
export const SEGMENT_LIST_NAME = 'segments.txt';
export const JOIN_FILTER_NAME = 'join-filters.txt';

// One clip, normalised onto the target's canvas and written to its own file.
// Returns the argv (minus the binary), the graph destined for its filter
// script, and the caption text files that have to exist before ffmpeg starts.
export function buildSegmentCommand(plan, index, { fontFile = 'font.ttf' } = {}) {
  const clip = plan.clips[index];
  const width = plan.width || REEL_WIDTH;
  const height = plan.height || REEL_HEIGHT;
  const textFiles = [];
  const inputs = ['-i', clip.path];

  // Zoom is "fit it into a frame this many times too big, then cut the frame
  // back out of the middle", which is the same two steps as the no-zoom case
  // with a bigger box and a crop on the end — so a clip at 1x comes out of
  // here byte-identical to what it was before zoom existed, and the browser
  // preview can mirror it with one CSS transform. The box is rounded to even
  // pixels because yuv420p has half-resolution chroma and libx264 refuses
  // odd dimensions.
  const zoom = clip.zoom > 1 ? clip.zoom : 1;
  const boxW = Math.round((width * zoom) / 2) * 2;
  const boxH = Math.round((height * zoom) / 2) * 2;

  const video = [
    `trim=start=${clip.in}:end=${clip.out}`,
    'setpts=PTS-STARTPTS',
    `fps=${REEL_FPS}`,
    `scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease`,
    `pad=${boxW}:${boxH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    zoom > 1 ? `crop=${width}:${height}` : null,
    'setsar=1',
    // The grade goes here — after the crop so it never grades pixels that get
    // cropped away, and before the captions below so it never dims them.
    plan.lookFilters || null,
    'format=yuv420p',
  ].filter(Boolean);

  // Captions go on after the crop, so zooming a clip in does not push its
  // own words off the side of the frame. The size follows the frame's short
  // edge rather than its width: scaled by width a caption on a landscape
  // video would come out nearly twice the size it is on a Story, and by
  // height it would come out half.
  const scale = Math.min(width, height) / 1080;
  const fontSize = Math.round(58 * scale);
  const lineSpacing = Math.round(14 * scale);
  const borderWidth = Math.round(26 * scale);

  clip.captions.forEach((caption, captionIndex) => {
    const textFileName = `caption-${index}-${captionIndex}.txt`;
    textFiles.push({ name: textFileName, content: caption.lines.join('\n') });
    video.push(
      [
        'drawtext=',
        `fontfile=${fontFile}`,
        `:textfile=${textFileName}`,
        // Without this drawtext runs the file through its own %{...}
        // template expansion, and a caption reading "100% brisket" is a
        // syntax error ("Stray %") that makes the filter draw *nothing* —
        // with only a warning on stderr and a zero exit code, so the reel
        // renders successfully and silently without its caption. Captions
        // are text, never templates; expansion is turned off.
        ':expansion=none',
        ':fontcolor=white',
        `:fontsize=${fontSize}`,
        `:line_spacing=${lineSpacing}`,
        `:box=1:boxcolor=black@0.55:boxborderw=${borderWidth}`,
        ':x=(w-text_w)/2',
        `:y=${captionY(caption.position, plan.captionBottom)}`,
        // Quoted because the expression's commas would otherwise end the
        // filter: a comma is what separates one filter from the next in a
        // chain. A caption that covers its whole clip gets no enable at all
        // — it is on for the clip's whole life either way, and the plainer
        // graph is the easier one to read in a render log.
        caption.wholeClip ? '' : `:enable='between(t,${caption.start},${caption.end})'`,
      ].join(''),
    );
  });

  const chains = [`[0:v]${video.join(',')}[vout]`];

  // Every segment carries an audio stream even when its clip is silent and
  // even when music is about to replace the lot. The concat demuxer joins
  // streams by position, so a segment missing one would put the next clip's
  // audio against the wrong picture — and this is the same job the anullsrc
  // inputs did in the single-graph version, decided per file rather than per
  // input index.
  let audioSource = '[0:a]';
  if (!clip.hasAudio) {
    audioSource = '[1:a]';
    inputs.push(
      '-f',
      'lavfi',
      '-t',
      String(clip.duration),
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`,
    );
  }

  // apad then atrim forces the audio leg to exactly the video leg's length.
  // Without it a clip whose audio stream runs a few frames short of its
  // video drifts, and the join carries that drift into every clip after it.
  const audio = [
    clip.hasAudio ? `atrim=start=${clip.in}:end=${clip.out}` : null,
    'asetpts=PTS-STARTPTS',
    `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
    'apad',
    `atrim=0:${clip.duration}`,
    'asetpts=PTS-STARTPTS',
  ].filter(Boolean);
  chains.push(`${audioSource}${audio.join(',')}[aout]`);

  const outputName = segmentName(index);
  const args = [
    '-hide_banner',
    '-y',
    ...inputs,
    // The graph goes to a file, not to argv: a heavily captioned clip builds a
    // graph long enough to matter against Windows argv limits.
    '-filter_complex_script',
    segmentFilterName(index),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...encodeArgs(),
    ...audioArgs(),
    outputName,
  ];

  return { args, filterGraph: chains.join(';\n'), textFiles, outputName, duration: clip.duration };
}

// The concat demuxer's playlist. Segment names are ours and contain nothing
// that needs escaping, but the quoting is what the format asks for.
export function buildSegmentList(plan) {
  return `${plan.clips.map((_, index) => `file '${segmentName(index)}'`).join('\n')}\n`;
}

// Stage two: the segments end to end, with the music laid over them.
//
// Video is copied rather than re-encoded — the segments were already made to
// the final spec, and a second encode would be a generation of quality lost
// for nothing. Audio is always re-encoded, even with no music at all, because
// copying AAC across a join carries each segment's encoder priming with it and
// leaves a click at every cut.
export function buildJoinCommand(plan, { outputPath = 'reel.mp4', listFile = SEGMENT_LIST_NAME } = {}) {
  const inputs = ['-f', 'concat', '-safe', '0', '-i', listFile];
  const chains = [];
  let audioMap = '0:a';

  if (plan.music) {
    // -stream_loop belongs to the input that follows it: a 20s track behind a
    // 45s reel repeats instead of leaving 25s of silence. atrim below cuts it
    // back to the reel's exact length.
    inputs.push('-stream_loop', '-1', '-i', plan.music.path);

    const musicChain = [
      `atrim=0:${plan.totalDuration}`,
      'asetpts=PTS-STARTPTS',
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      `volume=${plan.music.volume}`,
      `afade=t=out:st=${round3(Math.max(0, plan.totalDuration - plan.music.fadeOut))}:d=${plan.music.fadeOut}`,
    ];
    chains.push(`[1:a]${musicChain.join(',')}[amusic]`);

    if (plan.music.mode === 'mix') {
      chains.push(`[0:a]volume=${plan.music.originalVolume}[aorig]`);
      // normalize=0 keeps amix from halving both legs the moment a second
      // input appears, which is what makes a "mix" sound quieter than either
      // track did on its own.
      chains.push('[aorig][amusic]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
      audioMap = '[aout]';
    } else {
      // Replace: the segments' own audio is simply never mapped. It cost a
      // little to encode, and that is the price of every segment having the
      // same stream layout for the demuxer to join.
      audioMap = '[amusic]';
    }
  }

  const filterGraph = chains.join(';\n');
  const args = [
    '-hide_banner',
    '-y',
    ...inputs,
    ...(filterGraph ? ['-filter_complex_script', JOIN_FILTER_NAME] : []),
    '-map',
    '0:v',
    '-map',
    audioMap,
    '-c:v',
    'copy',
    ...audioArgs(),
    // Without faststart the moov atom lands at the end of the file and
    // Instagram's fetcher — which streams rather than downloads whole —
    // reports the video as unprocessable.
    '-movflags',
    '+faststart',
    outputPath,
  ];

  return { args, filterGraph };
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export async function probeMedia(filePath) {
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // A container's own duration is the honest one where it exists; some phone
  // recordings only carry it on the video stream.
  const duration = Number(parsed.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;

  return {
    duration: round3(duration),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    fps: parseFrameRate(video?.avg_frame_rate),
    sizeBytes: Number(parsed.format?.size) || 0,
  };
}

function parseFrameRate(value) {
  if (!value || typeof value !== 'string') return 0;
  const [num, den] = value.split('/').map(Number);
  if (!den) return round3(num || 0);
  return round3((num || 0) / den);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Renders are tracked in memory rather than SQLite on purpose: a render is
// only interesting while the screen that asked for it is still open, and the
// file it produces is the durable artefact.
//
// Losing the progress bar of an in-flight encode to a restart is the correct
// amount of loss. Losing a *finished* file is not, and that is what used to
// happen: `npm run start-server` runs under `node --watch`, so saving any
// server file mid-export wiped this Map, the screen's next poll 404'd, and a
// perfectly good reel sat on disk while the editor said the export had
// failed. recoverRenderJob is why it no longer does — see below.
const renderJobs = new Map();

export function getRenderJob(renderId) {
  return renderJobs.get(renderId) || null;
}

// Rebuilds a job for a render this process has no memory of, from the file it
// left behind.
//
// It works because the output name carries the render's own id
// (`reel-<millis>-<first 8 of renderId>.mp4`), so a file on disk can be
// matched back to the id the screen is still polling with. The probe is the
// part that matters: a restart that lands mid-join leaves a truncated mp4 at
// the same path, and a truncated mp4 has no moov atom, so ffprobe refuses it
// and this returns null rather than handing the Share step half a video.
//
// What cannot be recovered is which of the four targets it was rendered for —
// three of them are 1080x1920 and the file cannot say which. The dimensions
// go back instead and the screen falls back to the target it still has
// selected, which is the one it exported with in every case but a deliberate
// mid-export change of the dropdown.
export async function recoverRenderJob(renderId) {
  if (typeof renderId !== 'string' || renderId.length < 8) return null;
  const suffix = `-${renderId.slice(0, 8)}.mp4`;

  let fileName;
  try {
    fileName = fs.readdirSync(RENDERS_DIR).find((name) => name.startsWith('reel-') && name.endsWith(suffix));
  } catch {
    return null;
  }
  if (!fileName) return null;

  const outputPath = path.join(RENDERS_DIR, fileName);
  let probe;
  try {
    probe = await probeMedia(outputPath);
  } catch {
    return null;
  }
  if (!probe.hasVideo || !(probe.duration > 0)) return null;

  const stat = fs.statSync(outputPath);
  const job = {
    renderId,
    status: 'ready',
    percent: 100,
    fileName,
    outputPath,
    totalDuration: probe.duration,
    target: null,
    width: probe.width,
    height: probe.height,
    warnings: [],
    startedAt: stat.mtime.toISOString(),
    finishedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    error: null,
    recovered: true,
  };
  // Put it back in the Map so the poll that recovered it is the only one that
  // pays for a probe.
  renderJobs.set(renderId, job);
  return job;
}

export function listRenderJobs() {
  return [...renderJobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Starts the encode and returns immediately. The screen polls
// GET /api/marketing/reel/render/:id for progress.
export function startRender(plan) {
  ensureMediaDirs();
  const renderId = randomUUID();
  const fileName = `reel-${Date.now()}-${renderId.slice(0, 8)}.mp4`;
  const outputPath = path.join(RENDERS_DIR, fileName);

  const job = {
    renderId,
    status: 'rendering',
    percent: 0,
    fileName,
    outputPath,
    totalDuration: plan.totalDuration,
    target: plan.target,
    width: plan.width,
    height: plan.height,
    warnings: plan.warnings,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sizeBytes: 0,
    error: null,
  };
  renderJobs.set(renderId, job);

  runRender(plan, outputPath, job).catch((err) => {
    job.status = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

async function runRender(plan, outputPath, job) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srbbq-reel-'));
  try {
    const fontSource = findFontFile();
    if (!fontSource && plan.clips.some((clip) => clip.captions.length)) {
      throw new Error(
        'No usable font was found for the caption overlay. Set REEL_FONT_FILE in .env to a .ttf path, or clear the captions.',
      );
    }
    if (fontSource) fs.copyFileSync(fontSource, path.join(workDir, 'font.ttf'));

    // Stage one is the whole encode and stage two only copies the video
    // through, so the bar spends nearly all of its life in the first loop.
    // The last slice is left for the join rather than letting the bar sit at
    // 100% through a step that can still take a second or two on a long reel.
    const JOIN_SHARE = 0.06;
    const encodeSpan = plan.totalDuration * (1 - JOIN_SHARE);
    let secondsDone = 0;

    for (const index of plan.clips.keys()) {
      const { args, filterGraph, textFiles, duration } = buildSegmentCommand(plan, index);
      for (const file of textFiles) {
        fs.writeFileSync(path.join(workDir, file.name), file.content, 'utf8');
      }
      fs.writeFileSync(path.join(workDir, segmentFilterName(index)), filterGraph, 'utf8');

      const before = secondsDone;
      await runFfmpeg(args, workDir, (seconds) => {
        job.percent = progressPercent(before + Math.min(seconds, duration), encodeSpan);
      });
      secondsDone += duration;
      job.percent = progressPercent(secondsDone, encodeSpan);
    }

    const { args: joinArgs, filterGraph: joinGraph } = buildJoinCommand(plan, { outputPath });
    if (joinGraph) fs.writeFileSync(path.join(workDir, JOIN_FILTER_NAME), joinGraph, 'utf8');
    fs.writeFileSync(path.join(workDir, SEGMENT_LIST_NAME), buildSegmentList(plan), 'utf8');

    await runFfmpeg(joinArgs, workDir, (seconds) => {
      const through = plan.totalDuration > 0 ? Math.min(1, seconds / plan.totalDuration) : 1;
      job.percent = Math.min(99, Math.round((1 - JOIN_SHARE + JOIN_SHARE * through) * 100));
    });

    job.status = 'ready';
    job.percent = 100;
    job.sizeBytes = fs.statSync(outputPath).size;
    job.finishedAt = new Date().toISOString();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Never 100 and never past the encode's own share of the bar: a job that reads
// 100% while a file is still being written has told the screen a lie it will
// have to take back.
function progressPercent(seconds, span) {
  if (!(span > 0)) return 0;
  return Math.min(94, Math.max(0, Math.round((seconds / span) * 100)));
}

// Reports seconds encoded rather than a percentage: with the render split
// across several ffmpeg runs, only the caller knows where a given run's
// seconds sit on the whole reel's clock.
function runFfmpeg(args, cwd, onProgress) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      FFMPEG_PATH,
      ['-progress', 'pipe:1', '-nostats', ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        // ffmpeg's actual complaint is always the last few stderr lines; the
        // exit code on its own tells nobody anything.
        const tail = String(stderr || '')
          .trim()
          .split('\n')
          .slice(-4)
          .join(' ')
          .trim();
        return reject(new Error(tail || err.message));
      },
    );

    child.stdout?.on('data', (chunk) => {
      const pattern = /out_time_ms=(\d+)/g;
      let last = null;
      let found;
      while ((found = pattern.exec(String(chunk))) !== null) last = found[1];
      if (last === null) return;
      onProgress(Number(last) / 1_000_000);
    });
  });
}

// Renders and uploaded clips are working files, not records. Anything older
// than a week is swept when a new render starts so the uploads folder does not
// quietly grow to the size of every reel ever attempted.
export function pruneOldMedia({ maxAgeDays = MEDIA_MAX_AGE_DAYS, now = Date.now() } = {}) {
  ensureMediaDirs();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const dir of [CLIPS_DIR, RENDERS_DIR]) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed.push(entry);
        }
      } catch {
        // A file that vanished under us needs no sweeping.
      }
    }
  }
  return removed;
}

export function describeToolchain() {
  const font = findFontFile();
  return {
    ffmpeg: FFMPEG_PATH,
    ffprobe: FFPROBE_PATH,
    ffmpegAvailable: Boolean(FFMPEG_PATH) && fs.existsSync(FFMPEG_PATH),
    fontFile: font || null,
    width: REEL_WIDTH,
    height: REEL_HEIGHT,
    fps: REEL_FPS,
    // The screen builds its target picker from this rather than repeating the
    // sizes and limits, so there is one place the four of them are described.
    targets: REEL_TARGETS,
    defaultTarget: DEFAULT_TARGET,
    // Same deal for the grade picker: the looks and their descriptions are
    // defined once, here, and the screen renders whatever it is handed.
    looks: REEL_LOOKS.map(({ id, label, hint }) => ({ id, label, hint })),
    defaultLook: DEFAULT_LOOK,
    storyMaxSeconds: STORY_MAX_SECONDS,
    reelMaxSeconds: REEL_MAX_SECONDS,
  };
}
