// The source library, and the folder pin that is the whole of its security.
//
// This is the part of the reel feature that got a wider Google scope. Reading
// footage somebody dropped into a Drive folder by hand is impossible under
// drive.file — that scope only sees files the app itself created — so the app
// now asks for drive.readonly as well, which can read the entire account.
//
// Google sells no folder-scoped Drive scope, so "only that one folder" is not
// something the token enforces. It is something this code enforces, and that
// makes it exactly the kind of claim that has to be tested rather than
// commented. Two things hold it up and both are here:
//
//   * every listing query names the configured folder as a parent;
//   * every import re-checks, server-side, that the id it was handed is
//     actually in that folder — because without it the pin protects the
//     listing and nothing else, and any id in the account would be fetched on
//     request.
//
// Nothing here talks to Google.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./googleOAuth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  googleAccessToken: async () => 'test-token',
}));

const { listDriveLibrary, importDriveSource } = await import('./googleDrive.js');

const FOLDER = 'folder-abc123';

// A Drive id has to be at least ten of [A-Za-z0-9_-] to get past the format
// check, so these are shaped like the real thing.
const IN_FOLDER = 'file-in-folder-1';
const ELSEWHERE = 'file-elsewhere-9';

let requests = [];
let saved;

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

beforeEach(() => {
  requests = [];
  saved = {
    folder: process.env.GOOGLE_DRIVE_FOLDER_ID,
    id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
  };
  process.env.GOOGLE_DRIVE_FOLDER_ID = FOLDER;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'refresh';
});

afterEach(() => {
  for (const [key, value] of [
    ['GOOGLE_DRIVE_FOLDER_ID', saved.folder],
    ['GOOGLE_OAUTH_CLIENT_ID', saved.id],
    ['GOOGLE_OAUTH_CLIENT_SECRET', saved.secret],
    ['GOOGLE_DRIVE_REFRESH_TOKEN', saved.token],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

const stubFetch = (handler) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const href = String(url);
      requests.push(href);
      return handler(href);
    }),
  );
};

describe('listDriveLibrary', () => {
  beforeEach(() => {
    stubFetch(() =>
      jsonResponse({
        files: [
          {
            id: 'v1',
            name: 'on-the-smoker.mp4',
            mimeType: 'video/mp4',
            size: '41000000',
            createdTime: '2026-09-05T10:00:00.000Z',
            videoMediaMetadata: { width: 1080, height: 1920, durationMillis: '18400' },
          },
          { id: 'a1', name: 'slow-blues.mp3', mimeType: 'audio/mpeg', size: '4100000' },
          // In the bin, and still listable by the API. This is why the query
          // says trashed = false.
          { id: 'v2', name: 'deleted.mp4', mimeType: 'video/mp4', size: '10' },
        ],
      }),
    );
  });

  it('names the configured folder as a parent, and excludes the bin', async () => {
    await listDriveLibrary();
    const query = decodeURIComponent(new URL(requests[0]).searchParams.get('q'));
    expect(query).toContain(`'${FOLDER}' in parents`);
    expect(query).toContain('trashed = false');
  });

  it('splits the folder into footage and music by mime type', async () => {
    const library = await listDriveLibrary();
    expect(library.clips.map((file) => file.name)).toEqual(['on-the-smoker.mp4', 'deleted.mp4']);
    expect(library.songs.map((file) => file.name)).toEqual(['slow-blues.mp3']);
  });

  it('keeps finished reels this app uploaded out of the source footage', async () => {
    // The folder holds both directions of the feature. Under the old
    // drive.file-only scope the two could never meet; drive.readonly means the
    // clip picker would otherwise offer last week's finished reel as source
    // footage for this week's.
    stubFetch(() =>
      jsonResponse({
        files: [
          { id: 'v1', name: 'on-the-smoker.mp4', mimeType: 'video/mp4', size: '41000000' },
          {
            id: 'm1',
            name: 'friday-brisket-reel.mp4',
            mimeType: 'video/mp4',
            size: '18000000',
            appProperties: { smokerings: 'reel-master' },
          },
        ],
      }),
    );

    const library = await listDriveLibrary();
    expect(library.clips.map((file) => file.name)).toEqual(['on-the-smoker.mp4']);
  });

  it('converts Drive milliseconds into the seconds every screen counts in', async () => {
    const library = await listDriveLibrary();
    expect(library.clips[0].duration).toBe(18.4);
  });

  it('says which sign-in to redo when the token predates drive.readonly', async () => {
    // The failure mode worth a message: a refresh token minted for drive.file
    // alone gets a 403 here, and "insufficient permissions" on its own sends
    // someone to check the folder's sharing settings, which are fine.
    stubFetch(() =>
      jsonResponse({ error: { message: 'Request had insufficient authentication scopes.' } }, false, 403),
    );
    await expect(listDriveLibrary()).rejects.toThrow(/drive:login/);
  });
});

describe('importDriveSource', () => {
  it('refuses a file that is not in the configured folder', async () => {
    // The whole point. drive.readonly would serve this file quite happily.
    stubFetch(() =>
      jsonResponse({
        id: ELSEWHERE,
        name: 'tax-return.mp4',
        mimeType: 'video/mp4',
        size: '100',
        parents: ['some-other-folder'],
      }),
    );

    await expect(importDriveSource(ELSEWHERE)).rejects.toThrow(/cannot see that file/);
    // And nothing was downloaded: only the metadata call went out.
    expect(requests.filter((href) => href.includes('alt=media'))).toHaveLength(0);
  });

  it('refuses it in the same words as a file that does not exist', async () => {
    // Distinguishing the two would turn this into an oracle for what is in
    // the rest of the account.
    stubFetch((href) =>
      href.includes(ELSEWHERE)
        ? jsonResponse({ id: ELSEWHERE, name: 'x.mp4', mimeType: 'video/mp4', parents: ['elsewhere'] })
        : jsonResponse({ error: { message: 'File not found.' } }, false, 404),
    );

    const outside = await importDriveSource(ELSEWHERE).catch((err) => err);
    const missing = await importDriveSource('file-missing-777').catch((err) => err);
    expect(outside.message).toBe(missing.message);
    expect(outside.status).toBe(missing.status);
  });

  it('refuses a song asked for as a clip, and the reverse', async () => {
    stubFetch(() =>
      jsonResponse({
        id: IN_FOLDER,
        name: 'slow-blues.mp3',
        mimeType: 'audio/mpeg',
        size: '4100000',
        parents: [FOLDER],
      }),
    );
    await expect(importDriveSource(IN_FOLDER, { kind: 'video' })).rejects.toThrow(/audio file, not a clip/);
  });

  it('refuses an id that is not shaped like a Drive id without asking Google', async () => {
    stubFetch(() => jsonResponse({}));
    await expect(importDriveSource('../../../etc/passwd')).rejects.toThrow(/not a Drive file id/);
    expect(requests).toHaveLength(0);
  });

  it('refuses a clip over the size limit before downloading any of it', async () => {
    stubFetch(() =>
      jsonResponse({
        id: IN_FOLDER,
        name: 'the-whole-cook.mp4',
        mimeType: 'video/mp4',
        // Comfortably past MAX_CLIP_BYTES.
        size: String(900 * 1024 * 1024),
        parents: [FOLDER],
      }),
    );
    await expect(importDriveSource(IN_FOLDER, { kind: 'video' })).rejects.toThrow(/over the .*MB limit/);
    expect(requests.filter((href) => href.includes('alt=media'))).toHaveLength(0);
  });
});
