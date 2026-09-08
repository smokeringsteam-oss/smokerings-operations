// Drive folder in, finished reel out, with nobody on a timeline in between.
//
// This is the whole of the reel feature's control flow now. It replaced a
// manual editor — a preview over a scrubbing track, drag to reorder, handles
// to trim, click to caption — which worked and which nobody used, because the
// twenty minutes it takes are twenty minutes at the end of a cook when the
// kitchen is being cleaned. What survived from that editor is everything
// underneath it: the analysis, the cut planner and the renderer were always
// separate from the UI, and this file is a new caller for them.
//
// THE FIVE STAGES, and why each is where it is:
//
//   fetching   Drive ids are pulled down into the clips directory. Everything
//              downstream works on local paths, so this is the only stage that
//              needs the network to Google, and it is first so a signed-out
//              token fails before any decoding is paid for.
//
//   watching   Each clip is decoded at 240p and measured — black frames, a
//              frozen picture, silence, scene cuts. reelAnalysis.js.
//
//   cutting    Those measurements become an ordered list of picks: the dead
//              air gone, every clip represented, nothing outstaying its
//              welcome. roughCut.js, a pure function, five documented rules.
//
//   writing    One frame from the middle of each pick goes to Gemini and comes
//              back as the words on screen. reelCaptions.js. This is the only
//              stage that can fail without failing the build — see below.
//
//   rendering  The picks and their captions become a render plan and the
//              existing encoder takes it from there. reelStudio.js.
//
// WHY IT IS A JOB AND NOT A REQUEST. The four stages before the render are a
// download of several hundred megabytes, a decode of each clip, and a model
// call. On a domestic connection that is comfortably past any sensible HTTP
// timeout, and it is the same reason the render, the Instagram publish, the
// YouTube upload and the Drive upload are all jobs: the browser polls, and
// closing the tab does not cancel the work.
//
// WHY CAPTIONS CANNOT FAIL THE BUILD. They are the last thing added and the
// least important thing present. A quota that ran out — which on this
// project's free-tier key is a routine event, not an edge case — must not cost
// the operator the cut, so writeCaptions() returns notes instead of throwing
// and the reel renders clean. Everything before it is local and deterministic,
// so a build that got as far as `writing` will produce a video.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { importDriveSource } from '../integrations/googleDrive.js';
import { analyseClip } from './reelAnalysis.js';
import { planRoughCut } from './roughCut.js';
import { writeCaptions } from './reelCaptions.js';
import {
  DEFAULT_LOOK,
  DEFAULT_TARGET,
  buildRenderPlan,
  ensureMediaDirs,
  probeMedia,
  resolveTarget,
  startRender,
} from './reelStudio.js';

// How many clips are decoded at once. Analysis is the slow stage and it is
// CPU-bound, so this is a concurrency limit rather than a batch size: three
// keeps a four-core machine busy without making the dashboard's other pages
// unresponsive while a reel is building.
const ANALYSE_CONCURRENCY = 3;

// The same ceiling the upload route used. A reel is built from a session's
// footage, not from a library, and past this the analysis stage alone runs
// into minutes.
const MAX_SOURCE_CLIPS = 12;

const STAGES = ['fetching', 'watching', 'cutting', 'writing', 'rendering'];

// What each stage is called on screen. Written as what the machine is doing
// right now, not as a noun for the phase, because it is read while it is
// happening — "Watching the footage" answers "why is this taking a while" in
// a way that "Analysis" does not.
const STAGE_LABELS = {
  fetching: 'Fetching from Drive',
  watching: 'Watching the footage',
  cutting: 'Choosing the shots',
  writing: 'Writing the captions',
  rendering: 'Rendering',
};

const jobs = new Map();

export function getAutoReelJob(buildId) {
  return jobs.get(buildId) || null;
}

