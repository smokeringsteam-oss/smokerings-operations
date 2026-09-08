// The Share step's gate: which of the five destinations a given render is
// actually allowed to go to.
//
// The tiles themselves are not interesting. What is worth pinning is the rule
// underneath them, because getting it wrong publishes something rather than
// failing: a reel exported as a landscape YouTube video is 1920x1080, and
// Instagram will happily accept that file for a Story — it just pillarboxes it
// into a thin letterbox floating in a black phone screen. Nobody meant to post
// that, and nothing about the upload reports it as a problem.
//
// So the shape of the file on disk is a reason a tile is off, in the same
// place as "too long" and "not connected", and it says which way round it is
// wrong so the fix ("re-export it") is on screen rather than inferred.
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ShareStep, { type ReelDestinationStatus } from './ShareStep';
import type { ReelTarget } from './reelSettings';

const everythingConnected: ReelDestinationStatus = {
  instagram: { configured: true },
  youtube: { configured: true, hasClient: true, signedIn: true, error: '', privacyStatuses: ['public'] },
  drive: { configured: true, folderId: 'f', account: 'the signed-in Google account', error: '' },
  toolchain: {
    storyMaxSeconds: 60,
    reelMaxSeconds: 90,
    targets: [
      { id: 'ig-story', label: 'Instagram Story', maxSeconds: 60, width: 1080, height: 1920 },
      { id: 'ig-reel', label: 'Instagram Reel', maxSeconds: 90, width: 1080, height: 1920 },
      { id: 'yt-short', label: 'YouTube Short', maxSeconds: 180, width: 1080, height: 1920 },
      { id: 'yt-video', label: 'YouTube Video', maxSeconds: 0, width: 1920, height: 1080 },
    ],
  },
};

const show = (over: { target?: ReelTarget; seconds?: number; status?: ReelDestinationStatus | null } = {}) =>
  render(
    <ShareStep
      fileName="reel-1.mp4"
      durationSeconds={over.seconds ?? 20}
      renderedTarget={over.target ?? 'ig-story'}
      status={over.status === undefined ? everythingConnected : over.status}
      igUsername="smokerings"
      onCheckAccount={vi.fn()}
      onCheckDriveFolder={vi.fn()}
    />,
  );

const tile = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

test('offers the four targets plus Drive, and no others', () => {
  show();
  for (const label of ['Instagram Story', 'Instagram Reel', 'YouTube Short', 'YouTube Video', 'Google Drive']) {
    expect(tile(label)).toBeInTheDocument();
  }
});

test('an upright render can go anywhere except the landscape one', () => {
  show({ target: 'ig-reel' });

  expect(tile('Instagram Story')).toBeEnabled();
  expect(tile('Instagram Reel')).toBeEnabled();
  expect(tile('YouTube Short')).toBeEnabled();
  expect(tile('Google Drive')).toBeEnabled();

  // The one that wants 16:9. Off, and saying why rather than just looking dead.
  expect(tile('YouTube Video')).toBeDisabled();
  expect(screen.getByText(/exported upright/i)).toBeInTheDocument();
});

test('a landscape render is refused by the three vertical destinations', () => {
  // The failure this guards: Instagram takes a 16:9 file for a Story without
  // complaint and pillarboxes it. The upload succeeds; the post is unusable.
  show({ target: 'yt-video' });

  expect(tile('YouTube Video')).toBeEnabled();
  expect(tile('Google Drive')).toBeEnabled();
  for (const label of ['Instagram Story', 'Instagram Reel', 'YouTube Short']) {
    expect(tile(label)).toBeDisabled();
  }
  expect(screen.getAllByText(/exported landscape/i).length).toBeGreaterThan(0);
});

test('a reel past a destination’s cap names the cap rather than the file', () => {
  // 74s clears a Reel and a Short and does not clear a Story, and the tile has
  // to say which number it failed against — "too long" on its own leaves the
  // person guessing at where to trim to.
  show({ target: 'ig-story', seconds: 74 });

  expect(tile('Instagram Story')).toBeDisabled();
  expect(screen.getByText(/74s and the cap is 60s/)).toBeInTheDocument();
  expect(tile('Instagram Reel')).toBeEnabled();
});

test('the one destination with no cap takes a reel of any length', () => {
  // maxSeconds of 0 means no limit, and a comparison that read it as a real
  // number would refuse every video for being longer than nothing.
  show({ target: 'yt-video', seconds: 900 });
  expect(tile('YouTube Video')).toBeEnabled();
});

test('a destination that is not connected says so instead of blaming the file', () => {
  show({
    target: 'ig-story',
    status: { ...everythingConnected, instagram: { configured: false } },
  });

  expect(tile('Instagram Story')).toBeDisabled();
  expect(screen.getAllByText(/Instagram is not connected/).length).toBeGreaterThan(0);
  // Not connected is the first thing wrong with it, so it is the thing said.
  expect(screen.queryByText(/exported landscape/i)).not.toBeInTheDocument();
});

test('Drive takes the file whichever shape it came out', () => {
  // The point of the fifth tile: it is the archive, and it has no opinion.
  for (const target of ['ig-story', 'yt-video'] as ReelTarget[]) {
    const view = show({ target });
    expect(tile('Google Drive')).toBeEnabled();
    view.unmount();
  }
});
