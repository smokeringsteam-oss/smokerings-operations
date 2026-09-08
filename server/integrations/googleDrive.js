// Uploading a finished reel to Google Drive.
//
// This is the one destination that is a plain file copy rather than a
// publish: no transcode, no review, no platform deciding when it goes live.
// It is here because the other two destinations are lossy in a way that
// matters — Instagram and YouTube both re-encode, and neither hands the
// original back — so Drive is where the master ends up, and it is also the
// answer to "get it onto my phone" without a cable.
//
// Auth is the Google OAuth sign-in — the same one YouTube uses, the same
// refresh token, one extra scope. NOT the GA4 service account, and that is a
// deliberate reversal worth explaining, because the service account is right
// there and looks like the obvious choice.
//
// A service account has no Drive storage of its own. It can be granted access
// to a folder, but any file it creates there is *owned* by it, and an owner
// with a zero-byte quota cannot own anything — so the upload dies with "The
// user's Drive storage quota has been exceeded", which sends people off to
// check how full their Drive is. It is not about space. The documented fix is
// to put the folder in a Shared Drive, where the drive owns its files rather
// than a user — but Shared Drives are a Google Workspace feature, and this
// kitchen runs on a free Gmail account, so that door is shut.
//
// Signing in as the person instead solves it outright: the files are owned by
// the account that owns the Drive, on its own 15GB, exactly as if they had
// been dragged into the browser. The cost is one interactive sign-in, which
// YouTube already required.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DRIVE_SCOPE, describeOAuthConfig, googleAccessToken } from './googleOAuth.js';
import { CLIPS_DIR, MAX_AUDIO_BYTES, MAX_CLIP_BYTES, RENDERS_DIR } from '../marketing/reelStudio.js';

// Kept as a re-export so the scope this module needs is discoverable from the
// module that needs it, rather than only from the login script.
export { DRIVE_SCOPE };

const FILES_API = 'https://www.googleapis.com/drive/v3/files';

