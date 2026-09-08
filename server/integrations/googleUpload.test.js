// The two destinations the Share step added, and the shared credential
// underneath them.
//
// None of these tests talk to Google. What they cover is the part that is
// ours and that fails silently if it is wrong: which configuration counts as
// "set up", and — the reason most of this file exists — the translation of
// the two errors that mean something entirely different from what Google's
// own wording suggests.
//
//   * Drive: it authenticates as the signed-in person now, not as the GA4
//     service account. That reversal is the whole reason Drive works here at
//     all — a service account owns no storage, so it could not own a file in
//     a My Drive folder however that folder was shared, and Google's fix for
//     that (a Shared Drive) is a Workspace feature this kitchen's free Gmail
//     account cannot create. Signed in as a person the quota message means
//     what it says, which is itself worth a test.
//
//   * YouTube: quotaExceeded is not a rate limit that clears in a minute. An
//     upload costs 1600 of a project's 10,000 daily units — six a day — and
//     it resets at midnight Pacific.
//
// Getting either message wrong costs an afternoon, which is exactly the kind
// of thing worth pinning down in a test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = [
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_DRIVE_FOLDER_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'GOOGLE_DRIVE_REFRESH_TOKEN',
];

const { loadServiceAccountKey } = await import('./googleServiceAccount.js');
const { getDriveConfig, describeDriveConfig, translateUploadError: translateDriveError } = await import(
  './googleDrive.js'
);
const { describeOAuthConfig, buildConsentUrl, browserOpenCommand, OAUTH_PRODUCTS, REDIRECT_URI } = await import(
  './googleOAuth.js'
);
const { describeYouTubeConfig, translateUploadError: translateYouTubeError } = await import(
  '../marketing/youtubeUpload.js'
);

// A syntactically real key, so the PEM check passes without a real credential
// anywhere near the repo. It is never used to sign anything here.
const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n';

let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
});
afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
});

describe('the shared service account credential', () => {
  it('takes the two plain fields, which is the documented route', () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'bbq@example.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = FAKE_PEM;

    const { key, keyError } = loadServiceAccountKey();
    expect(keyError).toBe('');
    expect(key.email).toBe('bbq@example.iam.gserviceaccount.com');
  });

  it('un-escapes a PEM that came through an environment variable', () => {
    // A .env carries the key on one line with literal backslash-n, and
    // crypto.createSign needs the real newlines. Getting this wrong fails at
    // signing time with a DECODER error that names nothing.
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'bbq@example.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = FAKE_PEM.replace(/\n/g, '\\n');

    expect(loadServiceAccountKey().key.privateKey).toContain('\n');
  });

  it('names the private_key_id mistake rather than failing at signing time', () => {
    // The id is a 40-char hex string sitting right next to the key in the
    // JSON, and it is not a credential — it cannot be turned back into one.
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'bbq@example.iam.gserviceaccount.com';
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'a'.repeat(40);

    const { key, keyError } = loadServiceAccountKey();
    expect(key).toBeNull();
    expect(keyError).toMatch(/private_key_id, not the key/);
  });

  it('takes the whole JSON, base64 or not', () => {
    const json = JSON.stringify({ client_email: 'x@example.iam.gserviceaccount.com', private_key: FAKE_PEM });
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = Buffer.from(json).toString('base64');

    expect(loadServiceAccountKey().key.email).toBe('x@example.iam.gserviceaccount.com');
  });
});

