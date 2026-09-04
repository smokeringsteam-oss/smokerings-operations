import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Insta Reel Generator — drop in the clips from a smoking session, put them in
// order, trim the dead air off each end, caption them, and get one vertical
// file that can go straight to Instagram.
//
// The editing all happens here in the browser and none of it touches ffmpeg
// until Export. A "timeline" on this screen is just an ordered array of clip
// ids with in/out points and a caption; the preview player below plays that
// array by seeking one <video> element from clip to clip. That is why
// dragging a clip, dragging a trim handle or retyping a caption is instant —
// nothing is re-encoded until the moment the whole reel is, once.
//
// The two things that follow from that, and that shape the code below:
//
//   * The preview is an honest approximation, not the export. It plays the
//     source files at their own aspect ratios inside a 9:16 box, so a
//     landscape clip shows letterboxed here exactly as it will in the export
//     — but captions are drawn as HTML over the video rather than burnt in,
//     and music is not mixed in at all. The export panel says so, because a
//     preview that quietly differs from the output is worse than no preview.
//
//   * Nothing is saved. Reload the page and the timeline is gone, though the
//     uploaded clips are still on the server for a week (see pruneOldMedia in
//     server/marketing/reelStudio.js). A reel is made in one sitting; a
//     half-finished timeline is not a document anybody wants back.
//
// Backend: server/marketing/reelStudio.js renders, instagramGraph.js
// publishes, and the routes are in server/index.js under
// "Insta Reel Generator".

type Probe = {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number;
  sizeBytes: number;
};

type UploadedClip = Probe & {
  id: string;
  name: string;
  url: string;
};

// One entry on the timeline. Separate from UploadedClip because the same
// uploaded file can legitimately appear twice — a shot used at the top and
// again at the end is a normal thing to want.
type TimelineClip = {
  key: string;
  id: string;
  name: string;
  url: string;
  sourceDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  in: number;
  out: number;
  text: string;
  textPosition: 'top' | 'center' | 'bottom';
};

type MusicTrack = { id: string; name: string; url: string; duration: number };

