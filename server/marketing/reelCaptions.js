// Writing the words on the reel.
//
// roughCut.js decides which seconds of footage make it in; this decides what
// is said over them. It is the one layer in the reel pipeline that asks a
// model anything, and it is kept in its own file for that reason — everything
// upstream is a decode or a pure function, reproducible and testable, and
// mixing a model call into that would make the whole chain non-deterministic.
//
// HOW IT SEES THE FOOTAGE. Not by uploading the clips. One JPEG is pulled from
// the middle of each chosen shot and those frames are what the model is shown,
// which is a deliberate trade:
//
//   * a 15-second reel is six or seven shots, so this is six or seven small
//     images rather than forty megabytes of video per request;
//   * the middle of a pick is the frame roughCut already judged most settled —
//     past the autofocus hunt at the head, before whatever ended the shot;
//   * and it costs one cheap call instead of a video-understanding one, which
//     matters on a free-tier key. (See the grounding-quota note: this project's
//     Gemini key 429s readily, so the fallback path below is not theoretical.)
//
// What it gives up is motion — the model cannot tell a brisket being sliced
// from a brisket sitting still. Captions are written about what is IN frame,
// never about what is happening across it, and the prompt says so.
//
// FAILURE IS NOT FATAL, EVER. No API key, a 429, a malformed answer, ffmpeg
// refusing a frame — every one of them returns captions:[] and a note, and the
// reel renders silent of text. A reel with no words is a reel; a build that
// dies at the last step because a quota ran out is twenty minutes of footage
// wasted. Nothing in here throws.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { FFMPEG_PATH, wrapCaption } from './reelStudio.js';

const execFileAsync = promisify(execFile);

const MODEL = process.env.GEMINI_REEL_MODEL || process.env.GEMINI_CONTENT_MODEL || 'gemini-flash-lite-latest';

// Wide enough for the model to read a label or recognise a cut of meat, small
// enough that seven of them are a couple of hundred kilobytes in total.
const FRAME_WIDTH = 512;

// A caption has to be read on a phone, at arm's length, while the shot it
// belongs to is on screen for under three seconds. wrapCaption() breaks at 24
// characters a line, so this is about two lines — past that the reader is
// still reading when the picture changes.
const MAX_CAPTION_CHARS = 48;

// Below this a shot is gone before a caption could be read, so it is left
// clean rather than flashed at.
const MIN_CAPTIONABLE_SECONDS = 1.2;

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const SYSTEM_PROMPT = `You write the on-screen text for short vertical food videos for Smoke Rings BBQ, a small barbecue kitchen that smokes its own brisket, pulled pork and chicken.

You are shown one still frame from each shot of a reel, in the order they play. Write the words that appear over each shot.

RULES
- Describe what is visibly in the frame. You are seeing one still, not the motion, so never claim something is being sliced, poured, stirred or flipped.
- ${MAX_CAPTION_CHARS} characters maximum per caption. Shorter is better. Two or three words is often best.
- Sentence case, no full stop at the end. No emoji. No hashtags. No quote marks.
- Do not number the shots or refer to them as shots, clips or frames.
- The captions are read in sequence, so they should build: the first sets up, the last pays off. Do not repeat a word across captions.
- Leave a caption empty when the picture speaks for itself or you cannot tell what you are looking at. A reel where half the shots are clean reads better than one narrated end to end. Never invent a detail to fill a caption.
- Never state a temperature, a cook time, a weight or a price. You cannot see those and guessing them makes the kitchen look sloppy.

Also write one caption for the post itself: a sentence or two for the Instagram description, warmer and longer than the on-screen text, ending with three to five relevant hashtags.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    captions: {
      type: Type.ARRAY,
      description: 'One entry per shot shown, in the same order. Use an empty string to leave a shot clean.',
      items: {
        type: Type.OBJECT,
        properties: {
          shot: { type: Type.INTEGER, description: 'The 1-based number the shot was labelled with.' },
          text: { type: Type.STRING },
        },
        required: ['shot', 'text'],
      },
    },
    postCaption: { type: Type.STRING, description: 'The Instagram description, with hashtags.' },
  },
  required: ['captions', 'postCaption'],
};

// One frame from the middle of a pick, as a JPEG buffer.
//
// -ss goes BEFORE -i so ffmpeg seeks the container rather than decoding from
// the top and throwing frames away; on a three-minute source that is the
// difference between a tenth of a second and several. The accuracy that
// costs is irrelevant here — this frame is shown to a model, not cut into
// the reel.
async function grabFrame(sourcePath, seconds, outputPath) {
  await execFileAsync(
    FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(Math.max(0, seconds)),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${FRAME_WIDTH}:-2:flags=fast_bilinear`,
      '-q:v',
      '5',
      '-y',
      outputPath,
    ],
    { timeout: 20000, windowsHide: true },
  );
  return fs.readFileSync(outputPath);
}

