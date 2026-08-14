import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function waitForAny(page, selectors, timeout = 10000) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout });
      return sel;
    } catch (e) {
      // continue
    }
  }
  throw new Error('None of selectors found: ' + selectors.join(', '));
}

// After the one-time manual `reddit:login`, the automation profile already
// carries a Google identity cookie, but Reddit/Google still sometimes show a
// lightweight "Continue as <name>" prompt (Google One Tap / FedCM) to finish
// establishing the Reddit session. Unlike the full accounts.google.com sign-in
// page, this widget doesn't trigger Google's "browser may not be secure"
// automation block, so it's safe for Playwright to click.
async function tryClickContinueLogin(page) {
  try {
    const buttonSelectors = [
      'button:has-text("Continue as")',
      '[role="button"]:has-text("Continue as")',
      'div:has-text("Continue as") >> button',
    ];
    for (const sel of buttonSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        console.log('Clicked "Continue as" login prompt');
        await page.waitForTimeout(1500);
        return true;
      }
    }

    // Google One Tap renders inside an iframe from accounts.google.com.
    for (const frame of page.frames()) {
      if (!/accounts\.google\.com/.test(frame.url())) continue;
      try {
        const btn = await frame.waitForSelector('div[role="button"]', { timeout: 3000 });
        if (btn) {
          await btn.click();
          console.log('Clicked Google One Tap "Continue as" prompt');
          await page.waitForTimeout(1500);
          return true;
        }
      } catch {
        // this frame didn't have it; keep checking others
      }
    }
  } catch (e) {
    console.warn('No "Continue as" prompt to click (or click failed):', e.message);
  }
  return false;
}

// Reddit's composer often has more than one element with "Post" in its text
// (nav bar, community picker, etc.), and the real submit button starts out
// disabled until title/body are valid. Picking the first text match — what
// the old code did — can click the wrong thing and silently leave a draft.
// Ground-truth check: ask Reddit's own JSON listing whether the post is
// actually there. This is decisive where URL-watching is not — Reddit's
// submit composer is a client-routed SPA that can briefly navigate to the
// new post and then bounce back to a blank /submit form (on success), or
// stay on /submit after a rejected/invalid post (e.g. a too-short title).
// Both cases can leave the final page.url() at .../submit/, so the URL
// alone cannot distinguish "posted, then reset" from "never posted".
// page.request shares the browser context's cookies, so this call is
// authenticated as whichever Reddit account is logged into the profile.
async function verifyPostExists(page, subreddit, title, timeoutMs = 20000, pollMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await page.request.get(
        `https://www.reddit.com/r/${subreddit}/new.json?limit=10`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (RedditPosterAutomation)' } },
      );
      if (resp.ok()) {
        const data = await resp.json();
        const posts = data?.data?.children || [];
        const match = posts.find((p) => p?.data?.title === title);
        if (match) {
          return { success: true, url: `https://www.reddit.com${match.data.permalink}` };
        }
      } else {
        console.warn(`new.json check for r/${subreddit} returned status ${resp.status()}`);
      }
    } catch (e) {
      console.warn(`new.json check for r/${subreddit} failed:`, e.message);
    }
    await page.waitForTimeout(pollMs);
  }
  return { success: false };
}