// The mark this app puts on every master it uploads, and the reason it needs
// one at all.
//
// The source folder holds both directions of the reel feature: the raw clips a
// reel is built FROM, and the finished masters the Share step puts back. Under
// the old drive.file-only scope those two never met — the app could see its own
// uploads and literally nothing else, so "everything I can see" meant "the
// finished reels". drive.readonly ended that: the listing now returns the whole
// folder, and without a mark the clip picker would offer last week's finished
// reel as source footage for this week's.
//
// appProperties is private to this app — invisible in the Drive UI and to
// every other client — so it costs the operator nothing and cannot be
// accidentally edited away. A master uploaded before this existed carries no
// mark and so still shows up as a source clip; that is the honest failure and
// it is one wrong-looking row in a picker, not a broken feature.
const MASTER_MARK = { smokerings: 'reel-master' };
const MASTER_MARK_KEY = 'smokerings';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export function getDriveConfig() {
  const oauth = describeOAuthConfig('drive');
  // Accepts a bare id or the folder URL pasted straight out of the address
  // bar, which is what anybody looking at the folder will have on hand.
  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '')
    .trim()
    .replace(/^https?:\/\/drive\.google\.com\/drive\/(u\/\d+\/)?folders\//, '')
    .replace(/[?#].*$/, '');
  return {
    folderId,
    signedIn: oauth.configured,
    configured: Boolean(oauth.configured && folderId),
  };
}

// The status-route view: whether Drive will work and, when it will not, which
// half is missing. Never names the key material.
export function describeDriveConfig() {
  const oauth = describeOAuthConfig('drive');
  const { folderId, configured } = getDriveConfig();
  return {
    configured,
    folderId,
    // Kept in the payload because the Share step renders it. It is the
    // signed-in account now rather than a service account, and it is only
    // known after a sign-in, so it is a label rather than a setting.
    account: oauth.configured ? 'the signed-in Google account' : '',
    error:
      (!oauth.configured ? oauth.error : '') ||
      (!folderId
        ? 'GOOGLE_DRIVE_FOLDER_ID is not set — run `npm run drive:setup` to make the folder and print its id.'
        : ''),
  };
}

function requireConfig() {
  const config = getDriveConfig();
  if (!config.configured) {
    const err = new Error(describeDriveConfig().error || 'Google Drive is not configured.');
    err.status = 400;
    throw err;
  }
  return config;
}

// Confirms the folder is real and reachable *before* a 40MB upload is started
// against it — an id typed one character wrong otherwise fails after the
// whole file has gone up the line.
export async function checkDriveFolder() {
  const { folderId } = requireConfig();
  const token = await googleAccessToken('drive');
  const url = new URL(`${FILES_API}/${encodeURIComponent(folderId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,driveId,webViewLink');
  url.searchParams.set('supportsAllDrives', 'true');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = json.error?.message || `HTTP ${resp.status}`;
    const err = new Error(
      resp.status === 404
        ? `Drive cannot see folder ${folderId}. Either the id is wrong, or the signed-in account has no access to it. If the token predates the source-library feature it may not carry drive.readonly yet — re-run \`npm run drive:login\`.`
        : `Drive refused the folder check: ${reason}`,
    );
    err.status = 502;
    throw err;
  }
  if (json.mimeType !== 'application/vnd.google-apps.folder') {
    const err = new Error(`GOOGLE_DRIVE_FOLDER_ID points at "${json.name}", which is a file, not a folder.`);
    err.status = 400;
    throw err;
  }
  return {
    id: json.id,
    name: json.name,
    // Present only for a folder inside a Shared Drive. Its absence is the
    // early warning for the quota trap described at the top of this file.
    sharedDrive: Boolean(json.driveId),
    webViewLink: json.webViewLink || '',
  };
}

// Google's own wording for the service-account quota trap is "The user's
// Drive storage quota has been exceeded", which sends people to check how
// full their Drive is. It is not about space.
export function translateUploadError(status, json) {
  const reason = json.error?.message || `HTTP ${status}`;
  // Under the old service-account auth this error meant the Shared Drive
  // requirement and never meant a full disk. Signed in as a person it means
  // exactly what it says, so it is passed through with the obvious remedy.
  if (/storage quota/i.test(reason)) {
    return `Drive is out of space on the signed-in account — a reel is tens of megabytes and the free tier is 15GB shared with Gmail and Photos. Clear some room or upgrade the plan. (Google's wording: "${reason}")`;
  }
  if (status === 403 || status === 404) {
    return `Drive refused the upload: ${reason}. The folder in GOOGLE_DRIVE_FOLDER_ID has to be one this app created — re-run \`npm run drive:setup\` if it was made by hand or has since been deleted.`;
  }
  return `Drive refused the upload: ${reason}`;
}

// A resumable upload rather than a multipart one: multipart is capped at 5MB
// of payload and a rendered reel is comfortably past that. Two calls — one to
// open a session and register the metadata, one to send the bytes.
//
// The bytes go in a single PUT rather than in chunks. Chunking exists to
// survive a dropped connection on a long upload, and buys nothing for a file
// of this size on a connection that either works or does not; a failed
// upload here is retried by pressing the button again.
export async function uploadFile({ fileName, name, onStage } = {}) {
  requireConfig();
  const { folderId } = getDriveConfig();
  const stage = (step, detail) => {
    if (typeof onStage === 'function') onStage(step, detail);
  };

  if (!fileName || /[\\/]/.test(fileName)) {
    const err = new Error('A rendered file name is required.');
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
  const token = await googleAccessToken('drive');

  stage('opening', null);
  const startUrl = new URL(UPLOAD_API);
  startUrl.searchParams.set('uploadType', 'resumable');
  startUrl.searchParams.set('supportsAllDrives', 'true');
  const opened = await fetch(startUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(body.length),
    },
    body: JSON.stringify({
      name: name || fileName,
      parents: [folderId],
      mimeType: 'video/mp4',
      appProperties: MASTER_MARK,
    }),
  });

  if (!opened.ok) {
    const json = await opened.json().catch(() => ({}));
    const err = new Error(translateUploadError(opened.status, json));
    err.status = 502;
    throw err;
  }

  const sessionUrl = opened.headers.get('location');
  if (!sessionUrl) {
    const err = new Error('Drive opened an upload session but returned no upload URL.');
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

  stage('uploaded', json.id);
  return {
    id: json.id,
    name: json.name || name || fileName,
    // Built rather than requested back: asking for webViewLink means a second
    // round trip for a URL whose shape is fixed.
    webViewLink: json.id ? `https://drive.google.com/file/d/${json.id}/view` : '',
    bytes: body.length,
  };
}

// ---------------------------------------------------------------------------
// Coming back the other way
// ---------------------------------------------------------------------------
//
// Reposting a reel that already exists. A cook goes up as a Story on Friday
// and is worth a Short a fortnight later, by which time the render is long
// gone: server/uploads/reels is swept after seven days, deliberately, because
// those are working files and Drive is where the master went.
//
// The narrow scope pays off here by accident. drive.file can only see files
// this app created, so a listing of it is exactly the set of finished reels
// this app has ever uploaded — no holiday photos to page through, no filter
// to write, and nothing else in the account is even visible to the request.

// Only what the picker needs. videoMediaMetadata is Drive's own probe of the
// file, which saves downloading a reel to find out it is the wrong shape for
// the destination someone had in mind.
const LIST_FIELDS = 'files(id,name,size,createdTime,webViewLink,videoMediaMetadata(width,height,durationMillis))';

export async function listDriveReels({ limit = 50 } = {}) {
  const { folderId } = requireConfig();
  const token = await googleAccessToken('drive');

  const url = new URL(FILES_API);
  // trashed=false matters more than it looks: a file in the bin is still
  // visible to the API and still downloadable, so without this the picker
  // offers reels the operator believes they deleted.
  url.searchParams.set('q', `'${folderId}' in parents and trashed = false and mimeType contains 'video/'`);
  url.searchParams.set('fields', LIST_FIELDS);
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', String(Math.min(Math.max(Number(limit) || 50, 1), 200)));
  url.searchParams.set('supportsAllDrives', 'true');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Drive would not list the folder: ${json.error?.message || `HTTP ${resp.status}`}`);
    err.status = 502;
    throw err;
  }

  return (json.files || []).map((file) => ({
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size) || 0,
    createdAt: file.createdTime || '',
    webViewLink: file.webViewLink || '',
    width: Number(file.videoMediaMetadata?.width) || 0,
    height: Number(file.videoMediaMetadata?.height) || 0,
    // Drive reports milliseconds; everything on this screen counts seconds.
    duration: file.videoMediaMetadata?.durationMillis
      ? Math.round(Number(file.videoMediaMetadata.durationMillis) / 100) / 10
      : 0,
  }));
}

// Pulls one back down into the renders folder, where every destination
// already knows how to find it.
//
// The name is generated rather than taken from Drive, for two reasons. The
// route that serves these files only accepts `[A-Za-z0-9._-]+` — a reel
// called "Friday's cook (final).mp4" would be unservable — and the
// reel-<millis>-<8 hex> shape is what recoverRenderJob matches on, so an
// imported file behaves like any other finished render, including surviving
// a server restart mid-share.
export async function importDriveFile(fileId, { renderId } = {}) {
  requireConfig();
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    const err = new Error('That is not a Drive file id.');
    err.status = 400;
    throw err;
  }

  const token = await googleAccessToken('drive');
  const meta = await fetch(
    `${FILES_API}/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok) {
    const err = new Error(
      meta.status === 404
        ? 'Drive cannot see that file. It is either gone, or it was not one this app uploaded — the drive.file scope reaches no further than its own files.'
        : `Drive refused the file: ${info.error?.message || `HTTP ${meta.status}`}`,
    );
    err.status = meta.status === 404 ? 404 : 502;
    throw err;
  }
  if (!String(info.mimeType || '').startsWith('video/')) {
    const err = new Error(`"${info.name}" is not a video (${info.mimeType}).`);
    err.status = 400;
    throw err;
  }

  const id = renderId || randomUUID();
  const fileName = `reel-${Date.now()}-${id.slice(0, 8)}.mp4`;
  const outputPath = path.join(RENDERS_DIR, fileName);

  const media = await fetch(`${FILES_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!media.ok) {
    const err = new Error(`Drive refused the download: HTTP ${media.status}`);
    err.status = 502;
    throw err;
  }

  // Written to a temp name and renamed into place, so a download that dies
  // halfway cannot leave a truncated mp4 sitting at a name the Share step
  // will happily hand to Instagram.
  const partPath = `${outputPath}.part`;
  fs.writeFileSync(partPath, Buffer.from(await media.arrayBuffer()));
  fs.renameSync(partPath, outputPath);

  return { renderId: id, fileName, outputPath, driveName: info.name || fileName };
}

// ---------------------------------------------------------------------------
// The source library: the folder as a shelf of raw footage and music.
//
// This is the other direction from listDriveReels above. That one lists what
// this app PUT in Drive — finished reels, for reposting. This lists what
// somebody else put there: the clips shot on a phone during a cook and the
// songs to lay under them, dropped into the folder by hand and never touched
// by this app at all.
//
// Which is exactly why it needs drive.readonly (see googleOAuth.js). A
// drive.file token cannot see a file it did not create, so under the old
// scope this listing came back empty no matter how full the folder was — the
// most confusing failure available, because Drive answers 200 and an empty
// array rather than a permission error.
//
// THE FOLDER PIN IS THE SECURITY BOUNDARY. drive.readonly can read the whole
// account; Google has no folder-scoped Drive scope to ask for instead. So
// every query below hard-codes `'<folderId>' in parents` from the server's own
// env, and no caller can widen it — there is deliberately no folder parameter
// on any of these functions. Adding one would turn the pin into a default and
// hand the rest of the account to whoever can reach the route.

// What counts as footage and what counts as a song. Drive's own mime types are
// trusted for the split because it sniffs content on upload rather than
// believing the extension.
const VIDEO_MIME = "mimeType contains 'video/'";
const AUDIO_MIME = "mimeType contains 'audio/'";

const LIBRARY_FIELDS =
  'files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink,thumbnailLink,appProperties,' +
  'videoMediaMetadata(width,height,durationMillis))';

// Drive reports durations in milliseconds; every screen here counts seconds.
const secondsOf = (millis) => (millis ? Math.round(Number(millis) / 100) / 10 : 0);

function shapeLibraryFile(file) {
  const mimeType = String(file.mimeType || '');
  const kind = mimeType.startsWith('audio/') ? 'audio' : 'video';
  return {
    isMaster: file.appProperties?.[MASTER_MARK_KEY] === MASTER_MARK.smokerings,
    id: file.id,
    name: file.name || '',
    kind,
    mimeType,
    sizeBytes: Number(file.size) || 0,
    createdAt: file.createdTime || '',
    modifiedAt: file.modifiedTime || '',
    webViewLink: file.webViewLink || '',
    // The only preview available without downloading the whole file. Drive
    // expires these links, so one is fetched per listing and never stored.
    thumbnail: file.thumbnailLink || '',
    width: Number(file.videoMediaMetadata?.width) || 0,
    height: Number(file.videoMediaMetadata?.height) || 0,
    duration: secondsOf(file.videoMediaMetadata?.durationMillis),
  };
}

// Everything in the pinned folder that could go into a reel, video and audio
// together, newest first.
//
// One request rather than two, because the folder is small enough that a
// second round trip costs more than filtering the result does — and because
// two listings can disagree with each other if a file lands between them.
export async function listDriveLibrary({ limit = 200 } = {}) {
  const { folderId } = requireConfig();
  const token = await googleAccessToken('drive');

  const url = new URL(FILES_API);
  url.searchParams.set(
    'q',
    // trashed=false matters more than it looks: a file in the bin is still
    // listable and still downloadable, so without it the picker offers
    // footage the operator believes they deleted.
    `'${folderId}' in parents and trashed = false and (${VIDEO_MIME} or ${AUDIO_MIME})`,
  );
  url.searchParams.set('fields', LIBRARY_FIELDS);
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', String(Math.min(Math.max(Number(limit) || 200, 1), 1000)));
  url.searchParams.set('supportsAllDrives', 'true');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = json.error?.message || `HTTP ${resp.status}`;
    const err = new Error(
      resp.status === 403 && /insufficient|scope/i.test(reason)
        ? 'The Drive sign-in cannot read the folder. A token minted before the source library existed carries only drive.file, which cannot see files it did not create — re-run `npm run drive:login` to add drive.readonly.'
        : `Drive would not list the folder: ${reason}`,
    );
    err.status = 502;
    throw err;
  }

  const files = (json.files || []).map(shapeLibraryFile);
  return {
    // Masters are output, not input. They stay reachable through the
    // "bring back a past reel" picker, which is the place for them.
    clips: files.filter((file) => file.kind === 'video' && !file.isMaster),
    songs: files.filter((file) => file.kind === 'audio'),
  };
}

// Confirms one id really is in the pinned folder before anything downloads it.
//
// Without this the pin protects the LISTING and nothing else: a caller naming
// any id in the account would get that file fetched, because drive.readonly is
// perfectly happy to serve it. So membership is re-checked server-side against
// the same folder on every import, and an id from outside is refused as though
// it did not exist — which, as far as this feature is concerned, it does not.
async function requireFolderMember(fileId, token) {
  const { folderId } = getDriveConfig();
  const url = new URL(`${FILES_API}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,size,mimeType,parents,videoMediaMetadata(durationMillis)');
  url.searchParams.set('supportsAllDrives', 'true');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const info = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(
      resp.status === 404
        ? 'Drive cannot see that file.'
        : `Drive refused the file: ${info.error?.message || `HTTP ${resp.status}`}`,
    );
    err.status = resp.status === 404 ? 404 : 502;
    throw err;
  }
  if (!(info.parents || []).includes(folderId)) {
    // Same wording as a genuine miss, on purpose: a caller probing ids should
    // not be able to tell "exists elsewhere in your Drive" from "not there".
    const err = new Error('Drive cannot see that file.');
    err.status = 404;
    throw err;
  }
  return info;
}

