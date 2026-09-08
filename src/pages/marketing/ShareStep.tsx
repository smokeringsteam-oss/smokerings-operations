import React, { useEffect, useMemo, useState } from 'react';
import type { ReelTarget } from './reelSettings';

// Where a finished reel goes, once it exists.
//
// This replaced a step that could do exactly one thing — post to Instagram —
// and the shape of it is the point. The question after an export is not
// "which single platform", it is "this is done, put it out": a cook goes to a
// Story and a Short and the Drive folder, and doing that as three separate
// trips through a form is three chances to publish two of them and forget the
// third.
//
// So the destinations are checkboxes, not a dropdown, and there is one
// button. What you type is shared wherever it means the same thing — one
// caption box feeds Instagram's caption and YouTube's description, because
// writing the same sentence twice is how the two drift apart — and a field
// only appears when a destination that needs it is ticked. Nothing else is on
// screen.
//
// A destination that cannot take this particular render is shown greyed with
// the reason rather than hidden. A missing tile reads as a missing feature;
// "Story — this reel is 74s, the cap is 60s" reads as an instruction.
//
// The four video destinations are the same four targets the Export step
// offers, because they are the same four decisions: a Story and a Short want
// different lengths, and a YouTube video wants a different shape entirely.
// Drive is the fifth and takes anything, which is the point of it.

export type ReelDestinationStatus = {
  instagram: { configured: boolean };
  youtube: {
    configured: boolean;
    hasClient: boolean;
    signedIn: boolean;
    error: string;
    privacyStatuses: string[];
  };
  drive: { configured: boolean; folderId: string; account: string; error: string };
  toolchain: {
    storyMaxSeconds: number;
    reelMaxSeconds: number;
    targets?: { id: string; label: string; maxSeconds: number; width: number; height: number }[];
  };
};

type DestinationId = ReelTarget | 'drive';

// One row per destination while it is in flight and after it lands. Kept per
// destination rather than as one shared status because they finish at
// different times and a single "publishing…" line would go quiet while two of
// the three were still running.
type ShareJob = {
  id: string;
  state: 'running' | 'done' | 'failed';
  stage: string;
  error: string | null;
  link: string | null;
  linkLabel: string | null;
  note: string | null;
};

type Props = {
  fileName: string;
  durationSeconds: number;
  /** The target the file on disk was actually rendered for. A vertical render
   *  cannot sensibly go up as a landscape YouTube video and the reverse is
   *  worse, so the tile that does not match the file says so rather than
   *  quietly posting a letterboxed reel. */
  renderedTarget: ReelTarget;
  status: ReelDestinationStatus | null;
  igUsername: string | null;
  /** What the caption model wrote for the post, if it wrote anything. Used as
   *  the starting text of the caption box rather than as its value: it is a
   *  draft to edit, so typing over it must stick, and a later re-render of
   *  this component must not undo the edit. */
  suggestedCaption?: string;
  onCheckAccount: () => void;
  onCheckDriveFolder: () => void;
};

const DESTINATIONS: { id: DestinationId; label: string; sub: string; emoji: string }[] = [
  { id: 'ig-story', label: 'Instagram Story', sub: '24 hours, no caption', emoji: '⚡' },
  { id: 'ig-reel', label: 'Instagram Reel', sub: 'Stays on the profile', emoji: '🎬' },
  { id: 'yt-short', label: 'YouTube Short', sub: 'Vertical, under 3 min', emoji: '▶️' },
  { id: 'yt-video', label: 'YouTube Video', sub: 'Landscape, any length', emoji: '📺' },
  { id: 'drive', label: 'Google Drive', sub: 'The untouched master', emoji: '📁' },
];

const IS_YOUTUBE = (id: DestinationId) => id === 'yt-short' || id === 'yt-video';
const IS_INSTAGRAM = (id: DestinationId) => id === 'ig-story' || id === 'ig-reel';

// Whether a destination wants the file upright. Drive takes it either way.
const WANTS_UPRIGHT: Partial<Record<DestinationId, boolean>> = {
  'ig-story': true,
  'ig-reel': true,
  'yt-short': true,
  'yt-video': false,
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((json as { error?: string }).error || 'That did not go through.');
  return json as T;
}

