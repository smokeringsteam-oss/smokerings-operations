// The automatic build, from a Drive folder to a render.
//
// What is worth pinning here is not that a POST goes out. It is the handful of
// things that would be wrong in a way nobody would notice by looking at the
// screen:
//
//   * the order clips are picked in is the order they are sent, because that
//     is the order they play and it is the one editorial decision left to a
//     person. A Set would lose it and everything would still look fine;
//   * a song is optional and mutually exclusive with itself — clicking the
//     selected one clears it rather than leaving the reel stuck with music it
//     was told to drop;
//   * the screen stops polling the build the moment it names a render and
//     starts polling the render instead. Getting this wrong leaves two timers
//     running against a finished build forever;
//   * the caption the model wrote reaches the share box, which is the only
//     part of the model's output a person edits rather than re-runs.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import InstaReelGenerator from './InstaReelGenerator';

const videoFile = (id: string, name: string, duration = 20) => ({
  id,
  name,
  kind: 'video' as const,
  mimeType: 'video/mp4',
  sizeBytes: 40 * 1024 * 1024,
  createdAt: '2026-09-05T10:00:00.000Z',
  modifiedAt: '2026-09-05T10:00:00.000Z',
  webViewLink: '',
  thumbnail: '',
  width: 1080,
  height: 1920,
  duration,
});

const audioFile = (id: string, name: string) => ({
  ...videoFile(id, name, 0),
  kind: 'audio' as const,
  mimeType: 'audio/mpeg',
  sizeBytes: 4 * 1024 * 1024,
});

const LIBRARY = {
  clips: [videoFile('drv-a', 'trimming.mp4'), videoFile('drv-b', 'on-the-smoker.mp4'), videoFile('drv-c', 'slice.mp4')],
  songs: [audioFile('drv-song', 'slow-blues.mp3')],
};

// The server's own table, as the status route sends it. The screen builds its
// pickers from this rather than repeating any of it.
const TARGETS = [
  { id: 'ig-story', label: 'Instagram Story', short: 'Story', width: 1080, height: 1920, maxSeconds: 60, caption: false, hint: '' },
  { id: 'ig-reel', label: 'Instagram Reel', short: 'Reel', width: 1080, height: 1920, maxSeconds: 90, caption: true, hint: '' },
];

let calls: { url: string; method: string; body?: any }[] = [];
let buildAnswer: (n: number) => unknown;
let buildPolls = 0;
let renderPolls = 0;

const BUILD_RUNNING = {
  buildId: 'bld-1',
  status: 'building',
  stage: 'watching',
  stageLabel: 'Watching the footage',
  stageIndex: 1,
  stageCount: 5,
  detail: '1 of 2 read',
  notes: [],
  picks: [],
  captions: [],
  postCaption: '',
  totalSeconds: 0,
  renderId: null,
  error: null,
};

const BUILD_HANDED_OVER = {
  ...BUILD_RUNNING,
  status: 'rendering',
  stage: 'rendering',
  stageLabel: 'Rendering',
  stageIndex: 4,
  detail: null,
  picks: [
    { clipId: 'clip-1.mp4', name: 'trimming.mp4', in: 1.2, out: 3.4, seconds: 2.2 },
    { clipId: 'clip-2.mp4', name: 'slice.mp4', in: 0.5, out: 2.5, seconds: 2 },
  ],
  captions: ['Bark like that takes hours', ''],
  postCaption: 'Twelve hours on the smoker. #bbq #brisket #smokerings',
  totalSeconds: 4.2,
  renderId: 'r1',
};

