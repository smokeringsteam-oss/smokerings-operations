// Files every shared note not yet on GitHub as a sub-issue of its category,
// on the project board in the sprint for the week it was posted.
//
//   npm run notes:file            file the unfiled notes
//   npm run notes:file -- --board also (re)place already-filed notes on the board
//
// The server does the first on its own after each new note (see
// server/integrations/noteIssues.js). This is for notes that were on the
// board before that existed, and for retrying any that failed.
import 'dotenv/config';
import { fileUnfiledNotes, placeFiledNotesOnBoard, CATEGORIES } from '../integrations/noteIssues.js';

const titles = new Map(CATEGORIES.map((c) => [c.number, c.title]));
let failed = 0;
const report = (r, line) => {
  if (r.error) {
    failed += 1;
    console.error(`note ${r.noteId}: ${r.error}`);
  } else {
    console.log(line);
  }
};

const filed = await fileUnfiledNotes();
filed.forEach((r) =>
  report(r, `note ${r.noteId} -> #${r.issue} under #${r.category} ${titles.get(r.category)}, ${r.sprint || 'no sprint'}`),
);
console.log(`${filed.length} unfiled note(s) processed.`);

if (process.argv.includes('--board')) {
  const placed = await placeFiledNotesOnBoard();
  placed.forEach((r) => report(r, `note ${r.noteId} #${r.issue} on board, ${r.sprint || 'no sprint'}`));
  console.log(`${placed.length} filed note(s) placed on the board.`);
}

process.exit(failed ? 1 : 0);
