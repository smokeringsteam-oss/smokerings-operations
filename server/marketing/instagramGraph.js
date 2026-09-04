// Publishing a finished reel to Instagram through the Graph API.
//
// The one thing to understand before reading this file is that Instagram
// never receives the video from us. There is no multipart upload here and no
// file in any request body. The Graph API's video flow is *pull-based*: we
// hand Meta a URL, Meta's servers fetch it themselves, transcode it on their
// side, and only then will they publish it. That single fact drives every
// awkward part of this module.
//
//   * The rendered file has to be reachable from the public internet, by an
//     anonymous client, over HTTPS. A path on this laptop is useless, and so
//     is http://localhost:4000 — that URL resolves, for Meta, to Meta.
//     PUBLIC_BASE_URL is where the operator says how the outside world sees
//     this server; on this setup that is the Tailscale Funnel hostname (see
//     the legion / Tailscale note in the README). assertPublicBase below
//     refuses a private or plaintext base rather than letting the publish
//     fail forty seconds later with Meta's opaque "media could not be
//     fetched", which is the same error it returns for a dozen other causes.
//
//   * Publishing is three calls, not one: create a container, wait for Meta
//     to finish transcoding it, then publish the container. The wait is not
//     optional and is not instant — a 45-second story is typically ten to
//     forty seconds in IN_PROGRESS — so publishReel is a long-running
//     operation that the route layer runs as a background job, exactly as it
//     does for the render itself.
//
//   * Meta reports failure in two different shapes and both have to be read.
//     A malformed request comes back as HTTP 400 with an `error` object; a
//     container that failed to transcode comes back as HTTP *200* with
//     status_code ERROR and the real reason buried in `status`. Treating the
//     second as success is the classic way to end up telling someone their
//     story is live when it is not.
//
// Setup this expects, once, in .env — see .env.example for the walkthrough:
// an Instagram Business or Creator account linked to a Facebook Page, a Meta
// app with instagram_basic + instagram_content_publish, a long-lived token in
// IG_ACCESS_TOKEN, the IG user id in IG_USER_ID, and PUBLIC_BASE_URL.

// Meta supports each version for roughly two years. Pinned rather than
// floating so a version deprecation surfaces as one obvious constant to bump
// instead of behaviour that drifts under us; override with IG_GRAPH_VERSION
// without touching code.
const DEFAULT_GRAPH_VERSION = 'v23.0';

const graphVersion = () => process.env.IG_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
const graphBase = () => `https://graph.facebook.com/${graphVersion()}`;

// How long we are willing to wait for Meta to transcode before giving up. A
// 90-second reel is normally ready inside a minute; five minutes is the point
// past which something is wrong rather than slow.
const CONTAINER_POLL_INTERVAL_MS = 3000;
const CONTAINER_TIMEOUT_MS = 5 * 60 * 1000;

export function getInstagramConfig() {
  return {
    accessToken: process.env.IG_ACCESS_TOKEN || '',
    userId: process.env.IG_USER_ID || '',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    graphVersion: graphVersion(),
  };
}

// What the screen shows in its "Instagram connection" panel. Never returns the
// token itself — only whether one is present.
export function describeInstagramConfig() {
  const { accessToken, userId, publicBaseUrl, graphVersion: version } = getInstagramConfig();
  let publicBaseProblem = null;
  if (publicBaseUrl) {
    try {
      assertPublicBase(publicBaseUrl);
    } catch (err) {
      publicBaseProblem = err.message;
    }
  }

  return {
    hasToken: Boolean(accessToken),
    hasUserId: Boolean(userId),
    publicBaseUrl: publicBaseUrl || null,
    publicBaseProblem,
    graphVersion: version,
    configured: Boolean(accessToken && userId && publicBaseUrl && !publicBaseProblem),
  };
}

// Meta has to be able to fetch this URL. Anything that is only meaningful on
// this machine's network is rejected here, with the reason, rather than
// becoming an unexplainable fetch failure inside Meta's transcoder.
export function assertPublicBase(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const err = new Error(`PUBLIC_BASE_URL is not a valid URL: ${baseUrl}`);
    err.status = 400;
    throw err;
  }

  if (parsed.protocol !== 'https:') {
    const err = new Error('PUBLIC_BASE_URL must be https — Instagram will not fetch a video over plain http.');
    err.status = 400;
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) {
    const err = new Error(
      `PUBLIC_BASE_URL points at ${host}, which only exists on this network. Instagram fetches the video from its own servers, so this has to be a public hostname — e.g. the Tailscale Funnel URL from "tailscale funnel 4000".`,
    );
    err.status = 400;
    throw err;
  }

  return parsed.toString().replace(/\/+$/, '');
}

