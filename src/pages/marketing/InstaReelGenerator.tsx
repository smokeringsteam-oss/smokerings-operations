import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReelExportReview, { type ReelRenderView } from './ReelExportReview';
import DriveImportPicker, { type DriveReel } from './DriveImportPicker';
import {
  DEFAULT_REEL_LOOK,
  DEFAULT_REEL_TARGET,
  asReelLook,
  asReelTarget,
  fmtBytes,
  fmtSeconds,
  type ReelLook,
  type ReelTarget,
} from './reelSettings';

// Insta Reel Generator — pick the clips out of the Drive folder, press one
// button, get a reel.
//
// WHAT THIS REPLACED, AND WHY. Until now this screen was a video editor: a
// phone-shaped preview over a scrubbing timeline, clips dragged into order,
// handles to trim each end, click to place a caption. It worked. It was
// hardly ever used, and the reason was not the editor — it was when the
// editor had to be used. Cutting a reel is a job for the twenty minutes after
// a cook, which are the twenty minutes the kitchen is being cleaned down. A
// tool that needs a quiet half hour at the end of a Saturday does not get one.
//
// So the machine does the edit. Everything it needs was already here and was
// already separate from the editor's UI — the decode that measures each clip,
// the pure function that picks the shots, the ffmpeg pipeline that renders —
// and the only genuinely new part is the words, which a model writes from one
// frame per shot. What is gone is the hour of human judgement in the middle.
//
// The trade is honest and worth saying out loud: an automatic cut is not as
// good as a careful manual one. It is very much better than the reel that
// never got made, which was the actual alternative.
//
// WHERE THE FOOTAGE COMES FROM. One Google Drive folder, and nothing else.
// Clips go into it from a phone during the cook — which is where they already
// were — along with whatever songs are worth laying under them. Nothing is
// uploaded through this screen. See server/integrations/googleDrive.js for
// why that needed a second OAuth scope and how the folder stays the only
// thing this app can see.
//
// THE SHAPE OF THE SCREEN. Three questions and a button. What footage, what
// song, what is it for. Everything past that is the machine reporting what it
// is doing, and then the finished file. The order clips are picked in is the
// order they play, which is the one editorial decision left in human hands
// because it is the only one that is free to change and expensive to get
// wrong.
//
// Backend: server/marketing/autoReel.js runs the five stages,
// reelStudio.js renders, instagramGraph.js and youtubeUpload.js publish. The
// routes are in server/index.js under "Insta Reel Generator".

type ReelTargetSpec = {
  id: ReelTarget;
  label: string;
  short: string;
  width: number;
  height: number;
  maxSeconds: number;
  caption: boolean;
  hint: string;
};

type ReelLookSpec = { id: ReelLook; label: string; hint: string };

// The server sends the real tables down with its status. These exist so the
// first paint is not empty and so a status call that fails does not leave the
// screen with no targets at all.
const FALLBACK_TARGETS: ReelTargetSpec[] = [
  { id: 'ig-story', label: 'Instagram Story', short: 'Story', width: 1080, height: 1920, maxSeconds: 60, caption: false, hint: '' },
  { id: 'ig-reel', label: 'Instagram Reel', short: 'Reel', width: 1080, height: 1920, maxSeconds: 90, caption: true, hint: '' },
  { id: 'yt-short', label: 'YouTube Short', short: 'Short', width: 1080, height: 1920, maxSeconds: 180, caption: true, hint: '' },
  { id: 'yt-video', label: 'YouTube Video', short: 'Video', width: 1920, height: 1080, maxSeconds: 0, caption: true, hint: '' },
];

const FALLBACK_LOOKS: ReelLookSpec[] = [{ id: 'none', label: 'No grade', hint: '' }];

