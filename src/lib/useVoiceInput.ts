import { useCallback, useEffect, useRef, useState } from 'react';

// Dictation for a text box: record from the microphone, send the clip to the
// server, get the words back.
//
// Not the browser's own speech recogniser (the Web Speech API), which is what
// this first used. On a phone it fails silently where it matters most: in the
// dashboard opened from the home screen the recogniser exists, starts, shows
// the mic as live — and never returns a word. Recording works everywhere the
// microphone does, installed apps included, and the server's Gemini read
// copes with Indian accents and a sentence that drifts into Kannada or Hindi
// far better than the browser does.
//
// The price is no live text while speaking: the words arrive a second or two
// after the mic is tapped off. For a one-line to-do that is a fair trade for
// a mic that actually works.
//
// It only ever hands text back. What to do with it — append to a draft,
// replace a search term — is the caller's.

// Long enough for any to-do, short enough that a mic forgotten in a pocket
// does not upload ten minutes of kitchen noise.
const MAX_RECORDING_MS = 2 * 60 * 1000;

// Hands-free: how long a quiet spell ends the note, and how long to wait for
// the first word before giving up on a wake that nobody followed up.
const SILENCE_END_MS = 1600;
const NO_SPEECH_GIVE_UP_MS = 7000;
const HANDS_FREE_FALLBACK_MS = 8000;

// Root-mean-square level of the mic right now, 0 silent to ~1 clipping.
export function micLevel(analyser: AnalyserNode, samples: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

// In order of preference. iOS records only mp4; Chrome and Android record webm.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked — allow it for this app in your phone settings, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone found on this device.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app — close it and try again.';
  return 'Could not start the microphone.';
}

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

// The two-note chime Google's voice search plays: up when the mic opens, down
// when it closes. Heard rather than seen, so someone who tapped the mic and
// looked away at the grill still knows it is listening.
function chime(ctx: AudioContext | null, rising: boolean) {
  if (!ctx) return;
  try {
    const notes = rising ? [660, 880] : [880, 587];
    notes.forEach((freq, i) => {
      const at = ctx.currentTime + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    });
  } catch {
    // A chime that cannot play is not worth a message.
  }
}

