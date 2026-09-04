import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildTrackedUrl, slug } from './trackedUrl';
import { encodeQr, qrToCanvas, qrToSvg, type QrCode } from './qrcode';

// QR & Link Builder — the other end of attribution from the ROI screen.
//
// Marketing ROI answers "where did this order come from" after the fact, by
// tagging orders by hand, because nothing we published ever said. This screen
// is what stops that being necessary: name the campaign, pick where the link
// is going and say which bit of that place it is going into, and get one
// tracked link — with its QR code — per answer.
//
// The screen opens on the only question that has to be answered — where is
// this going — and that is a deliberate shrink from what it used to ask. It
// had a destination box (every link this business has ever built points at
// the order page), a campaign box, a free-text Content box, a Keyword box, a
// library Label box and a medium picker, all above the part that matters.
// The destination is now stated rather than asked; the campaign is one
// optional field down beside the Save button, where it is first needed; the
// rest are gone.
//
// The placement question is the important one, and it is asked per source
// rather than once. "Instagram" is not an answer anybody wants: a link in the
// bio, a link in a story and a link pasted into a DM are three different
// pieces of work, and they report as one row until something separates them.
// So choosing Instagram opens Instagram's own question — link in bio, story,
// DM — and choosing Reddit opens a different one, about which subreddit. Each
// answer becomes its own link, tagged utm_content, and the suggestions come
// from the server, which seeds them and then grows the list from whatever has
// actually been published (see listSourceDetails in trackedLinks.js).
//
// The QR codes are drawn in the browser by qrcode.ts — no service, no
// network — for the reason given at the top of that file: these end up on
// paper, and paper cannot be reissued when a third-party image API changes
// its URL scheme.
//
// Backend: server/marketing/trackedLinks.js. The preview is built locally by
// trackedUrl.ts, which is a second copy of the server's builder held to it by
// a test — see the note in that file.

type Preset = {
  kind: 'channel' | 'placement';
  source: string;
  label: string;
  medium: string;
  channel: string;
  hint: string;
};

type Detail = { prompt: string; options: string[] };

type SavedLink = {
  id: string;
  label: string;
  destination: string;
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  notes: string;
  url: string;
  channel: string;
  createdAt: string;
};

type LinksResponse = {
  links: SavedLink[];
  presets: Preset[];
  details: Record<string, Detail>;
  mediums: string[];
  campaigns: { campaign: string; links: number }[];
  defaultDestination: string;
};

// One built link, ready to be shown, copied, drawn and saved.
type Built = {
  key: string;
  source: string;
  detail: string;
  title: string;
  medium: string;
  channel: string;
  url: string;
};

// The order page, and the only place a link from this screen has ever gone.
// Used when the server declares no destination of its own; a landing page
// that isn't /order is set with MARKETING_SITE_URL rather than typed here.
const ORDER_URL = 'https://smokerings.in/order';

// The five places links actually get published, first and in this order, so
// the common job is the top of the screen rather than one tile among twelve.
// Everything else the server offers stays available behind "More places".
//
// 'referral' is renamed here and only here: the server collapses Friends &
// Family, B2B and Catering onto that one source (they share it, and no rule
// can say which of the three a referral click was), and "Referral" is the
// technical name for what is, in practice, a friend sending the link on.
const FEATURED: { source: string; label?: string }[] = [
  { source: 'instagram' },
  { source: 'reddit' },
  { source: 'whatsapp' },
  { source: 'poster' },
  { source: 'referral', label: 'Friends & family' },
];

const DEFAULT_DETAIL: Detail = { prompt: 'Which one, specifically?', options: [] };

const copyToClipboard = async (text: string) => {
  // navigator.clipboard needs a secure context; this app is also served over
  // plain http on the LAN, where it is undefined. The textarea fallback is
  // what makes Copy work on the kitchen tablet.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  }
};

const download = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
};

// Same guard the ops screens use (see B2BClients.tsx). A response with no
// body at all is not a failed save — it is the backend being down or midway
// through a restart, which is a routine thing to hit while the server is
// being edited, and `resp.json()` alone reports it as "Unexpected end of JSON
// input" from somewhere inside the browser. Say which thing is missing.
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

