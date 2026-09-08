import React, { useEffect } from 'react';

// Picking a finished reel out of Drive to send somewhere else.
//
// The case this exists for: a cook goes up as a Story on Friday and is worth
// a Short a fortnight later. By then the render is gone — server/uploads is
// swept after seven days on purpose, because those are working files and
// Drive is where the master went. Without this the only way back is to
// re-upload the clips and re-cut the whole thing.
//
// What is listed is the video in one Drive folder — the same folder the source
// footage is picked from, because a reel's inputs and its masters live
// together. That used to be free: under a drive.file-only scope the app could
// see nothing but its own uploads, so "everything visible" and "the finished
// reels" were the same set. Reading raw footage needed drive.readonly, which
// ended that, and the two directions are now told apart by a private
// appProperties mark the upload writes. See googleDrive.js.
//
// The consequence worth knowing: a master uploaded before that mark existed is
// still listed here (it is video in the folder) and will also appear in the
// clip picker, where it is not source footage. One odd-looking row, and it
// ages out as reels are made.
//
// Deliberately not a general file browser. There is no folder navigation and
// no search, because the folder is the whole of what this feature can reach —
// and a picker that looked like it could roam the account would be promising
// something the code deliberately refuses to do.

export type DriveReel = {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  webViewLink: string;
  width: number;
  height: number;
  duration: number;
};

type Props = {
  files: DriveReel[] | null;
  error: string;
  /** The id currently being pulled down, so the row that was clicked is the
   *  one that says so — a single shared "importing…" would leave the other
   *  rows looking clickable while a download is in flight. */
  busyId: string | null;
  onPick: (file: DriveReel) => void;
  onClose: () => void;
  fmtSeconds: (seconds: number) => string;
  fmtBytes: (bytes: number) => string;
};

const fmtWhen = (iso: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const DriveImportPicker: React.FC<Props> = ({
  files,
  error,
  busyId,
  onPick,
  onClose,
  fmtSeconds,
  fmtBytes,
}) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Not while a download is running: closing mid-import would leave the
      // file arriving with nothing on screen expecting it.
      if (event.key === 'Escape' && !busyId) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busyId]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="reel-review" role="dialog" aria-modal="true" aria-label="Repost from Drive">
      <div className="reel-review-bar">
        <div>
          <strong>Repost from Drive</strong>
          <span className="reel-dim">
            Every reel this app has uploaded. Pick one and it comes back ready to send anywhere.
          </span>
        </div>
        <button type="button" className="mkt-chip" disabled={Boolean(busyId)} onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="reel-review-body">
        <div className="reel-review-wait drive-pick">
          {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}

          {!files && !error ? <p className="reel-dim">Asking Drive what is in the folder…</p> : null}

          {files && !files.length ? (
            <>
              <strong>Nothing in the folder yet.</strong>
              <p className="reel-dim">
                Reels appear here once they have been shared to Drive from the final-cut screen. Only files this app
                uploaded are visible to it, so anything put in the folder by hand will not be listed.
              </p>
            </>
          ) : null}

          {files && files.length ? (
            <ul className="drive-list">
              {files.map((file) => {
                const upright = file.height >= file.width && file.height > 0;
                const busy = busyId === file.id;
                return (
                  <li key={file.id} className={`drive-row${busy ? ' drive-row-busy' : ''}`}>
                    <button
                      type="button"
                      className="drive-row-pick"
                      disabled={Boolean(busyId)}
                      onClick={() => onPick(file)}
                    >
                      <span className="drive-row-name">{file.name}</span>
                      <span className="drive-row-facts">
                        {file.width && file.height ? (
                          <>
                            <span className={`reel-flag ${upright ? 'reel-flag-ok' : ''}`}>
                              {upright ? 'Upright' : 'Landscape'}
                            </span>
                            {file.width}×{file.height}
                          </>
                        ) : null}
                        {file.duration ? ` · ${fmtSeconds(file.duration)}` : ''}
                        {file.sizeBytes ? ` · ${fmtBytes(file.sizeBytes)}` : ''}
                        {fmtWhen(file.createdAt) ? ` · ${fmtWhen(file.createdAt)}` : ''}
                      </span>
                    </button>
                    {busy ? <span className="reel-dim">Downloading…</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default DriveImportPicker;