beforeEach(() => {
  calls = [];
  buildPolls = 0;
  renderPolls = 0;
  buildAnswer = () => BUILD_HANDED_OVER;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined });

      if (url.startsWith('/api/marketing/reel/status')) {
        return {
          ok: true,
          json: async () => ({
            toolchain: { ffmpegAvailable: true, fontFile: 'arial.ttf', width: 1080, height: 1920, fps: 30, targets: TARGETS, looks: [{ id: 'none', label: 'No grade', hint: '' }], storyMaxSeconds: 60, reelMaxSeconds: 90 },
            instagram: { hasToken: true, hasUserId: true, publicBaseUrl: 'https://x.test', publicBaseProblem: null, graphVersion: 'v21.0', configured: true },
            youtube: { configured: true, hasClient: true, signedIn: true, error: '', privacyStatuses: ['public'] },
            drive: { configured: true, folderId: 'fld', account: 'the signed-in Google account', error: '' },
          }),
        };
      }
      if (url.startsWith('/api/marketing/reel/drive/library')) {
        return { ok: true, json: async () => LIBRARY };
      }
      if (url === '/api/marketing/reel/auto') {
        return { ok: true, json: async () => BUILD_RUNNING };
      }
      if (url.startsWith('/api/marketing/reel/auto/')) {
        buildPolls += 1;
        return { ok: true, json: async () => buildAnswer(buildPolls) };
      }
      if (url.startsWith('/api/marketing/reel/render/')) {
        renderPolls += 1;
        return {
          ok: true,
          json: async () => ({ renderId: 'r1', status: 'rendering', percent: 40, warnings: [], totalDuration: 4.2, sizeBytes: 0, url: null, fileName: null }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});

const tile = (name: string) => screen.getByTitle(name);

test('sends the picked clips in the order they were picked, not folder order', async () => {
  render(<InstaReelGenerator />);
  await screen.findByTitle('slice.mp4');

  // Deliberately out of the order the folder listed them in.
  fireEvent.click(tile('slice.mp4'));
  fireEvent.click(tile('trimming.mp4'));

  fireEvent.click(screen.getByRole('button', { name: /Make the reel from 2 clips/ }));

  await waitFor(() => expect(calls.some((call) => call.url === '/api/marketing/reel/auto')).toBe(true));
  const post = calls.find((call) => call.url === '/api/marketing/reel/auto');
  expect(post?.body.clipFileIds).toEqual(['drv-c', 'drv-a']);
});

test('clicking the chosen song again clears it rather than leaving it selected', async () => {
  render(<InstaReelGenerator />);
  await screen.findByTitle('trimming.mp4');
  fireEvent.click(tile('trimming.mp4'));

  const song = screen.getByRole('button', { name: /slow-blues\.mp3/ });
  fireEvent.click(song);
  // The mix/replace choice only exists once a song is chosen, so it is the
  // honest signal that one is.
  expect(screen.getByText(/keeps the sizzle/)).toBeInTheDocument();

  fireEvent.click(song);
  expect(screen.queryByText(/keeps the sizzle/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Make the reel/ }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/marketing/reel/auto')).toBe(true));
  expect(calls.find((call) => call.url === '/api/marketing/reel/auto')?.body.songFileId).toBe('');
});

test('stops polling the build once it hands over a render, and starts polling the render', async () => {
  // Real timers on purpose. The thing under test is an effect teardown that
  // fires on a state change driven by a resolved fetch, and driving that with
  // fake timers means hand-pumping React's scheduler and the microtask queue
  // in the right order — a test that would pass or fail for reasons unrelated
  // to the teardown. Two seconds of real waiting buys a result worth reading.
  render(<InstaReelGenerator />);
  await screen.findByTitle('trimming.mp4');
  fireEvent.click(tile('trimming.mp4'));
  fireEvent.click(screen.getByRole('button', { name: /Make the reel/ }));

  // The handover has happened once the chosen shots are on screen.
  await screen.findByText(/Bark like that takes hours/, undefined, { timeout: 4000 });
  const buildPollsAtHandover = buildPolls;
  const renderPollsAtHandover = renderPolls;
  expect(buildPollsAtHandover).toBeGreaterThan(0);

  // The build timer must be gone, not merely quiet: more time buys more
  // render polls and no more build polls.
  await waitFor(() => expect(renderPolls).toBeGreaterThan(renderPollsAtHandover), { timeout: 4000 });
  expect(buildPolls).toBe(buildPollsAtHandover);
}, 15000);

test('shows the cut it chose, captions and all, while the encode is still running', async () => {
  render(<InstaReelGenerator />);
  await screen.findByTitle('trimming.mp4');
  fireEvent.click(tile('trimming.mp4'));
  fireEvent.click(screen.getByRole('button', { name: /Make the reel/ }));

  // The caption the model wrote for a shot, and the shot it left clean.
  expect(await screen.findByText(/Bark like that takes hours/, undefined, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.getByText('no caption')).toBeInTheDocument();
});

test('does not offer to build with nothing picked', async () => {
  render(<InstaReelGenerator />);
  await screen.findByTitle('trimming.mp4');
  expect(screen.getByRole('button', { name: /Pick some footage first/ })).toBeDisabled();
});

test('says so when the folder has no video in it rather than showing an empty grid', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/marketing/reel/status')) {
        return {
          ok: true,
          json: async () => ({
            toolchain: { ffmpegAvailable: true, fontFile: null, width: 1080, height: 1920, fps: 30, targets: TARGETS, looks: [], storyMaxSeconds: 60, reelMaxSeconds: 90 },
            instagram: { hasToken: false, hasUserId: false, publicBaseUrl: null, publicBaseProblem: null, graphVersion: 'v21.0', configured: false },
            youtube: { configured: false, hasClient: false, signedIn: false, error: '', privacyStatuses: [] },
            drive: { configured: true, folderId: 'fld', account: '', error: '' },
          }),
        };
      }
      return { ok: true, json: async () => ({ clips: [], songs: [] }) };
    }),
  );

  render(<InstaReelGenerator />);
  expect(await screen.findByText(/Drop the clips from the cook into it/)).toBeInTheDocument();
});
