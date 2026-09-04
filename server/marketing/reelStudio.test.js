// The pure half of reelStudio.js: the plan, and the filtergraph built from it.
//
// Only that half is exercised. Whether a rendered reel *looks* right is not
// something a test can assert honestly, and asserting that ffmpeg exits zero
// would be a test of ffmpeg. What can go quietly wrong here — and what these
// cases are all about — is the graph being well-formed but wrong:
//
//   * a silent clip wired to the wrong anullsrc input, which does not fail,
//     it just puts the wrong silence against the wrong picture;
//   * a caption that renders as nothing at all because of one character in
//     it (see the expansion=none case, which is a regression guard for a real
//     bug: a caption reading "100% brisket" made drawtext draw *nothing*,
//     with a warning on stderr and a zero exit code, so the reel rendered
//     successfully and silently without its caption);
//   * a trim point a few milliseconds past a clip's real end failing an
//     entire render rather than being clamped.
import { describe, it, expect } from 'vitest';
import { buildFilterGraph, buildRenderPlan, wrapCaption } from './reelStudio.js';

const sources = {
  a: { path: '/clips/a.mp4', name: 'a.mp4', duration: 10, hasAudio: true },
  b: { path: '/clips/b.mp4', name: 'b.mp4', duration: 4, hasAudio: false },
};

