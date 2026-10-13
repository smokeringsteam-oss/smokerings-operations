// Voice commands — a spoken sentence turned into a draft purchase and/or a
// list of draft to-dos for the mic button (src/components/VoiceCommand.tsx)
// to show, check and only then save. Or into a day to look at: "show me
// pending tasks for today" comes back as `showTasksFor`, and the mic opens
// Daily View on that day instead of drafting anything.
//
// The same two halves as the bill scan next door (purchaseScan.js), and the
// purchase half IS the bill scan's: a spoken "5 kg pork shoulder at 540" is a
// one-line bill, so it goes through normaliseScannedBill and gets the same id
// checks, number coercion and vendor matching. Only the tasks are new here.
//
// Nothing here writes. The screen saves a confirmed draft through the
// endpoints that already exist — POST /api/purchasing/purchases, POST
// /api/notes, POST /api/recurring-schedule/tasks — so a voice entry is the
// same row, with the same side effects, as one typed in.
import { readVoiceCommand } from '../../integrations/geminiContent.js';
import { getRawMaterials, getVendors } from './purchasing.js';
import { normaliseScannedBill } from './purchaseScan.js';

// 10 MB. The browser sends 16 kHz mono WAV capped at a minute, which is under
// 2 MB; this is the ceiling for anything else that might post here.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// A YYYY-MM-DD that is a real day, or ''. Gemini resolves "tomorrow" and "the
// 15th" itself, so what comes back is a claim like any other field — and a
// date that does not exist would file a task under a day nobody ever opens.
function isoDay(value) {
  const text = clean(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return '';
  const day = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return day.toISOString().slice(0, 10) === text ? text : '';
}

// The team as the browser sent it: a JSON array in a multipart field.
function parseTeam(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// parsed: whatever readVoiceCommand returned. Pure, so it is testable without
// a Gemini key or a microphone — see voiceCommand.test.js.
function normaliseVoiceCommand(parsed, { materials = [], vendors = [], team = [] } = {}) {
  const bill = normaliseScannedBill(parsed, { materials, vendors });
  const purchase =
    bill.lines.length || bill.skipped.length
      ? {
          vendorName: bill.vendorName,
          vendorText: bill.vendorText,
          purchaseDate: bill.purchaseDate,
          channel: parsed?.channel === 'B2B' ? 'B2B' : 'B2C',
          lines: bill.lines,
          skipped: bill.skipped,
        }
      : null;

  const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
    .map((raw) => {
      const title = clean(raw?.title).slice(0, 2000);
      if (!title) return null;
      const spokenName = clean(raw.assignee).toLowerCase();
      const day = WEEKDAYS.find((name) => name.toLowerCase() === clean(raw.day).toLowerCase()) || '';
      const repeatsWeekly = Boolean(raw.repeatsWeekly);
      return {
        title,
        // Only a name the board knows. A misheard one is dropped rather than
        // kept, so it cannot split one person across two name chips.
        assignee: team.find((name) => name.toLowerCase() === spokenName) || '',
        repeatsWeekly,
        day,
        time: clean(raw.time).slice(0, 10),
        // A repeating task has a weekday, not a date; the two are never both
        // set, so the screen has one question to ask about when.
        dueDate: repeatsWeekly ? '' : isoDay(raw.dueDate),
      };
    })
    .filter(Boolean);

  return {
    transcript: clean(parsed?.transcript),
    purchase,
    tasks,
    showTasksFor: isoDay(parsed?.showTasksFor),
    notes: bill.notes,
  };
}

// The route's half: validate the upload, read it, normalise it. `buffer` is
// the recording from multer's memory storage; `text` is the typed fallback.
async function interpretVoiceCommand({ buffer, mimeType, size, text, team }) {
  const typed = clean(text);
  const hasAudio = Boolean(buffer && buffer.length);
  if (!hasAudio && !typed) {
    const err = new Error('Nothing was recorded — tap the mic and say the command.');
    err.status = 400;
    throw err;
  }
  if (hasAudio && !/^audio\//i.test(mimeType || '')) {
    const err = new Error(`Unsupported recording type${mimeType ? ` (${mimeType})` : ''}.`);
    err.status = 400;
    throw err;
  }
  if (hasAudio && (size ?? buffer.length) > MAX_AUDIO_BYTES) {
    const err = new Error('That recording is too long — keep a command under a minute.');
    err.status = 413;
    throw err;
  }

  const materials = getRawMaterials();
  const vendors = getVendors();
  const names = parseTeam(team);
  const now = new Date();
  const isoDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const parsed = await readVoiceCommand({
    audioBase64: hasAudio ? buffer.toString('base64') : '',
    mimeType,
    text: typed,
    catalogue: materials.map((m) => ({ material_id: m.material_id, item_name: m.item_name, category: m.category })),
    vendors: vendors.map((v) => v.vendor_name),
    team: names,
    // The server's own calendar day, with the weekday spelled out so "last
    // Friday" has something to count back from.
    today: `${now.toLocaleDateString('en-US', { weekday: 'long' })} ${isoDay}`,
  });

  return normaliseVoiceCommand(parsed, { materials, vendors, team: names });
}

export { MAX_AUDIO_BYTES, normaliseVoiceCommand, interpretVoiceCommand };