const ShareStep: React.FC<Props> = ({
  fileName,
  durationSeconds,
  renderedTarget,
  status,
  igUsername,
  suggestedCaption = '',
  onCheckAccount,
  onCheckDriveFolder,
}) => {
  const [selected, setSelected] = useState<DestinationId[]>([]);
  // Seeded once, from the initial-state argument rather than an effect. An
  // effect syncing this to the prop would wipe whatever had been typed every
  // time the parent re-rendered, which it does on every poll tick.
  const [caption, setCaption] = useState(suggestedCaption);
  const [title, setTitle] = useState('');
  const [privacy, setPrivacy] = useState('public');
  const [shareToFeed, setShareToFeed] = useState(true);
  const [jobs, setJobs] = useState<Partial<Record<DestinationId, ShareJob>>>({});
  const [error, setError] = useState('');

  // The caps come from the server's own target table where it has answered,
  // so a limit is described in exactly one place.
  const capOf = (id: DestinationId, fallback: number) =>
    status?.toolchain.targets?.find((spec) => spec.id === id)?.maxSeconds ?? fallback;

  // Why each destination is or isn't available, worked out once. The reason
  // travels with the flag so the tile can say it rather than just look dead.
  const availability = useMemo((): Record<DestinationId, { ok: boolean; reason: string }> => {
    const ig = status?.instagram.configured ?? false;
    const igReason = ig ? '' : 'Instagram is not connected — set IG_ACCESS_TOKEN, IG_USER_ID and PUBLIC_BASE_URL.';
    const ytReason = status?.youtube.configured ? '' : status?.youtube.error || 'YouTube is not connected.';
    const tooLong = (cap: number) =>
      cap && durationSeconds > cap ? `This reel is ${Math.round(durationSeconds)}s and the cap is ${cap}s.` : '';

    // The render is one shape and it is on disk. Posting a 16:9 file as a
    // Story pillarboxes it into a letterbox in a frame, which is not a thing
    // anyone meant to publish — so the mismatch is a reason, not a surprise.
    const renderedUpright = WANTS_UPRIGHT[renderedTarget] !== false;
    const wrongShape = (id: DestinationId) => {
      const wants = WANTS_UPRIGHT[id];
      if (wants === undefined || wants === renderedUpright) return '';
      return wants
        ? 'This was exported landscape. Re-export it as a Story, Reel or Short first.'
        : 'This was exported upright. Re-export it as a YouTube Video first.';
    };

    const reason = (id: DestinationId, connection: string, cap: number) =>
      connection || wrongShape(id) || tooLong(cap);

    const build = (id: DestinationId, connected: boolean, connection: string, cap: number) => {
      const why = reason(id, connection, cap);
      return { ok: connected && !why, reason: why };
    };

    return {
      'ig-story': build('ig-story', ig, igReason, capOf('ig-story', 60)),
      'ig-reel': build('ig-reel', ig, igReason, capOf('ig-reel', 90)),
      'yt-short': build('yt-short', status?.youtube.configured ?? false, ytReason, capOf('yt-short', 180)),
      'yt-video': build('yt-video', status?.youtube.configured ?? false, ytReason, 0),
      drive: { ok: status?.drive.configured ?? false, reason: status?.drive.error || '' },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, durationSeconds, renderedTarget]);

  // A destination that stops being available — the render was replaced with a
  // longer one — must not stay ticked and silently fail on the next press.
  useEffect(() => {
    setSelected((current) => current.filter((id) => availability[id].ok));
  }, [availability]);

  const toggle = (id: DestinationId) => {
    if (!availability[id].ok) return;
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const wantsCaption = selected.includes('ig-reel') || selected.some(IS_YOUTUBE);
  const wantsTitle = selected.some(IS_YOUTUBE);
  const running = Object.values(jobs).some((job) => job?.state === 'running');

  const setJob = (id: DestinationId, patch: Partial<ShareJob>) =>
    setJobs((current) => ({ ...current, [id]: { ...(current[id] as ShareJob), ...patch } }));

  // Polls one background job to completion. Each destination gets its own
  // loop: they are independent on the server and a shared poll would hold the
  // fastest one's result back until the slowest finished.
  const followJob = async (
    id: DestinationId,
    url: string,
    read: (body: Record<string, unknown>) => Partial<ShareJob>,
  ) => {
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      try {
        const resp = await fetch(url);
        const body = (await resp.json()) as Record<string, unknown>;
        if (!resp.ok) throw new Error((body.error as string) || 'Lost track of that.');
        const status = String(body.status || '');
        if (status === 'failed') {
          setJob(id, { state: 'failed', error: String(body.error || 'It failed.') });
          return;
        }
        if (status === 'published' || status === 'uploaded') {
          setJob(id, { state: 'done', stage: 'done', ...read(body) });
          return;
        }
        setJob(id, { stage: String(body.stage || '') });
      } catch (err) {
        setJob(id, { state: 'failed', error: errorText(err) });
        return;
      }
    }
  };

  const share = async () => {
    setError('');
    // Every destination starts at once. They are separate calls to separate
    // services and one being slow is no reason for the others to wait.
    selected.forEach((id) => {
      setJobs((current) => ({
        ...current,
        [id]: { id, state: 'running', stage: 'starting', error: null, link: null, linkLabel: null, note: null },
      }));
    });

    await Promise.all(
      selected.map(async (id) => {
        try {
          if (IS_INSTAGRAM(id)) {
            const target = id === 'ig-reel' ? 'reel' : 'story';
            const body = await postJson<{ publishId: string }>('/api/marketing/reel/publish', {
              fileName,
              target,
              caption: target === 'reel' ? caption : '',
              shareToFeed: target === 'reel' ? shareToFeed : false,
            });
            await followJob(id, `/api/marketing/reel/publish/${body.publishId}`, () => ({
              note: target === 'reel' ? 'Live on the profile.' : 'Live for 24 hours.',
            }));
            return;
          }
          if (IS_YOUTUBE(id)) {
            const body = await postJson<{ uploadId: string }>('/api/marketing/reel/youtube', {
              fileName,
              title,
              description: caption,
              privacyStatus: privacy,
            });
            await followJob(id, `/api/marketing/reel/youtube/${body.uploadId}`, (job) => ({
              link: (job.url as string) || null,
              linkLabel: 'Watch',
              // The one case where what happened is not what was asked for:
              // an API project that has not passed YouTube's audit forces
              // every upload to private, and says nothing about it.
              note: job.forcedPrivate
                ? 'YouTube forced this to Private — that is the unaudited-project cap, not a failure. Publish it in Studio.'
                : `Uploaded as ${String(job.privacyStatus || '')}.`,
            }));
            return;
          }
          const body = await postJson<{ uploadId: string }>('/api/marketing/reel/drive', { fileName });
          await followJob(id, `/api/marketing/reel/drive/${body.uploadId}`, (job) => ({
            link: (job.webViewLink as string) || null,
            linkLabel: 'Open in Drive',
            note: 'The original file, not re-encoded.',
          }));
        } catch (err) {
          setJob(id, { state: 'failed', error: errorText(err) });
        }
      }),
    );
  };

  const label = DESTINATIONS.reduce<Record<string, string>>((all, d) => ({ ...all, [d.id]: d.label }), {});

  return (
    <section className="mkt-panel">
      {/* Not "step 5" any more: this sits inside the final-cut review rather
          than at the bottom of the numbered page, and the file it is aimed at
          is already on screen above it. */}
      <h4>Where does it go?</h4>
      <p className="mkt-panel-hint">
        Tick everywhere this cook should go — they all start at once and report back on their own. A destination that
        cannot take this particular file says why instead of disappearing.
      </p>

      <div className="share-grid">
        {DESTINATIONS.map((destination) => {
          const { ok, reason } = availability[destination.id];
          const on = selected.includes(destination.id);
          return (
            <button
              type="button"
              key={destination.id}
              className={['share-tile', on ? 'share-tile-on' : '', ok ? '' : 'share-tile-off'].filter(Boolean).join(' ')}
              onClick={() => toggle(destination.id)}
              disabled={!ok || running}
              aria-pressed={on}
              title={ok ? '' : reason}
            >
              <span className="share-tile-emoji">{destination.emoji}</span>
              <span className="share-tile-label">{destination.label}</span>
              <span className="share-tile-sub">{ok ? destination.sub : reason}</span>
            </button>
          );
        })}
      </div>

      {selected.length > 0 ? (
        <div className="share-fields">
          {wantsTitle ? (
            <label className="mkt-field mkt-field-wide">
              <span>Title — YouTube only</span>
              <input
                value={title}
                maxLength={100}
                placeholder="Pulled pork, 12 hours on the smoker"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : null}

          {wantsCaption ? (
            <label className="mkt-field mkt-field-wide">
              <span>
                {selected.includes('ig-reel') && selected.some(IS_YOUTUBE)
                  ? 'Caption — the Reel caption and the YouTube description'
                  : selected.some(IS_YOUTUBE)
                    ? 'Description'
                    : 'Caption'}
              </span>
              <textarea
                rows={3}
                maxLength={2200}
                value={caption}
                placeholder="What is in this cook, and where to order."
                onChange={(event) => setCaption(event.target.value)}
              />
            </label>
          ) : null}

          <div className="share-options">
            {selected.includes('ig-reel') ? (
              <label className="reel-check">
                <input
                  type="checkbox"
                  checked={shareToFeed}
                  onChange={(event) => setShareToFeed(event.target.checked)}
                />
                <span>Also show the Reel on the profile grid</span>
              </label>
            ) : null}
            {wantsTitle ? (
              <label className="reel-check">
                <span>YouTube visibility</span>
                <select value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
                  {(status?.youtube.privacyStatuses || ['public', 'unlisted', 'private']).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {selected.includes('ig-story') ? (
            <p className="reel-dim">Stories carry no caption — Instagram drops one if it is sent, so none is.</p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mkt-error">{error}</p> : null}

      <div className="reel-export-actions">
        <button
          type="button"
          className="mkt-primary"
          disabled={selected.length === 0 || running || (wantsTitle && !title.trim())}
          onClick={share}
        >
          {running
            ? 'Sending…'
            : selected.length === 0
              ? 'Pick where it goes'
              : `Share to ${selected.length} ${selected.length === 1 ? 'place' : 'places'}`}
        </button>
        {wantsTitle && !title.trim() ? <span className="reel-dim">YouTube needs a title.</span> : null}
      </div>

      {Object.keys(jobs).length > 0 ? (
        <ul className="share-results">
          {(Object.keys(jobs) as DestinationId[]).map((id) => {
            const job = jobs[id] as ShareJob;
            return (
              <li key={id} className={`share-result share-result-${job.state}`}>
                <span className="share-result-name">{label[id]}</span>
                {job.state === 'running' ? <span className="reel-dim">{job.stage}…</span> : null}
                {job.state === 'done' ? (
                  <>
                    <span className="reel-flag reel-flag-ok">Done</span>
                    {job.note ? <span className="reel-dim">{job.note}</span> : null}
                    {job.link ? (
                      <a href={job.link} target="_blank" rel="noreferrer">
                        {job.linkLabel}
                      </a>
                    ) : null}
                  </>
                ) : null}
                {job.state === 'failed' ? <span className="mkt-error">{job.error}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* The two connection checks, out of the way at the bottom. They matter
          the day something is set up and never again. */}
      <div className="share-checks">
        {status?.instagram.configured ? (
          <button type="button" className="mkt-chip" onClick={onCheckAccount}>
            {igUsername ? `Instagram: @${igUsername}` : 'Check Instagram'}
          </button>
        ) : null}
        {status?.drive.configured ? (
          <button type="button" className="mkt-chip" onClick={onCheckDriveFolder}>
            Check the Drive folder
          </button>
        ) : null}
      </div>
    </section>
  );
};

export default ShareStep;