async function submitPost(page, subreddit, title) {
  const submitSelectors = [
    // Reddit's RPL button components name paired actions "inner-<action>-button"
    // (confirmed via the sibling "Save Draft" button: id="inner-save-draft-button").
    '#inner-post-submit-button',
    '#inner-post-button',
    'button[data-testid="post-submit-button"]',
    'button[slot="submit"]',
    'button[data-testid="post-button"]',
    'button:has-text("Post"):not(:has-text("Save Draft"))',
    'button:has-text("Submit")',
  ];

  // Capture the URL *before* we click. Reddit normalizes /submit -> /submit/
  // on load, so comparing against "endsWith('/submit')" (no trailing slash)
  // is unreliable — that condition can already be true before the click ever
  // happens, producing a false "submitted" positive. Comparing the full
  // pathname before vs. after — plus a submit-page regex that tolerates the
  // trailing slash — is the reliable signal that navigation actually occurred.
  const startPath = new URL(page.url()).pathname;

  let clicked = false;
  for (const sel of submitSelectors) {
    const candidates = await page.$$(sel);
    for (const btn of candidates) {
      const visible = await btn.isVisible().catch(() => false);
      const disabled = await btn.isDisabled().catch(() => true);
      if (visible && !disabled) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click();
        console.log(`Clicked submit button (selector: ${sel}) for r/${subreddit}`);
        clicked = true;
        break;
      }
    }
    if (clicked) break;
  }

  if (!clicked) {
    const allButtons = await dumpButtons(page);
    console.warn(`No enabled submit button found for r/${subreddit}. Buttons on page:`, allButtons);
    return false;
  }

  // Quick, non-authoritative signal: did the URL move off /submit at all?
  // Useful for logging/timing, but NOT trusted on its own — see comment above.
  let navigatedAway = false;
  try {
    await page.waitForFunction(
      (prevPath) => location.pathname !== prevPath && !/\/submit\/?$/.test(location.pathname),
      startPath,
      { timeout: 8000 },
    );
    navigatedAway = true;
    console.log(`URL moved off /submit for r/${subreddit} — now at`, page.url());
  } catch {
    console.log(`URL for r/${subreddit} did not move off /submit within 8s (still checking via API) — currently at`, page.url());
  }

  // Authoritative check: does the post actually exist on Reddit now?
  const verification = await verifyPostExists(page, subreddit, title);
  if (verification.success) {
    console.log(`Confirmed r/${subreddit} post exists:`, verification.url);
    return true;
  }

  console.warn(
    `Could not confirm r/${subreddit} post via r/${subreddit}/new.json`,
    navigatedAway ? '(URL did move off /submit, but no matching post was found — title may have been edited/truncated by Reddit, or check manually)' : '(and URL never left /submit — likely rejected, e.g. title too short/invalid, or not logged in)',
    'Currently at', page.url(),
    'Buttons on page:', await dumpButtons(page),
  );

  try {
    const debugPath = path.join(__dirname, '..', `debug-${subreddit}-submit-failed.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.warn('Saved debug screenshot:', debugPath);
  } catch (e) {
    console.warn('Could not save debug screenshot:', e.message);
  }

  return false;
}

// Reddit's composer is built from web components with shadow DOM, so a plain
// document.querySelectorAll misses most buttons. Walk shadow roots too.
async function dumpButtons(page) {
  return page.evaluate(() => {
    function deepQuery(root, results) {
      root.querySelectorAll('button').forEach((el) => results.push(el));
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) deepQuery(el.shadowRoot, results);
      });
      return results;
    }
    return deepQuery(document, [])
      .map((b) => ({ text: b.innerText?.trim(), disabled: b.disabled, testId: b.getAttribute('data-testid') }))
      .filter((b) => b.text);
  });
}

async function getFileInputHandle(page) {
  const handle = await page.evaluateHandle(() => {
    function findFileInput(root) {
      const inputs = Array.from(root.querySelectorAll('input[type="file"]'));
      if (inputs.length) {
        return inputs[0];
      }
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) {
          const found = findFileInput(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    return findFileInput(document);
  });
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

async function clickImagePostTab(page) {
  const selectors = [
    'button[role="tab"]:has-text("Image & Video")',
    'button[role="tab"]:has-text("Image & video")',
    'button[role="tab"]:has-text("Image")',
    'div[role="tab"]:has-text("Image & Video")',
    'div[role="tab"]:has-text("Image & video")',
  ];

  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        const isVisible = await btn.isVisible().catch(() => false);
        if (!isVisible) continue;
        await btn.click();
        console.log('Clicked image post tab:', sel);
        await page.waitForTimeout(1200);
        return true;
      } catch (e) {
        console.warn('Could not click image post tab selector', sel, e.message);
      }
    }
  }
  return false;
}

async function fillBodyPreservingFormatting(page, selector, text) {
  const element = await page.$(selector);
  if (!element) return false;

  const isEditable = await element.evaluate((node) => node.isContentEditable);
  if (!isEditable) {
    await page.fill(selector, text);
    return true;
  }

  await element.evaluate((node, value) => {
    node.focus();
    node.textContent = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);

  return true;
}

// Safety net for any step that could theoretically hang indefinitely (e.g. a
// real native OS file-picker dialog that Playwright's 'filechooser' event
// cannot intercept — this can happen if a page uses the File System Access
// API instead of a classic <input type="file">). Instead of the script
// sitting silent forever, this forces a failure after `ms` and grabs a
// screenshot so you can see exactly what's on screen at that moment.
async function withWatchdog(promise, ms, label, page) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      (async () => {
        try {
          const debugPath = path.join(__dirname, '..', `debug-timeout-${label}-${Date.now()}.png`);
          await page.screenshot({ path: debugPath, fullPage: true });
          console.error(`WATCHDOG: "${label}" exceeded ${ms}ms — screenshot saved to`, debugPath);
        } catch (e) {
          console.error(`WATCHDOG: "${label}" exceeded ${ms}ms — also failed to save screenshot:`, e.message);
        }
      })();
      reject(new Error(`Watchdog timeout after ${ms}ms: ${label}`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function uploadRedditImages(page, files) {
  if (!files?.length) return true;

  console.log('Preparing Reddit image upload (expand folders if needed):', files);

  // Expand any directories passed in to individual image files.
  // Paths coming from an HTTP request body (e.g. a form field or query
  // string) may arrive percent-encoded (e.g. "Personal%20GIT"); decode them
  // first or fs.existsSync/statSync will silently miss the real path.
  // Try the path exactly as given first (it may genuinely exist on disk with
  // a literal "%20" etc. in it if some upstream step encoded the filename
  // when saving, rather than just the string used to reference it). Only
  // fall back to a decoded variant if the raw path doesn't resolve. Trying
  // both — instead of assuming either is always correct — avoids silently
  // "fixing" a path that was already right.
  const resolveExistingPath = (raw) => {
    const candidates = [raw];
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) candidates.push(decoded);
    } catch (e) {
      // malformed percent-escape in a path that never needed decoding; ignore
    }

    for (const candidate of candidates) {
      const abs = path.resolve(candidate);
      if (fs.existsSync(abs)) {
        if (candidate !== raw) {
          console.log('Resolved file path using decoded variant:', abs, '(raw was:', raw + ')');
        }
        return abs;
      }
    }
    return null;
  };

  const expandFilesList = (items) => {
    const out = [];
    for (const raw of items) {
      const abs = resolveExistingPath(raw);
      if (!abs) {
        console.warn('Path does not exist (tried raw and decoded), skipping:', raw);
        continue;
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const dirFiles = fs
          .readdirSync(abs)
          .filter((f) => /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(f))
          .map((f) => path.join(abs, f));
        out.push(...dirFiles);
      } else if (stat.isFile()) {
        out.push(abs);
      }
    }
    return out;
  };

  const absoluteFiles = expandFilesList(files);
  if (!absoluteFiles.length) {
    console.error('No image files resolved from provided paths/folders');
    return false;
  }

  console.log('Resolved image files to upload:', absoluteFiles);

  // Attempt to trigger a native file chooser if the UI exposes an upload button.
  const triggerSelectors = [
    // Specific toolbar button used in Reddit's editor (wrapped in rpl-tooltip)
    'rpl-tooltip button:has(svg[icon-name="image"])',
    'button:has(svg[icon-name="image"])',
    'button:has(.rpl-rtl-icon)',
    'button:has-text("Upload")',
    'button:has-text("Add images")',
    'button:has-text("Add image")',
    'button:has-text("Choose files")',
    'button:has-text("Browse")',
    'button[aria-label*="upload"]',
  ];

  for (const sel of triggerSelectors) {
    const els = page.locator(sel);
    if ((await els.count()) === 0) continue;

    const el = els.first();
    // A locator matching something ≠ it being clickable right now (it may be
    // hidden, off-screen, or belong to an unrelated part of the page, e.g. an
    // avatar-upload icon). Without an explicit timeout, click() falls back to
    // Playwright's default 30s actionability wait per candidate — with up to
    // six selectors that can silently burn minutes with zero console output,
    // which looks exactly like a hang. Skip fast instead of waiting on it.
    const visible = await el.isVisible().catch(() => false);
    if (!visible) {
      console.log(`Trigger selector "${sel}" matched but is not visible — skipping`);
      continue;
    }

    const chooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    try {
      await el.click({ timeout: 3000 });
    } catch (e) {
      console.log(`Trigger selector "${sel}" matched but click failed/timed out — skipping:`, e.message);
      continue;
    }

    const fileChooser = await chooserPromise;
    if (fileChooser) {
      try {
        // Try to attach all files at once first (preferred).
        try {
          await fileChooser.setFiles(absoluteFiles);
          console.log('Set all files at once using native file chooser via selector', sel);
        } catch (e) {
          console.warn('Setting all files at once failed, will try cumulative', e.message);
          // fall through to cumulative below
          for (let i = 0; i < absoluteFiles.length; i++) {
            const subset = absoluteFiles.slice(0, i + 1);
            await fileChooser.setFiles(subset);
            await page.waitForTimeout(250);
          }
          console.log('Set files cumulatively using native file chooser via selector', sel);
        }

        // Wait briefly for uploader UI to accept files and verify preview.
        await page.waitForTimeout(1000);
        try {
          await page.waitForSelector('img, [data-testid="image-preview"], div[role="img"]', { timeout: 8000 });
          console.log('Image preview detected after native file chooser upload');
          return true;
        } catch (err) {
          console.warn('No image preview detected after native file chooser upload:', err.message);
          return false;
        }
      } catch (err) {
        console.warn('fileChooser.setFiles failed:', err.message);
      }
    }
  }

  // Fallback: locate hidden input[type=file] and set files directly.
  try {
    await page.waitForSelector('input[type="file"]', { timeout: 4000 });
  } catch {
    // no file input, still try to continue — caller will detect missing preview
  }

  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) {
    console.warn('No input[type="file"] elements found; cannot attach images');
    return false;
  }

  // Prefer an input whose accept attribute mentions images/videos
  let chosen = null;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const accept = (await input.getAttribute('accept')) || '';
    if (/image|video|\*/i.test(accept)) {
      chosen = input;
      break;
    }
  }
  if (!chosen) chosen = inputs.nth(0);

  try {
    // Try to set all files at once first.
    try {
      await chosen.setInputFiles(absoluteFiles);
      console.log('Attached all files via hidden file input');
    } catch (e) {
      console.warn('Setting all files at once failed, will try cumulative approach', e.message);
      for (let i = 0; i < absoluteFiles.length; i++) {
        const subset = absoluteFiles.slice(0, i + 1);
        await chosen.setInputFiles(subset);
        await page.waitForTimeout(250);
      }
      console.log('Attached files via hidden file input (cumulative)');
    }
  } catch (err) {
    console.error('setInputFiles fallback failed:', err);
    return false;
  }

  // Give the UI a moment to render previews
  await page.waitForTimeout(1200);
  try {
    await page.waitForSelector('img, [data-testid="image-preview"], div[role="img"]', { timeout: 8000 });
    console.log('Image preview detected after hidden-input upload');
    return true;
  } catch (err) {
    console.warn('No image preview detected after hidden-input upload:', err.message);
    return false;
  }
}

export function getSystemBrowserPath() {
  const envPath = process.env.BROWSER_PATH || process.env.CHROME_PATH || process.env.CHROME_EXECUTABLE;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  return candidates.find((path) => fs.existsSync(path));
}

async function launchPersistentContextWithFallback(userDataDir, options) {
  const browserExecutable = getSystemBrowserPath();

  if (userDataDir) {
    const launchOptions = { ...options, channel: 'chrome' };
    console.log('Launching persistent context with Chrome channel and profile:', userDataDir, launchOptions);
    try {
      return await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (err) {
      console.warn('Chrome channel launch failed, falling back to executablePath:', browserExecutable, err);
      if (!browserExecutable) {
        throw err;
      }
      return await chromium.launchPersistentContext(userDataDir, { ...options, executablePath: browserExecutable });
    }
  }

  try {
    return await chromium.launchPersistentContext(userDataDir || '', options);
  } catch (err) {
    const fallback = browserExecutable;
    if (!fallback) {
      throw err;
    }
    console.warn('Default Playwright Chromium launch failed; falling back to system browser:', fallback, err);
    return await chromium.launchPersistentContext(userDataDir || '', { ...options, executablePath: fallback });
  }
}

// Dedicated Chrome profile used only by this automation — never opened as your
// everyday browser — so Playwright always owns the singleton lock on it.
// Log into Reddit inside it once via `npm run reddit:login`; the session then
// persists here for every future automated run. Override with
// REDDIT_CHROME_PROFILE_DIR if you want it elsewhere.
export const AUTOMATION_USER_DATA_DIR =
  process.env.REDDIT_CHROME_PROFILE_DIR || path.join(__dirname, '..', '.reddit-chrome-profile');

export async function postToSubreddits({ subreddits = [], title = '', text = '', files = [], profilePath }) {
  console.log('Starting Playwright reddit poster', { subreddits, title, files });
  const userDataDir = profilePath || AUTOMATION_USER_DATA_DIR;
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await launchPersistentContextWithFallback(userDataDir, {
    headless: false,
    args: ['--start-maximized'],
    channel: 'chrome',
  });

  // Land on the homepage first so any pending "Continue as" prompt gets
  // resolved before we deep-link straight into subreddit submit pages.
  try {
    const warmupPage = await context.newPage();
    await warmupPage.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tryClickContinueLogin(warmupPage);
    await warmupPage.close();
  } catch (e) {
    console.warn('Warm-up navigation to reddit.com failed:', e.message);
  }

  const results = [];

  try {
    for (const sub of subreddits) {
      try {
        const subreddit = sub.replace(/^(r\/?|\/r\/)/i, '').replace(/\//g, '');
        const targetUrl = `https://www.reddit.com/r/${subreddit}/submit`;
        const existingPages = context.pages();
        console.log('Existing pages before navigation:', existingPages.map((p) => p.url()));

        const page = existingPages.find((p) => p.url() === 'about:blank') || existingPages[0] || (await context.newPage());
        await page.bringToFront();
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (navErr) {
          console.error(`Navigation to ${targetUrl} failed:`, navErr.message);
        }
        console.log('Page URL after goto:', page.url(), '(target was', targetUrl + ')');

        if (page.url() === 'about:blank') {
          console.warn('Page still at about:blank after goto; retrying once.');
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (reloadErr) {
            console.error('Reload failed:', reloadErr.message);
          }
          console.log('Page URL after reload:', page.url());
        }

        await tryClickContinueLogin(page);

        if (page.url().includes('/login')) {
          console.warn(
            `Reddit redirected to login for r/${subreddit} — the automation profile isn't logged in. Run "npm run reddit:login" once and sign in.`,
          );
        }

        // Try to click "Create post" if present
        try {
          const createBtn = await page.$('button:has-text("Create post")');
          if (createBtn) await createBtn.click();
        } catch {}

        if (files && files.length) {
          const tabClicked = await clickImagePostTab(page);
          if (tabClicked) {
            await page.waitForTimeout(1000);
          } else {
            console.warn(`Could not switch to Image & Video tab for r/${subreddit}`);
          }

          const uploaded = await withWatchdog(
            uploadRedditImages(page, files),
            35000,
            `upload-${subreddit}`,
            page,
          );
          if (!uploaded) {
            throw new Error(`Could not upload images to r/${subreddit}`);
          }
        }

        // Wait for title input after the composer has settled.
        let titleSelector;
        try {
          titleSelector = await waitForAny(page, [
            'textarea[name="title"]',
            'textarea[placeholder*="Title"]',
            'textarea[data-test-id="post-title-input"]',
          ], 8000);
        } catch (e) {
          console.warn('Title selector not found, attempting generic textarea');
          titleSelector = 'textarea';
        }

        await page.fill(titleSelector, title || '');

        // Fill body / text area if present
        try {
          const bodySel = await waitForAny(page, [
            'div[role="textbox"]',
            'textarea[name="text"]',
            'textarea[placeholder*="Text"]',
          ], 3000);
          if (bodySel) {
            await fillBodyPreservingFormatting(page, bodySel, text || '');
          }
        } catch (e) {
          // ignore
        }

        if (files && files.length) {
          try {
            await page.waitForFunction(
              (selectors) => selectors.some((sel) => !!document.querySelector(sel)),
              ['img', 'div[role="img"]', '[data-testid="image-preview"]'],
              { timeout: 8000 },
            );
            console.log('Image preview appeared on Reddit submit page');
          } catch {
            console.warn('No image preview detected before submit; upload may not have happened');
          }
        }

        // Try to submit
        let submitted = false;
        try {
          submitted = await submitPost(page, subreddit, title);
        } catch (e) {
          console.warn('Could not find/press submit button for', sub, e.message);
        }

        results.push({ subreddit, submitted });

        await page.waitForTimeout(2000);
        if (page.url() !== 'about:blank') {
          await page.close();
        }
      } catch (err) {
        console.error('Error posting to', sub, err);
        results.push({ subreddit: sub, submitted: false, error: err.message });
      }
    }
  } finally {
    // keep browser open so user can confirm; do not close context automatically
    console.log('Posting finished; leaving browser open for review');
    console.log('Results summary:', results);
  }

  return results;
}

// If run directly, allow a simple dev invocation
if (process.argv[1] && process.argv[1].endsWith('redditPoster.js')) {
  const subs = process.env.SUBS ? JSON.parse(process.env.SUBS) : ['smokeringsbbq'];
  const title = process.env.TITLE || 'Test post from automation';
  const text = process.env.TEXT || '';
  const files = process.env.FILES ? process.env.FILES.split(',') : [];
  const profilePath = process.env.PROFILE_PATH;
  postToSubreddits({ subreddits: subs, title, text, files, profilePath }).catch((e) => console.error(e));
}