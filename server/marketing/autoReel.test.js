// The automatic build, in the parts that are worth pinning.
//
// Most of this pipeline was already covered where it lives: roughCut.test.js
// owns the five rules that choose the shots, reelStudio.test.js owns the
// filtergraph. What is new here is the joinery between them, and the joinery
// is where the invisible failures are — a caption attached to the wrong shot
// or a time on the wrong ruler renders perfectly and is only discoverable by
// watching the finished video.
import { describe, it, expect } from 'vitest';

const { planFromPicks, defaultTargetSeconds } = await import('./autoReel.js');
const { tidyCaption, captionablePicks, attachCaptions, MAX_CAPTION_CHARS } = await import('./reelCaptions.js');

const pick = (clipId, inPoint, outPoint) => ({
  clipId,
  name: clipId,
  in: inPoint,
  out: outPoint,
  seconds: Math.round((outPoint - inPoint) * 1000) / 1000,
});

describe('planFromPicks', () => {
  it('keeps caption times on the source ruler, not the clip-local one', () => {
    // This is the bug worth a test. buildRenderPlan shifts caption times by
    // the in-point to get the clock drawtext counts in, so a caption already
    // shifted here comes out at 0s of a clip that starts at 12s — which for a
    // 2s pick means a caption that never appears at all.
    const [clip] = planFromPicks([pick('a.mp4', 12.5, 14.5)], ['Bark like that takes hours']);
    expect(clip.captions[0].start).toBe(12.5);
    expect(clip.captions[0].end).toBe(14.5);
    expect(clip.in).toBe(12.5);
  });

  it('gives a shot with no caption an empty list rather than an empty caption', () => {
    // A caption of '' would survive to wrapCaption, which drops it — but it
    // would also count as "this clip has captions", and that is what decides
    // whether the render needs a font at all.
    const clips = planFromPicks([pick('a.mp4', 0, 2), pick('b.mp4', 0, 2)], ['Words', '']);
    expect(clips[0].captions).toHaveLength(1);
    expect(clips[1].captions).toEqual([]);
  });

  it('carries one clip per pick, so the same source used twice appears twice', () => {
    // roughCut takes several shots out of one long clip. If these were keyed
    // by clip id anywhere the reel would silently lose all but one of them.
    const clips = planFromPicks([pick('a.mp4', 0, 2), pick('a.mp4', 30, 32)], ['', '']);
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.in)).toEqual([0, 30]);
  });
});

describe('defaultTargetSeconds', () => {
  it('leaves room under the cap rather than aiming at it', () => {
    // A cut planned to exactly the cap overshoots it on the last pick — see
    // OVERSHOOT_ALLOWANCE in roughCut.js — and lands on a reel the publish
    // step then refuses.
    expect(defaultTargetSeconds('ig-story')).toBeLessThan(60);
    expect(defaultTargetSeconds('ig-story')).toBeGreaterThan(30);
  });

  it('gives an uncapped target a real length instead of forever', () => {
    // yt-video reports maxSeconds 0, meaning "no cap". Multiplying that would
    // ask for a zero-second reel.
    expect(defaultTargetSeconds('yt-video')).toBeGreaterThan(10);
  });
});

describe('tidyCaption', () => {
  it('strips the things the prompt asked against but a model still sends', () => {
    expect(tidyCaption('  "Low and slow."  ')).toBe('Low and slow');
    expect(tidyCaption('Brisket day #bbq #smoked')).toBe('Brisket day');
  });

  it('cuts an over-long caption at a word boundary', () => {
    const long = 'Twelve hours in the smoke and the bark has gone properly dark all over';
    const out = tidyCaption(long);
    expect(out.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    // Not mid-word: whatever survives has to be a prefix ending on a whole word.
    expect(long.startsWith(out)).toBe(true);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('returns empty for anything with nothing left in it', () => {
    expect(tidyCaption('')).toBe('');
    expect(tidyCaption('   ')).toBe('');
    expect(tidyCaption('#bbq')).toBe('');
    expect(tidyCaption(null)).toBe('');
  });
});

describe('captionablePicks', () => {
  it('leaves a shot too short to read alone', () => {
    const picks = [pick('a.mp4', 0, 0.8), pick('b.mp4', 0, 3)];
    expect(captionablePicks(picks).map((entry) => entry.index)).toEqual([1]);
  });
});

describe('attachCaptions', () => {
  it('matches on the shot number, not on array position', () => {
    // The failure this exists for: shot 1 is too short to caption, so the
    // model is shown shots 2 and 3 only and labels them 1 and 2. Attaching by
    // array position would slide both captions one shot earlier — which
    // renders perfectly and is wrong all the way through.
    const picks = [pick('a.mp4', 0, 0.5), pick('b.mp4', 0, 3), pick('c.mp4', 0, 3)];
    const captionable = captionablePicks(picks);
    const answer = { captions: [{ shot: 1, text: 'On the smoker' }, { shot: 2, text: 'Rested and sliced' }] };

    expect(attachCaptions(picks, captionable, answer)).toEqual(['', 'On the smoker', 'Rested and sliced']);
  });

  it('survives a model that returns fewer captions than it was shown', () => {
    const picks = [pick('a.mp4', 0, 3), pick('b.mp4', 0, 3)];
    const captionable = captionablePicks(picks);
    const answer = { captions: [{ shot: 2, text: 'Only this one' }] };

    expect(attachCaptions(picks, captionable, answer)).toEqual(['', 'Only this one']);
  });

  it('ignores a caption for a shot that was never shown', () => {
    const picks = [pick('a.mp4', 0, 3)];
    const answer = { captions: [{ shot: 4, text: 'Where did this come from' }] };
    expect(attachCaptions(picks, captionablePicks(picks), answer)).toEqual(['']);
  });

  it('returns a clean reel rather than throwing on a malformed answer', () => {
    const picks = [pick('a.mp4', 0, 3)];
    expect(attachCaptions(picks, captionablePicks(picks), {})).toEqual(['']);
    expect(attachCaptions(picks, captionablePicks(picks), { captions: null })).toEqual(['']);
    expect(attachCaptions(picks, captionablePicks(picks), { captions: [{ text: 'no shot number' }] })).toEqual(['']);
  });
});
