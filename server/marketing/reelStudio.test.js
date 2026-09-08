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
//     entire render rather than being clamped;
//   * a segment whose encode settings drift from the others', which the concat
//     demuxer cannot copy through and which therefore has to be built from one
//     shared list rather than spelled out twice.
import { describe, it, expect } from 'vitest';
import {
  buildJoinCommand,
  buildRenderPlan,
  buildSegmentCommand,
  buildSegmentList,
  resolveTarget,
  wrapCaption,
} from './reelStudio.js';

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
    const plan = buildRenderPlan({ clips: [{ id: 'long' }], sources: { long }, target: 'ig-story' });

    expect(plan.warnings.join(' ')).toMatch(/Instagram Story caps out at 60s/);
    expect(plan.clips).toHaveLength(1);
  });

  it('holds the same 70s reel to the longer Reels limit without complaint', () => {
    const long = { path: '/clips/long.mp4', duration: 70, hasAudio: true };
    const plan = buildRenderPlan({ clips: [{ id: 'long' }], sources: { long }, target: 'ig-reel' });

    expect(plan.warnings).toEqual([]);
    expect(plan.target).toBe('ig-reel');
  });

  it('never warns about length on the one target that has no limit', () => {
    // A YouTube video's real cap is twelve hours. A reel that ran into it has
    // a different problem than a warning under the export button.
    const long = { path: '/clips/long.mp4', duration: 600, hasAudio: true };
    const plan = buildRenderPlan({ clips: [{ id: 'long' }], sources: { long }, target: 'yt-video' });

    expect(plan.warnings).toEqual([]);
    expect(plan.maxSeconds).toBe(0);
  });

  it('puts the target’s canvas on the plan rather than leaving it to the encoder', () => {
    const vertical = buildRenderPlan({ clips: [{ id: 'a' }], sources, target: 'yt-short' });
    const landscape = buildRenderPlan({ clips: [{ id: 'a' }], sources, target: 'yt-video' });

    expect(vertical).toMatchObject({ width: 1080, height: 1920 });
    expect(landscape).toMatchObject({ width: 1920, height: 1080 });
  });

  it('still understands the two target ids that existed before there were four', () => {
    // A draft saved in a tab open since before the four targets says 'story',
    // and it means what it always meant.
    expect(buildRenderPlan({ clips: [{ id: 'a' }], sources, target: 'story' }).target).toBe('ig-story');
    expect(buildRenderPlan({ clips: [{ id: 'a' }], sources, target: 'reel' }).target).toBe('ig-reel');
    // And anything unrecognised lands on the tightest of the four, so a file
    // made from a mangled request is one every destination can still take.
    expect(resolveTarget('nonsense').id).toBe('ig-story');
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

describe('buildSegmentCommand', () => {
  const planOf = (overrides = {}) =>
    buildRenderPlan({ clips: [{ id: 'a', in: 1, out: 4 }, { id: 'b' }], sources, ...overrides });

  const graphsOf = (plan) => plan.clips.map((_, index) => buildSegmentCommand(plan, index));

  it('gives a silent clip its own anullsrc input and wires the segment to it', () => {
    // Clip b has no audio track. Every segment has to carry one anyway — the
    // concat demuxer joins streams by position, so a segment short of an
    // audio stream would put the next clip's sound against the wrong picture.
    const [withAudio, silent] = graphsOf(planOf());

    expect(withAudio.args.join(' ')).not.toContain('anullsrc');
    expect(withAudio.filterGraph).toContain('[0:a]atrim=start=1:end=4');

    expect(silent.args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(silent.filterGraph).toContain('[1:a]asetpts=PTS-STARTPTS');
  });

  it('gives every clip its own file, filter script and encode', () => {
    // The whole point of the split: one input per ffmpeg run, so the frames of
    // the clips that are not being written cannot pile up in a filtergraph.
    const commands = graphsOf(planOf());

    expect(commands.map((command) => command.outputName)).toEqual(['seg-0.mp4', 'seg-1.mp4']);
    expect(commands[0].args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(commands[0].args.join(' ')).toContain('-filter_complex_script filters-0.txt');
    expect(commands[1].args.join(' ')).toContain('-filter_complex_script filters-1.txt');
    expect(buildSegmentList(planOf())).toBe("file 'seg-0.mp4'\nfile 'seg-1.mp4'\n");
  });

  it('pads and re-times every clip onto the same 1080x1920 30fps grid', () => {
    for (const { filterGraph } of graphsOf(planOf())) {
      const [chain] = filterGraph.split('\n');
      expect(chain).toContain('fps=30');
      expect(chain).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
      expect(chain).toContain('pad=1080:1920');
      // A non-square SAR surviving the join skews everything after it.
      expect(chain).toContain('setsar=1');
    }
  });

  it('follows the target onto a landscape canvas', () => {
    const [{ filterGraph }] = graphsOf(planOf({ target: 'yt-video' }));

    expect(filterGraph).toContain('scale=1920:1080:force_original_aspect_ratio=decrease');
    expect(filterGraph).toContain('pad=1920:1080');
  });

  it('forces each audio leg to its clip’s exact length so the join cannot drift', () => {
    const [first, second] = graphsOf(planOf());
    expect(first.filterGraph).toContain('apad,atrim=0:3');
    expect(second.filterGraph).toContain('apad,atrim=0:4');
  });

  it('turns drawtext off for expansion so a % in a caption still renders', () => {
    // The regression this file exists for. Without expansion=none, drawtext
    // reads "100%" as a broken %{...} template, draws nothing, and exits 0.
    const plan = buildRenderPlan({
      clips: [{ id: 'a', text: 'Ready at 6:30 — 100% brisket' }],
      sources,
    });
    const { filterGraph, textFiles } = buildSegmentCommand(plan, 0);

    expect(filterGraph).toContain('expansion=none');
    // And the text itself never enters the graph — it goes to a file, so no
    // amount of punctuation in a caption can reach the filtergraph parser.
    expect(filterGraph).not.toContain('100%');
    expect(textFiles).toEqual([{ name: 'caption-0-0.txt', content: 'Ready at 6:30 — 100%\nbrisket' }]);
  });

  it('adds no drawtext at all to a clip with no caption', () => {
    for (const { filterGraph, textFiles } of graphsOf(planOf())) {
      expect(filterGraph).not.toContain('drawtext');
      expect(textFiles).toEqual([]);
    }
  });

  it('positions a caption by the position asked for', () => {
    const plan = buildRenderPlan({
      clips: [
        { id: 'a', text: 'top one', textPosition: 'top' },
        { id: 'b', text: 'bottom one', textPosition: 'nonsense' },
      ],
      sources,
    });
    const [top, bottom] = graphsOf(plan);

    expect(top.filterGraph).toContain('y=h*0.12');
    // An unknown position falls back to bottom rather than breaking the graph.
    expect(bottom.filterGraph).toContain('y=h-text_h-h*0.2');
  });

  it('lifts a caption off the bottom far enough to clear the app’s own buttons', () => {
    // A fifth of a Story is covered by Instagram's reply bar. A landscape
    // YouTube video has nothing down there, and holding it to the same margin
    // would throw away a fifth of the frame for no reason.
    const clips = [{ id: 'a', text: 'Pulled at 203', textPosition: 'bottom' }];
    const story = buildSegmentCommand(buildRenderPlan({ clips, sources, target: 'ig-story' }), 0);
    const video = buildSegmentCommand(buildRenderPlan({ clips, sources, target: 'yt-video' }), 0);

    expect(story.filterGraph).toContain('y=h-text_h-h*0.2');
    expect(video.filterGraph).toContain('y=h-text_h-h*0.08');
  });

  it('keeps a caption the same physical size on a landscape frame', () => {
    // Scaled by the frame's width a caption on a 1920-wide video would come
    // out near double the size it is on a Story; by its height, half. The
    // short edge is the one that keeps it the size it was drawn to be.
    const clips = [{ id: 'a', text: 'Pulled at 203' }];
    const story = buildSegmentCommand(buildRenderPlan({ clips, sources, target: 'ig-story' }), 0);
    const video = buildSegmentCommand(buildRenderPlan({ clips, sources, target: 'yt-video' }), 0);

    expect(story.filterGraph).toContain('fontsize=58');
    expect(video.filterGraph).toContain('fontsize=58');
  });

  it('gives each caption its own window, on the clock the clip actually counts in', () => {
    // Caption times arrive on the source file's ruler, the same one as in/out,
    // because that is the only ruler a caption stays glued to its frames on.
    // By the time drawtext sees the clip, trim and setpts have restarted its
    // clock at zero — so a caption written at 4s of a file trimmed from 1s is
    // on screen from 3s, and getting this shift wrong puts every caption in a
    // trimmed reel a few seconds late.
    const plan = buildRenderPlan({
      clips: [
        {
          id: 'a',
          in: 1,
          out: 9,
          captions: [
            { text: 'Rub goes on', position: 'top', start: 4, end: 6 },
            { text: 'Then it rests', position: 'bottom', start: 7, end: 8.5 },
          ],
        },
      ],
      sources,
    });
    const { filterGraph, textFiles } = buildSegmentCommand(plan, 0);

    expect(textFiles.map((file) => file.name)).toEqual(['caption-0-0.txt', 'caption-0-1.txt']);
    // Quoted, because the commas inside the expression would otherwise end the
    // filter — a comma is what separates one filter from the next.
    expect(filterGraph).toContain(":enable='between(t,3,5)'");
    expect(filterGraph).toContain(":enable='between(t,6,7.5)'");
    expect(filterGraph).toContain('y=h*0.12');
    expect(filterGraph).toContain('y=h-text_h-h*0.2');
  });

  it('clips a caption to the trim and drops one trimmed away entirely', () => {
    const plan = buildRenderPlan({
      clips: [
        {
          id: 'a',
          in: 2,
          out: 6,
          captions: [
            // Written before the head was trimmed off, and running past the
            // tail: what survives is the overlap, not the original window.
            { text: 'Straddles the in-point', start: 0, end: 8 },
            // Entirely in the part that was cut. The frames it was written for
            // are not in the reel, so neither is it.
            { text: 'Gone with the tail', start: 7, end: 9 },
          ],
        },
      ],
      sources,
    });

    expect(plan.clips[0].captions).toHaveLength(1);
    expect(plan.clips[0].captions[0]).toMatchObject({ start: 0, end: 4, wholeClip: true });
    // Covering the whole clip, so it needs no window at all.
    expect(buildSegmentCommand(plan, 0).filterGraph).not.toContain('enable=');
  });

  it('still understands a single caption sent the old way', () => {
    // An older tab that has not been reloaded posts `text` on the clip and
    // means "the whole clip", which is what it always meant.
    const plan = buildRenderPlan({ clips: [{ id: 'a', in: 1, out: 5, text: 'One line' }], sources });
    expect(plan.clips[0].captions).toMatchObject([{ start: 0, end: 4, position: 'bottom' }]);
  });

  it('zooms by fitting into a bigger frame and cropping the real one back out', () => {
    // The same two steps as the no-zoom path with a larger box and a crop on
    // the end, which is what lets the browser preview mirror it with one CSS
    // transform: contain into the box, then scale and clip.
    const plan = buildRenderPlan({ clips: [{ id: 'a', zoom: 1.5 }, { id: 'b' }], sources });
    const [zoomed, plain] = graphsOf(plan).map((command) => command.filterGraph.split('\n')[0]);

    expect(zoomed).toContain('scale=1620:2880:force_original_aspect_ratio=decrease');
    expect(zoomed).toContain('pad=1620:2880');
    expect(zoomed).toContain('crop=1080:1920');
    // A clip nobody zoomed comes out exactly as it did before zoom existed —
    // no crop filter at all, so there is nothing to round off.
    expect(plain).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(plain).not.toContain('crop=');
  });

  it('rounds the zoom box to even pixels and refuses a zoom out', () => {
    // libx264 with yuv420p rejects odd dimensions outright, and 1080 x 1.31 is
    // 1414.8. Below a zoom of 1 there is nothing to zoom into, only more black.
    const plan = buildRenderPlan({ clips: [{ id: 'a', zoom: 1.31 }, { id: 'b', zoom: 0.4 }], sources });

    expect(buildSegmentCommand(plan, 0).filterGraph).toContain('scale=1414:2516:force_original_aspect_ratio=decrease');
    expect(plan.clips[1].zoom).toBe(1);
  });

  it('applies the colour grade after the crop and before the captions', () => {
    // Order is the whole correctness question for the grade. Before the crop
    // it would grade pixels that get thrown away and land the vignette's dark
    // corners inside the frame; after drawtext it would pull the caption's
    // white down with the rest of the picture.
    const plan = buildRenderPlan({
      clips: [{ id: 'a', zoom: 1.5, text: 'PORK.' }],
      sources,
      look: 'cinematic',
    });
    const graph = buildSegmentCommand(plan, 0).filterGraph;

    expect(graph).toContain('vignette=PI/5');
    expect(graph.indexOf('crop=1080:1920')).toBeLessThan(graph.indexOf('vignette=PI/5'));
    expect(graph.indexOf('vignette=PI/5')).toBeLessThan(graph.indexOf('drawtext'));
  });

  it('leaves the filtergraph untouched when no look is picked', () => {
    // A reel nobody graded has to come out byte-identical to what it was
    // before the grade existed, which is what makes the default safe.
    const graded = buildRenderPlan({ clips: [{ id: 'a' }], sources, look: 'none' });
    const silent = buildRenderPlan({ clips: [{ id: 'a' }], sources });

    expect(buildSegmentCommand(graded, 0).filterGraph).toBe(buildSegmentCommand(silent, 0).filterGraph);
    expect(buildSegmentCommand(graded, 0).filterGraph).not.toContain('eq=');
  });

  it('falls back to no grade when the look is one the renderer has never heard of', () => {
    const plan = buildRenderPlan({ clips: [{ id: 'a' }], sources, look: 'teal-and-orange-please' });

    expect(plan.look).toBe('none');
    expect(plan.lookFilters).toBe(null);
  });

  it('encodes every segment identically, which is what lets the join copy them', () => {
    // A segment whose settings drift from the others' cannot be copied through
    // by the concat demuxer — it comes out as a corrupt stretch of video
    // rather than as an error, so the two commands share one list.
    const [first, second] = graphsOf(planOf()).map((command) => command.args.join(' '));

    for (const joined of [first, second]) {
      expect(joined).toContain('-c:v libx264');
      expect(joined).toContain('-pix_fmt yuv420p');
      expect(joined).toContain('-r 30');
      expect(joined).toContain('-c:a aac');
    }
  });
});

describe('buildJoinCommand', () => {
  const planOf = (overrides = {}) =>
    buildRenderPlan({ clips: [{ id: 'a', in: 1, out: 4 }, { id: 'b' }], sources, ...overrides });

  it('reads the segments through the concat demuxer and copies the video', () => {
    // This is the half of the fix that matters: the demuxer opens one segment
    // at a time, so nothing about peak memory depends on how long the reel is,
    // and the video the segments already encoded is not encoded again.
    const { args, filterGraph } = buildJoinCommand(planOf(), { outputPath: 'out.mp4' });
    const joined = args.join(' ');

    expect(joined).toContain('-f concat -safe 0 -i segments.txt');
    expect(joined).toContain('-c:v copy');
    // Audio is re-encoded even with no music at all: copying AAC across a join
    // carries each segment's encoder priming with it and clicks at every cut.
    expect(joined).toContain('-map 0:a');
    expect(joined).toContain('-c:a aac');
    expect(filterGraph).toBe('');
    // Without faststart the moov atom lands at the end and Instagram's
    // streaming fetcher reports the video as unprocessable.
    expect(joined).toContain('-movflags +faststart');
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  it('loops a music track shorter than the reel and cuts it to the exact length', () => {
    const { args, filterGraph } = buildJoinCommand(planOf({ music: { path: '/clips/track.m4a', mode: 'replace' } }));

    // -stream_loop -1 must sit immediately before the music input, not before
    // the segment list: it applies to the input that follows it.
    const loopIndex = args.indexOf('-stream_loop');
    expect(args[loopIndex + 1]).toBe('-1');
    expect(args[loopIndex + 2]).toBe('-i');
    expect(args[loopIndex + 3]).toBe('/clips/track.m4a');

    expect(filterGraph).toContain('afade=t=out:st=5.5:d=1.5');
    expect(filterGraph).not.toContain('amix');
    expect(args.join(' ')).toContain('-map [amusic]');
  });

  it('never maps the segments’ own audio when music replaces it', () => {
    // The regression the old single-graph version had here was worse: the
    // clip-audio legs were built anyway, concat's audio pad was left connected
    // to nothing, and ffmpeg rejected the whole graph — so every export with
    // "Replace it entirely" selected failed, whatever was on the timeline.
    // Segments always carry audio now, so replacing is simply not mapping it.
    const { args } = buildJoinCommand(planOf({ music: { path: '/clips/track.m4a', mode: 'replace' } }));
    const joined = args.join(' ');

    expect(joined).toContain('-map [amusic]');
    expect(joined).not.toContain('-map 0:a');
  });

  it('mixes without letting amix halve both tracks', () => {
    const plan = planOf({ music: { path: '/clips/track.m4a', mode: 'mix', volume: 0.8, originalVolume: 0.3 } });
    const { args, filterGraph } = buildJoinCommand(plan);

    expect(filterGraph).toContain('[0:a]volume=0.3[aorig]');
    expect(filterGraph).toContain('volume=0.8');
    // normalize=0 is what stops a "mix" sounding quieter than either track on
    // its own.
    expect(filterGraph).toContain('normalize=0');
    expect(args.join(' ')).toContain('-map [aout]');
  });
});
