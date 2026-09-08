// Writes the mirrored knowledge-base CSVs out from the database, without
// waiting for someone to edit something in the app.
//
//   npm run csv:mirror
//
// The mirrors normally run on their own, after each edit the app makes (see
// server/sprint/recurringSchedule.js, server/sprint/weeklyScheduleStatusLog.js
// and server/ops/shared/smoking.js).
// This is for the two cases those don't cover: the first run after this
// feature landed, when the files on disk are still whatever the SQLite cutover
// left behind, and after a `npm run db -- "update scheduled_task ..."`
// one-liner, which changes the table without going through the app at all.
//
// Read-only against the database, so it is always safe to run.
import 'dotenv/config';
import { mirrorScheduleCsv } from '../sprint/recurringSchedule.js';
import { mirrorWeekStatusCsv } from '../sprint/weeklyScheduleStatusLog.js';
import { mirrorSessionsCsv } from '../ops/shared/smoking.js';

let failed = false;

[
  ['schedule', mirrorScheduleCsv],
  ['weekly status log', mirrorWeekStatusCsv],
  ['smoking log', mirrorSessionsCsv],
].forEach(([label, mirror]) => {
  const result = mirror();
  if (result.mirrored) {
    console.log(`${label}: wrote ${result.rows} row(s) to ${result.path}`);
  } else {
    failed = true;
    console.error(`${label}: ${result.reason}`);
  }
});

// Non-zero when a mirror was skipped or failed — this one is run by hand and
// the whole point of running it is to know the files are current.
process.exit(failed ? 1 : 0);
