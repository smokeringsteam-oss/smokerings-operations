// Unattended AI SEO sweep — runs every active tracked prompt through a
// grounded Gemini check and writes the results to the aiseo_run table,
// exactly as the dashboard's "Run all checks" button does.
//
// Calls server/marketing/aiSeo.js directly rather than the HTTP API, so a scheduled run
// doesn't depend on the express server being up. The dashboard reads the same
// database, so results show up there next time it loads.
//
// Run with:
//   npm run aiseo:sweep
//   node server/scripts/runAiSeoSweep.js --stale-days=6 --delay=3000
//
// Flags:
//   --stale-days=N  skip prompts already checked within the last N days
//                   (default 6 — a weekly task then re-checks everything,
//                   but a re-run the same afternoon is a cheap no-op)
//   --delay=MS      pause between prompts (default 3000) to stay inside the
//                   API's per-minute rate limit
//   --limit=N       check at most N prompts this run
//   --dry-run       list what would be checked and exit without calling the API
//
// To run it on a schedule, point Task Scheduler at the wrapper next to this
// file — server/scripts/aiseo-sweep.cmd — which sets the working directory and
// tees output to server/logs/aiseo-sweep.log. Registration command is in its
// header.
import 'dotenv/config';
import { listPrompts, listRuns, runCheck, getStatus } from '../marketing/aiSeo.js';

function flag(name, fallback) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!match) return fallback;
  const value = Number(match.split('=')[1]);
  return Number.isFinite(value) ? value : fallback;
}

const staleDays = flag('stale-days', 6);
const delayMs = flag('delay', 3000);
const limit = flag('limit', Infinity);
const dryRun = process.argv.includes('--dry-run');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const status = getStatus();
if (!status.autoRunAvailable) {
  console.error('GEMINI_API_KEY is not set, so there is nothing to sweep with. Set it in .env and try again.');
  process.exit(1);
}

const { prompts } = listPrompts();
const { runs } = listRuns({});

// Newest check per prompt, so --stale-days can skip what was just done.
const lastCheckedAt = new Map();
runs.forEach((run) => {
  if (!run.promptId) return;
  const at = Date.parse(run.ranAt);
  if (Number.isNaN(at)) return;
  if (!lastCheckedAt.has(run.promptId) || at > lastCheckedAt.get(run.promptId)) {
    lastCheckedAt.set(run.promptId, at);
  }
});

const staleCutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
const due = prompts
  .filter((prompt) => prompt.isActive)
  .filter((prompt) => (lastCheckedAt.get(prompt.id) || 0) < staleCutoff)
  .slice(0, limit);

const skipped = prompts.filter((p) => p.isActive).length - due.length;
console.log(
  `${prompts.length} prompt(s) tracked, ${due.length} due for a check${
    skipped > 0 ? ` (${skipped} checked within the last ${staleDays} day(s))` : ''
  }.`,
);

if (dryRun) {
  due.forEach((prompt) => console.log(`  would check ${prompt.id}: ${prompt.text}`));
  process.exit(0);
}

if (!due.length) {
  console.log('Nothing to do.');
  process.exit(0);
}

let logged = 0;
let named = 0;
const failures = [];

for (let i = 0; i < due.length; i += 1) {
  const prompt = due[i];
  process.stdout.write(`[${i + 1}/${due.length}] ${prompt.text} … `);
  try {
    const { run } = await runCheck({ promptId: prompt.id });
    logged += 1;
    if (run.mentioned) named += 1;
    const placing = run.mentioned
      ? `named${run.position ? ` #${run.position}` : ''}${run.totalBrands ? ` of ${run.totalBrands}` : ''}`
      : 'not named';
    console.log(`${placing}${run.citationDomains.length ? ` (cited ${run.citationDomains.length} source(s))` : ''}`);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    failures.push(`${prompt.id}: ${err.message}`);

    // A 429 is a spent daily allowance, not a flaky call: every remaining
    // prompt would fail identically. Stop rather than spend ten minutes
    // producing the same error N more times.
    if (err.status === 429) {
      console.error('\nQuota exhausted — stopping the sweep. Remaining prompts were not checked.');
      break;
    }
  }

  if (i < due.length - 1) await sleep(delayMs);
}

const unchecked = due.length - logged - failures.length;
console.log(
  `\nDone: ${logged} check(s) logged, named in ${named}, ${failures.length} failure(s)${
    unchecked > 0 ? `, ${unchecked} not attempted` : ''
  }.`,
);
failures.forEach((line) => console.error(`  ${line}`));

// exitCode rather than process.exit(): the API client still holds keep-alive
// sockets at this point, and forcing the process down on top of them trips a
// libuv assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)") that
// turns a clean run into a crash with a junk exit code. Setting the code lets
// Node close the sockets and exit on its own a moment later.
//
// Non-zero on failure so a scheduled task shows as failed rather than
// silently logging nothing week after week.
process.exitCode = failures.length ? 1 : 0;
