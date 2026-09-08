// Timed Instagram posting, in two halves.
//
// Instagram's publishing API has no "post this at 7pm" parameter — you create
// a media container, then you publish it, and both happen the moment you call
// them. So a post timed for this evening has to be split across two runs:
//
//   node server/scripts/schedulePost.js prepare <file.mp4> --caption-file <f>
//       Hands Meta the video now. It downloads it off the Tailscale Funnel and
//       transcodes it. NOTHING APPEARS ON THE PROFILE. The container id, the
//       caption and the target are written to scheduled-post.json.
//
//   node server/scripts/schedulePost.js publish
//       Reads that file and makes the container public. One HTTPS call.
//
// Why bother splitting it rather than doing the whole thing at 6:30: by then
// Meta already holds the video, so the run that fires at the appointed minute
// needs nothing except an internet connection. It does not need server/index.js
// to still be up, and it does not need the Funnel on port 10000 — which is the
// part most likely to be off by the evening, and whose failure would otherwise
// mean the post silently never happens.
//
// The cost of the split is that a container expires after 24 hours, so prepare
// and publish have to happen on the same day. `status` prints how long is left.
// Before anything that reads IG_ACCESS_TOKEN — this runs outside the server
// process, so nothing else has loaded .env for it.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prepareReel, publishPreparedContainer, checkInstagramAccount } from '../marketing/instagramGraph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'uploads', 'reels', 'scheduled-post.json');

// A container is dead to Meta after 24 hours. Warn well before that rather
// than at the cliff edge, since the whole point is an unattended run.
const CONTAINER_TTL_HOURS = 24;

const readState = () => {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const writeState = (state) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

async function prepare() {
  const fileName = process.argv[3];
  if (!fileName) throw new Error('Usage: schedulePost.js prepare <file.mp4> --caption-file <path> [--target reel|story]');

  const captionFile = arg('caption-file');
  const caption = captionFile ? fs.readFileSync(captionFile, 'utf8').trim() : '';
  const target = arg('target') || 'reel';
  // share_to_feed only means anything for a reel; a story has no feed copy.
  const shareToFeed = arg('share-to-feed') !== 'false';

  const account = await checkInstagramAccount();
  console.log(`account: @${account.username} (${account.followers} followers)`);
  console.log(`file:    ${fileName}`);
  console.log(`target:  ${target}${target === 'reel' ? ` (share to feed: ${shareToFeed})` : ''}`);
  console.log(`caption: ${caption.length} chars`);

  const result = await prepareReel({
    fileName,
    target,
    caption,
    shareToFeed,
    onStage: (stage, detail) => console.log(`  ${stage}: ${detail}`),
  });

  writeState({
    containerId: result.containerId,
    videoUrl: result.videoUrl,
    target: result.target,
    fileName,
    caption,
    preparedAt: new Date().toISOString(),
    publishedAt: null,
    mediaId: null,
  });

  console.log(`\nPREPARED. Container ${result.containerId} is on Meta's servers and is NOT public.`);
  console.log(`Publish it with: node server/scripts/schedulePost.js publish`);
  console.log(`Cancel by deleting: ${STATE_FILE}`);
}

async function publish() {
  const state = readState();
  if (!state) throw new Error(`Nothing is prepared — ${STATE_FILE} does not exist. Run "prepare" first.`);
  if (state.publishedAt) {
    // Publishing the same container twice is how one reel becomes two posts.
    console.log(`Already published at ${state.publishedAt} as media ${state.mediaId}. Doing nothing.`);
    return;
  }

  const age = hoursSince(state.preparedAt);
  if (age > CONTAINER_TTL_HOURS) {
    throw new Error(
      `Container ${state.containerId} was prepared ${age.toFixed(1)}h ago and Meta expires them at ${CONTAINER_TTL_HOURS}h. Re-run "prepare".`,
    );
  }

  console.log(`publishing container ${state.containerId} (prepared ${age.toFixed(1)}h ago)`);
  const mediaId = await publishPreparedContainer(state.containerId);
  if (!mediaId) throw new Error('Instagram returned no media id — the post may not have gone up.');

  writeState({ ...state, publishedAt: new Date().toISOString(), mediaId });
  console.log(`PUBLISHED as media ${mediaId}`);
}

function status() {
  const state = readState();
  if (!state) return console.log('Nothing scheduled.');
  const age = hoursSince(state.preparedAt);
  console.log(`container:  ${state.containerId}`);
  console.log(`file:       ${state.fileName}`);
  console.log(`target:     ${state.target}`);
  console.log(`prepared:   ${state.preparedAt} (${age.toFixed(1)}h ago)`);
  console.log(`expires in: ${(CONTAINER_TTL_HOURS - age).toFixed(1)}h`);
  console.log(state.publishedAt ? `PUBLISHED:  ${state.publishedAt} as ${state.mediaId}` : 'status:     NOT yet public');
}

const command = process.argv[2];
try {
  if (command === 'prepare') await prepare();
  else if (command === 'publish') await publish();
  else if (command === 'status') status();
  else {
    console.error('Usage: schedulePost.js <prepare|publish|status>');
    process.exit(2);
  }
} catch (err) {
  // The scheduled task reads the exit code, and a log nobody watched is the
  // only trace an unattended failure leaves.
  console.error(`FAILED: ${err.message || err}`);
  process.exit(1);
}
