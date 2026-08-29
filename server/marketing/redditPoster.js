import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dedicated Chrome profile used only by this automation. Log into Reddit
// inside it once via `npm run reddit:login`; the session then persists here
// for every future automated run. Override with REDDIT_CHROME_PROFILE_DIR.
export const AUTOMATION_USER_DATA_DIR =
  process.env.REDDIT_CHROME_PROFILE_DIR || path.join(__dirname, '..', '..', '.reddit-chrome-profile');

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

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function normalizeSubreddit(name) {
  return String(name || '').trim().replace(/^(r\/?|\/r\/)/i, '').replace(/\//g, '');
}

async function launchBrowser(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const executablePath = getSystemBrowserPath();
  const options = { headless: false, args: ['--start-maximized'] };

  try {
    return await chromium.launchPersistentContext(userDataDir, { ...options, channel: 'chrome' });
  } catch (err) {
    if (!executablePath) throw err;
    console.warn('Chrome channel launch failed, falling back to executablePath:', executablePath);
    return await chromium.launchPersistentContext(userDataDir, { ...options, executablePath });
  }
}

async function clickIfPresent(page, selector, timeout = 3000) {
  try {
    const el = await page.waitForSelector(selector, { timeout });
    await el.click();
    return true;
  } catch {
    return false;
  }
}

async function fillTitle(page, title) {
  const selectors = [
    'textarea[name="title"]',
    'textarea[placeholder*="Title" i]',
    'textarea[data-test-id="post-title-input"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(title);
      return true;
    }
  }
  return false;
}

async function fillBody(page, text) {
  if (!text) return true;
  // Most specific first: the real Lexical-editor node Reddit renders for the
  // post body (confirmed via its actual DOM: <div slot="rte" role="textbox"
  // data-lexical-editor="true" contenteditable="true">). Falling back to
  // broader matches in case the markup shifts.
  const selectors = [
    'div[data-lexical-editor="true"][role="textbox"]',
    'shreddit-composer[name="body"] div[role="textbox"]',
    'div[role="textbox"]',
    'textarea[name="text"]',
    'textarea[placeholder*="Text" i]',
  ];
  for (const sel of selectors) {
    // A locator (vs. an ElementHandle from page.$) re-resolves the live
    // element on every action instead of caching a reference, which matters
    // here: Reddit's Lit-based composer re-renders its DOM nodes as the
    // form's state changes, and a cached handle can go stale mid-interaction
    // and silently no-op.
    const locator = page.locator(sel).first();
    if ((await locator.count()) === 0) continue;
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      continue;
    }

    const isEditable = await locator.evaluate((node) => node.isContentEditable).catch(() => false);
    if (isEditable) {
      // Reddit's body field is a Lexical rich-text editor: it keeps its own
      // internal state driven by real input/beforeinput events, so writing
      // node.textContent directly gets silently discarded on Lexical's next
      // render. Simulate actual typing instead — click to focus, clear any
      // existing content, then type line by line so each newline becomes a
      // real Enter keypress (a paragraph break Lexical recognizes).
      await locator.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await page.keyboard.insertText(lines[i]);
        if (i < lines.length - 1) await page.keyboard.press('Enter');
      }
    } else {
      await locator.fill(text);
    }

    // Verify the text actually landed instead of trusting the click/type
    // silently worked.
    const landed = await locator.evaluate((node) => node.innerText || node.value || '').catch(() => '');
    if (!landed.trim()) {
      console.warn(`Body fill via "${sel}" reported success but field looks empty afterward`);
      continue;
    }
    return true;
  }
  return false;
}

// Expands any directory paths into their image files and resolves relative
// paths, so callers can pass a mix of individual files and folders.
function resolveImageFiles(files) {
  const out = [];
  for (const raw of files || []) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) {
      console.warn('Image path does not exist, skipping:', raw);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const dirFiles = fs
        .readdirSync(abs)
        .filter((f) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f))
        .map((f) => path.join(abs, f));
      out.push(...dirFiles);
    } else {
      out.push(abs);
    }
  }
  return out;
}

