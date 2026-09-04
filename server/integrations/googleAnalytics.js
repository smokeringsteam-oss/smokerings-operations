// Google Analytics 4, for the traffic half of the Marketing ROI screen: how
// many sessions each source/medium/campaign sent to the site, next to what
// those visits were worth in Odoo.
//
// Talks to the GA4 Data API over plain fetch, and mints its own OAuth token
// from a service account key rather than pulling in googleapis or
// @google-analytics/data. That is the same "raw API over fetch" choice
// odoo.js and githubProjects.js already make, and here it buys something
// specific: the whole Google client stack is a large dependency tree for two
// HTTP calls, one of which is a signature this file does in nine lines with
// node:crypto.
//
// Setup, once:
//   1. Google Cloud console > IAM > Service Accounts > create one, then Keys
//      > Add key > JSON.
//   2. Enable the "Google Analytics Data API" on that project.
//   3. GA4 admin > Property Access Management > add the service account's
//      client_email as a Viewer.
//   4. Copy two fields out of that JSON into .env — client_email into
//      GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key into
//      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY — alongside GA4_PROPERTY_ID (the
//      numeric property id, not the G- measurement id).
//
// Credentials are configuration, not a file to mount. A service account is
// two strings; requiring a path to the downloaded JSON means a second secret
// to keep in step with .env on every machine this runs on, and it breaks the
// moment the file is moved. The whole-JSON forms
// (GOOGLE_SERVICE_ACCOUNT_KEY, raw or base64) and the file form
// (GOOGLE_SERVICE_ACCOUNT_KEY_FILE) still work for hosts that mount secrets
// that way, but the two plain fields are the route to document.
//
// Nothing here throws when it is unconfigured. The ROI screen has to work on
// the Odoo half alone -- invested vs generated is answerable without ever
// knowing a session count -- so isConfigured() is checked by the caller and
// the traffic block is simply absent when GA is not set up. A GA outage must
// not take the revenue figures down with it.
import crypto from 'crypto';
import fs from 'fs';

// Read-only is all this ever needs, and the narrowest scope Google offers for
// the Data API.
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

// NOTE: carries the raw private key. Never hand this object to a route --
// /api/marketing/status picks the safe fields out of describeConfig().
function getConfig() {
  // Accepts the three forms the id gets copied in as: the bare number, the
  // API's "properties/550057156", and the "p550057156" the Analytics URL
  // shows (which is what anybody reading it off the address bar will paste).
  // A property id is all digits, so stripping a leading "p" cannot eat part
  // of a real one.
  const propertyId = String(process.env.GA4_PROPERTY_ID || '')
    .trim()
    .replace(/^properties\//, '')
    .replace(/^p(?=\d)/, '');
  // The two credential fields, straight out of the JSON Google hands over.
  // This is the form to prefer: a service account is two strings, and asking
  // for a file path means a secret that has to be mounted, backed up and kept
  // in step with .env on every machine the dashboard runs on.
  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim();
  // Whole-JSON forms, for pasting the downloaded file's contents in one go:
  // raw JSON, or the same base64-encoded (which survives a .env, a CI secret
  // and a copy-paste without any quoting to get wrong).
  const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').trim();
  // Still honoured for anyone already set up this way, and for hosts that
  // mount a secret as a file. No longer the documented route.
  const keyFile = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '').trim();

  const keySource = email || privateKey ? 'config' : inline ? 'inline' : keyFile ? 'file' : '';

  let key = null;
  let keyError = '';

  // \n arrives escaped whenever the PEM came through an environment variable
  // rather than a file; createSign needs the real newlines. Surrounding
  // quotes are stripped too — a .env value is already unquoted by dotenv, so
  // a pair still present means they were pasted as part of the value.
  const normalisePem = (pem) =>
    String(pem)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
      .replace(/\\n/g, '\n');

  if (keySource === 'config') {
    if (!email) {
      keyError = 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is set but GOOGLE_SERVICE_ACCOUNT_EMAIL is not. Both come from the service account JSON: client_email and private_key.';
    } else if (!privateKey) {
      keyError = 'GOOGLE_SERVICE_ACCOUNT_EMAIL is set but GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not. The private key is the "private_key" field of the service account JSON, the whole BEGIN/END block.';
    } else if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(normalisePem(privateKey))) {
      // The easy mistake, named rather than left to fail at signing time:
      // pasting the private_key_id (a 40-character hex string) into the
      // variable that wants the key itself. The id is not a credential and
      // cannot be turned back into one — Google shows the private key exactly
      // once, when the key is created.
      keyError = /^[0-9a-f]{40}$/i.test(privateKey)
        ? `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is set to "${privateKey}", which is the private_key_id, not the key. It needs the "private_key" field of the service account JSON — the block starting "-----BEGIN PRIVATE KEY-----". If that JSON is gone, make a new key: Cloud console > IAM > Service Accounts > Keys > Add key > JSON.`
        : 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY does not look like a PEM private key: it should start with "-----BEGIN PRIVATE KEY-----".';
    } else {
      key = { email, privateKey: normalisePem(privateKey) };
    }
  } else if (inline || keyFile) {
    try {
      let raw = keyFile ? fs.readFileSync(keyFile, 'utf8') : inline;
      // Base64 of the JSON is accepted wherever the JSON is. A service
      // account key is never itself base64, so this cannot misread a real
      // one — and a JSON document always starts with "{".
      if (raw.trim()[0] !== '{' && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      }
      const parsed = JSON.parse(raw);
      if (!parsed.client_email || !parsed.private_key) {
        keyError = 'The service account JSON has no client_email/private_key — is it an OAuth client secret rather than a service account key?';
      } else {
        key = { email: parsed.client_email, privateKey: normalisePem(parsed.private_key) };
      }
    } catch (err) {
      // Same 40-hex mistake as above, in the variable it used to be made in.
      const looksLikeKeyId = /^[0-9a-f]{40}$/i.test(keyFile);
      keyError = looksLikeKeyId
        ? `GOOGLE_SERVICE_ACCOUNT_KEY_FILE is set to "${keyFile}", which is the private_key_id, not a file path — and no file is needed. Clear it and set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY from the service account JSON instead.`
        : keyFile
          ? `Could not read GOOGLE_SERVICE_ACCOUNT_KEY_FILE (${keyFile}): ${err.message}`
          : `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`;
    }
  }

  return {
    propertyId,
    key,
    keyError,
    keySource,
    configured: Boolean(propertyId && key),
  };
}

