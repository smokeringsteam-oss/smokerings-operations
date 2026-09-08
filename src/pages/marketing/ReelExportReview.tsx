import React, { useEffect } from 'react';
import ShareStep, { type ReelDestinationStatus } from './ShareStep';
import type { ReelTarget } from './reelSettings';

// The screen that opens the moment Export is pressed, and does not close
// until the reel has gone somewhere.
//
// It used to be two panels stacked under the editor: a progress bar at the
// bottom of section 4 and the destinations under it in section 5. That is a
// bad shape for this particular moment, for two reasons that have nothing to
// do with looks.
//
// The first is that the progress bar was below the fold on a page that is
// already three screens tall, so the usual experience of exporting was
// pressing a button and watching nothing happen. When it did fail, the
// failure was down there too.
//
// The second is the one that actually matters: what comes out of ffmpeg is
// not what the editor was showing. The preview draws captions as HTML over a
// <video> and seeks between clips; the file has them burnt in, every clip
// padded to one canvas, the music mixed and the cuts encoded as one
// continuous stream. Those two can differ — a caption that clears the frame
// in the preview can sit under Instagram's reply bar in the file, and a
// landscape shot that looked full-bleed can come out with black down both
// sides. So the last thing before publishing should be the actual file,
// playing, at a size where you can see it, with nothing else competing for
// the screen. Check it, then pick where it goes.
//
// Hence: an overlay, the render as large as the window allows, the facts of
// the file beside it, and the destination picker directly underneath. The
// editor is still there behind it and one button away — this covers the
// editor rather than replacing it, so going back to fix a caption costs
// nothing and loses nothing.

export type ReelRenderView = {
  status: 'rendering' | 'ready' | 'failed';
  percent: number;
  error: string | null;
  warnings: string[];
  totalDuration: number;
  sizeBytes: number;
  url: string | null;
  fileName: string | null;
  target?: ReelTarget;
  width?: number;
  height?: number;
  stalled?: number;
};

type Props = {
  render: ReelRenderView;
  /** The target picked in the editor. Only used where the render itself does
   *  not say — a render recovered from disk after a server restart knows its
   *  dimensions but not which of the three 1080x1920 targets it was for. */
  fallbackTarget: ReelTarget;
  targetLabel: string;
  /** The editor's own total, used while the render is still running and the
   *  server has not reported a duration back yet. */
  plannedDuration: number;
  status: ReelDestinationStatus | null;
  igUsername: string | null;
  /** Handed straight to the Share step, which explains what it is for. */
  suggestedCaption?: string;
  fmtSeconds: (seconds: number) => string;
  fmtBytes: (bytes: number) => string;
  onClose: () => void;
  onRetry: () => void;
  onCheckAccount: () => void;
  onCheckDriveFolder: () => void;
};

const ReelExportReview: React.FC<Props> = ({
  render,
  fallbackTarget,
  targetLabel,
  plannedDuration,
  status,
  igUsername,
  suggestedCaption,
  fmtSeconds,
  fmtBytes,
  onClose,
  onRetry,
  onCheckAccount,
  onCheckDriveFolder,
}) => {
  // Escape goes back to the editor. A full-screen layer with no keyboard way
  // out is a trap, and this one is opened by a button press that a person can
  // reasonably want to take back a second later.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The page behind must not scroll under the overlay: a wheel over the
  // overlay that moves the editor instead reads as the overlay being broken.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const width = render.width || 1080;
  const height = render.height || 1920;
  const duration = render.totalDuration || plannedDuration;
  const renderedTarget = render.target ?? fallbackTarget;

  return (
    <div className="reel-review" role="dialog" aria-modal="true" aria-label="Final cut">
      <div className="reel-review-bar">
        <div>
          <strong>Final cut</strong>
          <span className="reel-dim">
            {render.status === 'ready'
              ? `This is the file — ${targetLabel}, ${width}×${height}. Check it, then send it.`
              : render.status === 'failed'
                ? 'The export did not finish.'
                : `Encoding for ${targetLabel}.`}
          </span>
        </div>
        <button type="button" className="mkt-chip" onClick={onClose}>
          Back to the editor
        </button>
      </div>

      <div className="reel-review-body">
        {render.status === 'rendering' ? (
          <div className="reel-review-wait">
            <div className="reel-bar">
              <div className="reel-bar-fill" style={{ width: `${render.percent}%` }} />
            </div>
            <strong>Stitching, padding and encoding — {render.percent}%</strong>
            <p className="reel-dim">
              Every clip is being squared to {width}×{height} at 30fps, the captions burnt in and the cuts encoded as
              one continuous stream. Roughly a second of encoding per second of reel.
            </p>
            {/* Said out loud rather than left as a bar that has stopped
                moving. The encode is a process on the server and it does not
                care that this tab cannot reach it for a moment. */}
            {render.stalled ? (
              <p className="mkt-error">
                Lost contact with the server — the encode is still running, and this will pick it back up as soon as it
                answers.
              </p>
            ) : null}
          </div>
        ) : null}

        {render.status === 'failed' ? (
          <div className="reel-review-wait">
            <div className="mkt-alert mkt-alert-error">{render.error || 'The export failed.'}</div>
            <div className="reel-export-actions">
              <button type="button" className="mkt-primary" onClick={onRetry}>
                Try the export again
              </button>
              <button type="button" className="mkt-chip" onClick={onClose}>
                Back to the editor
              </button>
            </div>
          </div>
        ) : null}

        {render.status === 'ready' && render.url ? (
          <>
            <div className="reel-review-cut">
              <div
                className="reel-phone reel-review-frame"
                style={{ '--reel-frame-aspect': String(width / height) } as React.CSSProperties}
              >
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video src={render.url} controls playsInline autoPlay />
              </div>

              <div className="reel-review-facts">
                <h4>{targetLabel}</h4>
                <dl className="reel-facts">
                  <div>
                    <dt>Length</dt>
                    <dd>{fmtSeconds(duration)}</dd>
                  </div>
                  <div>
                    <dt>Frame</dt>
                    <dd>
                      {width}×{height}
                    </dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{fmtBytes(render.sizeBytes)}</dd>
                  </div>
                </dl>
                <p className="reel-dim">
                  Captions are burnt in and the music is mixed — what plays here is exactly what a viewer gets. The
                  black bars, if there are any, are in the file too.
                </p>
                <a className="mkt-primary mkt-primary-sm" href={`${render.url}?download=1`} download>
                  Download the file
                </a>

                {(render.warnings || []).map((warning) => (
                  <div key={warning} className="mkt-alert mkt-alert-warn">
                    {warning}
                  </div>
                ))}
              </div>
            </div>

            <ShareStep
              fileName={render.fileName as string}
              durationSeconds={duration}
              renderedTarget={renderedTarget}
              status={status}
              igUsername={igUsername}
              suggestedCaption={suggestedCaption}
              onCheckAccount={onCheckAccount}
              onCheckDriveFolder={onCheckDriveFolder}
            />
          </>
        ) : null}
      </div>
    </div>
  );
};

export default ReelExportReview;
