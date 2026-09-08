// Turning measured footage into a first cut.
//
// reelAnalysis.js says what is in each clip; this decides what makes the
// reel. It is deliberately a pure function of the analyses — no ffmpeg, no
// filesystem, no model — because every judgement in here is one somebody will
// eventually disagree with, and a judgement you can disagree with should be
// one you can read, test and change. roughCut.test.js exercises it directly.
//
// What it is for
// --------------
// Not to produce a finished reel. To produce the thing you would have spent
// twenty minutes dragging into place before you started making the actual
// decisions: the black frames at the head gone, the eight seconds of the
// phone lying on the counter gone, each shot cut to something watchable, and
// every clip you uploaded represented. It lands on the timeline as ordinary
// clips and you edit it from there.
//
// The five rules, in the order they are applied
// ---------------------------------------------
// 1. UNUSABLE FOOTAGE IS ALREADY GONE. shotsOf() removed the black and the
//    frozen stretches upstream; a shot arriving here is real footage.
// 2. A SHOT TOO SHORT TO READ IS NOT A SHOT. Under MIN_SHOT_SECONDS the
//    viewer registers a flash, not an image, so it is dropped rather than
//    kept as a stutter between two good ones.
// 3. NO SHOT OUTSTAYS ITS WELCOME. Anything over maxShotSeconds is trimmed to
//    it. This is the single biggest difference between raw phone footage and
//    something that plays as a reel, and it is why the rough cut of a minute
//    of clips is twenty seconds long.
// 4. EVERY CLIP GETS IN. Picks go round-robin across the clips — best shot
//    from each, then second-best from each — so four uploads produce a reel
//    with four uploads in it rather than one long one that filled the budget
//    first.
// 5. THE ORDER YOU UPLOADED IN IS THE ORDER IT PLAYS. Chronological is nearly
//    always the story (prep, then smoke, then plate), and a reordering
//    nobody asked for is the change hardest to spot and undo.
//
// What it deliberately does NOT do: pick a hook, write captions, or judge
// what is *interesting*. None of those are answerable from a decode, and
// guessing at them is how an automatic edit ends up worse than no edit. They
// are the next layer's job.

const round3 = (value) => Math.round(value * 1000) / 1000;

// Long enough to register as a picture. Below about six tenths of a second a
// shot reads as a glitch in the cut rather than as something you saw.
const MIN_SHOT_SECONDS = 0.6;

// The default ceiling on one shot. Two and a half seconds is the outer edge
// of what holds attention on a phone without something changing in frame; the
// caller can raise it for a slower, more cinematic cut.
const DEFAULT_MAX_SHOT_SECONDS = 2.5;

// How long the finished rough cut aims to be. Fifteen seconds is the length
// an Instagram Reel is watched all the way through most reliably, and a first
// cut that is short is a much easier thing to lengthen than a long one is to
// tighten.
const DEFAULT_TARGET_SECONDS = 15;

// The budget is a target, not a wall. A pick is taken while the reel is
// shorter than the target, so the last one can overshoot — stopping exactly
// on the number would mean either a truncated final shot or leaving the reel
// short by most of one. Anything past this multiple of the target is refused
// outright.
const OVERSHOOT_ALLOWANCE = 1.25;

// The first moments after a cut are where the camera is still settling and
// the autofocus is still hunting. Starting a pick a fraction late costs
// nothing and skips exactly that.
const SETTLE_SECONDS = 0.12;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// One shot, trimmed to the ceiling, taken from where the picture has settled.
//
// A long shot is cut from its start rather than its middle on purpose: the
// interesting thing in a piece of handheld footage is nearly always at the
// beginning, because that is where the camera was pointed when the recording
// was started. The middle is where it is being moved somewhere else.
function pickFrom(shot, maxShotSeconds) {
  const settle = shot.seconds > MIN_SHOT_SECONDS + SETTLE_SECONDS ? SETTLE_SECONDS : 0;
  const start = shot.start + settle;
  const end = Math.min(shot.end, start + maxShotSeconds);
  return { start: round3(start), end: round3(end), seconds: round3(end - start) };
}

// How good a shot is, given that nothing here has seen it.
//
// Only two things are knowable from a decode, and both are weak, which is why
// this is a sort order and not a score anybody reads. A shot that ran long
// before it was trimmed is a shot the camera was held on something — that is
// the strongest available signal for "this was deliberate". A shot with sound
// in it beats a silent one, weakly, because a kitchen making a noise is
// usually a kitchen doing something.
const shotRank = (shot) => shot.seconds + (shot.quiet ? 0 : 0.4);

