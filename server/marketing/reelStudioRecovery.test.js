// Getting a finished export back after the process that made it is gone.
//
// Separate from reelStudio.test.js because that file is deliberately pure —
// plans and filtergraphs, no disk — and this one is only about the disk. It
// writes real mp4s into the renders folder and runs the real ffprobe, because
// the single thing worth pinning here is a judgement about a file: whether
// the mp4 sitting at that path is a whole video or the first few kilobytes of
// one that was being written when the server went down.
//
// Why any of this exists: `npm run start-server` runs under `node --watch`,
// the render job table is in memory, and so saving any server file during an
// export wiped the record of it. The screen's next poll got a 404, called the
// export failed, and a finished reel sat on disk with nothing pointing at it.
// The output name carries the render's own id, so it can be found again.
//
// The case that makes this non-trivial is the second test. A restart that
// lands in the middle of the join leaves a file at exactly the same path,
// with a plausible name and a non-zero size, and handing that to the Share
// step would publish half a video.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { FFMPEG_PATH, RENDERS_DIR, ensureMediaDirs, recoverRenderJob } from './reelStudio.js';

const execFileAsync = promisify(execFile);

// Only the files these tests wrote are swept afterwards. The folder is a real
// working directory with real exports in it.
const written = [];

const renderName = (renderId) => `reel-${Date.now()}-${renderId.slice(0, 8)}.mp4`;

const put = (name, bytes) => {
  const target = path.join(RENDERS_DIR, name);
  fs.writeFileSync(target, bytes);
  written.push(target);
  return target;
};

let wholeVideo;

beforeAll(async () => {
  ensureMediaDirs();
  const scratch = path.join(os.tmpdir(), `srbbq-recover-${Date.now()}.mp4`);
  await execFileAsync(FFMPEG_PATH, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=30:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    scratch,
  ]);
  wholeVideo = fs.readFileSync(scratch);
  fs.rmSync(scratch, { force: true });
}, 60_000);

afterAll(() => {
  for (const file of written) fs.rmSync(file, { force: true });
});

describe('recoverRenderJob', () => {
  it('finds a finished render by the id baked into its file name', async () => {
    const renderId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const name = renderName(renderId);
    put(name, wholeVideo);

    const job = await recoverRenderJob(renderId);

    expect(job).not.toBeNull();
    expect(job.status).toBe('ready');
    expect(job.fileName).toBe(name);
    expect(job.percent).toBe(100);
    expect(job.totalDuration).toBeGreaterThan(0);
    expect(job.width).toBe(320);
    expect(job.height).toBe(568);
    expect(job.sizeBytes).toBe(wholeVideo.length);
    // Three of the four targets are 1080x1920, so the file cannot say which
    // one it was made for. Saying nothing is the honest answer — the screen
    // falls back to the target it still has selected.
    expect(job.target).toBeNull();
  });

  it('refuses a render that was still being written when the server went down', async () => {
    // A truncated mp4 has no moov atom, so ffprobe will not have it — which
    // is the only reliable way to tell it apart from a finished one by
    // looking at the file. Size and name are both plausible.
    const renderId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    put(renderName(renderId), wholeVideo.subarray(0, 2048));

    await expect(recoverRenderJob(renderId)).resolves.toBeNull();
  });

  it('has nothing to say about a render whose file is not there', async () => {
    await expect(recoverRenderJob('cccccccc-3333-4333-8333-cccccccccccc')).resolves.toBeNull();
  });

  it('does not match a render id against another render’s file', async () => {
    // The match is on the id suffix, not just the reel- prefix: a folder
    // holding a week of exports must not hand back whichever one is first.
    put(renderName('dddddddd-4444-4444-8444-dddddddddddd'), wholeVideo);

    await expect(recoverRenderJob('eeeeeeee-5555-4555-8555-eeeeeeeeeeee')).resolves.toBeNull();
  });
});