// Best-effort text dump of visible tabs/buttons, used only to make failure
// logs actionable (Reddit's composer wording/selectors shift over time).
async function dumpInteractiveText(page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]'));
    return els
      .map((el) => el.innerText?.trim() || el.getAttribute('aria-label'))
      .filter(Boolean)
      .slice(0, 30);
  }).catch(() => []);
}

async function uploadImages(page, files) {
  const absoluteFiles = resolveImageFiles(files);
  if (!absoluteFiles.length) return true;

  // Switch to the image/media composer tab if present. Reddit has worded this
  // "Images & Video", "Image & Video", "Images & Videos" at various times, so
  // match broadly rather than a single exact phrase.
  const tabClicked = await clickIfPresent(
    page,
    'button[role="tab"]:has-text("Image"), button[role="tab"]:has-text("Media"), div[role="tab"]:has-text("Image")',
    5000,
  );
  if (tabClicked) {
    await page.waitForTimeout(800);
  }

  // Prefer the native file input if the page exposes one directly.
  try {
    const input = await page.waitForSelector('input[type="file"]', { timeout: 6000 });
    await input.setInputFiles(absoluteFiles);
  } catch {
    // Fall back to triggering an upload button that opens a file chooser.
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    const triggered =
      (await clickIfPresent(page, 'button:has-text("Upload")', 2000)) ||
      (await clickIfPresent(page, 'button[aria-label*="upload" i]', 2000)) ||
      (await clickIfPresent(page, 'button:has(svg[icon-name="image"])', 2000));
    if (!triggered) {
      console.warn(
        'No file input or upload trigger found; skipping image upload. Visible tabs/buttons:',
        await dumpInteractiveText(page),
      );
      return false;
    }
    const chooser = await chooserPromise;
    if (!chooser) {
      console.warn('Upload button clicked but no file chooser appeared');
      return false;
    }
    await chooser.setFiles(absoluteFiles);
  }

  try {
    await page.waitForSelector('img, [data-testid="image-preview"]', { timeout: 8000 });
    return true;
  } catch {
    console.warn('No image preview appeared after upload');
    return false;
  }
}

async function submitPost(page) {
  const selectors = [
    '#inner-post-submit-button',
    'button[data-testid="post-submit-button"]',
    'button:has-text("Post"):not(:has-text("Save Draft"))',
  ];

  for (const sel of selectors) {
    // Locator instead of page.$: the submit button starts disabled until
    // Reddit's form validation clears (title/body just got typed a moment
    // earlier), and re-resolving on each check avoids acting on a stale
    // handle if the button re-renders when it flips enabled.
    const locator = page.locator(sel).first();
    if ((await locator.count()) === 0) continue;

    // Poll briefly for it to become visible + enabled rather than checking once.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const visible = await locator.isVisible().catch(() => false);
      const disabled = await locator.isDisabled().catch(() => true);
      if (visible && !disabled) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click();
        return true;
      }
      await page.waitForTimeout(300);
    }
  }
  return false;
}

async function verifyPosted(page, subreddit, title, timeoutMs = 15000, pollMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await page.request.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=10`);
      if (resp.ok()) {
        const data = await resp.json();
        const posts = data?.data?.children || [];
        const match = posts.find((p) => p?.data?.title === title);
        if (match) {
          return { success: true, url: `https://www.reddit.com${match.data.permalink}` };
        }
      }
    } catch {
      // ignore and retry until deadline
    }
    await page.waitForTimeout(pollMs);
  }
  return { success: false };
}

async function debugScreenshot(page, subreddit, suffix) {
  const debugPath = path.join(__dirname, '..', '..', `debug-${subreddit}-${suffix}.png`);
  await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
  return debugPath;
}