// A filename that says what the code is for, so a folder of downloads is
// still legible a month later: qr-diwali-instagram-link-in-bio.png. The
// placement is in the name because it is now the thing that tells two codes
// for the same campaign apart.
const fileStem = (campaign: string, source: string, detail: string) =>
  ['qr', slug(campaign), slug(source), slug(detail)].filter(Boolean).join('-');

/**
 * The code itself, drawn onto a canvas.
 *
 * Canvas rather than an <img> of the SVG, because the PNG download is what
 * most people take to a printer and this way the pixels on screen are the
 * pixels in the file. Scale is fixed at whole pixels per module — see
 * qrToCanvas — so the preview never shows a blurred code that would scan
 * worse than the real one.
 */
const QrPreview = ({ code, scale = 4 }: { code: QrCode; scale?: number }) => {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvas.current) qrToCanvas(code, canvas.current, { scale });
  }, [code, scale]);

  return <canvas ref={canvas} className="qrb-canvas" aria-label={`QR code, version ${code.version}`} />;
};

const LinkCard = ({ built, campaign }: { built: Built; campaign: string }) => {
  const [copied, setCopied] = useState(false);

  // The code, or the reason there isn't one. A link past what a version 10
  // grid holds is a real (if rare) outcome, and it belongs in the card for
  // the link that caused it rather than as a page-level failure.
  const code = useMemo(() => {
    try {
      return { code: encodeQr(built.url), error: '' };
    } catch (err) {
      return { code: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [built.url]);

  const copy = async () => {
    setCopied(await copyToClipboard(built.url));
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <article className="qrb-card">
      {/* A div, not a <header>: `.marketing-dashboard header` in App.css is
          the dark hero this dashboard puts at the top of the page, and a
          <header> here inherits it — eight dark-brown bars down the results
          list. Same trap MarketingROI.tsx notes at its own page head. */}
      <div className="qrb-card-head">
        <div>
          <h5>{built.title}</h5>
          <span className="qrb-card-sub">
            utm_source={built.source}
            {built.medium ? ` · utm_medium=${built.medium}` : ''}
            {built.detail ? ` · utm_content=${slug(built.detail)}` : ''}
          </span>
        </div>
        {built.channel ? (
          <span className="qrb-badge qrb-badge-ok">Rolls up to {built.channel}</span>
        ) : (
          <span
            className="qrb-badge qrb-badge-warn"
            title="Clicks are still tracked in GA4 — but revenue from them lands in the unattributed row on the ROI screen until those orders are tagged by hand."
          >
            No channel mapping
          </span>
        )}
      </div>

      <div className="qrb-card-body">
        {code.code ? <QrPreview code={code.code} /> : null}

        <div className="qrb-card-link">
          <code className="qrb-url">{built.url}</code>
          {code.error ? <p className="qrb-error">{code.error}</p> : null}

          <div className="qrb-card-actions">
            <button type="button" className="mkt-chip" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {code.code ? (
              <>
                <button
                  type="button"
                  className="mkt-chip"
                  onClick={() => {
                    // Drawn fresh at print scale rather than lifted off the
                    // preview: 4px a module is fine on screen and coarse on a
                    // sticker, and the file is what gets enlarged.
                    const canvas = document.createElement('canvas');
                    qrToCanvas(code.code as QrCode, canvas, { scale: 16 });
                    canvas.toBlob((blob) => {
                      if (blob) download(blob, `${fileStem(campaign, built.source, built.detail)}.png`);
                    }, 'image/png');
                  }}
                >
                  PNG
                </button>
                <button
                  type="button"
                  className="mkt-chip"
                  onClick={() =>
                    download(
                      new Blob([qrToSvg(code.code as QrCode, { scale: 16 })], { type: 'image/svg+xml' }),
                      `${fileStem(campaign, built.source, built.detail)}.svg`,
                    )
                  }
                  title="Vector — what a printer wants for anything larger than a sticker"
                >
                  SVG
                </button>
                <span className="qrb-meta">
                  v{code.code.version} · {code.code.size}×{code.code.size}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
};

/**
 * One source, chosen or not, and — once chosen — its own placement question.
 *
 * The question opens inside the tile rather than in a panel below it, so the
 * answer stays attached to the thing it answers. With four sources selected
 * there are four different questions on screen at once, and a single shared
 * "Content" box (which is what this replaced) could only ever ask one of
 * them.
 */
const SourceTile = ({
  preset,
  label,
  detail,
  chosen,
  picked,
  onToggle,
  onPick,
}: {
  preset: Preset;
  label: string;
  detail: Detail;
  chosen: boolean;
  picked: string[];
  onToggle: () => void;
  onPick: (values: string[]) => void;
}) => {
  const [draft, setDraft] = useState('');

  const has = (value: string) => picked.some((item) => slug(item) === slug(value));
  const togglePick = (value: string) =>
    onPick(has(value) ? picked.filter((item) => slug(item) !== slug(value)) : [...picked, value]);

  const addDraft = () => {
    const value = draft.trim();
    if (!value) return;
    if (!has(value)) onPick([...picked, value]);
    setDraft('');
  };

  // Anything picked that the server did not suggest — typed here a moment
  // ago — still shows as a pill, so it un-picks the same way as the rest.
  const typed = picked.filter((value) => !detail.options.some((option) => slug(option) === slug(value)));

  return (
    <div className={`qrb-tile ${chosen ? 'is-on' : ''}`}>
      <button type="button" className="qrb-tile-head" onClick={onToggle} aria-pressed={chosen}>
        <span className="qrb-tick" aria-hidden="true">
          {chosen ? '✓' : '+'}
        </span>
        <span className="qrb-tile-name">
          <strong>{label}</strong>
          <span>{preset.hint || `utm_source=${preset.source}`}</span>
        </span>
      </button>

      {chosen ? (
        <div className="qrb-detail">
          <span className="qrb-detail-q">{detail.prompt}</span>
          <div className="qrb-chips">
            {detail.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`qrb-pill ${has(option) ? 'is-on' : ''}`}
                onClick={() => togglePick(option)}
              >
                {option}
              </button>
            ))}
            {typed.map((value) => (
              <button key={value} type="button" className="qrb-pill is-on" onClick={() => togglePick(value)}>
                {value}
              </button>
            ))}
          </div>
          <input
            className="qrb-detail-add"
            type="text"
            value={draft}
            placeholder="or type another…"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={addDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addDraft();
              }
            }}
          />
          <span className="qrb-meta">
            {picked.length
              ? `${picked.length} link${picked.length === 1 ? '' : 's'} from ${label}`
              : 'One untagged link — pick or type a placement to tell them apart later.'}
          </span>
        </div>
      ) : null}
    </div>
  );
};

const QRLinkBuilder = () => {
  const [data, setData] = useState<LinksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const [campaign, setCampaign] = useState('');
  // Selected sources in the order they were picked, and the placements
  // chosen under each. Two pieces of state rather than one map, because the
  // order the cards appear in should be the order the tiles were clicked.
  const [chosen, setChosen] = useState<string[]>([]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [showMore, setShowMore] = useState(false);
  const [custom, setCustom] = useState<Preset[]>([]);
  const [customSource, setCustomSource] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/marketing/links');
      const body = await readJson<LinksResponse & { error?: string }>(resp, 'Could not load the link library.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const destination = data?.defaultDestination || ORDER_URL;
  const presets = useMemo(() => [...(data?.presets || []), ...custom], [data, custom]);
  const bySource = useMemo(() => new Map(presets.map((preset) => [preset.source, preset])), [presets]);

  const featured = useMemo(
    () =>
      FEATURED.flatMap((entry) => {
        const preset = bySource.get(entry.source);
        // A featured source the server does not offer is simply not shown.
        // That is not hypothetical: 'poster' only exists once the backend
        // carrying it has been restarted (server/index.js caches its
        // modules), and a tile that renders half-built would be worse than
        // one that waits.
        return preset ? [{ preset, label: entry.label }] : [];
      }),
    [bySource],
  );

  const rest = useMemo(
    () => presets.filter((preset) => !FEATURED.some((entry) => entry.source === preset.source)),
    [presets],
  );

  const labelFor = useCallback(
    (preset: Preset) => FEATURED.find((entry) => entry.source === preset.source)?.label || preset.label,
    [],
  );

  // One link per source per placement — and one link for a source with no
  // placement picked at all, which is a legitimate thing to want and the
  // reason this is not simply a flatMap over the picks.
  const built = useMemo<Built[]>(
    () =>
      chosen.flatMap((source) => {
        const preset = bySource.get(source);
        if (!preset) return [];
        const details = picks[source]?.length ? picks[source] : [''];
        return details.map((detail) => ({
          key: `${source}::${slug(detail)}`,
          source: preset.source,
          detail,
          title: detail ? `${labelFor(preset)} — ${detail}` : labelFor(preset),
          medium: slug(preset.medium),
          channel: preset.channel,
          url: buildTrackedUrl({
            destination,
            source: preset.source,
            medium: preset.medium,
            campaign,
            content: detail,
          }),
        }));
      }),
    [chosen, picks, bySource, destination, campaign, labelFor],
  );

  const toggle = (source: string) =>
    setChosen((current) =>
      current.includes(source) ? current.filter((item) => item !== source) : [...current, source],
    );

  const addCustom = () => {
    const source = slug(customSource);
    if (!source) return;
    if (!bySource.has(source)) {
      setCustom((current) => [
        ...current,
        // No channel: nothing in orderAttribution's CHANNELS maps a source
        // we have just invented, and claiming one here would be a guess the
        // ROI screen would then report as fact. The card says so.
        { kind: 'channel', source, label: customSource.trim(), medium: 'referral', channel: '', hint: 'Added here' },
      ]);
    }
    setChosen((current) => (current.includes(source) ? current : [...current, source]));
    setCustomSource('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved('');
    try {
      const resp = await fetch('/api/marketing/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          links: built.map((item) => ({
            // The library label is not asked for any more — the source and
            // the placement already say what the link is, and a box asking
            // somebody to say it a third time was a box they left empty.
            label: item.title,
            destination,
            source: item.source,
            medium: item.medium,
            campaign,
            content: item.detail,
          })),
        }),
      });
      const body = await readJson<{ links: SavedLink[]; error?: string }>(resp, 'Could not save those links.');
      setSaved(`Saved ${body.links.length} link${body.links.length === 1 ? '' : 's'} to the library.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError('');
    try {
      const resp = await fetch(`/api/marketing/links/${id}`, { method: 'DELETE' });
      await readJson<{ deleted?: string; error?: string }>(resp, 'Could not delete that link.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const library = (data?.links || []).filter((link) => (filter ? link.campaign === filter : true));

  const tile = (preset: Preset, label?: string) => (
    <SourceTile
      key={preset.source}
      preset={preset}
      label={label || preset.label}
      detail={data?.details?.[preset.source] || DEFAULT_DETAIL}
      chosen={chosen.includes(preset.source)}
      picked={picks[preset.source] || []}
      onToggle={() => toggle(preset.source)}
      onPick={(values) => setPicks((current) => ({ ...current, [preset.source]: values }))}
    />
  );

  return (
    <div className="mkt-roi">
      <div className="mkt-head">
        <h3>QR &amp; Link Builder</h3>
        <p>
          Pick where the link is going, then say which bit of that place — the bio or a story, which subreddit, which
          friend. Every answer becomes its own tracked link to <code>{destination}</code>, with its own QR code, so an
          order arrives already saying where it came from instead of being tagged by hand a week later.
        </p>
      </div>

      {error ? <div className="mkt-alert mkt-alert-error">{error}</div> : null}
      {saved ? <div className="mkt-alert mkt-alert-ok">{saved}</div> : null}

      <section className="mkt-panel">
        <h4>Where is it going?</h4>

        <div className="qrb-tiles">{featured.map((entry) => tile(entry.preset, entry.label))}</div>

        {rest.length ? (
          <button type="button" className="qrb-more" onClick={() => setShowMore((current) => !current)}>
            {showMore ? 'Hide the rest' : `More places (${rest.length})`} — Swiggy, Zomato, flyers, packaging, stalls
          </button>
        ) : null}

        {showMore ? (
          <>
            <div className="qrb-tiles">{rest.map((preset) => tile(preset))}</div>
            <div className="qrb-custom">
              <label className="mkt-field">
                <span>Somewhere else entirely</span>
                <input
                  type="text"
                  placeholder="e.g. food-blogger-post"
                  value={customSource}
                  onChange={(event) => setCustomSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addCustom();
                    }
                  }}
                />
              </label>
              <button type="button" className="mkt-chip" onClick={addCustom} disabled={!slug(customSource)}>
                Add source
              </button>
            </div>
          </>
        ) : null}
      </section>

      {built.length ? (
        <section className="mkt-panel">
          <div className="qrb-results-head">
            <h4>
              {built.length} link{built.length === 1 ? '' : 's'}, {built.length === 1 ? 'its' : 'their'} QR{' '}
              {built.length === 1 ? 'code' : 'codes'} below
            </h4>
            {/* The campaign sits here rather than at the top of the screen,
                where it used to be the first thing asked and the first thing
                skipped. It is one field shared by everything in this batch,
                it is optional, and it only starts mattering at the point the
                batch is being looked at and saved — which is here. Typed
                once, still: a campaign name written four slightly different
                ways becomes four campaigns on the ROI screen, each with a
                quarter of the revenue. */}
            <div className="qrb-save">
              <label className="mkt-field qrb-campaign-field">
                <span>Campaign (optional)</span>
                <input
                  type="text"
                  list="qrb-campaigns"
                  placeholder="e.g. Diwali Weekend"
                  value={campaign}
                  onChange={(event) => setCampaign(event.target.value)}
                />
                <datalist id="qrb-campaigns">
                  {(data?.campaigns || []).map((item) => (
                    <option key={item.campaign} value={item.campaign}>
                      {item.links} link{item.links === 1 ? '' : 's'}
                    </option>
                  ))}
                </datalist>
              </label>
              <button type="button" className="mkt-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save to library'}
              </button>
            </div>
          </div>
          <p className="mkt-panel-hint">
            Check them before anything is published — a printed QR cannot be corrected. Saving records what went out,
            which is the only copy that exists once a sticker is on a box.
            {campaign && slug(campaign) !== campaign ? (
              <>
                {' '}
                The campaign is saved as <code>{slug(campaign)}</code>.
              </>
            ) : null}
          </p>

          <div className="qrb-cards">
            {built.map((item) => (
              <LinkCard key={item.key} built={item} campaign={campaign} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mkt-panel">
        <div className="qrb-results-head">
          <h4>Published links</h4>
          {data?.campaigns?.length ? (
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="">Every campaign</option>
              {data.campaigns.map((item) => (
                <option key={item.campaign} value={item.campaign}>
                  {item.campaign} ({item.links})
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {loading && !data ? <p className="mkt-panel-hint">Loading…</p> : null}

        {library.length ? (
          <div className="mkt-table-wrap">
            <table className="mkt-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Placement</th>
                  <th>Campaign</th>
                  <th>Channel</th>
                  <th>Link</th>
                  <th>Added</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {library.map((link) => (
                  <tr key={link.id}>
                    <td>
                      <strong>{link.source}</strong>
                      {link.medium ? <span className="qrb-meta"> · {link.medium}</span> : null}
                    </td>
                    <td>{link.content || <span className="qrb-meta">—</span>}</td>
                    <td>{link.campaign || '—'}</td>
                    <td>{link.channel || <span className="qrb-meta">unmapped</span>}</td>
                    <td>
                      <code className="qrb-url qrb-url-tight">{link.url}</code>
                    </td>
                    <td>{link.createdAt?.slice(0, 10)}</td>
                    <td className="qrb-row-actions">
                      <button type="button" className="mkt-chip" onClick={() => copyToClipboard(link.url)}>
                        Copy
                      </button>
                      <button type="button" className="mkt-chip" onClick={() => remove(link.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mkt-panel-hint">
            Nothing saved yet. Links built above and saved here are the record of what was published — which matters
            most for the printed ones, since deleting the row does not stop anybody scanning the sticker.
          </p>
        )}
      </section>
    </div>
  );
};

export default QRLinkBuilder;