type ReelStatus = {
  toolchain: {
    ffmpegAvailable: boolean;
    fontFile: string | null;
    width: number;
    height: number;
    fps: number;
    targets?: ReelTargetSpec[];
    looks?: ReelLookSpec[];
    storyMaxSeconds: number;
    reelMaxSeconds: number;
  };
  instagram: {
    hasToken: boolean;
    hasUserId: boolean;
    publicBaseUrl: string | null;
    publicBaseProblem: string | null;
    graphVersion: string;
    configured: boolean;
  };
  // Has to stay assignable to ShareStep's ReelDestinationStatus — the compiler
  // is what says it still is.
  youtube: {
    configured: boolean;
    hasClient: boolean;
    signedIn: boolean;
    error: string;
    privacyStatuses: string[];
  };
  drive: { configured: boolean; folderId: string; account: string; error: string };
};

// One file in the source folder, video or audio, as googleDrive.js shapes it.
type LibraryFile = {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  modifiedAt: string;
  webViewLink: string;
  thumbnail: string;
  width: number;
  height: number;
  duration: number;
};

type Library = { clips: LibraryFile[]; songs: LibraryFile[] };

// The five stages of an automatic build. Mirrors STAGES in
// server/marketing/autoReel.js, which is the copy that decides the order.
const BUILD_STAGES = ['fetching', 'watching', 'cutting', 'writing', 'rendering'] as const;

type AutoBuild = {
  buildId: string;
  status: 'building' | 'rendering' | 'failed';
  stage: (typeof BUILD_STAGES)[number];
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  detail: string | null;
  notes: string[];
  picks: { clipId: string; name: string; in: number; out: number; seconds: number }[];
  captions: string[];
  postCaption: string;
  totalSeconds: number;
  renderId: string | null;
  error: string | null;
};

type RenderJob = ReelRenderView & {
  renderId: string;
  /** Consecutive polls that could not reach the server. Not from the API —
   *  the screen's own count, so a blink can be shown as a blink rather than as
   *  a dead export. */
  stalled?: number;
};

const POLL_INTERVAL_MS = 1200;

// Long enough to ride out a `node --watch` restart mid-build. The work is a
// detached child process on the server and survives one; failing the job on
// the first missed poll is what used to make this look broken.
const POLL_MISSES_ALLOWED = 8;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function readJson<T>(resp: Response, fallback: string): Promise<T> {
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((json as { error?: string }).error || fallback);
  return json as T;
}

