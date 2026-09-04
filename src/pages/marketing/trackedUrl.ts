// The tracked-URL builder, in the browser.
//
// This is deliberately a second implementation of buildTrackedUrl and slug
// from server/marketing/trackedLinks.js, and the duplication is the point of
// the note below — so read this before editing either.
//
// The screen shows a link, a QR code drawn from that link, and a Copy button,
// all of them live as somebody types. Asking the server for each keystroke
// would make the preview lag behind the form, and a preview that lags is a
// preview somebody copies mid-update. So the browser builds its own.
//
// The risk that creates is real: two builders that disagree means the URL on
// screen — the one copied into an Instagram bio, the one drawn into a QR code
// that goes to a printer — is not the URL the library recorded. So they are
// held to be identical by a test, in server/marketing/trackedLinks.test.js,
// which imports both and runs the same table of cases through each. Change
// one, change the other, and that test is what says you did.
//
// Everything the server's version says about why applies here too: values are
// slugged so GA4 does not report Instagram and instagram as two sources; an
// absent parameter is deleted from the destination rather than inherited;
// the params come out sorted so the same link always renders the same way.

export type LinkParts = {
  destination: string;
  source: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
};

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export function slug(value: string | undefined | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The published link, or a thrown error explaining what is wrong with the
 * destination. The screen catches that and shows it where the link would be,
 * which is the right place for it — an unbuildable link has no preview.
 */
export function buildTrackedUrl({ destination, source, medium, campaign, content, term }: LinkParts): string {
  const raw = String(destination || '').trim();
  if (!raw) throw new Error('A destination URL is required — the link has to point somewhere.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL. It needs the https:// on the front.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The destination has to be an http or https URL — UTM parameters cannot ride on anything else.');
  }

  const values: Record<string, string> = {
    utm_source: slug(source),
    utm_medium: slug(medium),
    utm_campaign: slug(campaign),
    utm_content: slug(content),
    utm_term: slug(term),
  };

  UTM_KEYS.forEach((key) => {
    if (values[key]) url.searchParams.set(key, values[key]);
    else url.searchParams.delete(key);
  });

  url.searchParams.sort();
  return url.toString();
}
