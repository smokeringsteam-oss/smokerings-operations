// The five rules at the top of roughCut.js, one test each, plus the parsing
// and range arithmetic underneath them in reelAnalysis.js.
//
// analyseClip itself is not exercised here: it spawns ffmpeg over a real
// video file, which is an integration test needing fixtures this repo does
// not carry. Everything it decides once the decode is over — what counts as a
// shot, what gets dropped, what makes the cut — is below that line and is
// what these cover.
import { describe, it, expect } from 'vitest';
import { planRoughCut, pickFrom, MIN_SHOT_SECONDS, DEFAULT_MAX_SHOT_SECONDS } from './roughCut.js';
import {
  shotsOf,
  mergeRanges,
  subtractRanges,
  parseBlack,
  parseFreeze,
  parseSilence,
  parseSceneCuts,
  buildAnalysisArgs,
} from './reelAnalysis.js';

// A clip as the route hands it to the planner: an id, a name and its analysis.
const clip = (id, shots, extra = {}) => ({
  id,
  name: id,
  analysis: {
    duration: shots.reduce((max, shot) => Math.max(max, shot.end), 0),
    shots: shots.map((shot) => ({ quiet: false, seconds: shot.end - shot.start, ...shot })),
    black: [],
    frozen: [],
    silent: [],
    ...extra,
  },
});

const shot = (start, end, quiet = false) => ({ start, end, seconds: end - start, quiet });

describe('planRoughCut', () => {
  it('trims every shot to the ceiling — the thing that makes it play as a reel', () => {
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 30)])],
      targetSeconds: 10,
      maxShotSeconds: 2,
    });
    expect(plan.picks).toHaveLength(1);
    expect(plan.picks[0].seconds).toBeCloseTo(2, 2);
    // And it starts a fraction late, past the settle.
    expect(plan.picks[0].in).toBeGreaterThan(0);
  });

  it('drops a shot too short to read rather than keeping it as a stutter', () => {
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 0.3), shot(0.3, 3)])],
      targetSeconds: 10,
    });
    expect(plan.picks).toHaveLength(1);
    expect(plan.picks[0].in).toBeGreaterThanOrEqual(0.3);
    expect(plan.notes.some((note) => note.includes(`under ${MIN_SHOT_SECONDS}s`))).toBe(true);
  });

  it('takes from every clip before taking twice from any one of them', () => {
    // Clip a has the longest shots by far. Ranked purely on quality it would
    // fill the whole budget on its own, and the other two uploads would not
    // be in the reel at all.
    const plan = planRoughCut({
      clips: [
        clip('a', [shot(0, 20), shot(20, 40)]),
        clip('b', [shot(0, 3)]),
        clip('c', [shot(0, 3)]),
      ],
      targetSeconds: 9,
      maxShotSeconds: 2.5,
    });
    expect(new Set(plan.picks.map((pick) => pick.clipId))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('plays in upload order, however the shots were ranked', () => {
    // b's shot is the strongest and gets picked first; it still plays second,
    // because that is the order the footage was shot in.
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 2)]), clip('b', [shot(0, 20)])],
      targetSeconds: 10,
    });
    expect(plan.picks.map((pick) => pick.clipId)).toEqual(['a', 'b']);
  });

  it('keeps a shot in its own order within a clip', () => {
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 2), shot(2, 9), shot(9, 11)])],
      targetSeconds: 12,
      maxShotSeconds: 2,
    });
    expect(plan.picks.map((pick) => pick.in)).toEqual([...plan.picks.map((pick) => pick.in)].sort((x, y) => x - y));
  });

  it('stops near the target rather than exactly on it', () => {
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 4), shot(4, 8), shot(8, 12), shot(12, 16)])],
      targetSeconds: 5,
      maxShotSeconds: 2,
    });
    // Never truncates a shot to land on the number, and never runs away with
    // the budget either.
    expect(plan.totalSeconds).toBeGreaterThanOrEqual(4);
    expect(plan.totalSeconds).toBeLessThanOrEqual(5 * 1.25);
  });

  it('says what it skipped and why, so the cut can be argued with', () => {
    const plan = planRoughCut({
      clips: [
        {
          id: 'a',
          name: 'kitchen.mp4',
          analysis: {
            duration: 12,
            // Three seconds of the twelve are black at the head, so only the
            // remaining nine are shots.
            shots: [shot(3, 12)],
            black: [{ start: 0, end: 3 }],
            frozen: [],
            silent: [],
          },
        },
      ],
      targetSeconds: 5,
    });
    expect(plan.notes.some((note) => note.includes('black frames'))).toBe(true);
    expect(plan.notes.some((note) => note.includes('3.0s'))).toBe(true);
  });

  it('names the clips that did not make it, rather than dropping them quietly', () => {
    const plan = planRoughCut({
      clips: [clip('used.mp4', [shot(0, 5)]), clip('left-out.mp4', [shot(0, 5)])],
      targetSeconds: 2,
      maxShotSeconds: 2,
    });
    expect(plan.picks).toHaveLength(1);
    expect(plan.notes.some((note) => note.includes('left-out.mp4'))).toBe(true);
  });

  it('refuses a set of clips with nothing usable in it, and says so', () => {
    expect(() => planRoughCut({ clips: [clip('a', [shot(0, 0.2)])], targetSeconds: 10 })).toThrow(/long enough/);
  });

  it('prefers the shot with sound when two are otherwise the same length', () => {
    const plan = planRoughCut({
      clips: [clip('a', [shot(0, 3, true), shot(3, 6, false)])],
      targetSeconds: 2,
      maxShotSeconds: 2,
    });
    expect(plan.picks).toHaveLength(1);
    expect(plan.picks[0].in).toBeGreaterThanOrEqual(3);
  });
});

