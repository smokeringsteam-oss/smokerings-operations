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
//     black to exactly 1080x1920 — never cropped, because cropping decides
//     for the user which half of their shot to throw away;
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
// buildRenderPlan and buildFilterGraph below are pure and are what
// reelStudio.test.js exercises. Everything that actually spawns a process is
// kept underneath them, because a test can honestly assert the shape of a
// filtergraph and cannot honestly assert that a video looks right.
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

// Instagram's vertical canvas. Everything is padded to exactly this.
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_FPS = 30;
export const AUDIO_RATE = 48000;

// Graph API limits, checked here so the user is told before a two-minute
// encode rather than after the publish call bounces.
export const STORY_MAX_SECONDS = 60;
export const REEL_MAX_SECONDS = 90;

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
export function buildRenderPlan({ clips = [], sources = {}, music = null, target = 'story' } = {}) {
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

    const captionLines = wrapCaption(clip.text);
    const position = ['top', 'center', 'bottom'].includes(clip.textPosition) ? clip.textPosition : 'bottom';

    return {
      id: clip.id,
      path: source.path,
      name: source.name || clip.id,
      in: inPoint,
      out: outPoint,
      duration,
      hasAudio: Boolean(source.hasAudio),
      captionLines,
      textPosition: position,
    };
  });

  const totalDuration = round3(planned.reduce((sum, clip) => sum + clip.duration, 0));

  const normalizedTarget = target === 'reel' ? 'reel' : 'story';
  const limit = normalizedTarget === 'reel' ? REEL_MAX_SECONDS : STORY_MAX_SECONDS;
  if (totalDuration > limit) {
    warnings.push(
      `This is ${totalDuration.toFixed(1)}s long. Instagram ${
        normalizedTarget === 'reel' ? 'Reels published through the API' : 'Stories'
      } cap out at ${limit}s — it will export fine but the publish step will refuse it.`,
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

  return { clips: planned, music: plannedMusic, totalDuration, target: normalizedTarget, warnings };
}

function clampVolume(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(2, Math.max(0, numeric)) * 100) / 100;
}

// Where a caption sits in the frame, as a drawtext y-expression. Bottom leaves
// room for Instagram's own reply bar, which covers roughly the last fifth of a
// Story.
const CAPTION_Y = {
  top: 'h*0.12',
  center: '(h-text_h)/2',
  bottom: 'h-text_h-h*0.20',
};