// The plan the screen applies. `picks` are in play order; `notes` say what was
// left out and why, which is the part that makes the cut arguable rather than
// mysterious — a first cut that silently dropped half your footage is one
// nobody trusts twice.
function planRoughCut({
  clips = [],
  targetSeconds = DEFAULT_TARGET_SECONDS,
  maxShotSeconds = DEFAULT_MAX_SHOT_SECONDS,
} = {}) {
  const target = Number(targetSeconds);
  const ceiling = Number(maxShotSeconds);
  if (!(target > 0)) badRequest('The target length must be a number of seconds above zero.');
  if (!(ceiling >= MIN_SHOT_SECONDS)) badRequest(`The longest shot must be at least ${MIN_SHOT_SECONDS}s.`);
  if (!clips.length) badRequest('There are no clips to cut.');

  const notes = [];
  // Per clip, its shots ranked best-first but each remembering where it came
  // in the clip — the ranking decides what gets in, the original order decides
  // where it plays.
  const benches = clips.map((clip) => {
    const analysis = clip.analysis || {};
    const shots = (analysis.shots || []).map((shot, index) => ({ ...shot, index }));

    const droppedSeconds = Math.max(0, (analysis.duration || 0) - shots.reduce((sum, s) => sum + s.seconds, 0));
    if (droppedSeconds > 0.4) {
      const why = [];
      if ((analysis.black || []).length) why.push('black frames');
      if ((analysis.frozen || []).length) why.push('a frozen picture');
      notes.push(`${clip.name}: skipped ${droppedSeconds.toFixed(1)}s of ${why.join(' and ') || 'unusable footage'}.`);
    }

    const usable = shots.filter((shot) => shot.seconds >= MIN_SHOT_SECONDS);
    const tooShort = shots.length - usable.length;
    if (tooShort > 0) {
      notes.push(`${clip.name}: left out ${tooShort} shot${tooShort === 1 ? '' : 's'} under ${MIN_SHOT_SECONDS}s.`);
    }
    if (!usable.length && (analysis.duration || 0) > 0) {
      notes.push(`${clip.name}: nothing usable found, so it is not in the cut.`);
    }

    return { clip, ranked: [...usable].sort((a, b) => shotRank(b) - shotRank(a)) };
  });

  // Round-robin, so the reel is made of everything you gave it. See rule 4.
  const chosen = [];
  let total = 0;
  let round = 0;
  let tookSomething = true;
  while (tookSomething && total < target) {
    tookSomething = false;
    for (const bench of benches) {
      if (total >= target) break;
      const shot = bench.ranked[round];
      if (!shot) continue;
      const pick = pickFrom(shot, ceiling);
      if (pick.seconds < MIN_SHOT_SECONDS) continue;
      if (total + pick.seconds > target * OVERSHOOT_ALLOWANCE) continue;
      chosen.push({ clip: bench.clip, shotIndex: shot.index, ...pick });
      total += pick.seconds;
      tookSomething = true;
    }
    round += 1;
  }

  if (!chosen.length) {
    badRequest('None of those clips had a shot long enough to use. Trim them by hand, or lower the shortest-shot floor.');
  }

  // Back into upload order, then into the order each shot appears within its
  // own clip. See rule 5.
  const clipOrder = new Map(clips.map((clip, index) => [clip.id, index]));
  chosen.sort(
    (a, b) => (clipOrder.get(a.clip.id) ?? 0) - (clipOrder.get(b.clip.id) ?? 0) || a.shotIndex - b.shotIndex,
  );

  const used = new Set(chosen.map((pick) => pick.clip.id));
  const unused = clips.filter((clip) => !used.has(clip.id));
  if (unused.length) {
    notes.push(`Not in the cut: ${unused.map((clip) => clip.name).join(', ')}. Raise the target length to fit them in.`);
  }
  if (total < target * 0.75) {
    notes.push(
      `The cut came to ${total.toFixed(1)}s against a target of ${target}s — that is all the usable footage there was.`,
    );
  }

  return {
    picks: chosen.map((pick) => ({
      clipId: pick.clip.id,
      name: pick.clip.name,
      in: pick.start,
      out: pick.end,
      seconds: pick.seconds,
    })),
    totalSeconds: round3(total),
    targetSeconds: target,
    maxShotSeconds: ceiling,
    notes,
  };
}

export {
  planRoughCut,
  pickFrom,
  shotRank,
  MIN_SHOT_SECONDS,
  DEFAULT_MAX_SHOT_SECONDS,
  DEFAULT_TARGET_SECONDS,
};