describe('pickFrom', () => {
  it('cuts a long shot from its start, where the camera was pointed on purpose', () => {
    expect(pickFrom({ start: 10, end: 40, seconds: 30 }, 2)).toMatchObject({ start: 10.12, end: 12.12 });
  });

  it('does not skip the settle on a shot that has none to spare', () => {
    expect(pickFrom({ start: 0, end: 0.65, seconds: 0.65 }, DEFAULT_MAX_SHOT_SECONDS).start).toBe(0);
  });
});

describe('range arithmetic', () => {
  it('merges ranges that overlap or touch', () => {
    expect(mergeRanges([{ start: 2, end: 4 }, { start: 0, end: 1 }, { start: 3.5, end: 6 }])).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 6 },
    ]);
  });

  it('leaves the gaps between the ranges it is given', () => {
    expect(subtractRanges(10, [{ start: 0, end: 2 }, { start: 8, end: 10 }])).toEqual([{ start: 2, end: 8 }]);
  });

  it('gives back the whole clip when nothing is unusable', () => {
    expect(subtractRanges(5, [])).toEqual([{ start: 0, end: 5 }]);
  });
});

describe('shotsOf', () => {
  it('splits the usable footage at the scene changes and nowhere else', () => {
    const shots = shotsOf({ duration: 10, sceneCuts: [4], black: [{ start: 0, end: 1 }], frozen: [], silent: [] });
    expect(shots.map((s) => [s.start, s.end])).toEqual([[1, 4], [4, 10]]);
  });

  it('never produces a shot inside a frozen or black stretch', () => {
    const shots = shotsOf({
      duration: 12,
      sceneCuts: [5],
      black: [],
      frozen: [{ start: 8, end: 12 }],
      silent: [],
    });
    expect(shots.every((s) => s.end <= 8)).toBe(true);
  });

  it('marks a shot quiet without removing it — silence is a ranking, not a verdict', () => {
    const shots = shotsOf({
      duration: 4,
      sceneCuts: [],
      black: [],
      frozen: [],
      silent: [{ start: 0, end: 4 }],
    });
    expect(shots).toHaveLength(1);
    expect(shots[0].quiet).toBe(true);
  });
});

describe('parsing ffmpeg', () => {
  it('reads black stretches', () => {
    const text = '[blackdetect @ 0x1] black_start:0 black_end:2.4 black_duration:2.4';
    expect(parseBlack(text)).toEqual([{ start: 0, end: 2.4 }]);
  });

  it('runs an unclosed freeze to the end of the clip', () => {
    // The usual shape: the phone was put down and the recording ran on, so
    // there is a freeze_start and the file simply ends.
    expect(parseFreeze('[freezedetect] lavfi.freezedetect.freeze_start: 9.5', 14)).toEqual([{ start: 9.5, end: 14 }]);
  });

  it('pairs silence starts with their ends', () => {
    const text = 'silence_start: 1.2\nsilence_end: 3.7 | silence_duration: 2.5';
    expect(parseSilence(text, 10)).toEqual([{ start: 1.2, end: 3.7 }]);
  });

  it('reads one cut per scene change, not one per duplicated frame', () => {
    const text = 'pts_time:1.5\npts_time:1.52\npts_time:6.0';
    expect(parseSceneCuts(text)).toEqual([1.5, 6]);
  });
});

describe('buildAnalysisArgs', () => {
  it('scales down before it detects anything, and selects last', () => {
    const args = buildAnalysisArgs('clip.mp4', { hasAudio: true });
    const chain = args[args.indexOf('-vf') + 1];
    // The order is load-bearing: select drops frames, so anything after it
    // would never see the rest of the clip. See the note in reelAnalysis.js.
    expect(chain.indexOf('scale')).toBe(0);
    expect(chain.indexOf('blackdetect')).toBeLessThan(chain.indexOf('select'));
    expect(chain.indexOf('freezedetect')).toBeLessThan(chain.indexOf('select'));
    expect(chain.trimEnd().endsWith('metadata=print')).toBe(true);
  });

  it('asks for no audio filter on a clip that has no audio', () => {
    const args = buildAnalysisArgs('clip.mp4', { hasAudio: false });
    expect(args).toContain('-an');
    expect(args).not.toContain('-af');
  });

  it('decodes to nothing — the answers are all on stderr', () => {
    expect(buildAnalysisArgs('clip.mp4', { hasAudio: true }).slice(-3)).toEqual(['-f', 'null', '-']);
  });
});
