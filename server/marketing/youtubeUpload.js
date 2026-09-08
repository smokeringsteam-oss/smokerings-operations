// Publishing a finished reel to YouTube — as a Short or as an ordinary
// video, which from this end is the same upload.
//
// Unlike Instagram, YouTube takes the bytes: this is a real upload from this
// machine, so nothing here depends on PUBLIC_BASE_URL or on a tunnel being
// open. That makes it the destination most likely to work on a laptop.
//
// Three things about the YouTube Data API decide the shape of this file, and
// two of them will surprise anyone who has only used the Instagram side.
//
//   * A video becomes a Short by being vertical and under three minutes —
//     there is no "shorts" flag to set, and asking for one is a common way to
//     waste an afternoon. That is why this file does not distinguish the two
//     YouTube destinations at all: the reel studio already renders the file
//     to the shape and length its target asked for, and by the time it
//     reaches here the difference is in the bytes, not in the request.
//     Putting #Shorts in the description is the only nudge that exists, and
//     it is a hint to the recommender, not a switch.
//
//   * Upload quota is the real limit. videos.insert costs 1600 units against
//     a default daily quota of 10,000, so roughly six uploads a day, total,
//     across everything using this Cloud project. Exceeding it fails until
//     midnight Pacific. quotaExceeded is translated below rather than passed
//     on, because Google's message does not mention that number.
//
//   * An API project that has not passed YouTube's compliance audit is
//     capped: every video it uploads is forced to PRIVATE, whatever
//     privacyStatus asks for, and cannot be made public through the API
//     either. The upload succeeds, the video is real, and it sits private in
//     YouTube Studio until it is published by hand. That is not an error and
//     is not reported as one — so this module reads the privacy status back
//     off the response and says which one actually stuck, rather than
//     echoing what was asked for and letting the screen claim a video is
//     live when nobody can see it.
import fs from 'fs';
import path from 'path';
import { googleAccessToken, describeOAuthConfig } from '../integrations/googleOAuth.js';
import { RENDERS_DIR, YOUTUBE_SHORT_MAX_SECONDS } from './reelStudio.js';

const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';

// What the API will accept. 'private' is also what an unaudited project
// silently forces, which is why the screen shows the value that came back
// rather than the one that was sent.
export const PRIVACY_STATUSES = ['public', 'unlisted', 'private'];

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;

export function describeYouTubeConfig() {
  const oauth = describeOAuthConfig('youtube');
  return {
    configured: oauth.configured,
    hasClient: oauth.hasClient,
    signedIn: oauth.signedIn,
    error: oauth.error,
    shortMaxSeconds: YOUTUBE_SHORT_MAX_SECONDS,
    privacyStatuses: PRIVACY_STATUSES,
  };
}

export function translateUploadError(status, json) {
  const detail = json.error?.message || `HTTP ${status}`;
  const reason = json.error?.errors?.[0]?.reason || '';

  if (reason === 'quotaExceeded' || /quota/i.test(detail)) {
    return `YouTube's daily upload quota is used up. An upload costs 1600 of the 10,000 units a Cloud project gets per day — about six videos — and it resets at midnight US Pacific. (Google's wording: "${detail}")`;
  }
  if (reason === 'youtubeSignupRequired') {
    return 'That Google account has no YouTube channel. Create one on the account you signed in with, then upload again.';
  }
  if (reason === 'forbidden' || status === 403) {
    return `YouTube refused the upload: ${detail}. If this account has never uploaded before, YouTube requires a verified phone number on the channel first.`;
  }
  if (status === 401) {
    return `YouTube rejected the sign-in: ${detail}. Re-run \`npm run youtube:login\`.`;
  }
  return `YouTube refused the upload: ${detail}`;
}