async function graphRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`Instagram returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }

  if (!response.ok || payload.error) {
    const metaError = payload.error || {};
    // error_user_msg is the one written for a human to read; it is absent on
    // most errors, which is why the generic message has to be kept too.
    const detail = metaError.error_user_msg || metaError.message || `HTTP ${response.status}`;
    const err = new Error(`Instagram rejected the request: ${detail}`);
    err.status = response.status === 200 ? 502 : response.status;
    err.meta = {
      type: metaError.type,
      code: metaError.code,
      subcode: metaError.error_subcode,
      traceId: metaError.fbtrace_id,
    };
    throw err;
  }

  return payload;
}

function requireConfig() {
  const config = getInstagramConfig();
  if (!config.accessToken || !config.userId) {
    const err = new Error(
      'Instagram is not connected. Set IG_ACCESS_TOKEN and IG_USER_ID in .env (see .env.example) and restart the server.',
    );
    err.status = 400;
    throw err;
  }
  if (!config.publicBaseUrl) {
    const err = new Error(
      'PUBLIC_BASE_URL is not set. Instagram fetches the video from a public URL rather than receiving an upload, so the server needs to know how it is reachable from outside.',
    );
    err.status = 400;
    throw err;
  }
  assertPublicBase(config.publicBaseUrl);
  return config;
}

// Confirms the token works and says which account it is for, so the screen can
// show "posting as @smokeringsbbq" rather than asking the user to trust that
// a string in a .env file points where they think it does.
export async function checkInstagramAccount() {
  const { accessToken, userId } = requireConfig();
  const url = new URL(`${graphBase()}/${userId}`);
  url.searchParams.set('fields', 'id,username,name,followers_count');
  url.searchParams.set('access_token', accessToken);

  const account = await graphRequest(url.toString());
  return {
    id: account.id,
    username: account.username || null,
    name: account.name || null,
    followers: account.followers_count ?? null,
  };
}

// Step 1 — hand Meta the URL and get back a container id.
async function createContainer({ videoUrl, target, caption, shareToFeed }) {
  const { accessToken, userId } = getInstagramConfig();
  const body = new URLSearchParams();
  body.set('access_token', accessToken);
  body.set('video_url', videoUrl);

  if (target === 'reel') {
    body.set('media_type', 'REELS');
    if (caption) body.set('caption', caption);
    body.set('share_to_feed', shareToFeed ? 'true' : 'false');
  } else {
    // Stories carry no caption — anything typed for one would be silently
    // dropped by Meta, so it is not sent at all.
    body.set('media_type', 'STORIES');
  }

  const created = await graphRequest(`${graphBase()}/${userId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!created.id) {
    const err = new Error('Instagram accepted the request but returned no container id.');
    err.status = 502;
    throw err;
  }
  return created.id;
}

// Step 2 — wait for Meta's own transcode. status_code is the machine-readable
// one; status is the sentence explaining an ERROR.
async function waitForContainer(containerId, onProgress = () => {}) {
  const { accessToken } = getInstagramConfig();
  const deadline = Date.now() + CONTAINER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = new URL(`${graphBase()}/${containerId}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', accessToken);

    const result = await graphRequest(url.toString());
    const code = result.status_code;

    if (code === 'FINISHED') return result;
    if (code === 'ERROR' || code === 'EXPIRED') {
      const err = new Error(
        `Instagram could not process the video: ${result.status || code}. The usual cause is that it could not fetch ${
          getInstagramConfig().publicBaseUrl
        } from the outside — check the tunnel is up.`,
      );
      err.status = 502;
      throw err;
    }

    onProgress(code || 'IN_PROGRESS');
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
  }

  const err = new Error(
    'Instagram is still processing the video after five minutes. It may still appear — check the app before re-posting, so you do not end up with it twice.',
  );
  err.status = 504;
  throw err;
}

// Step 3 — publish the finished container.
async function publishContainer(containerId) {
  const { accessToken, userId } = getInstagramConfig();
  const body = new URLSearchParams();
  body.set('access_token', accessToken);
  body.set('creation_id', containerId);

  const published = await graphRequest(`${graphBase()}/${userId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  return published.id || null;
}

// The whole publish, start to finish. `fileName` is a name inside the renders
// directory; the public URL is built here rather than taken from the caller so
// a request body can never point Instagram at an arbitrary URL.
export async function publishReel({ fileName, target = 'story', caption = '', shareToFeed = false, onStage } = {}) {
  const { publicBaseUrl } = requireConfig();

  if (!fileName || /[\\/]/.test(fileName)) {
    const err = new Error('A rendered file name is required.');
    err.status = 400;
    throw err;
  }

  const videoUrl = `${publicBaseUrl}/api/marketing/reel/render-file/${encodeURIComponent(fileName)}`;
  const stage = (name, detail) => {
    if (typeof onStage === 'function') onStage(name, detail);
  };

  stage('creating', videoUrl);
  const containerId = await createContainer({ videoUrl, target, caption, shareToFeed });

  stage('processing', containerId);
  await waitForContainer(containerId, (code) => stage('processing', code));

  stage('publishing', containerId);
  const mediaId = await publishContainer(containerId);

  stage('published', mediaId);
  return { mediaId, containerId, videoUrl, target };
}

// A publish takes as long as Meta takes, which is longer than a browser will
// hold a request open. So it runs as a background job the screen polls, the
// same shape as reelStudio's render jobs — see the note there about why these
// live in memory rather than in SQLite.
const publishJobs = new Map();

export function getPublishJob(publishId) {
  return publishJobs.get(publishId) || null;
}

export function startPublish({ fileName, target, caption, shareToFeed }) {
  const publishId = `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    publishId,
    status: 'publishing',
    stage: 'creating',
    detail: null,
    target,
    fileName,
    mediaId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  publishJobs.set(publishId, job);

  publishReel({
    fileName,
    target,
    caption,
    shareToFeed,
    onStage: (name, detail) => {
      job.stage = name;
      // The container id is useful to a human debugging a stuck publish; the
      // video URL is not, so only the id is surfaced.
      job.detail = typeof detail === 'string' && detail.startsWith('http') ? null : detail;
    },
  })
    .then((result) => {
      job.status = 'published';
      job.stage = 'published';
      job.mediaId = result.mediaId;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.finishedAt = new Date().toISOString();
    });

  return job;
}
