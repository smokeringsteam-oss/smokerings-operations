// Microphone capture for the voice command button.
//
// What a browser records is whatever its MediaRecorder feels like — WebM/Opus
// in Chrome, MP4/AAC in Safari — and neither is on the list of audio formats
// Gemini documents. So the clip is decoded here and re-encoded as 16 kHz mono
// WAV, which is: speech is all that is in it, a minute of it is under 2 MB,
// and it is the one format every model and every server agrees on.

const SAMPLE_RATE = 16_000;

export type Recording = {
  // Ends the recording and resolves with the clip.
  stop: () => Promise<Blob>;
  // Ends it and throws the audio away.
  cancel: () => void;
};

function encodeWav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function toWav(clip: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await clip.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0));
  } finally {
    void ctx.close();
  }
}

// How long a pause ends a hands-free command, and how long to wait for one to
// start at all before giving up on it.
const SILENCE_MS = 1800;
const NO_SPEECH_MS = 8000;

// Calls onSilence once, when the speaker has said something and then stopped
// (or never started). "Loud" is measured against the room rather than against
// a fixed level, because the room here has a smoker's fan in it. Returns the
// function that stops watching.
function watchForSilence(stream: MediaStream, onSilence: () => void): () => void {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const started = Date.now();
  let floor = Infinity;
  let heard = false;
  let lastLoud = started;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const level = Math.sqrt(sum / samples.length);
    // The quietest the room has been, allowed to drift up slowly so one dead
    // moment at the start does not set the bar for the whole clip.
    floor = Math.min(level, floor * 1.02 + 0.0001);
    const now = Date.now();
    if (level > Math.max(0.015, floor * 3)) {
      heard = true;
      lastLoud = now;
    }
    if (heard ? now - lastLoud > SILENCE_MS : now - started > NO_SPEECH_MS) {
      end();
      onSilence();
    }
  }, 100);

  const end = () => {
    clearInterval(timer);
    void ctx.close().catch(() => {});
  };
  return end;
}

// onSilence: for a recording nobody is going to tap to stop (the "Hey Smokey"
// path) — called once when the speaker has finished.
export async function startRecording({ onSilence }: { onSilence?: () => void } = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record audio.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error('Microphone access was blocked — allow it for this site and try again.');
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.start();

  // The tab's "recording" indicator stays lit until every track is stopped.
  const unwatch = onSilence ? watchForSilence(stream, onSilence) : () => {};
  const release = () => {
    unwatch();
    stream.getTracks().forEach((track) => track.stop());
  };

  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        recorder.addEventListener(
          'stop',
          () => {
            release();
            const clip = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            if (!clip.size) {
              reject(new Error('Nothing was recorded — try again.'));
              return;
            }
            // A browser that cannot decode its own recording still gets to
            // send it; the server only insists on audio/*.
            toWav(clip).then(resolve, () => resolve(clip));
          },
          { once: true },
        );
        recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