describe('Google Drive', () => {
  // Drive authenticates as the signed-in person now, not as the GA4 service
  // account — see the header of googleDrive.js for why that reversal had to
  // happen. So the fixture is an OAuth sign-in, and the service account being
  // absent is deliberate: it must no longer make any difference.
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'drive-refresh';
  });

  it('takes the folder URL straight out of the address bar', () => {
    // Nobody has the bare id to hand; they have the page they are looking at.
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'https://drive.google.com/drive/u/0/folders/1AbC-dEfGh?usp=sharing';

    expect(getDriveConfig().folderId).toBe('1AbC-dEfGh');
  });

  it('is not configured until the folder is named, and says which half is missing', () => {
    expect(describeDriveConfig().configured).toBe(false);
    expect(describeDriveConfig().error).toMatch(/GOOGLE_DRIVE_FOLDER_ID/);
    // Names the thing that produces the id, not just the variable: the folder
    // has to be one this app created, so "go and make a folder" is wrong
    // advice and pointing at the script is the only correct instruction.
    expect(describeDriveConfig().error).toMatch(/drive:setup/);

    process.env.GOOGLE_DRIVE_FOLDER_ID = '1AbC-dEfGh';
    expect(describeDriveConfig()).toMatchObject({ configured: true, error: '' });
  });

  it('reports the sign-in as the missing half when there is no sign-in', () => {
    // The two halves fail differently and the screen shows whichever is
    // actually wrong. Without a token it is the sign-in, not the folder.
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    process.env.GOOGLE_DRIVE_FOLDER_ID = '1AbC-dEfGh';

    const described = describeDriveConfig();
    expect(described.configured).toBe(false);
    expect(described.error).toMatch(/signed in/i);
    expect(described.error).not.toMatch(/GOOGLE_DRIVE_FOLDER_ID/);
  });

  it('does not read the YouTube sign-in, which grants it nothing', () => {
    // Google refuses to issue one token for both scopes, so Drive has its own
    // and being signed in to YouTube is no help at all. A Drive that fell back
    // to GOOGLE_OAUTH_REFRESH_TOKEN would look configured on screen and then
    // fail every upload with an opaque scope error.
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'the-youtube-one';
    process.env.GOOGLE_DRIVE_FOLDER_ID = '1AbC-dEfGh';

    const described = describeDriveConfig();
    expect(described.configured).toBe(false);
    expect(described.error).toMatch(/GOOGLE_DRIVE_REFRESH_TOKEN/);
    expect(described.error).toMatch(/drive:login/);
  });

  it('does not depend on the service account any more', () => {
    // The regression guard for the reversal. A Drive that quietly went back
    // to needing the service account would work on a machine that happens to
    // have GA4 configured and fail on one that does not, for reasons nothing
    // on screen would explain.
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    process.env.GOOGLE_DRIVE_FOLDER_ID = '1AbC-dEfGh';

    expect(describeDriveConfig()).toMatchObject({ configured: true, error: '' });
  });
});

describe('the errors that mean something other than what they say', () => {
  it('reads Drive’s storage-quota refusal literally, now that a person owns the files', () => {
    const message = translateDriveError(403, {
      error: { message: "The user's Drive storage quota has been exceeded." },
    });

    // This message used to be a lie worth translating. Under the old
    // service-account auth it never meant a full disk — a service account
    // owns no storage at all, so it could not own a file in a My Drive folder
    // however that folder was shared, and the real fix was a Shared Drive.
    // Signed in as a person, the same words mean exactly what they say, and
    // dressing them up as the old trap would send someone hunting for a
    // Shared Drive problem that no longer exists.
    expect(message).toMatch(/out of space/i);
    expect(message).toMatch(/15GB/);
    expect(message).not.toMatch(/Shared Drive/);
    // Google's own wording is still carried, so it is searchable.
    expect(message).toContain("The user's Drive storage quota has been exceeded.");
  });

  it('blames the folder, not the sharing, when Drive refuses the parent', () => {
    // Under drive.file the failure mode is "that folder is not one I made",
    // and the remedy is the setup script — not inviting anybody to anything.
    const message = translateDriveError(404, { error: { message: 'File not found: 1AbC.' } });

    expect(message).toMatch(/drive:setup/);
    expect(message).not.toMatch(/shared with/i);
  });

  it('says how big YouTube’s daily quota actually is, since the refusal does not', () => {
    const message = translateYouTubeError(403, {
      error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] },
    });

    // "Quota exceeded" reads like a rate limit that clears in a minute. It is
    // six uploads a day, and it comes back at midnight Pacific.
    expect(message).toMatch(/1600 of the 10,000/);
    expect(message).toMatch(/about six videos/);
    expect(message).toMatch(/midnight US Pacific/);
  });

  it('tells an account with no channel what is actually wrong', () => {
    const message = translateYouTubeError(401, { error: { errors: [{ reason: 'youtubeSignupRequired' }] } });
    expect(message).toMatch(/no YouTube channel/);
  });

  it('sends an expired sign-in back to the login script rather than to Google', () => {
    const message = translateYouTubeError(401, { error: { message: 'Invalid Credentials' } });
    expect(message).toMatch(/youtube:login/);
  });
});