async function postToSubreddit(context, { subreddit, title, text, files }) {
  const page = await context.newPage();
  let closePage = true; // left open on any failure so the user can finish manually
  try {
    await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    if (page.url().includes('/login')) {
      closePage = false;
      return { subreddit, submitted: false, error: 'Not logged in — run "npm run reddit:login" first.' };
    }

    // Wait for the composer to actually be interactive before touching it —
    // domcontentloaded fires before Reddit's SPA finishes rendering the form.
    try {
      await page.waitForSelector(
        'textarea[name="title"], textarea[placeholder*="Title" i], textarea[data-test-id="post-title-input"]',
        { timeout: 15000 },
      );
    } catch {
      closePage = false;
      const debugPath = await debugScreenshot(page, subreddit, 'composer-not-ready');
      return { subreddit, submitted: false, error: 'Composer never became ready (title field not found)', debugPath };
    }

    // Fill title/body first so they're preserved in the browser even if the
    // image upload step below fails — the user can then finish manually
    // instead of losing everything.
    const titleFilled = await fillTitle(page, title);
    if (!titleFilled) {
      closePage = false;
      return { subreddit, submitted: false, error: 'Could not find title field' };
    }
    await fillBody(page, text);

    if (files && files.length) {
      const uploaded = await uploadImages(page, files);
      if (!uploaded) {
        closePage = false;
        const debugPath = await debugScreenshot(page, subreddit, 'image-upload-failed');
        return {
          subreddit,
          submitted: false,
          error: 'Image upload failed (title/body were filled in — finish manually)',
          debugPath,
        };
      }
    }

    const clicked = await submitPost(page);
    if (!clicked) {
      closePage = false;
      const debugPath = await debugScreenshot(page, subreddit, 'submit-failed');
      return { subreddit, submitted: false, error: 'Submit button not found/enabled', debugPath };
    }

    const verification = await verifyPosted(page, subreddit, title);
    if (verification.success) {
      return { subreddit, submitted: true, url: verification.url };
    }

    closePage = false;
    const debugPath = await debugScreenshot(page, subreddit, 'verify-failed');
    return { subreddit, submitted: false, error: 'Could not confirm post via Reddit API', debugPath };
  } catch (err) {
    closePage = false;
    return { subreddit, submitted: false, error: err.message };
  } finally {
    if (closePage) await page.close().catch(() => {});
  }
}

// Posts the same title/body/images to every subreddit in `subreddits`, one
// at a time, reusing a single authenticated browser context. Each subreddit
// is fully independent — one failing doesn't stop the rest.
export async function postToSubreddits({ subreddits = [], title = '', text = '', files = [], profilePath }) {
  const userDataDir = profilePath || AUTOMATION_USER_DATA_DIR;
  const context = await launchBrowser(userDataDir);

  const results = [];
  try {
    for (const raw of subreddits) {
      const subreddit = normalizeSubreddit(raw);
      if (!subreddit) continue;
      console.log(`Posting to r/${subreddit}...`);
      const result = await postToSubreddit(context, { subreddit, title, text, files });
      console.log(`r/${subreddit}:`, result.submitted ? `posted (${result.url})` : `FAILED (${result.error})`);
      results.push(result);
    }
  } finally {
    console.log('Posting finished. Results:', results);
    // Leave the browser open so the user can review the posted content.
  }

  return results;
}

// Allows a quick manual run: SUBS='["smokeringsbbq"]' TITLE="..." node server/marketing/redditPoster.js
if (process.argv[1] && process.argv[1].endsWith('redditPoster.js')) {
  const subs = process.env.SUBS ? JSON.parse(process.env.SUBS) : ['smokeringsbbq'];
  const title = process.env.TITLE || 'Test post from automation';
  const text = process.env.TEXT || '';
  const files = process.env.FILES ? process.env.FILES.split(',') : [];
  const profilePath = process.env.PROFILE_PATH;
  postToSubreddits({ subreddits: subs, title, text, files, profilePath }).catch((e) => console.error(e));
}