type ReelStatus = {
  toolchain: {
    ffmpegAvailable: boolean;
    fontFile: string | null;
    width: number;
    height: number;
    fps: number;
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
};

type RenderJob = {
  renderId: string;
  status: 'rendering' | 'ready' | 'failed';
  percent: number;
  error: string | null;
  warnings: string[];
  totalDuration: number;
  sizeBytes: number;
  url: string | null;
  fileName: string | null;
};

type PublishJob = {
  publishId: string;
  status: 'publishing' | 'published' | 'failed';
  stage: string;
  detail: string | null;
  target: string;
  mediaId: string | null;
  error: string | null;
};

async function readJson<T extends { error?: string }>(resp: Response, fallbackMessage: string): Promise<T> {
  let json: T;
  try {
    json = (await resp.json()) as T;
  } catch {
    throw new Error('Got an empty response from the server. Is the backend running (npm run start-server)? Try again.');
  }
  if (!resp.ok) throw new Error(json.error || fallbackMessage);
  return json;
}

// fetch gives no upload progress, and these are hundred-megabyte files on a
// home connection — a Save button that sits there for ninety seconds with no
// feedback reads as broken. XHR is the only way to watch the bytes go out.
function uploadWithProgress<T>(url: string, files: File[], onProgress: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append('clips', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let parsed: (T & { error?: string }) | null = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(`The server gave back something unreadable (HTTP ${xhr.status}).`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed) resolve(parsed);
      else reject(new Error(parsed?.error || `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload could not reach the server. Is the backend running?'));
    xhr.send(form);
  });
}

const fmtSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
};

const fmtBytes = (bytes: number) => {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// 9:16 is the target. Anything else gets black bars in the export, and saying
// which way round is more use than repeating the pixel dimensions back.
const shapeOf = (width: number, height: number) => {
  if (!width || !height) return null;
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.02) return null;
  return ratio > 1 ? 'landscape — will export with bars top and bottom' : 'not 9:16 — will export with bars';
};

const InstaReelGenerator = () => {
  const [status, setStatus] = useState<ReelStatus | null>(null);
  const [library, setLibrary] = useState<UploadedClip[]>([]);
  const [timeline, setTimeline] = useState<TimelineClip[]>([]);
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const [musicMode, setMusicMode] = useState<'replace' | 'mix'>('mix');
  const [musicVolume, setMusicVolume] = useState(0.8);
  const [originalVolume, setOriginalVolume] = useState(0.35);
  const [target, setTarget] = useState<'story' | 'reel'>('story');
  const [caption, setCaption] = useState('');
  const [shareToFeed, setShareToFeed] = useState(true);

  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'clip' | 'reel'>('clip');
  const [playIndex, setPlayIndex] = useState(0);
  const [playhead, setPlayhead] = useState(0);

  const [render, setRender] = useState<RenderJob | null>(null);
  const [publish, setPublish] = useState<PublishJob | null>(null);
  const [account, setAccount] = useState<{ username: string | null; followers: number | null } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const dragKey = useRef<string | null>(null);

  const totalDuration = useMemo(
    () => timeline.reduce((sum, clip) => sum + Math.max(0, clip.out - clip.in), 0),
    [timeline],
  );

  const limit = target === 'reel' ? status?.toolchain.reelMaxSeconds ?? 90 : status?.toolchain.storyMaxSeconds ?? 60;
  const overLimit = totalDuration > limit;

  useEffect(() => {
    fetch('/api/marketing/reel/status')
      .then((resp) => readJson<ReelStatus & { error?: string }>(resp, 'Could not read the reel tooling status.'))
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // ---- uploading ----------------------------------------------------------

  const addFiles = useCallback(async (files: File[]) => {
    const videos = files.filter((file) => file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name));
    if (!videos.length) {
      setError('Those did not look like video files. Drop .mp4 or .mov clips.');
      return;
    }

    setError('');
    setNotice('');
    setUploading(true);
    setUploadPercent(0);
    try {
      const body = await uploadWithProgress<{ clips: UploadedClip[] }>(
        '/api/marketing/reel/clips',
        videos,
        setUploadPercent,
      );
      setLibrary((current) => [...current, ...body.clips]);
      // Straight onto the end of the timeline, full length. Dropping four
      // clips in and then having to add each one again is busywork; taking one
      // back out is one click.
      setTimeline((current) => [
        ...current,
        ...body.clips.map((clip, index) => ({
          key: `${clip.id}-${Date.now()}-${index}`,
          id: clip.id,
          name: clip.name,
          url: clip.url,
          sourceDuration: clip.duration,
          width: clip.width,
          height: clip.height,
          hasAudio: clip.hasAudio,
          in: 0,
          out: clip.duration,
          text: '',
          textPosition: 'bottom' as const,
        })),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  }, []);

  const addMusic = useCallback(async (file: File) => {
    setError('');
    setUploading(true);
    setUploadPercent(0);
    try {
      const body = await uploadWithProgress<{ music: MusicTrack }>(
        '/api/marketing/reel/music',
        [file],
        setUploadPercent,
      );
      setMusic(body.music);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  }, []);

  // ---- timeline editing ---------------------------------------------------

  const patchClip = (key: string, patch: Partial<TimelineClip>) =>
    setTimeline((current) => current.map((clip) => (clip.key === key ? { ...clip, ...patch } : clip)));

  const removeClip = (key: string) => {
    setTimeline((current) => current.filter((clip) => clip.key !== key));
    setSelectedKey((current) => (current === key ? null : current));
  };

  const moveClip = (key: string, direction: -1 | 1) =>
    setTimeline((current) => {
      const index = current.findIndex((clip) => clip.key === key);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
      return reordered;
    });

  // Drag-and-drop for the desktop, the arrows above for the kitchen tablet
  // where a long press means something else already.
  const dropOn = (targetKey: string) => {
    const sourceKey = dragKey.current;
    dragKey.current = null;
    if (!sourceKey || sourceKey === targetKey) return;

    setTimeline((current) => {
      const from = current.findIndex((clip) => clip.key === sourceKey);
      const to = current.findIndex((clip) => clip.key === targetKey);
      if (from < 0 || to < 0) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);
      return reordered;
    });
  };

  const addFromLibrary = (clip: UploadedClip) =>
    setTimeline((current) => [
      ...current,
      {
        key: `${clip.id}-${Date.now()}`,
        id: clip.id,
        name: clip.name,
        url: clip.url,
        sourceDuration: clip.duration,
        width: clip.width,
        height: clip.height,
        hasAudio: clip.hasAudio,
        in: 0,
        out: clip.duration,
        text: '',
        textPosition: 'bottom',
      },
    ]);

  // ---- preview ------------------------------------------------------------

  const selected = timeline.find((clip) => clip.key === selectedKey) || null;
  const previewClip = previewMode === 'reel' ? timeline[playIndex] || null : selected;

  // Keep something under the preview player whenever there is anything to
  // show. Without this the panel sits empty until a card is clicked — and the
  // trim sliders swallow clicks, so "click the card" is not as obvious as it
  // sounds. Also covers the selected clip being deleted out from under it.
  useEffect(() => {
    if (!timeline.length) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    if (!timeline.some((clip) => clip.key === selectedKey)) setSelectedKey(timeline[0].key);
  }, [timeline, selectedKey]);

  // Re-seek whenever the clip under the player changes, or its in-point moves.
  // Without the second, dragging the in-handle leaves the picture on a frame
  // that is no longer in the reel.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewClip) return;
    const wanted = previewClip.url;
    if (!video.src.endsWith(wanted)) {
      video.src = wanted;
      video.load();
    }
    const seek = () => {
      video.currentTime = previewClip.in;
      setPlayhead(previewClip.in);
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }, [previewClip?.url, previewClip?.in, previewClip?.key]);

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !previewClip) return;
    setPlayhead(video.currentTime);

    if (video.currentTime >= previewClip.out - 0.03) {
      if (previewMode === 'reel' && playIndex < timeline.length - 1) {
        setPlayIndex((index) => index + 1);
      } else {
        video.pause();
        if (previewMode === 'reel') setPreviewMode('clip');
      }
    }
  };

  const playWholeReel = () => {
    if (!timeline.length) return;
    setPreviewMode('reel');
    setPlayIndex(0);
    // The effect above seeks; play once it has.
    window.setTimeout(() => videoRef.current?.play().catch(() => undefined), 60);
  };

  // Advancing playIndex changes previewClip, which re-seeks — then play again.
  useEffect(() => {
    if (previewMode !== 'reel') return;
    const video = videoRef.current;
    if (!video) return;
    const id = window.setTimeout(() => video.play().catch(() => undefined), 60);
    return () => window.clearTimeout(id);
  }, [playIndex, previewMode]);

  // ---- render -------------------------------------------------------------

  const startRender = async () => {
    setError('');
    setNotice('');
    setPublish(null);
    try {
      const resp = await fetch('/api/marketing/reel/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: timeline.map((clip) => ({
            id: clip.id,
            name: clip.name,
            in: clip.in,
            out: clip.out,
            text: clip.text,
            textPosition: clip.textPosition,
          })),
          music: music
            ? { id: music.id, name: music.name, mode: musicMode, volume: musicVolume, originalVolume }
            : null,
          target,
        }),
      });
      const body = await readJson<{ renderId: string; warnings: string[]; error?: string }>(
        resp,
        'Could not start the export.',
      );
      setRender({
        renderId: body.renderId,
        status: 'rendering',
        percent: 0,
        error: null,
        warnings: body.warnings || [],
        totalDuration,
        sizeBytes: 0,
        url: null,
        fileName: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Poll while an export is running. The interval is torn down the moment the
  // job leaves 'rendering', so a finished reel does not keep hitting the API.
  useEffect(() => {
    if (!render || render.status !== 'rendering') return undefined;
    const id = window.setInterval(async () => {
      try {
        const resp = await fetch(`/api/marketing/reel/render/${render.renderId}`);
        const body = await readJson<RenderJob & { error?: string }>(resp, 'Lost track of that export.');
        setRender(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRender((current) => (current ? { ...current, status: 'failed' } : current));
      }
    }, 1200);
    return () => window.clearInterval(id);
  }, [render?.renderId, render?.status]);

  // ---- publish ------------------------------------------------------------

  const checkAccount = async () => {
    setError('');
    try {
      const resp = await fetch('/api/marketing/reel/account');
      const body = await readJson<{ username: string | null; followers: number | null; error?: string }>(
        resp,
        'Could not reach Instagram.',
      );
      setAccount(body);
      setNotice(`Connected to Instagram as @${body.username ?? 'unknown'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startPublish = async () => {
    if (!render?.fileName) return;
    setError('');
    setNotice('');
    try {
      const resp = await fetch('/api/marketing/reel/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: render.fileName, target, caption, shareToFeed }),
      });
      const body = await readJson<{ publishId: string; error?: string }>(resp, 'Could not start the publish.');
      setPublish({
        publishId: body.publishId,
        status: 'publishing',
        stage: 'creating',
        detail: null,
        target,
        mediaId: null,
        error: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!publish || publish.status !== 'publishing') return undefined;
    const id = window.setInterval(async () => {
      try {
        const resp = await fetch(`/api/marketing/reel/publish/${publish.publishId}`);
        const body = await readJson<PublishJob & { error?: string }>(resp, 'Lost track of that publish.');
        setPublish(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPublish((current) => (current ? { ...current, status: 'failed' } : current));
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [publish?.publishId, publish?.status]);

  // ---- render tree --------------------------------------------------------

  const ig = status?.instagram;
  const unusedLibrary = library.filter((clip) => !timeline.some((item) => item.id === clip.id));

  return (
    <div className="mkt-roi reel-studio">
      <div className="mkt-head">
        <h3>Insta Reel Generator</h3>
        <p>
          Drop in the clips from a cook, put them in order, trim the dead air off each end and caption them. Export
          gives you one vertical {status?.toolchain.width ?? 1080}×{status?.toolchain.height ?? 1920} file — every clip
          padded to the same shape and framerate, so a landscape shot and a phone video stitch together cleanly — which
          you can download or post straight to Instagram.
        </p>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {notice ? <div className="mkt-alert mkt-alert-ok">{notice}</div> : null}
      {status && !status.toolchain.ffmpegAvailable ? (
        <div className="mkt-alert mkt-alert-error">
          ffmpeg is missing, so nothing can be exported. Run <code>npm install</code> to restore it.
        </div>
      ) : null}

      <section className="mkt-panel">
        <h4>1. Clips</h4>
        <p className="mkt-panel-hint">
          Drop them in the order you shot them — you can rearrange below. Mixed resolutions and framerates are fine;
          they are all squared up on export. Clips are kept on the server for a week and then swept.
        </p>

        <div
          className={`reel-drop${uploading ? ' reel-drop-busy' : ''}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles([...event.dataTransfer.files]);
          }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
          }}
        >
          <span className="reel-drop-icon" aria-hidden="true">
            🎬
          </span>
          {uploading ? (
            <>
              <strong>Uploading… {uploadPercent}%</strong>
              <div className="reel-bar">
                <div className="reel-bar-fill" style={{ width: `${uploadPercent}%` }} />
              </div>
            </>
          ) : (
            <>
              <strong>Drop video clips here</strong>
              <span>or click to choose — .mp4, .mov, several at once</span>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(event) => {
            void addFiles([...(event.target.files || [])]);
            event.target.value = '';
          }}
        />

        {unusedLibrary.length ? (
          <div className="reel-library">
            <span className="reel-library-label">Uploaded but not on the timeline</span>
            <div className="reel-library-chips">
              {unusedLibrary.map((clip) => (
                <button key={clip.id} type="button" className="mkt-chip" onClick={() => addFromLibrary(clip)}>
                  + {clip.name} <span className="reel-dim">({fmtSeconds(clip.duration)})</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {timeline.length ? (
        <section className="mkt-panel">
          <div className="mkt-panel-head">
            <div>
              <h4>2. Timeline</h4>
              <p className="mkt-panel-hint">
                Drag a card to reorder, or use the arrows. Trim with the two handles on each card — the preview on the
                right follows whichever clip is selected.
              </p>
            </div>
            <span className={`reel-total${overLimit ? ' reel-total-over' : ''}`}>
              {fmtSeconds(totalDuration)} / {limit}s
            </span>
          </div>

          <div className="reel-editor">
            <div className="reel-clips">
              {timeline.map((clip, index) => {
                const shape = shapeOf(clip.width, clip.height);
                const clipLength = Math.max(0, clip.out - clip.in);
                return (
                  <article
                    key={clip.key}
                    className={`reel-clip${selectedKey === clip.key ? ' reel-clip-active' : ''}`}
                    draggable
                    onDragStart={() => {
                      dragKey.current = clip.key;
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => dropOn(clip.key)}
                    onClick={() => {
                      setSelectedKey(clip.key);
                      setPreviewMode('clip');
                    }}
                  >
                    {/* A div rather than a <header>: .marketing-dashboard
                        header in App.css is an unscoped descendant rule that
                        paints any header inside this dashboard as the big
                        charcoal page banner, and a card title row is not that. */}
                    <div className="reel-clip-head">
                      <span className="reel-clip-index">{index + 1}</span>
                      <span className="reel-clip-name" title={clip.name}>
                        {clip.name}
                      </span>
                      <span className="reel-clip-len">{fmtSeconds(clipLength)}</span>
                      <div className="reel-clip-move">
                        <button
                          type="button"
                          aria-label="Move earlier"
                          disabled={index === 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            moveClip(clip.key, -1);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label="Move later"
                          disabled={index === timeline.length - 1}
                          onClick={(event) => {
                            event.stopPropagation();
                            moveClip(clip.key, 1);
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label="Remove clip"
                          className="reel-clip-remove"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeClip(clip.key);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    <div className="reel-clip-flags">
                      {clip.hasAudio ? null : <span className="reel-flag">no audio</span>}
                      {shape ? <span className="reel-flag">{shape}</span> : null}
                    </div>

                    <label className="reel-trim">
                      <span>
                        In <b>{fmtSeconds(clip.in)}</b>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={clip.sourceDuration}
                        step={0.05}
                        value={clip.in}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          // The two handles must not cross; the in-point stops
                          // a tenth of a second short of the out-point.
                          patchClip(clip.key, { in: Math.min(next, clip.out - 0.1) });
                        }}
                      />
                    </label>
                    <label className="reel-trim">
                      <span>
                        Out <b>{fmtSeconds(clip.out)}</b>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={clip.sourceDuration}
                        step={0.05}
                        value={clip.out}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          patchClip(clip.key, { out: Math.max(next, clip.in + 0.1) });
                        }}
                      />
                    </label>

                    {selectedKey === clip.key ? (
                      <div className="reel-trim-actions">
                        <button
                          type="button"
                          className="mkt-chip"
                          onClick={(event) => {
                            event.stopPropagation();
                            patchClip(clip.key, { in: Math.min(playhead, clip.out - 0.1) });
                          }}
                        >
                          Set in to playhead
                        </button>
                        <button
                          type="button"
                          className="mkt-chip"
                          onClick={(event) => {
                            event.stopPropagation();
                            patchClip(clip.key, { out: Math.max(playhead, clip.in + 0.1) });
                          }}
                        >
                          Set out to playhead
                        </button>
                      </div>
                    ) : null}

                    <div className="reel-caption-row">
                      <input
                        type="text"
                        placeholder="Caption burnt onto this clip (optional)"
                        value={clip.text}
                        maxLength={90}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => patchClip(clip.key, { text: event.target.value })}
                      />
                      <select
                        value={clip.textPosition}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          patchClip(clip.key, { textPosition: event.target.value as TimelineClip['textPosition'] })
                        }
                      >
                        <option value="top">Top</option>
                        <option value="center">Middle</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="reel-preview">
              <div className="reel-phone">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  ref={videoRef}
                  playsInline
                  controls
                  onTimeUpdate={onTimeUpdate}
                  onSeeking={() => setPlayhead(videoRef.current?.currentTime ?? 0)}
                />
                {previewClip?.text ? (
                  <div className={`reel-overlay reel-overlay-${previewClip.textPosition}`}>{previewClip.text}</div>
                ) : null}
                {!previewClip ? <div className="reel-phone-empty">Select a clip to preview it</div> : null}
              </div>
              <div className="reel-preview-actions">
                <button type="button" className="mkt-primary mkt-primary-sm" onClick={playWholeReel}>
                  ▶ Play whole reel
                </button>
                <span className="reel-dim">
                  {previewMode === 'reel' ? `Clip ${playIndex + 1} of ${timeline.length}` : 'Single clip'}
                </span>
              </div>
              <p className="reel-preview-note">
                A guide, not the export: captions are drawn over the video here rather than burnt in, and music is not
                mixed into this preview. The black bars are real — they are what the export will have.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {timeline.length ? (
        <section className="mkt-panel">
          <h4>3. Music</h4>
          <p className="mkt-panel-hint">
            Optional. Use your own or licensed audio — Instagram mutes or takes down reels carrying commercial tracks,
            and it does that to the post, not to the file. A track shorter than the reel loops; a longer one is cut, and
            it fades out at the end either way.
          </p>

          {music ? (
            <div className="reel-music">
              <div className="reel-music-head">
                <strong>{music.name}</strong>
                <span className="reel-dim">{fmtSeconds(music.duration)}</span>
                <button type="button" className="mkt-link-danger" onClick={() => setMusic(null)}>
                  Remove
                </button>
              </div>
              <div className="mkt-form reel-music-controls">
                <label className="mkt-field">
                  <span>Original clip audio</span>
                  <select value={musicMode} onChange={(event) => setMusicMode(event.target.value as 'replace' | 'mix')}>
                    <option value="mix">Keep it under the music</option>
                    <option value="replace">Replace it entirely</option>
                  </select>
                </label>
                <label className="mkt-field">
                  <span>Music volume {Math.round(musicVolume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={musicVolume}
                    onChange={(event) => setMusicVolume(Number(event.target.value))}
                  />
                </label>
                {musicMode === 'mix' ? (
                  <label className="mkt-field">
                    <span>Clip audio {Math.round(originalVolume * 100)}%</span>
                    <input
                      type="range"
                      min={0}
                      max={1.5}
                      step={0.05}
                      value={originalVolume}
                      onChange={(event) => setOriginalVolume(Number(event.target.value))}
                    />
                  </label>
                ) : null}
              </div>
            </div>
          ) : (
            <button type="button" className="mkt-chip" onClick={() => musicInputRef.current?.click()}>
              + Add a music track
            </button>
          )}
          <input
            ref={musicInputRef}
            type="file"
            accept="audio/*"
            hidden
            onChange={(event) => {
              const file = (event.target.files || [])[0];
              if (file) void addMusic(file);
              event.target.value = '';
            }}
          />
        </section>
      ) : null}

      {timeline.length ? (
        <section className="mkt-panel">
          <h4>4. Export</h4>

          <div className="mkt-form">
            <label className="mkt-field">
              <span>Posting as</span>
              <select value={target} onChange={(event) => setTarget(event.target.value as 'story' | 'reel')}>
                <option value="story">Story (up to {status?.toolchain.storyMaxSeconds ?? 60}s, no caption)</option>
                <option value="reel">Reel (up to {status?.toolchain.reelMaxSeconds ?? 90}s, with a caption)</option>
              </select>
            </label>
            <div className="reel-export-actions">
              <button
                type="button"
                className="mkt-primary"
                disabled={!timeline.length || render?.status === 'rendering' || !status?.toolchain.ffmpegAvailable}
                onClick={startRender}
              >
                {render?.status === 'rendering' ? 'Exporting…' : 'Export the reel'}
              </button>
            </div>
          </div>

          {overLimit ? (
            <div className="mkt-alert mkt-alert-warn">
              This runs to {fmtSeconds(totalDuration)}, over the {limit}s Instagram allows for a{' '}
              {target === 'reel' ? 'Reel published through the API' : 'Story'}. It will still export — but trim it
              before posting, or the publish step will refuse it.
            </div>
          ) : null}

          {render ? (
            <div className="reel-render">
              {render.status === 'rendering' ? (
                <>
                  <div className="reel-bar">
                    <div className="reel-bar-fill" style={{ width: `${render.percent}%` }} />
                  </div>
                  <span className="reel-dim">Stitching, padding and encoding — {render.percent}%</span>
                </>
              ) : null}

              {render.status === 'failed' ? (
                <div className="mkt-alert mkt-alert-error">{render.error || 'The export failed.'}</div>
              ) : null}

              {(render.warnings || []).map((warning) => (
                <div key={warning} className="mkt-alert mkt-alert-warn">
                  {warning}
                </div>
              ))}

              {render.status === 'ready' && render.url ? (
                <div className="reel-done">
                  <div className="reel-phone reel-phone-sm">
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video src={render.url} controls playsInline />
                  </div>
                  <div className="reel-done-side">
                    <strong>Exported — {fmtSeconds(render.totalDuration)}, {fmtBytes(render.sizeBytes)}</strong>
                    <p className="reel-dim">
                      This is the real file: captions burnt in, everything squared to{' '}
                      {status?.toolchain.width ?? 1080}×{status?.toolchain.height ?? 1920}.
                    </p>
                    <a className="mkt-primary mkt-primary-sm" href={`${render.url}?download=1`} download>
                      Download
                    </a>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {render?.status === 'ready' ? (
        <section className="mkt-panel">
          <h4>5. Post to Instagram</h4>
          <p className="mkt-panel-hint">
            Instagram does not accept an upload — it fetches the video from a public URL of ours, transcodes it, and
            then publishes. So the tunnel has to be up and <code>PUBLIC_BASE_URL</code> has to be how the outside world
            sees this server.
          </p>

          {ig?.configured ? (
            <>
              <div className="reel-ig-status">
                <span className="reel-flag reel-flag-ok">Connected</span>
                <span className="reel-dim">
                  {account?.username ? `@${account.username}` : `Graph ${ig.graphVersion}`} · serving from{' '}
                  {ig.publicBaseUrl}
                </span>
                <button type="button" className="mkt-chip" onClick={checkAccount}>
                  Check the connection
                </button>
              </div>

              {target === 'reel' ? (
                <div className="mkt-form">
                  <label className="mkt-field mkt-field-wide">
                    <span>Caption</span>
                    <textarea
                      rows={3}
                      maxLength={2200}
                      value={caption}
                      placeholder="What is in this cook, and where to order."
                      onChange={(event) => setCaption(event.target.value)}
                    />
                  </label>
                  <label className="reel-check">
                    <input
                      type="checkbox"
                      checked={shareToFeed}
                      onChange={(event) => setShareToFeed(event.target.checked)}
                    />
                    <span>Also show it on the profile grid</span>
                  </label>
                </div>
              ) : (
                <p className="reel-dim">Stories carry no caption — Instagram drops one if it is sent, so none is.</p>
              )}

              <div className="reel-export-actions">
                <button
                  type="button"
                  className="mkt-primary"
                  disabled={publish?.status === 'publishing' || overLimit}
                  onClick={startPublish}
                >
                  {publish?.status === 'publishing'
                    ? 'Posting…'
                    : `Post as a ${target === 'reel' ? 'Reel' : 'Story'}`}
                </button>
              </div>

              {publish ? (
                <div className="reel-publish">
                  {publish.status === 'publishing' ? (
                    <span className="reel-dim">
                      {publish.stage === 'creating'
                        ? 'Handing Instagram the video URL…'
                        : publish.stage === 'processing'
                          ? 'Instagram is transcoding it — this takes a moment…'
                          : 'Publishing…'}
                    </span>
                  ) : null}
                  {publish.status === 'published' ? (
                    <div className="mkt-alert mkt-alert-ok">
                      Posted as a {publish.target === 'reel' ? 'Reel' : 'Story'}. Media id {publish.mediaId}.
                    </div>
                  ) : null}
                  {publish.status === 'failed' ? (
                    <div className="mkt-alert mkt-alert-error">{publish.error}</div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mkt-alert mkt-alert-warn">
              <strong>Not connected yet.</strong> Missing:{' '}
              {[
                !ig?.hasToken ? 'IG_ACCESS_TOKEN' : null,
                !ig?.hasUserId ? 'IG_USER_ID' : null,
                !ig?.publicBaseUrl ? 'PUBLIC_BASE_URL' : null,
              ]
                .filter(Boolean)
                .join(', ') || 'nothing — but PUBLIC_BASE_URL is not usable'}
              . {ig?.publicBaseProblem ? <span>{ig.publicBaseProblem} </span> : null}
              See <code>.env.example</code> for the walkthrough, then restart the server. You can still download the
              file above and post it from your phone.
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
};

export default InstaReelGenerator;