// A resumable upload: open a session, then send the bytes to the URL it hands
// back. The alternative — one multipart request — has no way to report
// progress and no way to resume, and YouTube's own docs push everything
// larger than a few MB down this path.
export async function uploadVideo({
  fileName,
  title,
  description = '',
  privacyStatus = 'public',
  tags = [],
  onStage,
} = {}) {
  const stage = (step, detail) => {
    if (typeof onStage === 'function') onStage(step, detail);
  };

  if (!fileName || /[\\/]/.test(fileName)) {
    const err = new Error('A rendered file name is required.');
    err.status = 400;
    throw err;
  }
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    const err = new Error('YouTube needs a title — it is the one field it will not invent.');
    err.status = 400;
    throw err;
  }
  if (!PRIVACY_STATUSES.includes(privacyStatus)) {
    const err = new Error(`privacyStatus must be one of: ${PRIVACY_STATUSES.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const filePath = path.join(RENDERS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    const err = new Error(`There is no rendered file called ${fileName} any more — re-export and try again.`);
    err.status = 404;
    throw err;
  }

  const body = fs.readFileSync(filePath);
  const token = await googleAccessToken('youtube');

  const metadata = {
    snippet: {
      title: cleanTitle.slice(0, TITLE_MAX),
      description: String(description || '').slice(0, DESCRIPTION_MAX),
      tags: (Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 30),
    },
    status: {
      privacyStatus,
      // Says the video is not "made for kids", which YouTube requires an
      // answer to on every upload; leaving it unset makes the video
      // undiscoverable and disables several features on it.
      selfDeclaredMadeForKids: false,
    },
  };

  stage('opening', null);
  const startUrl = new URL(UPLOAD_API);
  startUrl.searchParams.set('uploadType', 'resumable');
  startUrl.searchParams.set('part', 'snippet,status');
  const opened = await fetch(startUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(body.length),
    },
    body: JSON.stringify(metadata),
  });

  if (!opened.ok) {
    const json = await opened.json().catch(() => ({}));
    const err = new Error(translateUploadError(opened.status, json));
    err.status = 502;
    throw err;
  }

  const sessionUrl = opened.headers.get('location');
  if (!sessionUrl) {
    const err = new Error('YouTube opened an upload session but returned no upload URL.');
    err.status = 502;
    throw err;
  }

  stage('uploading', `${Math.round(body.length / 1024 / 1024)}MB`);
  const sent = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
    body,
  });

  const json = await sent.json().catch(() => ({}));
  if (!sent.ok) {
    const err = new Error(translateUploadError(sent.status, json));
    err.status = 502;
    throw err;
  }
  if (!json.id) {
    const err = new Error('YouTube accepted the upload but returned no video id.');
    err.status = 502;
    throw err;
  }

  // What actually stuck, not what was asked for — see the note about the
  // compliance audit at the top of this file.
  const landedPrivacy = json.status?.privacyStatus || privacyStatus;
  stage('uploaded', json.id);

  return {
    videoId: json.id,
    url: `https://youtu.be/${json.id}`,
    studioUrl: `https://studio.youtube.com/video/${json.id}/edit`,
    requestedPrivacy: privacyStatus,
    privacyStatus: landedPrivacy,
    // The screen shows this rather than working it out itself, so the reason
    // travels with the fact.
    forcedPrivate: landedPrivacy === 'private' && privacyStatus !== 'private',
    bytes: body.length,
  };
}

// An upload takes as long as the connection takes, which is longer than a
// browser will hold a request open. Same background-job shape as the render
// and the Instagram publish — see the note in reelStudio.js about why these
// live in memory rather than in SQLite.
const uploadJobs = new Map();

export function getUploadJob(uploadId) {
  return uploadJobs.get(uploadId) || null;
}

export function startUpload({ fileName, title, description, privacyStatus, tags }) {
  const uploadId = `yt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    uploadId,
    status: 'uploading',
    stage: 'opening',
    detail: null,
    fileName,
    videoId: null,
    url: null,
    privacyStatus: null,
    forcedPrivate: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  uploadJobs.set(uploadId, job);

  uploadVideo({
    fileName,
    title,
    description,
    privacyStatus,
    tags,
    onStage: (step, detail) => {
      job.stage = step;
      job.detail = detail;
    },
  })
    .then((result) => {
      job.status = 'uploaded';
      job.stage = 'uploaded';
      job.videoId = result.videoId;
      job.url = result.url;
      job.studioUrl = result.studioUrl;
      job.privacyStatus = result.privacyStatus;
      job.forcedPrivate = result.forcedPrivate;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.finishedAt = new Date().toISOString();
    });

  return job;
}
