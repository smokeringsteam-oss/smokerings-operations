import fs from 'fs';
import { spawn } from 'child_process';
import { AUTOMATION_USER_DATA_DIR, getSystemBrowserPath } from './redditPoster.js';

// One-time setup: opens the dedicated automation profile in a completely
// plain, un-automated Chrome process (no DevTools pipe, no Playwright) so you
// can sign in — including "Continue with Google" — without hitting Google's
// "this browser or app may not be secure" block, which triggers on ANY
// CDP-controlled browser regardless of flags.
//
// Reddit's session cookie doesn't care how the browser was launched, only
// Google's login page does — so once you're signed in here and close the
// window, postToSubreddits()'s Playwright-driven launches will reuse this
// same profile already authenticated.
const userDataDir = AUTOMATION_USER_DATA_DIR;
fs.mkdirSync(userDataDir, { recursive: true });

const browserPath = getSystemBrowserPath();
if (!browserPath) {
  console.error(
    'Could not find a Chrome/Edge install in the usual locations. Set BROWSER_PATH to the executable and re-run.',
  );
  process.exit(1);
}

console.log('Automation profile directory:', userDataDir);
console.log('Opening a plain Chrome window (not automated) on that profile...');
console.log('Log into Reddit normally — Google sign-in works fine here.');
console.log('When you are done, just close the Chrome window.');

const child = spawn(browserPath, [`--user-data-dir=${userDataDir}`, 'https://www.reddit.com/login'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