async function transcribe(blob: Blob): Promise<string> {
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio', blob, `voice-note.${ext}`);
  const res = await fetch('/api/notes/transcribe', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`);
  return typeof data?.text === 'string' ? data.text.trim() : '';
}

export interface VoiceInput {
  supported: boolean;
  // The mic is live and recording.
  listening: boolean;
  // Recording finished; waiting for the words to come back.
  transcribing: boolean;
  // This recording was opened by voice and ends itself on a pause.
  handsFree: boolean;
  error: string | null;
  // Live level of the microphone while recording, for the overlay's rings.
  // Null when not recording or where the browser has no Web Audio.
  analyser: AnalyserNode | null;
  // `handsFree` ends the recording on its own once the speaker goes quiet,
  // for when it was opened by "Hey Smokey" and nobody has a hand free to tap.
  start(options?: { handsFree?: boolean }): void;
  // Ends the recording and writes down what was said.
  stop(): void;
  // Ends the recording and throws it away.
  cancel(): void;
  toggle(): void;
  clearError(): void;
}

// `onText` is called once per recording with what was said. Held in a ref so
// a caller passing a fresh closure each render is always the one called.
export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [supported] = useState(isSupported);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [handsFree, setHandsFree] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const levelNodeRef = useRef<AnalyserNode | null>(null);
  const discardRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set while starting, so a double tap does not open the mic twice.
  const startingRef = useRef(false);
  // Cleared on unmount, so a reply that lands after the panel is gone is
  // dropped rather than written into state nobody holds.
  const aliveRef = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const releaseMic = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (silenceRef.current) clearInterval(silenceRef.current);
    silenceRef.current = null;
    // Stopping the tracks is what turns the phone's mic indicator off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    levelNodeRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async (options?: { handsFree?: boolean }) => {
    if (!isSupported() || recorderRef.current || startingRef.current) return;
    startingRef.current = true;
    discardRef.current = false;
    setHandsFree(!!options?.handsFree);
    setError(null);
    // Made (or woken) here, inside the tap, before anything is awaited:
    // iOS only lets a page make a sound from a context started by a gesture.
    const AudioCtx = audioContextCtor();
    if (AudioCtx && !audioCtxRef.current) {
      try {
        audioCtxRef.current = new AudioCtx();
      } catch {
        audioCtxRef.current = null;
      }
    }
    void audioCtxRef.current?.resume?.().catch(() => undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      startingRef.current = false;
      if (aliveRef.current) setError(describeMicError(err));
      return;
    }
    if (!aliveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      startingRef.current = false;
      setError('Recording is not available on this device.');
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      recorderRef.current = null;
      releaseMic();
      if (!aliveRef.current) return;
      setListening(false);
      setAnalyser(null);
      chime(audioCtxRef.current, false);
      if (discardRef.current) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (blob.size === 0) {
        setError("Didn't catch anything — tap the mic and try again.");
        return;
      }
      setTranscribing(true);
      try {
        const text = await transcribe(blob);
        if (!aliveRef.current) return;
        if (text) onTextRef.current(text);
        else setError("Didn't catch anything — tap the mic and try again.");
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (aliveRef.current) setTranscribing(false);
      }
    };

    streamRef.current = stream;
    recorderRef.current = recorder;
    const ctx = audioCtxRef.current;
    if (ctx) {
      try {
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createAnalyser();
        node.fftSize = 512;
        node.smoothingTimeConstant = 0.6;
        source.connect(node);
        sourceRef.current = source;
        levelNodeRef.current = node;
        setAnalyser(node);
      } catch {
        setAnalyser(null);
      }
    }
    recorder.start();
    startingRef.current = false;
    setListening(true);
    chime(ctx, true);
    timerRef.current = setTimeout(() => stop(), MAX_RECORDING_MS);

    const node = levelNodeRef.current;
    if (options?.handsFree && !node) {
      // No level to watch (no Web Audio): stop on a fixed clock instead.
      timerRef.current = setTimeout(() => stop(), HANDS_FREE_FALLBACK_MS);
    } else if (options?.handsFree && node) {
      const samples = new Uint8Array(node.fftSize);
      const began = Date.now();
      let heardAt = 0;
      let floor = 0.01;
      silenceRef.current = setInterval(() => {
        const now = Date.now();
        // Opened by voice rather than a tap, the audio context can be held
        // suspended by the browser and read as silence; fall back to a clock
        // rather than give up on someone who is talking.
        if (ctx?.state !== 'running') {
          if (now - began > HANDS_FREE_FALLBACK_MS) stop();
          return;
        }
        const level = micLevel(node, samples);
        // Speech is whatever stands well clear of the room's own hum, which
        // in a kitchen with the exhaust running is far from silence.
        if (level > Math.max(0.03, floor * 2.5)) heardAt = now;
        else floor = floor * 0.95 + level * 0.05;
        if (heardAt && now - heardAt > SILENCE_END_MS) stop();
        else if (!heardAt && now - began > NO_SPEECH_GIVE_UP_MS) cancel();
      }, 100);
    }
  }, [releaseMic, stop, cancel]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop();
    else void start();
  }, [start, stop]);

  // A recorder left running after the panel is gone keeps the mic light on.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      releaseMic();
      void audioCtxRef.current?.close?.().catch(() => undefined);
      audioCtxRef.current = null;
    };
  }, [releaseMic]);

  const clearError = useCallback(() => setError(null), []);

  return {
    supported,
    listening,
    transcribing,
    handsFree,
    error,
    analyser,
    start: (options?: { handsFree?: boolean }) => void start(options),
    stop,
    cancel,
    toggle,
    clearError,
  };
}