const fmtWhen = (iso: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const InstaReelGenerator: React.FC = () => {
  const [status, setStatus] = useState<ReelStatus | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [loadingLibrary, setLoadingLibrary] = useState(false);

  // Selection order is play order, so this is an ordered array and not a Set.
  const [picked, setPicked] = useState<string[]>([]);
  const [songId, setSongId] = useState('');
  const [musicMode, setMusicMode] = useState<'mix' | 'replace'>('mix');

  const [target, setTarget] = useState<ReelTarget>(DEFAULT_REEL_TARGET);
  const [look, setLook] = useState<ReelLook>(DEFAULT_REEL_LOOK);
  const [lengthChoice, setLengthChoice] = useState<'auto' | number>('auto');
  const [sessionHint, setSessionHint] = useState('');

  const [build, setBuild] = useState<AutoBuild | null>(null);
  const [render, setRender] = useState<RenderJob | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const [account, setAccount] = useState<{ username: string | null } | null>(null);
  const [drivePicker, setDrivePicker] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveReel[] | null>(null);
  const [driveListError, setDriveListError] = useState('');
  const [driveBusyId, setDriveBusyId] = useState<string | null>(null);

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const targets = status?.toolchain.targets?.length ? status.toolchain.targets : FALLBACK_TARGETS;
  const looks = status?.toolchain.looks?.length ? status.toolchain.looks : FALLBACK_LOOKS;
  const targetSpec = useMemo(
    () => targets.find((spec) => spec.id === target) ?? targets[0],
    [targets, target],
  );

  // ---- loading ------------------------------------------------------------

  const loadLibrary = useCallback(async () => {
    setLoadingLibrary(true);
    setLibraryError('');
    try {
      const resp = await fetch('/api/marketing/reel/drive/library');
      setLibrary(await readJson<Library>(resp, 'Could not read the Drive folder.'));
    } catch (err) {
      setLibraryError(errorText(err));
      setLibrary(null);
    } finally {
      setLoadingLibrary(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/marketing/reel/status');
        setStatus(await readJson<ReelStatus>(resp, 'Could not read the reel settings.'));
      } catch (err) {
        setError(errorText(err));
      }
    })();
  }, []);

  // The listing is only attempted once Drive is known to be configured. Asking
  // first produces a 400 about a missing folder id on every load of the page,
  // which reads as a fault rather than as a setup step not done yet.
  useEffect(() => {
    if (status?.drive.configured) void loadLibrary();
  }, [status?.drive.configured, loadLibrary]);

  // ---- selection ----------------------------------------------------------

  const togglePick = (id: string) => {
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  // Selected footage in play order, which is pick order. Anything the folder
  // has stopped offering since it was picked is dropped rather than sent: the
  // server would refuse the id anyway, and it should not be counted in the
  // length estimate on the button.
  const pickedFiles = useMemo(() => {
    const byId = new Map((library?.clips || []).map((file) => [file.id, file]));
    return picked.map((id) => byId.get(id)).filter((file): file is LibraryFile => Boolean(file));
  }, [picked, library]);

  const rawSeconds = pickedFiles.reduce((sum, file) => sum + (file.duration || 0), 0);
  const song = (library?.songs || []).find((file) => file.id === songId) || null;

  // ---- building -----------------------------------------------------------

  const startBuild = async () => {
    setError('');
    setNotice('');
    setRender(null);
    try {
      const resp = await fetch('/api/marketing/reel/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipFileIds: picked,
          songFileId: songId,
          target,
          look,
          ...(lengthChoice === 'auto' ? {} : { targetSeconds: lengthChoice }),
          musicMode,
          sessionHint: sessionHint.trim(),
        }),
      });
      setBuild(await readJson<AutoBuild>(resp, 'Could not start the build.'));
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Poll the build until it hands over a renderId. Torn down the moment it
  // does, because from there the render route is the one with the progress.
  useEffect(() => {
    if (!build || build.status === 'failed' || build.renderId) return undefined;
    let misses = 0;
    const id = window.setInterval(async () => {
      try {
        const resp = await fetch(`/api/marketing/reel/auto/${build.buildId}`);
        const body = await readJson<AutoBuild>(resp, 'Lost track of that build.');
        misses = 0;
        setBuild(body);
      } catch (err) {
        misses += 1;
        if (misses < POLL_MISSES_ALLOWED) return;
        const message = errorText(err);
        setError(message);
        setBuild((current) => (current ? { ...current, status: 'failed', error: message } : current));
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [build?.buildId, build?.status, build?.renderId]);

  // The handover. Once the build names a render, the review screen opens on it
  // — which is the same screen a Drive re-import opens, so nothing downstream
  // knows or cares which way the file was made.
  const handedOver = useRef<string | null>(null);
  useEffect(() => {
    if (!build?.renderId || handedOver.current === build.renderId) return;
    handedOver.current = build.renderId;
    setRender({
      renderId: build.renderId,
      status: 'rendering',
      percent: 0,
      error: null,
      warnings: build.notes,
      totalDuration: build.totalSeconds,
      sizeBytes: 0,
      url: null,
      fileName: null,
    });
    setReviewing(true);
  }, [build?.renderId, build?.notes, build?.totalSeconds]);

  // Poll while the encode runs. One unreachable poll is not a failed export:
  // the encode is a child process on the server and carries on through a proxy
  // hiccup or a restart, so misses are counted and shown as a stall before
  // anything is called failed.
  useEffect(() => {
    if (!render || render.status !== 'rendering' || !render.renderId) return undefined;
    let misses = 0;
    const id = window.setInterval(async () => {
      try {
        const resp = await fetch(`/api/marketing/reel/render/${render.renderId}`);
        const body = await readJson<RenderJob>(resp, 'Lost track of that export.');
        misses = 0;
        setRender(body);
      } catch (err) {
        misses += 1;
        if (misses < POLL_MISSES_ALLOWED) {
          setRender((current) => (current ? { ...current, stalled: misses } : current));
          return;
        }
        const message = errorText(err);
        setError(message);
        setRender((current) => (current ? { ...current, status: 'failed', error: message } : current));
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [render?.renderId, render?.status]);

  // ---- reposting ----------------------------------------------------------

  const openDrivePicker = async () => {
    setError('');
    setNotice('');
    setDriveListError('');
    setDriveFiles(null);
    setDrivePicker(true);
    try {
      const resp = await fetch('/api/marketing/reel/drive/files');
      const body = await readJson<{ files: DriveReel[] }>(resp, 'Could not read the Drive folder.');
      setDriveFiles(body.files || []);
    } catch (err) {
      setDriveListError(errorText(err));
    }
  };

  const importFromDrive = async (file: DriveReel) => {
    setDriveBusyId(file.id);
    setDriveListError('');
    try {
      const resp = await fetch('/api/marketing/reel/drive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id }),
      });
      const job = await readJson<RenderJob>(resp, 'Could not bring that reel back from Drive.');
      // A re-import is a finished file, so there is no build behind it and the
      // review screen must not show one.
      setBuild(null);
      setRender(job);
      setDrivePicker(false);
      setReviewing(true);
    } catch (err) {
      setDriveListError(errorText(err));
    } finally {
      setDriveBusyId(null);
    }
  };

  // ---- destination checks -------------------------------------------------

  const checkAccount = async () => {
    setError('');
    try {
      const resp = await fetch('/api/marketing/reel/account');
      const body = await readJson<{ username: string | null; followers: number | null }>(
        resp,
        'Could not reach Instagram.',
      );
      setAccount(body);
      setNotice(`Connected to Instagram as @${body.username ?? 'unknown'}.`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const checkDriveFolder = async () => {
    setError('');
    try {
      const resp = await fetch('/api/marketing/reel/drive-folder');
      const body = await readJson<{ name: string; sharedDrive: boolean }>(resp, 'Could not reach Google Drive.');
      setNotice(`Drive folder "${body.name}" is reachable.`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  // ---- render tree --------------------------------------------------------

  const building = Boolean(build && build.status !== 'failed' && !build.renderId);
  const canBuild = picked.length > 0 && !building && status?.toolchain.ffmpegAvailable !== false;

  return (
    <div className="mkt-roi reel-studio">
      <div className="mkt-head">
        <h3>Insta Reel Generator</h3>
        <div className="mkt-head-actions">
          <button type="button" className="mkt-ghost" onClick={() => void openDrivePicker()}>
            Bring back a past reel
          </button>
          <button type="button" className="mkt-ghost" disabled={loadingLibrary} onClick={() => void loadLibrary()}>
            {loadingLibrary ? 'Reading Drive…' : 'Refresh the folder'}
          </button>
        </div>
      </div>

      {error ? <div className="mkt-alert mkt-alert-bad">{error}</div> : null}
      {notice ? <div className="mkt-alert mkt-alert-good">{notice}</div> : null}
      {status && !status.toolchain.ffmpegAvailable ? (
        <div className="mkt-alert mkt-alert-bad">
          ffmpeg is not available on the server, so nothing can be rendered. Check FFMPEG_PATH.
        </div>
      ) : null}
      {status && !status.drive.configured ? (
        <div className="mkt-alert mkt-alert-bad">
          {status.drive.error || 'Google Drive is not set up, so there is no footage to pick from.'}
        </div>
      ) : null}

      {/* ---- 1. the footage ------------------------------------------------ */}
      <section className="reel-step">
        <header className="reel-step-head">
          <h4>
            <span className="reel-step-n">1</span> Pick the footage
          </h4>
          <p className="reel-dim">
            Everything in the Drive folder. They play in the order you pick them.
            {picked.length ? ` ${picked.length} picked, ${fmtSeconds(rawSeconds)} of raw footage.` : ''}
          </p>
        </header>

        {libraryError ? <div className="mkt-alert mkt-alert-bad">{libraryError}</div> : null}

        {!library && !libraryError ? <p className="reel-dim">Reading the folder…</p> : null}

        {library && !library.clips.length ? (
          <p className="reel-dim">
            No video in that folder yet. Drop the clips from the cook into it and press Refresh.
          </p>
        ) : null}

        <div className="reel-library">
          {(library?.clips || []).map((file) => {
            const order = picked.indexOf(file.id);
            return (
              <button
                type="button"
                key={file.id}
                className={`reel-tile${order >= 0 ? ' is-picked' : ''}`}
                onClick={() => togglePick(file.id)}
                disabled={building}
                title={file.name}
              >
                <span className="reel-tile-shot">
                  {file.thumbnail ? (
                    // Drive's own thumbnail. It expires, which is why it is
                    // never cached and why a broken one is simply hidden
                    // rather than shown as a broken-image icon.
                    <img src={file.thumbnail} alt="" loading="lazy" onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                    }} />
                  ) : null}
                  {order >= 0 ? <span className="reel-tile-order">{order + 1}</span> : null}
                  {file.duration ? <span className="reel-tile-time">{fmtSeconds(file.duration)}</span> : null}
                </span>
                <span className="reel-tile-name">{file.name}</span>
                <span className="reel-tile-meta">
                  {fmtWhen(file.createdAt)}
                  {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ---- 2. the music -------------------------------------------------- */}
      <section className="reel-step">
        <header className="reel-step-head">
          <h4>
            <span className="reel-step-n">2</span> Pick a song
          </h4>
          <p className="reel-dim">
            Any audio file in the same folder. Optional — without one the reel keeps the sound the clips came with.
          </p>
        </header>

        {library && !library.songs.length ? (
          <p className="reel-dim">No audio in that folder. Drop an mp3 in beside the clips.</p>
        ) : null}

        <div className="reel-songs">
          {(library?.songs || []).map((file) => (
            <button
              type="button"
              key={file.id}
              className={`reel-song${songId === file.id ? ' is-picked' : ''}`}
              onClick={() => setSongId(songId === file.id ? '' : file.id)}
              disabled={building}
            >
              <span className="reel-song-name">♪ {file.name}</span>
              <span className="reel-tile-meta">{fmtBytes(file.sizeBytes)}</span>
            </button>
          ))}
        </div>

        {song ? (
          <div className="reel-music-mode">
            <label>
              <input
                type="radio"
                name="musicMode"
                checked={musicMode === 'mix'}
                onChange={() => setMusicMode('mix')}
                disabled={building}
              />
              Under the clips — keeps the sizzle and the room
            </label>
            <label>
              <input
                type="radio"
                name="musicMode"
                checked={musicMode === 'replace'}
                onChange={() => setMusicMode('replace')}
                disabled={building}
              />
              Instead of the clips — for windy or noisy footage
            </label>
          </div>
        ) : null}
      </section>

      {/* ---- 3. what it is for ---------------------------------------------- */}
      <section className="reel-step">
        <header className="reel-step-head">
          <h4>
            <span className="reel-step-n">3</span> Say what it is for
          </h4>
        </header>

        <div className="reel-settings">
          <label>
            Going to
            <select
              value={target}
              onChange={(event) => setTarget(asReelTarget(event.target.value))}
              disabled={building}
            >
              {targets.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Length
            <select
              value={String(lengthChoice)}
              onChange={(event) =>
                setLengthChoice(event.target.value === 'auto' ? 'auto' : Number(event.target.value))
              }
              disabled={building}
            >
              <option value="auto">Whatever suits {targetSpec?.short ?? 'it'}</option>
              <option value="10">About 10s</option>
              <option value="15">About 15s</option>
              <option value="30">About 30s</option>
              <option value="45">About 45s</option>
            </select>
          </label>

          <label>
            Grade
            <select value={look} onChange={(event) => setLook(asReelLook(event.target.value))} disabled={building}>
              {looks.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.label}
                </option>
              ))}
            </select>
          </label>

          <label className="reel-hint-field">
            What was cooking
            <input
              type="text"
              value={sessionHint}
              placeholder="brisket and burnt ends"
              maxLength={80}
              onChange={(event) => setSessionHint(event.target.value)}
              disabled={building}
            />
          </label>
        </div>
        <p className="reel-dim">
          The last one is only for the captions — it tells the model what it is looking at, which is the difference
          between "low and slow" and a caption that names the cut.
        </p>

        <button type="button" className="mkt-primary reel-go" disabled={!canBuild} onClick={() => void startBuild()}>
          {building ? 'Making it…' : picked.length ? `Make the reel from ${picked.length} clips` : 'Pick some footage first'}
        </button>
      </section>

      {/* ---- the build ------------------------------------------------------ */}
      {build ? (
        <section className="reel-step reel-build">
          <header className="reel-step-head">
            <h4>{build.status === 'failed' ? 'That build stopped' : build.stageLabel}</h4>
            {build.detail ? <p className="reel-dim">{build.detail}</p> : null}
          </header>

          {build.status === 'failed' ? (
            <div className="mkt-alert mkt-alert-bad">{build.error}</div>
          ) : (
            <ol className="reel-stages">
              {BUILD_STAGES.map((stage, index) => (
                <li
                  key={stage}
                  className={
                    build.renderId || index < build.stageIndex
                      ? 'is-done'
                      : index === build.stageIndex
                        ? 'is-now'
                        : ''
                  }
                >
                  {stage === 'fetching'
                    ? 'Fetching from Drive'
                    : stage === 'watching'
                      ? 'Watching the footage'
                      : stage === 'cutting'
                        ? 'Choosing the shots'
                        : stage === 'writing'
                          ? 'Writing the captions'
                          : 'Rendering'}
                </li>
              ))}
            </ol>
          )}

          {build.picks.length ? (
            <div className="reel-cut">
              <p className="reel-dim">
                {build.picks.length} shot{build.picks.length === 1 ? '' : 's'}, {build.totalSeconds.toFixed(1)}s
              </p>
              <ol className="reel-shots">
                {build.picks.map((pick, index) => (
                  <li key={`${pick.clipId}-${pick.in}`}>
                    <span className="reel-shot-time">{pick.seconds.toFixed(1)}s</span>
                    <span className="reel-shot-name">{pick.name}</span>
                    {build.captions[index] ? (
                      <span className="reel-shot-caption">“{build.captions[index]}”</span>
                    ) : (
                      <span className="reel-dim">no caption</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {build.notes.length ? (
            <ul className="reel-notes">
              {build.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          {build.renderId && !reviewing ? (
            <button type="button" className="mkt-ghost" onClick={() => setReviewing(true)}>
              Show the reel
            </button>
          ) : null}
        </section>
      ) : null}

      {reviewing && render ? (
        <ReelExportReview
          render={render}
          fallbackTarget={target}
          targetLabel={targetSpec?.label ?? target}
          plannedDuration={build?.totalSeconds ?? render.totalDuration}
          status={status}
          igUsername={account?.username ?? null}
          suggestedCaption={build?.postCaption ?? ''}
          fmtSeconds={fmtSeconds}
          fmtBytes={fmtBytes}
          onClose={() => setReviewing(false)}
          onRetry={() => void startBuild()}
          onCheckAccount={() => void checkAccount()}
          onCheckDriveFolder={() => void checkDriveFolder()}
        />
      ) : null}

      {drivePicker ? (
        <DriveImportPicker
          files={driveFiles}
          error={driveListError}
          busyId={driveBusyId}
          onPick={(file) => void importFromDrive(file)}
          onClose={() => setDrivePicker(false)}
          fmtSeconds={fmtSeconds}
          fmtBytes={fmtBytes}
        />
      ) : null}
    </div>
  );
};

export default InstaReelGenerator;