describe('wrapCaption', () => {
  it('wraps on word boundaries within the line budget', () => {
    expect(wrapCaption('Fresh brisket every single weekend', { maxCharsPerLine: 16 })).toEqual([
      'Fresh brisket',
      'every single',
      'weekend',
    ]);
  });

  it('breaks a single word that is longer than a whole line', () => {
    // drawtext has no wrapping of its own, so a word with nowhere to break
    // would otherwise run off both edges of the frame.
    expect(wrapCaption('Supercalifragilistic', { maxCharsPerLine: 8 })).toEqual([
      'Supercal',
      'ifragili',
      'stic',
    ]);
  });

  it('truncates past the line cap so a pasted paragraph cannot cover the video', () => {
    const lines = wrapCaption('one two three four five six seven eight nine ten', {
      maxCharsPerLine: 8,
      maxLines: 2,
    });
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('treats empty and whitespace-only text as no caption at all', () => {
    expect(wrapCaption('')).toEqual([]);
    expect(wrapCaption('   \n  ')).toEqual([]);
    expect(wrapCaption(undefined)).toEqual([]);
  });
});

describe('buildRenderPlan', () => {
  it('clamps a trim point that runs past the clip rather than failing the render', () => {
    // The browser's currentTime is a float and lands a few milliseconds past
    // the real duration often enough that rejecting it would be theatre.
    const plan = buildRenderPlan({
      clips: [{ id: 'b', in: 0, out: 4.06 }],
      sources,
    });

    expect(plan.clips[0].out).toBe(4);
    expect(plan.totalDuration).toBe(4);
  });

  it('defaults a missing out point to the end of the clip', () => {
    const plan = buildRenderPlan({ clips: [{ id: 'a' }], sources });
    expect(plan.clips[0]).toMatchObject({ in: 0, out: 10, duration: 10 });
  });

  it('refuses a clip trimmed down to nothing', () => {
    expect(() => buildRenderPlan({ clips: [{ id: 'a', in: 3, out: 3 }], sources })).toThrow(/trimmed down to nothing/);
  });

  it('refuses a clip whose file is no longer on the server', () => {
    expect(() => buildRenderPlan({ clips: [{ id: 'gone' }], sources })).toThrow(/no longer on the server/);
  });

  it('refuses an empty timeline', () => {
    expect(() => buildRenderPlan({ clips: [], sources })).toThrow(/at least one clip/);
  });

  it('warns rather than fails when the reel is over the Story limit', () => {
    // A 70s story exports fine and is only refused at the publish step, so
    // this is a warning: the export is still worth having.
    const long = { path: '/clips/long.mp4', duration: 70, hasAudio: true };
    const plan = buildRenderPlan({ clips: [{ id: 'long' }], sources: { long }, target: 'story' });

    expect(plan.warnings.join(' ')).toMatch(/Stories cap out at 60s/);
    expect(plan.clips).toHaveLength(1);
  });

  it('holds the same 70s reel to the longer Reels limit without complaint', () => {
    const long = { path: '/clips/long.mp4', duration: 70, hasAudio: true };
    const plan = buildRenderPlan({ clips: [{ id: 'long' }], sources: { long }, target: 'reel' });

    expect(plan.warnings).toEqual([]);
    expect(plan.target).toBe('reel');
  });

  it('warns when nothing in the timeline makes any sound', () => {
    const plan = buildRenderPlan({ clips: [{ id: 'b' }], sources });
    expect(plan.warnings.join(' ')).toMatch(/will be silent/);
  });

  it('says nothing about silence once a music track covers it', () => {
    const plan = buildRenderPlan({
      clips: [{ id: 'b' }],
      sources,
      music: { path: '/clips/track.m4a' },
    });
    expect(plan.warnings).toEqual([]);
  });

  it('zeroes the original audio when music replaces rather than mixes', () => {
    const plan = buildRenderPlan({
      clips: [{ id: 'a' }],
      sources,
      music: { path: '/clips/track.m4a', mode: 'replace', volume: 3 },
    });

    expect(plan.music.originalVolume).toBe(0);
    // Volume is clamped: a slider that got away from someone should not be
    // able to ask for 300%.
    expect(plan.music.volume).toBe(2);
  });

  it('shortens the music fade on a reel too short to carry a 1.5s one', () => {
    const tiny = { path: '/clips/tiny.mp4', duration: 2, hasAudio: true };
    const plan = buildRenderPlan({
      clips: [{ id: 'tiny' }],
      sources: { tiny },
      music: { path: '/clips/track.m4a' },
    });

    expect(plan.music.fadeOut).toBe(0.5);
  });
});

describe('buildFilterGraph', () => {
  const planOf = (overrides = {}) =>
    buildRenderPlan({ clips: [{ id: 'a', in: 1, out: 4 }, { id: 'b' }], sources, ...overrides });

  it('gives every silent clip its own anullsrc input and wires it to that clip', () => {
    // Clip b has no audio track. concat with a=1 needs one anyway, and it has
    // to be the silence generated for b's own length — input 2, not input 1.
    const { args, filterGraph, inputCount } = buildFilterGraph(planOf());

    expect(inputCount).toBe(3);
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(filterGraph).toContain('[0:a]atrim=start=1:end=4');
    expect(filterGraph).toContain('[2:a]asetpts=PTS-STARTPTS');
    expect(filterGraph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][acat]');
  });

  it('pads and re-times every clip onto the same 1080x1920 30fps grid', () => {
    const { filterGraph } = buildFilterGraph(planOf());
    const videoChains = filterGraph.split('\n').filter((line) => line.startsWith('[0:v]') || line.startsWith('[1:v]'));

    expect(videoChains).toHaveLength(2);
    for (const chain of videoChains) {
      expect(chain).toContain('fps=30');
      expect(chain).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
      expect(chain).toContain('pad=1080:1920');
      // A non-square SAR surviving concat skews everything after it.
      expect(chain).toContain('setsar=1');
    }
  });

  it('forces each audio leg to its clip’s exact length so concat cannot drift', () => {
    const { filterGraph } = buildFilterGraph(planOf());
    expect(filterGraph).toContain('apad,atrim=0:3');
    expect(filterGraph).toContain('apad,atrim=0:4');
  });

  it('turns drawtext off for expansion so a % in a caption still renders', () => {
    // The regression this file exists for. Without expansion=none, drawtext
    // reads "100%" as a broken %{...} template, draws nothing, and exits 0.
    const plan = buildRenderPlan({
      clips: [{ id: 'a', text: 'Ready at 6:30 — 100% brisket' }],
      sources,
    });
    const { filterGraph, textFiles } = buildFilterGraph(plan);

    expect(filterGraph).toContain('expansion=none');
    // And the text itself never enters the graph — it goes to a file, so no
    // amount of punctuation in a caption can reach the filtergraph parser.
    expect(filterGraph).not.toContain('100%');
    expect(textFiles).toEqual([{ name: 'caption-0.txt', content: 'Ready at 6:30 — 100%\nbrisket' }]);
  });

  it('adds no drawtext at all to a clip with no caption', () => {
    const { filterGraph, textFiles } = buildFilterGraph(planOf());
    expect(filterGraph).not.toContain('drawtext');
    expect(textFiles).toEqual([]);
  });

  it('positions a caption by the position asked for', () => {
    const plan = buildRenderPlan({
      clips: [
        { id: 'a', text: 'top one', textPosition: 'top' },
        { id: 'b', text: 'bottom one', textPosition: 'nonsense' },
      ],
      sources,
    });
    const { filterGraph } = buildFilterGraph(plan);

    expect(filterGraph).toContain('y=h*0.12');
    // An unknown position falls back to bottom rather than breaking the graph.
    expect(filterGraph).toContain('y=h-text_h-h*0.20');
  });

  it('loops a music track shorter than the reel and cuts it to the exact length', () => {
    const plan = planOf({ music: { path: '/clips/track.m4a', mode: 'replace' } });
    const { args, filterGraph } = buildFilterGraph(plan);

    // -stream_loop -1 must sit immediately before the music input, not before
    // a clip: it applies to the input that follows it.
    const loopIndex = args.indexOf('-stream_loop');
    expect(args[loopIndex + 1]).toBe('-1');
    expect(args[loopIndex + 2]).toBe('-i');
    expect(args[loopIndex + 3]).toBe('/clips/track.m4a');

    expect(filterGraph).toContain('afade=t=out:st=5.5:d=1.5');
    expect(filterGraph).not.toContain('amix');
    expect(args.join(' ')).toContain('-map [amusic]');
  });

  it('builds no clip-audio legs at all when music replaces them', () => {
    // The regression this exists for: building the audio legs anyway left
    // concat's audio pad connected to nothing, and ffmpeg rejects the entire
    // graph with "Filter concat has an unconnected output" — so every export
    // with "Replace it entirely" selected failed, whatever was on the
    // timeline. Nothing may reference [acat] once nothing consumes it.
    const plan = planOf({ music: { path: '/clips/track.m4a', mode: 'replace' } });
    const { args, filterGraph, inputCount } = buildFilterGraph(plan);

    expect(filterGraph).toContain('[v0][v1]concat=n=2:v=1:a=0[vout]');
    expect(filterGraph).not.toContain('[acat]');
    expect(filterGraph).not.toContain('[a0]');
    // Clip b is silent, but with its audio leg gone it needs no anullsrc
    // either: two clips plus the music track, and nothing else. That also
    // shifts the music to input 2, which the graph has to agree with.
    expect(args.join(' ')).not.toContain('anullsrc');
    expect(inputCount).toBe(3);
    expect(filterGraph).toContain('[2:a]atrim=0:7');
  });

  it('keeps the clip-audio legs when music only sits over them', () => {
    const plan = planOf({ music: { path: '/clips/track.m4a', mode: 'mix' } });
    const { args, filterGraph, inputCount } = buildFilterGraph(plan);

    expect(filterGraph).toContain('concat=n=2:v=1:a=1[vout][acat]');
    expect(args.join(' ')).toContain('anullsrc');
    expect(inputCount).toBe(4);
  });

  it('mixes without letting amix halve both tracks', () => {
    const plan = planOf({ music: { path: '/clips/track.m4a', mode: 'mix', volume: 0.8, originalVolume: 0.3 } });
    const { args, filterGraph } = buildFilterGraph(plan);

    expect(filterGraph).toContain('[acat]volume=0.3[aorig]');
    expect(filterGraph).toContain('volume=0.8');
    // normalize=0 is what stops a "mix" sounding quieter than either track on
    // its own.
    expect(filterGraph).toContain('normalize=0');
    expect(args.join(' ')).toContain('-map [aout]');
  });

  it('encodes what Instagram will accept', () => {
    const { args } = buildFilterGraph(planOf(), { outputPath: 'out.mp4' });
    const joined = args.join(' ');

    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-pix_fmt yuv420p');
    // Without faststart the moov atom lands at the end and Instagram's
    // streaming fetcher reports the video as unprocessable.
    expect(joined).toContain('-movflags +faststart');
    expect(args[args.length - 1]).toBe('out.mp4');
    // The graph goes to a file, not to argv: a ten-clip captioned reel builds
    // a graph long enough to matter against Windows argv limits.
    expect(joined).toContain('-filter_complex_script filters.txt');
  });
});