// Builds the whole ffmpeg invocation. Returns the argv (minus the binary), the
// filtergraph destined for filters.txt, and the caption text files that have
// to exist in the work directory before ffmpeg starts.
//
// Input order is fixed and the graph indexes into it, so it is spelled out
// once here: every clip first, then one anullsrc per silent clip, then the
// music track. A shared anullsrc would need an asplit and gains nothing —
// lavfi inputs cost nothing to open.
export function buildFilterGraph(plan, { outputPath = 'reel.mp4', fontFile = 'font.ttf' } = {}) {
  const inputs = [];
  const textFiles = [];
  const chains = [];
  const countInputs = () => inputs.filter((arg) => arg === '-i').length;

  // When music replaces the clips' own audio, none of the per-clip audio legs
  // are wanted: no atrim, no anullsrc inputs for the silent clips, and concat
  // joins video only. This is not just an optimisation — building them anyway
  // leaves concat's audio output connected to nothing, and ffmpeg rejects the
  // whole graph with "Filter concat has an unconnected output".
  const keepClipAudio = !plan.music || plan.music.mode === 'mix';

  for (const clip of plan.clips) {
    inputs.push('-i', clip.path);
  }

  const silentInputIndex = new Map();
  for (const [index, clip] of plan.clips.entries()) {
    if (clip.hasAudio || !keepClipAudio) continue;
    silentInputIndex.set(index, countInputs());
    inputs.push(
      '-f',
      'lavfi',
      '-t',
      String(clip.duration),
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`,
    );
  }

  let musicInputIndex = null;
  if (plan.music) {
    musicInputIndex = countInputs();
    // -stream_loop belongs to the input that follows it: a 20s track behind a
    // 45s reel repeats instead of leaving 25s of silence. atrim below cuts it
    // back to the reel's exact length.
    inputs.push('-stream_loop', '-1', '-i', plan.music.path);
  }

  plan.clips.forEach((clip, index) => {
    const video = [
      `trim=start=${clip.in}:end=${clip.out}`,
      'setpts=PTS-STARTPTS',
      `fps=${REEL_FPS}`,
      `scale=${REEL_WIDTH}:${REEL_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${REEL_WIDTH}:${REEL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      'format=yuv420p',
    ];

    if (clip.captionLines.length) {
      const textFileName = `caption-${index}.txt`;
      textFiles.push({ name: textFileName, content: clip.captionLines.join('\n') });
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
          ':fontsize=58',
          ':line_spacing=14',
          ':box=1:boxcolor=black@0.55:boxborderw=26',
          ':x=(w-text_w)/2',
          `:y=${CAPTION_Y[clip.textPosition]}`,
        ].join(''),
      );
    }

    chains.push(`[${index}:v]${video.join(',')}[v${index}]`);

    if (!keepClipAudio) return;

    // apad then atrim forces the audio leg to exactly the video leg's length.
    // Without it a clip whose audio stream runs a few frames short of its
    // video drifts, and concat carries that drift into every clip after it.
    const audioSource = clip.hasAudio ? `[${index}:a]` : `[${silentInputIndex.get(index)}:a]`;
    const audio = [
      clip.hasAudio ? `atrim=start=${clip.in}:end=${clip.out}` : null,
      'asetpts=PTS-STARTPTS',
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      'apad',
      `atrim=0:${clip.duration}`,
      'asetpts=PTS-STARTPTS',
    ].filter(Boolean);

    chains.push(`${audioSource}${audio.join(',')}[a${index}]`);
  });

  const concatInputs = plan.clips
    .map((_, index) => (keepClipAudio ? `[v${index}][a${index}]` : `[v${index}]`))
    .join('');
  chains.push(
    keepClipAudio
      ? `${concatInputs}concat=n=${plan.clips.length}:v=1:a=1[vout][acat]`
      : `${concatInputs}concat=n=${plan.clips.length}:v=1:a=0[vout]`,
  );

  let audioOut = '[acat]';
  if (plan.music) {
    const musicChain = [
      `atrim=0:${plan.totalDuration}`,
      'asetpts=PTS-STARTPTS',
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      `volume=${plan.music.volume}`,
      `afade=t=out:st=${round3(Math.max(0, plan.totalDuration - plan.music.fadeOut))}:d=${plan.music.fadeOut}`,
    ];
    chains.push(`[${musicInputIndex}:a]${musicChain.join(',')}[amusic]`);

    if (plan.music.mode === 'mix') {
      chains.push(`[acat]volume=${plan.music.originalVolume}[aorig]`);
      // normalize=0 keeps amix from halving both legs the moment a second
      // input appears, which is what makes a "mix" sound quieter than either
      // track did on its own.
      chains.push('[aorig][amusic]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
      audioOut = '[aout]';
    } else {
      audioOut = '[amusic]';
    }
  }

  const filterGraph = chains.join(';\n');

  const args = [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex_script',
    'filters.txt',
    '-map',
    '[vout]',
    '-map',
    audioOut,
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
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    String(AUDIO_RATE),
    '-ac',
    '2',
    // Without faststart the moov atom lands at the end of the file and
    // Instagram's fetcher — which streams rather than downloads whole —
    // reports the video as unprocessable.
    '-movflags',
    '+faststart',
    outputPath,
  ];

  return { args, filterGraph, textFiles, inputCount: countInputs() };
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
// file it produces is the durable artefact. A server restart losing the
// progress bar of an in-flight encode is the correct amount of loss.
const renderJobs = new Map();

export function getRenderJob(renderId) {
  return renderJobs.get(renderId) || null;
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
    if (!fontSource && plan.clips.some((clip) => clip.captionLines.length)) {
      throw new Error(
        'No usable font was found for the caption overlay. Set REEL_FONT_FILE in .env to a .ttf path, or clear the captions.',
      );
    }
    if (fontSource) fs.copyFileSync(fontSource, path.join(workDir, 'font.ttf'));

    const { args, filterGraph, textFiles } = buildFilterGraph(plan, { outputPath });
    for (const file of textFiles) {
      fs.writeFileSync(path.join(workDir, file.name), file.content, 'utf8');
    }
    fs.writeFileSync(path.join(workDir, 'filters.txt'), filterGraph, 'utf8');

    await runFfmpeg(args, workDir, plan.totalDuration, (percent) => {
      job.percent = percent;
    });

    job.status = 'ready';
    job.percent = 100;
    job.sizeBytes = fs.statSync(outputPath).size;
    job.finishedAt = new Date().toISOString();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function runFfmpeg(args, cwd, totalDuration, onProgress) {
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

    if (totalDuration > 0) {
      child.stdout?.on('data', (chunk) => {
        const pattern = /out_time_ms=(\d+)/g;
        let last = null;
        let found;
        while ((found = pattern.exec(String(chunk))) !== null) last = found[1];
        if (last === null) return;
        const seconds = Number(last) / 1_000_000;
        onProgress(Math.min(99, Math.round((seconds / totalDuration) * 100)));
      });
    }
  });
}

// Renders and uploaded clips are working files, not records. Anything older
// than a week is swept when a new render starts so the uploads folder does not
// quietly grow to the size of every reel ever attempted.
export function pruneOldMedia({ maxAgeDays = 7, now = Date.now() } = {}) {
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
    storyMaxSeconds: STORY_MAX_SECONDS,
    reelMaxSeconds: REEL_MAX_SECONDS,
  };
}