// Kept bounded for the same reason the render jobs map is: this process is
// long-lived and a job is only interesting until the render it started is
// collected. Ten is more history than anyone scrolls back through.
function forgetOldJobs(limit = 10) {
  const ids = [...jobs.keys()];
  for (const id of ids.slice(0, Math.max(0, ids.length - limit))) jobs.delete(id);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The picks become clips on a render plan.
//
// Each pick is one clip entry carrying its own in/out — the same shape the
// timeline used to send, which is why the renderer needed no changes at all.
// The caption spans the whole pick because a pick IS one shot: roughCut cut it
// at the scene boundaries, so there is no second thing happening inside it for
// a second caption to be about.
//
// Caption times are on the SOURCE clock, the same ruler as in/out, because
// that is the ruler planCaptions() shifts from. See reelStudio.js.
export function planFromPicks(picks, captions = []) {
  return picks.map((pick, index) => {
    const text = captions[index] || '';
    return {
      id: pick.clipId,
      name: pick.name,
      in: pick.in,
      out: pick.out,
      zoom: 1,
      captions: text ? [{ text, position: 'bottom', start: pick.in, end: pick.out }] : [],
    };
  });
}

// A reel's target length, defaulted from where it is going rather than from a
// constant. A Story caps at 15s and a YouTube video does not cap at all, and
// asking for a 15s cut of footage destined for the latter throws away most of
// it. Capped at 60 regardless: past a minute this is not a reel and the
// round-robin picker is the wrong tool.
export function defaultTargetSeconds(target) {
  const spec = resolveTarget(target);
  if (!spec.maxSeconds) return 45;
  return Math.min(60, Math.max(8, Math.round(spec.maxSeconds * 0.85)));
}

export function startAutoReel({
  clipFileIds = [],
  songFileId = '',
  target = DEFAULT_TARGET,
  look = DEFAULT_LOOK,
  targetSeconds,
  maxShotSeconds,
  musicMode = 'mix',
  sessionHint = '',
} = {}) {
  if (!Array.isArray(clipFileIds) || !clipFileIds.length) {
    throw badRequest('Pick at least one clip from the Drive folder.');
  }
  if (clipFileIds.length > MAX_SOURCE_CLIPS) {
    throw badRequest(`That is ${clipFileIds.length} clips. ${MAX_SOURCE_CLIPS} is the most one reel is built from.`);
  }

  ensureMediaDirs();
  const buildId = `bld-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = {
    buildId,
    status: 'building',
    stage: 'fetching',
    stageLabel: STAGE_LABELS.fetching,
    // Whole stages rather than a byte count. Only the render reports real
    // progress; the rest are steps that either have happened or have not, and
    // a fabricated percentage across them would be a lie that stalls.
    stageIndex: 0,
    stageCount: STAGES.length,
    detail: `${clipFileIds.length} clip${clipFileIds.length === 1 ? '' : 's'} to come down`,
    notes: [],
    // Filled in as they are learned, so the screen can show the edit before
    // the encode has finished.
    picks: [],
    captions: [],
    postCaption: '',
    totalSeconds: 0,
    renderId: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(buildId, job);
  forgetOldJobs();

  runBuild(job, {
    clipFileIds,
    songFileId,
    target,
    look,
    targetSeconds,
    maxShotSeconds,
    musicMode,
    sessionHint,
  }).catch((err) => {
    job.status = 'failed';
    job.error = err.message || String(err);
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

function enterStage(job, stage, detail = null) {
  job.stage = stage;
  job.stageLabel = STAGE_LABELS[stage] || stage;
  job.stageIndex = STAGES.indexOf(stage);
  job.detail = detail;
}

async function runBuild(job, options) {
  const { clipFileIds, songFileId, target, look, musicMode, sessionHint } = options;

  // ---- fetching -----------------------------------------------------------
  // Sequential, not parallel. These are tens of megabytes each on a domestic
  // upstream; six at once do not arrive sooner, they arrive together at the
  // end, and one slow file would have no visible position in the queue.
  const fetched = [];
  for (const [index, fileId] of clipFileIds.entries()) {
    enterStage(job, 'fetching', `Clip ${index + 1} of ${clipFileIds.length}`);
    try {
      fetched.push(await importDriveSource(fileId, { kind: 'video' }));
    } catch (err) {
      // One clip that will not come down must not lose the other five, but a
      // build where nothing arrived is a failure rather than an empty reel.
      job.notes.push(`Skipped a clip: ${err.message || String(err)}`);
    }
  }
  if (!fetched.length) {
    throw new Error(`Nothing could be fetched from Drive. ${job.notes.join(' ')}`);
  }

  let song = null;
  if (songFileId) {
    enterStage(job, 'fetching', 'Fetching the song');
    try {
      song = await importDriveSource(songFileId, { kind: 'audio' });
    } catch (err) {
      // A missing song costs the reel its music, not its existence.
      job.notes.push(`No music: ${err.message || String(err)}`);
    }
  }

  // ---- watching -----------------------------------------------------------
  enterStage(job, 'watching', `Reading ${fetched.length} clip${fetched.length === 1 ? '' : 's'}`);
  const sources = {};
  const analysed = [];
  let watched = 0;

  for (let start = 0; start < fetched.length; start += ANALYSE_CONCURRENCY) {
    const batch = fetched.slice(start, start + ANALYSE_CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (record) => {
        try {
          const probe = await probeMedia(record.path);
          if (!probe.hasVideo) return { record, error: 'has no video track' };
          const analysis = await analyseClip(record.path, { probe });
          return { record, probe, analysis };
        } catch (err) {
          return { record, error: err.message || String(err) };
        }
      }),
    );
    for (const result of done) {
      watched += 1;
      if (result.error) {
        job.notes.push(`Could not read ${result.record.driveName}: ${result.error}`);
        continue;
      }
      sources[result.record.id] = {
        path: result.record.path,
        name: result.record.driveName,
        duration: result.probe.duration,
        hasAudio: result.probe.hasAudio,
      };
      analysed.push({ id: result.record.id, name: result.record.driveName, analysis: result.analysis });
    }
    enterStage(job, 'watching', `${watched} of ${fetched.length} read`);
  }

  if (!analysed.length) {
    throw new Error(`None of those clips could be read as video. ${job.notes.join(' ')}`);
  }

  // ---- cutting ------------------------------------------------------------
  enterStage(job, 'cutting', null);
  const targetSeconds = Number(options.targetSeconds) > 0 ? Number(options.targetSeconds) : defaultTargetSeconds(target);
  const cut = planRoughCut({
    clips: analysed,
    targetSeconds,
    ...(Number(options.maxShotSeconds) > 0 ? { maxShotSeconds: Number(options.maxShotSeconds) } : {}),
  });
  job.picks = cut.picks;
  job.totalSeconds = cut.totalSeconds;
  job.notes.push(...cut.notes);
  enterStage(job, 'cutting', `${cut.picks.length} shots, ${cut.totalSeconds.toFixed(1)}s`);

  // ---- writing ------------------------------------------------------------
  enterStage(job, 'writing', `Looking at ${cut.picks.length} shots`);
  // Its own directory, swept whatever happens: the frames are worth nothing
  // once the request has been made, and a build that throws should not leave
  // a pile of JPEGs in the temp folder.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srbbq-caption-'));
  let written = { captions: cut.picks.map(() => ''), postCaption: '', notes: [] };
  try {
    written = await writeCaptions({ picks: cut.picks, sources, workDir, sessionHint });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  job.captions = written.captions;
  job.postCaption = written.postCaption;
  job.notes.push(...written.notes);

  // ---- rendering ----------------------------------------------------------
  enterStage(job, 'rendering', null);
  const plan = buildRenderPlan({
    clips: planFromPicks(cut.picks, written.captions),
    sources,
    music: song
      ? {
          path: song.path,
          name: song.driveName,
          // mix keeps the sizzle and the room under the track. replace throws
          // the location audio away, which is right for a windy phone
          // recording and wrong for most else, so mix is the default.
          mode: musicMode === 'replace' ? 'replace' : 'mix',
          volume: 1,
          originalVolume: 0.35,
        }
      : null,
    target,
    look,
  });
  job.notes.push(...plan.warnings);

  const render = startRender(plan);
  job.renderId = render.renderId;
  job.status = 'rendering';
  job.totalSeconds = plan.totalDuration;
  job.finishedAt = new Date().toISOString();
}

export { MAX_SOURCE_CLIPS, STAGES, STAGE_LABELS };