// Trims a model's answer back inside the rules the prompt asked for, because
// a prompt is a request and this is the enforcement. Anything that comes back
// too long, quoted, hashtagged or punctuated is cleaned rather than dropped —
// the judgement about what the picture shows is the valuable part and a
// trailing full stop is not worth losing it over.
export function tidyCaption(text) {
  let out = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/#\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '');

  if (!out) return '';
  if (out.length > MAX_CAPTION_CHARS) {
    // Cut at a word boundary rather than mid-word. If the first word alone is
    // over the limit there is nothing sensible to keep, so it goes.
    const clipped = out.slice(0, MAX_CAPTION_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    if (lastSpace < 8) return '';
    out = clipped.slice(0, lastSpace).replace(/[,;:–—-]+$/, '').trim();
  }
  // A caption wrapCaption cannot lay out is one drawtext would render as an
  // empty box, so it is treated as no caption at all.
  return wrapCaption(out).length ? out : '';
}

// Which picks are worth captioning at all. Kept separate and exported because
// it is a rule about the edit, not about the model, and the tests assert it
// without touching the network.
export function captionablePicks(picks) {
  return picks
    .map((pick, index) => ({ pick, index }))
    .filter(({ pick }) => Number(pick.seconds ?? pick.out - pick.in) >= MIN_CAPTIONABLE_SECONDS);
}

// Turns the model's answer into captions attached to the picks it was shown.
//
// Matching is by the shot number the prompt labelled each frame with, not by
// array position: a model that returns six captions for seven frames, or
// returns them out of order, would otherwise slide every caption onto the
// wrong shot — a failure that renders perfectly and is only visible by
// watching the reel.
export function attachCaptions(picks, captionable, answer) {
  const byShot = new Map();
  for (const entry of answer?.captions || []) {
    const shot = Number(entry?.shot);
    if (!Number.isInteger(shot)) continue;
    const text = tidyCaption(entry.text);
    if (text) byShot.set(shot, text);
  }

  const captions = picks.map(() => '');
  captionable.forEach(({ index }, position) => {
    const text = byShot.get(position + 1);
    if (text) captions[index] = text;
  });
  return captions;
}

// The whole job: frames out of the picks, one call, captions back.
//
// Returns { captions, postCaption, notes } where `captions` is one string per
// pick, parallel to the array that came in, and '' means leave that shot
// clean. It never throws — see the header.
export async function writeCaptions({ picks = [], sources = {}, workDir, sessionHint = '' } = {}) {
  const notes = [];
  const blank = { captions: picks.map(() => ''), postCaption: '', notes };

  if (!picks.length) return blank;

  const ai = getClient();
  if (!ai) {
    notes.push('No GEMINI_API_KEY is set, so the reel was cut without captions.');
    return blank;
  }

  const captionable = captionablePicks(picks);
  if (!captionable.length) {
    notes.push(`Every shot is under ${MIN_CAPTIONABLE_SECONDS}s — too brief to read a caption on, so none were written.`);
    return blank;
  }

  // Frames go to the render's own work directory, which is swept with it.
  const framesDir = path.join(workDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const parts = [];
  const shown = [];
  for (const [position, entry] of captionable.entries()) {
    const { pick, index } = entry;
    const source = sources[pick.clipId];
    if (!source?.path) continue;
    const midpoint = (Number(pick.in) + Number(pick.out)) / 2;
    try {
      const jpeg = await grabFrame(source.path, midpoint, path.join(framesDir, `shot-${position + 1}.jpg`));
      parts.push({ text: `Shot ${position + 1} of ${captionable.length}:` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
      shown.push({ index, position: shown.length });
    } catch {
      // One frame that will not come out costs that shot its caption and
      // nothing else.
      notes.push(`Could not read a frame from ${source.name || pick.clipId}, so that shot has no caption.`);
    }
  }

  if (!shown.length) {
    notes.push('No frames could be read out of the footage, so the reel was cut without captions.');
    return blank;
  }

  // Renumbered against the frames that actually went in the request, so the
  // labels the model sees and the numbers attachCaptions matches on agree
  // even when a frame grab failed partway down the list.
  const sent = shown.map(({ index }) => ({ index }));

  if (sessionHint) {
    parts.unshift({ text: `What was cooking: ${sessionHint}` });
  }
  parts.push({
    text: `That is all ${shown.length} shots, in play order. Write the on-screen captions and the post caption now.`,
  });

  let answer;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // Thinking tokens count against this, so it needs headroom well above
        // the visible JSON or generation is cut off mid-object.
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    answer = JSON.parse(response.text);
  } catch (err) {
    const reason = String(err?.message || err);
    notes.push(
      /429|quota|RESOURCE_EXHAUSTED/i.test(reason)
        ? 'The Gemini quota is used up, so the reel was cut without captions. The footage and the edit are unaffected — try again later, or add them by hand.'
        : `The caption model could not be reached (${reason.slice(0, 120)}), so the reel was cut without captions.`,
    );
    return blank;
  }

  const captions = attachCaptions(picks, sent, answer);
  const written = captions.filter(Boolean).length;
  if (!written) {
    notes.push('The caption model left every shot clean.');
  }

  return {
    captions,
    postCaption: String(answer?.postCaption || '').replace(/\s+/g, ' ').trim(),
    notes,
  };
}

export { MAX_CAPTION_CHARS, MIN_CAPTIONABLE_SECONDS };