// A file's own extension, kept so ffprobe and ffmpeg get the container they
// expect. Anything unrecognised falls back by kind rather than being refused,
// because the demuxer is a better judge of a file than its name is.
function extensionFor(name, kind) {
  const match = /\.([A-Za-z0-9]{2,4})$/.exec(String(name || ''));
  if (match) return `.${match[1].toLowerCase()}`;
  return kind === 'audio' ? '.mp3' : '.mp4';
}

// Pulls one source file down into the clips directory, where the rest of the
// pipeline already knows how to find it.
//
// The local name is generated, never taken from Drive. The route that serves
// these files only accepts `[A-Za-z0-9._-]+`, so a clip called "Friday's cook
// (final).mp4" would be unservable — and two phones both producing
// "VID_20260904.mp4" must not collide in one directory.
//
// Downloads are idempotent per Drive id: the same id asked for twice hands
// back the file already on disk rather than fetching forty megabytes again.
// That matters because building a second reel from an overlapping set of clips
// is the normal case, not the exception.
const imported = new Map();

export async function importDriveSource(fileId, { kind = '' } = {}) {
  requireConfig();
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    const err = new Error('That is not a Drive file id.');
    err.status = 400;
    throw err;
  }

  const cached = imported.get(fileId);
  if (cached && fs.existsSync(cached.path)) return cached;

  const token = await googleAccessToken('drive');
  const info = await requireFolderMember(fileId, token);

  const mimeType = String(info.mimeType || '');
  const actualKind = mimeType.startsWith('audio/') ? 'audio' : mimeType.startsWith('video/') ? 'video' : '';
  if (!actualKind) {
    const err = new Error(`"${info.name}" is not a video or an audio file (${mimeType || 'unknown type'}).`);
    err.status = 400;
    throw err;
  }
  if (kind && actualKind !== kind) {
    const err = new Error(
      kind === 'audio' ? `"${info.name}" is a video, not a song.` : `"${info.name}" is an audio file, not a clip.`,
    );
    err.status = 400;
    throw err;
  }

  const limit = actualKind === 'audio' ? MAX_AUDIO_BYTES : MAX_CLIP_BYTES;
  const size = Number(info.size) || 0;
  if (size > limit) {
    const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(0);
    const err = new Error(
      `"${info.name}" is ${mb(size)}MB, over the ${mb(limit)}MB limit for a ${actualKind === 'audio' ? 'song' : 'clip'}.`,
    );
    err.status = 400;
    throw err;
  }

  const prefix = actualKind === 'audio' ? 'song' : 'clip';
  const localName = `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}${extensionFor(info.name, actualKind)}`;
  const outputPath = path.join(CLIPS_DIR, localName);

  const media = await fetch(`${FILES_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!media.ok) {
    const err = new Error(`Drive refused the download of "${info.name}": HTTP ${media.status}`);
    err.status = 502;
    throw err;
  }

  // Temp name then rename, so a download that dies halfway cannot leave a
  // truncated file at a name the renderer will happily feed to ffmpeg.
  const partPath = `${outputPath}.part`;
  fs.writeFileSync(partPath, Buffer.from(await media.arrayBuffer()));
  fs.renameSync(partPath, outputPath);

  const record = {
    id: localName,
    fileId,
    kind: actualKind,
    path: outputPath,
    driveName: info.name || localName,
    sizeBytes: size,
  };
  imported.set(fileId, record);
  return record;
}

// Called by the media sweep. A local copy pruned off disk must not stay in the
// map, or the next import hands back a path to nothing.
export function forgetImportedSources() {
  for (const [fileId, record] of imported) {
    if (!fs.existsSync(record.path)) imported.delete(fileId);
  }
}

// A Drive upload is quick next to a YouTube one, but it is still a file going
// up a domestic connection — long enough that the browser would time out
// waiting. Same background-job shape as the render, the Instagram publish and
// the YouTube upload, so the Share step polls one way for all three.
const uploadJobs = new Map();

export function getDriveJob(uploadId) {
  return uploadJobs.get(uploadId) || null;
}

export function startDriveUpload({ fileName, name }) {
  const uploadId = `drv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    uploadId,
    status: 'uploading',
    stage: 'opening',
    detail: null,
    fileName,
    fileId: null,
    webViewLink: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  uploadJobs.set(uploadId, job);

  uploadFile({
    fileName,
    name,
    onStage: (step, detail) => {
      job.stage = step;
      job.detail = detail;
    },
  })
    .then((result) => {
      job.status = 'uploaded';
      job.stage = 'uploaded';
      job.fileId = result.id;
      job.webViewLink = result.webViewLink;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.finishedAt = new Date().toISOString();
    });

  return job;
}
