// Makes the Drive folder the reel feature works out of.
//
//   npm run drive:setup
//
// One folder, both directions: the clips and the songs a reel is built from go
// into it by hand, and the finished masters come back into it from the Share
// step.
//
// THIS IS NO LONGER THE ONLY WAY TO GET A FOLDER, and that is a change worth
// knowing about. It used to be. Drive access was `drive.file` alone — per-file
// access to files this app created — and under that scope a folder made by
// hand in the browser is invisible: naming it as a parent fails at upload with
// a permission error pointing at nothing. So the app had to make its own.
//
// Reading footage somebody else put in the folder needed `drive.readonly` as
// well (see googleOAuth.js), and that lifts the restriction. Any folder id
// pasted out of the address bar works now, including one a phone already syncs
// its camera roll into. This script is still the shortest path if you have no
// folder in mind, and still the right answer if you want one that exists only
// for this.
//
// Nothing is written to .env — that file holds every other secret this
// project has, and a script that rewrites it is a script that can corrupt it.
// The id is printed to paste, the same bargain googleLogin.js makes.
//
// Re-running is safe. It looks for a folder it made earlier before making
// another, so a second run prints the same id rather than quietly creating a
// duplicate for reels to start scattering between.
import 'dotenv/config';
import { describeOAuthConfig, googleAccessToken } from '../integrations/googleOAuth.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILES_API = 'https://www.googleapis.com/drive/v3/files';

// The name is only ever seen by a human in their own Drive, so it says what
// is in it and who put it there.
const FOLDER_NAME = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Smoke Rings BBQ — Reels';

const oauth = describeOAuthConfig('drive');
if (!oauth.configured) {
  console.error(`
Google is not signed in yet, so there is no account to make a folder in.

  ${oauth.error}

Drive has its own sign-in, separate from YouTube's: Google will not grant both
scopes in one request, so being signed in to YouTube does nothing for Drive.
"npm run drive:login" is the one that matters here.
`);
  process.exit(1);
}

const token = await googleAccessToken('drive');
const authed = (url, init = {}) =>
  fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });

const fail = async (resp, what) => {
  const body = await resp.json().catch(() => ({}));
  const message = body.error?.message || `HTTP ${resp.status}`;
  console.error(`\nCould not ${what}: ${message}`);
  if (/insufficient|scope/i.test(message)) {
    console.error(
      '\nThat is the scope. GOOGLE_DRIVE_REFRESH_TOKEN was minted without the Drive scopes — run\n' +
        '"npm run drive:login" and paste the new refresh token in. Note this is Drive\'s own\n' +
        'sign-in: the YouTube one grants nothing here, because Google refuses to issue the\n' +
        'two scopes together.',
    );
  }
  if (/has not been used|disabled/i.test(message)) {
    console.error('\nThe Drive API is switched off for this Cloud project. Enable "Google Drive API" and retry.');
  }
  process.exit(1);
};

// Re-running is safe because this looks for the folder before making a second
// one. It used to be safe for a stronger reason — drive.file could only see
// folders this app had created, so the search could not match anything else —
// and drive.readonly ended that: a folder of your own called "Smoke Rings
// Reels" would now be found here too.
//
// That is the right outcome rather than a hazard. Nothing is moved, renamed or
// written; the id is printed for you to read and paste, and adopting a folder
// you already made is exactly what the wider scope was for. The one case to
// watch is several folders sharing the name, where the first is taken — which
// is why the name is printed back before the id.
//
// It remains scoped to folders, and to the bin being excluded, so a *file*
// called this can never come back as the destination.
const query = encodeURIComponent(`mimeType = '${FOLDER_MIME}' and name = '${FOLDER_NAME}' and trashed = false`);
const found = await authed(`${FILES_API}?q=${query}&fields=files(id,name,webViewLink)&pageSize=10`);
if (!found.ok) await fail(found, 'look for an existing folder');

const existing = (await found.json()).files || [];
let folder = existing[0];

if (folder) {
  console.log(`Using the existing folder "${folder.name}".`);
  if (existing.length > 1) {
    console.log(`(There are ${existing.length} folders with that name — this is the first. Check the link below.)`);
  }
} else {
  const created = await authed(FILES_API + '?fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  if (!created.ok) await fail(created, 'create the folder');
  folder = await created.json();
  console.log(`Created "${folder.name}" in the root of your Drive.`);
}

console.log(`
Put this in .env and restart the server:

GOOGLE_DRIVE_FOLDER_ID=${folder.id}

The folder is in your own Drive, owned by you, on your own storage — move it,
rename it or share it with whoever you like. Only the id matters here, and it
does not change when the folder is moved or renamed.

  ${folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`}
`);
if (existing.length > 1) {
  console.log(
    `Note: ${existing.length} folders by that name exist. Using the first. The others are listed here so you can\n` +
      `tidy them up if reels have been landing in more than one:\n` +
      existing.map((f) => `  ${f.id}`).join('\n') +
      '\n',
  );
}