// The status-route view of the above: says whether GA will work and, when it
// will not, which of the two halves is missing — without ever naming the key
// material itself.
function describeConfig() {
  const { propertyId, key, keyError, keySource, configured } = getConfig();
  return {
    configured,
    propertyId,
    serviceAccount: key ? key.email : '',
    keySource,
    error:
      keyError ||
      (!propertyId && !key
        ? 'GA4 is not set up: set GA4_PROPERTY_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in .env.'
        : '') ||
      (!propertyId ? 'GA4_PROPERTY_ID is not set.' : '') ||
      (!key ? 'No service account credentials: set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.' : ''),
  };
}

function isConfigured() {
  return getConfig().configured;
}

const base64url = (input) => Buffer.from(input).toString('base64url');

// One access token, reused until it is nearly expired. Google's are good for
// an hour, and the ROI screen makes several reports per load — minting a
// token per report would triple the round trips for nothing. Keyed on the
// service account email so editing .env and restarting cannot serve a token
// signed by the previous key.
let tokenCache = { email: '', token: '', expiresAt: 0 };

async function accessToken() {
  const { key } = getConfig();
  if (!key) throw configError();

  // 60s of slack, so a token that expires mid-report is refreshed before the
  // call rather than failing it.
  if (tokenCache.token && tokenCache.email === key.email && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;

  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.privateKey, 'base64url');
  } catch (err) {
    // A truncated or re-wrapped PEM fails here rather than at Google, which
    // is worth saying plainly — the error crypto raises on its own ("error:
    // 1E08010C:DECODER routines") tells nobody anything.
    const wrapped = new Error(`The service account private key could not be used to sign: ${err.message}. Check the key was copied whole, including the BEGIN/END lines.`);
    wrapped.status = 500;
    throw wrapped;
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    // Google's own description is the useful one here: "invalid_grant" for a
    // clock skew or a deleted key, "invalid_scope" for an API not enabled.
    const err = new Error(
      `Google refused the service account: ${json.error_description || json.error || `HTTP ${resp.status}`}`,
    );
    err.status = 502;
    throw err;
  }

  tokenCache = {
    email: key.email,
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

function configError() {
  const err = new Error(describeConfig().error || 'Google Analytics is not configured.');
  err.status = 400;
  throw err;
}

// The one call everything below is built on. `dimensions` and `metrics` are
// GA4 API names (sessionSource, sessions, ...); the response comes back as
// objects keyed by those names rather than GA's positional arrays, because a
// report read by index breaks silently the moment a dimension is inserted.
async function runReport({
  dimensions = [],
  metrics = [],
  fromDate,
  toDate,
  limit = 250,
  orderByMetric,
  orderByDimension,
  // A GA4 FilterExpression, passed through untouched. Needed for anything
  // built on an event-scoped custom dimension: percent_scrolled is only
  // meaningful on a scroll_depth event, and asking for it unfiltered returns
  // a "(not set)" row for every other event on the property -- see the
  // reports at the bottom of this file.
  dimensionFilter,
}) {
  const { propertyId } = getConfig();
  if (!isConfigured()) configError();

  const body = {
    dateRanges: [{ startDate: fromDate, endDate: toDate }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
    // Sessions are a count of a thing that happened, so a source with none in
    // the window is a row of zeroes that GA is right to omit and we have no
    // use for.
    keepEmptyRows: false,
  };
  if (orderByMetric) {
    body.orderBys = [{ desc: true, metric: { metricName: orderByMetric } }];
  } else if (orderByDimension) {
    // Ascending, and by dimension, for the ladders. A scroll-depth table
    // sorted by users is just the funnel restated; the reader wants
    // 25/50/75/100 in that order, because the shape of the drop between them
    // is the whole point of the table.
    body.orderBys = [{ desc: false, dimension: { dimensionName: orderByDimension } }];
  }
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;

  const resp = await fetch(`${DATA_API}/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = json.error?.message || `HTTP ${resp.status}`;
    const err = new Error(
      // The two failures worth naming, because both look like a code bug and
      // neither is: the property id is wrong, or the service account was
      // never added to the property.
      /permission|PERMISSION_DENIED/i.test(detail)
        ? `GA4 refused the request: ${detail}. Add ${getConfig().key?.email || 'the service account'} as a Viewer under GA4 admin > Property Access Management.`
        : `GA4 report failed: ${detail}`,
    );
    err.status = 502;
    throw err;
  }

  const dimHeaders = (json.dimensionHeaders || []).map((h) => h.name);
  const metHeaders = (json.metricHeaders || []).map((h) => h.name);

  return (json.rows || []).map((row) => {
    const out = {};
    dimHeaders.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? '';
    });
    metHeaders.forEach((name, i) => {
      // Every GA4 metric arrives as a string, including the integers.
      out[name] = Number(row.metricValues?.[i]?.value ?? 0);
    });
    return out;
  });
}

// Traffic split the way the spend ledger is: by campaign within source and
// medium. `session*` dimensions rather than `firstUser*` on purpose — the
// question this screen asks is "what did the money we spent this month
// bring", which is about the visit, not about where the visitor originally
// came from months ago.
//
// keyEvents is GA4's replacement for the old `conversions` metric. It counts
// whatever the property has marked as a key event, which for a site that
// hands off to Odoo for checkout is usually the "begin order" click rather
// than a purchase — useful as a funnel step, not as revenue. Revenue on this
// screen always comes from Odoo.
async function fetchTrafficByCampaign({ fromDate, toDate }) {
  const rows = await runReport({
    dimensions: ['sessionSource', 'sessionMedium', 'sessionCampaignName'],
    metrics: ['sessions', 'totalUsers', 'keyEvents'],
    fromDate,
    toDate,
    orderByMetric: 'sessions',
  });

  return rows.map((row) => ({
    source: row.sessionSource || '(not set)',
    medium: row.sessionMedium || '(not set)',
    // GA4 says "(not set)" for a visit that carried no utm_campaign, which is
    // most of them. Normalised to empty so the caller's "has a campaign"
    // check is a falsiness check and not a string comparison against a
    // Google-specific sentinel.
    campaign: row.sessionCampaignName && row.sessionCampaignName !== '(not set)' ? row.sessionCampaignName : '',
    sessions: row.sessions,
    users: row.totalUsers,
    keyEvents: row.keyEvents,
  }));
}

// Sessions per utm_source on its own — "how many people arrived from each
// place we published a link", which is the question the campaign report above
// cannot be summed into.
//
// Sessions could be: a session has exactly one source, so adding the
// source/medium/campaign rows for a source gives its real session count.
// Users could not. totalUsers deduplicates a person, so somebody who came
// once from the Instagram bio and once from a Reddit comment is one user in
// each of those rows and one user site-wide — adding the rows would report
// two. So the per-source figures are asked for at the grain they are shown
// at, and the medium and campaign detail the screen puts beside them is
// sessions only, which is the measure that does add up.
//
// '(not set)' is left as GA wrote it here, unlike the campaign name in
// fetchTrafficByCampaign. A visit with no campaign is ordinary; a visit whose
// source GA could not determine is a real bucket of traffic that has to be
// visible on the screen rather than collapsed into an empty string that reads
// as a rendering bug.
async function fetchTrafficBySource({ fromDate, toDate }) {
  const rows = await runReport({
    dimensions: ['sessionSource'],
    metrics: ['sessions', 'totalUsers', 'newUsers', 'keyEvents'],
    fromDate,
    toDate,
    orderByMetric: 'sessions',
  });

  return rows.map((row) => ({
    source: row.sessionSource || '(not set)',
    sessions: row.sessions,
    users: row.totalUsers,
    newUsers: row.newUsers,
    keyEvents: row.keyEvents,
  }));
}

// Site-wide totals for the window, which is not the sum of the rows above:
// totalUsers deduplicates a person who arrived twice from different sources,
// so adding the per-source figures overcounts them.
async function fetchTrafficTotals({ fromDate, toDate }) {
  const [row] = await runReport({
    dimensions: [],
    metrics: ['sessions', 'totalUsers', 'newUsers', 'keyEvents'],
    fromDate,
    toDate,
    limit: 1,
  });
  return {
    sessions: row?.sessions || 0,
    users: row?.totalUsers || 0,
    newUsers: row?.newUsers || 0,
    keyEvents: row?.keyEvents || 0,
  };
}


// ---- Site behaviour -------------------------------------------------------
// The reports behind the Site funnel tab: what people looked at, how far down
// they got, and how many of them made it to each step of ordering.
//
// Everything here is measured in users rather than events, and that is the
// most important thing about this block. An event count answers "how many
// times did this happen", which for view_item on a menu page is a number in
// the thousands and says almost nothing. totalUsers answers "how many people
// did this at all", which is the only figure a funnel step can honestly be
// compared against the step above it. Event counts are carried alongside for
// the rows where repetition is itself the finding -- somebody opening eleven
// items is browsing, somebody opening one is deciding.

// One filter shape, since four of the reports below need it: restrict to a
// single event so an event-scoped custom dimension has a meaning. Without it
// GA returns one "(not set)" row per event on the property and the values
// that were actually wanted are lost among them.
const onEvent = (name) => ({ filter: { fieldName: 'eventName', stringFilter: { value: name } } });
const onEvents = (names) => ({ filter: { fieldName: 'eventName', inListFilter: { values: names } } });

// Page by page: views, the people behind them, and how long they stayed.
//
// Views and users are both wanted and are different questions -- /order took
// 350 views from 165 people, which is people coming back to a page they had
// already seen, and a table showing only one of the two hides it.
// engagementRate is GA4's own measure and bounceRate is its complement; both
// are reported because the screen prints the one people already know.
async function fetchPageEngagement({ fromDate, toDate, limit = 40 }) {
  const rows = await runReport({
    dimensions: ['pagePath'],
    metrics: ['screenPageViews', 'totalUsers', 'sessions', 'userEngagementDuration', 'engagementRate', 'bounceRate'],
    fromDate,
    toDate,
    limit,
    orderByMetric: 'screenPageViews',
  });

  return rows.map((row) => ({
    path: row.pagePath || '(not set)',
    views: row.screenPageViews,
    users: row.totalUsers,
    sessions: row.sessions,
    // Seconds in GA's response, and per user here rather than in total:
    // "people spent 9,512 seconds on the order page" is not a fact anybody
    // can hold in their head, and "58 seconds each" is.
    secondsPerUser: row.totalUsers > 0 ? Math.round(row.userEngagementDuration / row.totalUsers) : 0,
    // GA returns these as fractions; the screen wants percentages, and
    // rounding once here stops two callers doing it two ways.
    engagementRate: Math.round(row.engagementRate * 1000) / 10,
    bounceRate: Math.round(row.bounceRate * 1000) / 10,
  }));
}

// How many people fired each event at all, which is what the ordering funnel
// is built out of. Unfiltered, because it is one round trip either way and
// the events nobody asked for are exactly the ones worth having when a step
// reads low: checkout_abandoned sitting next to begin_checkout tells a story
// that begin_checkout alone does not.
async function fetchEventReach({ fromDate, toDate, limit = 200 }) {
  const rows = await runReport({
    dimensions: ['eventName'],
    metrics: ['totalUsers', 'eventCount', 'sessions'],
    fromDate,
    toDate,
    limit,
    orderByMetric: 'totalUsers',
  });

  return rows.map((row) => ({
    event: row.eventName,
    users: row.totalUsers,
    events: row.eventCount,
    sessions: row.sessions,
  }));
}

// The same reach split by the source the session arrived on, so the funnel
// can be read per channel -- "what did Reddit traffic actually do once it got
// here" is the question the ROI tables raise and cannot answer.
//
// Restricted to the steps the funnel names rather than fetched whole: the
// unfiltered cross of every event against every source is several hundred
// rows of which a dozen are ever shown.
async function fetchEventReachBySource({ fromDate, toDate, events, limit = 500 }) {
  const rows = await runReport({
    dimensions: ['eventName', 'sessionSource'],
    metrics: ['totalUsers', 'eventCount', 'sessions'],
    fromDate,
    toDate,
    limit,
    orderByMetric: 'totalUsers',
    dimensionFilter: onEvents(events),
  });

  return rows.map((row) => ({
    event: row.eventName,
    source: row.sessionSource || '(not set)',
    users: row.totalUsers,
    events: row.eventCount,
    sessions: row.sessions,
  }));
}

// How far down the page people got: the site's own scroll_depth event, whose
// percent_scrolled parameter is registered as a custom dimension and fires at
// 25 / 50 / 75 / 100.
//
// Deliberately not GA4's built-in scroll event, which fires once at 90% and can
// therefore only answer "did they reach the bottom" -- one number where the
// question is a shape. The built-in is still reported by fetchEventReach, and
// the screen shows it beside this as a cross-check.
async function fetchScrollDepth({ fromDate, toDate }) {
  const rows = await runReport({
    dimensions: ['customEvent:percent_scrolled'],
    metrics: ['totalUsers', 'eventCount', 'sessions'],
    fromDate,
    toDate,
    limit: 25,
    orderByDimension: 'customEvent:percent_scrolled',
    dimensionFilter: onEvent('scroll_depth'),
  });

  return (
    rows
      // '(not set)' and '' are scroll_depth events fired by a build that did
      // not send the parameter yet. Dropped rather than shown as a depth,
      // because they are not one; the caller reports them as a coverage gap
      // instead of silently folding them into 25%.
      .filter((row) => /^[0-9]+$/.test(row['customEvent:percent_scrolled']))
      .map((row) => ({
        depth: Number(row['customEvent:percent_scrolled']),
        users: row.totalUsers,
        events: row.eventCount,
        sessions: row.sessions,
      }))
      .sort((a, b) => a.depth - b.depth)
  );
}

// Which sections of the landing page were actually seen, from the site's
// section_view event. The nearest thing there is to "how far did they read",
// and said in the site's own words -- Hero, Menu, Testimonials -- rather than
// in percentages.
async function fetchSectionViews({ fromDate, toDate }) {
  const rows = await runReport({
    dimensions: ['customEvent:section_name'],
    metrics: ['totalUsers', 'eventCount', 'sessions'],
    fromDate,
    toDate,
    limit: 50,
    orderByMetric: 'totalUsers',
    dimensionFilter: onEvent('section_view'),
  });

  return rows
    .filter((row) => row['customEvent:section_name'] && row['customEvent:section_name'] !== '(not set)')
    .map((row) => ({
      section: row['customEvent:section_name'],
      users: row.totalUsers,
      events: row.eventCount,
      sessions: row.sessions,
    }));
}

// Which call to action people pressed, and where on the page it was. The
// bridge between "they scrolled past it" and "they started an order": a CTA
// with reach and no clicks is a different problem from one nobody scrolled
// as far as, and the section table cannot tell those two apart on its own.
async function fetchCtaClicks({ fromDate, toDate }) {
  const rows = await runReport({
    dimensions: ['customEvent:cta_location', 'customEvent:cta_id'],
    metrics: ['totalUsers', 'eventCount'],
    fromDate,
    toDate,
    limit: 50,
    orderByMetric: 'eventCount',
    dimensionFilter: onEvent('cta_click'),
  });

  const clean = (value) => (value && value !== '(not set)' ? value : '');

  return rows
    .map((row) => ({
      location: clean(row['customEvent:cta_location']),
      cta: clean(row['customEvent:cta_id']),
      users: row.totalUsers,
      clicks: row.eventCount,
    }))
    .filter((row) => row.location || row.cta);
}

export {
  getConfig,
  describeConfig,
  isConfigured,
  runReport,
  fetchTrafficByCampaign,
  fetchTrafficBySource,
  fetchTrafficTotals,
  fetchPageEngagement,
  fetchEventReach,
  fetchEventReachBySource,
  fetchScrollDepth,
  fetchSectionViews,
  fetchCtaClicks,
};