describe('the YouTube sign-in', () => {
  it('separates having an app from having signed in — they fail differently', () => {
    expect(describeOAuthConfig()).toMatchObject({ configured: false, hasClient: false, signedIn: false });
    expect(describeOAuthConfig().error).toMatch(/GOOGLE_OAUTH_CLIENT_ID/);

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    expect(describeOAuthConfig()).toMatchObject({ hasClient: true, signedIn: false });
    expect(describeOAuthConfig().error).toMatch(/youtube:login/);

    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'refresh';
    expect(describeOAuthConfig()).toMatchObject({ configured: true, signedIn: true, error: '' });
  });

  it('asks for a refresh token explicitly, which is the whole point of the flow', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    const url = new URL(buildConsentUrl({ state: 'abc' }));

    // Without access_type=offline Google issues no refresh token at all, and
    // without prompt=consent a second run for an already-approved account
    // comes back with an access token only — so the login script would have
    // nothing to print.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // ONE SCOPE PER CONSENT SCREEN, and this assertion is the guard.
    //
    // Bundling YouTube and Drive into a single sign-in is the obvious design,
    // and Google rejects it at the consent screen:
    //
    //   Error 400: invalid_request
    //   ...contains scopes that cannot be requested together
    //
    // That is not discoverable from the docs and costs a round trip through a
    // browser to find out. Anyone tidying the two back into one array would
    // reintroduce it, so the default consent URL is pinned to exactly one.
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.upload');
    expect(url.searchParams.get('scope')).not.toContain(' ');
    // Google switched the out-of-band redirect off in 2022; loopback is what
    // a desktop client has left.
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(REDIRECT_URI).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(url.searchParams.get('state')).toBe('abc');
  });

  it('gives each product its own scope, its own variable and its own command', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';

    // Drive asks for two scopes in the one consent screen, which Google
    // allows because they are both Drive — the refusal quoted above is
    // specific to pairing YouTube with anything else.
    //
    // Both are needed and they do different jobs, so a tidy-up that dropped
    // either would break a feature without breaking a test unless this said
    // which is which: drive.file uploads and owns the finished reels, and
    // drive.readonly reads the source folder, whose clips and songs were put
    // there by hand and are therefore invisible to drive.file.
    const driveScope = new URL(buildConsentUrl({ scope: OAUTH_PRODUCTS.drive.scope })).searchParams.get('scope');
    expect(driveScope.split(' ')).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ]);
    // Read-only, never the full `drive` scope. The source folder is only ever
    // read, so nothing in this app should be able to rewrite or delete a file
    // somebody dropped into it.
    expect(driveScope).not.toContain('auth/drive ');
    expect(driveScope.endsWith('auth/drive')).toBe(false);
    // They must not collide on storage or on the command that fills it, or
    // signing into one would silently overwrite the other.
    expect(OAUTH_PRODUCTS.youtube.env).not.toBe(OAUTH_PRODUCTS.drive.env);
    expect(OAUTH_PRODUCTS.youtube.command).not.toBe(OAUTH_PRODUCTS.drive.command);
  });

  it('never puts the client secret or the refresh token in what a route can see', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'super-secret';
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'the-refresh-token';

    const described = JSON.stringify([describeOAuthConfig(), describeYouTubeConfig()]);
    expect(described).not.toContain('super-secret');
    expect(described).not.toContain('the-refresh-token');
    // The client id is public by design — it travels in the consent URL.
    expect(describeOAuthConfig().clientId).toBe('id.apps.googleusercontent.com');
  });

  it('offers the three visibilities YouTube accepts', () => {
    expect(describeYouTubeConfig().privacyStatuses).toEqual(['public', 'unlisted', 'private']);
  });
});

// Handing the consent URL to a browser, which is where a sign-in that is
// otherwise entirely correct can still fail.
describe('browserOpenCommand', () => {
  // A real consent URL: several `&`, and percent-encoding throughout.
  const URL_WITH_AMPERSANDS =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x.apps.googleusercontent.com' +
    '&redirect_uri=http%3A%2F%2F127.0.0.1%3A47623%2Foauth2callback&response_type=code' +
    '&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state=abc';

  it('quotes the URL for cmd, because cmd splits its command line on &', () => {
    // Unquoted, Windows hands the browser everything up to the first `&` and
    // tries to run the rest as commands. Google then reports a missing
    // response_type, which sends you looking at how the URL was built — where
    // there is nothing wrong, because pasting the same URL by hand works.
    const { command, args, options } = browserOpenCommand(URL_WITH_AMPERSANDS, 'win32');
    expect(command).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '""', `"${URL_WITH_AMPERSANDS}"`]);
    // Without this Node re-escapes the quotes on the way out and they never
    // reach cmd as quotes at all.
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  it('keeps the window-title argument, or start opens nothing', () => {
    // `start "<url>"` reads the quoted string as the title of a new console
    // window. The empty title ahead of it is what makes the URL the target.
    const { args } = browserOpenCommand(URL_WITH_AMPERSANDS, 'win32');
    expect(args[2]).toBe('""');
    expect(args[3]).toContain('response_type=code');
  });

  it('does not quote where there is no shell to confuse', () => {
    // open and xdg-open are exec'd directly, so a quote would become part of
    // the address rather than delimiting it.
    for (const platform of ['darwin', 'linux']) {
      const { command, args, options } = browserOpenCommand(URL_WITH_AMPERSANDS, platform);
      expect(command).toBe(platform === 'darwin' ? 'open' : 'xdg-open');
      expect(args).toEqual([URL_WITH_AMPERSANDS]);
      expect(options).toEqual({});
    }
  });
});
