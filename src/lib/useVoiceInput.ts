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
  error: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

// `onText` is called once per recording with what was said. Held in a ref so
// a caller passing a fresh closure each render is always the one called.
export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [supported] = useState(isSupported);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    // Stopping the tracks is what turns the phone's mic indicator off.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!isSupported() || recorderRef.current || startingRef.current) return;
    startingRef.current = true;
    setError(null);
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
    recorder.start();
    startingRef.current = false;
    setListening(true);
    timerRef.current = setTimeout(() => stop(), MAX_RECORDING_MS);
  }, [releaseMic, stop]);

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
    };
  }, [releaseMic]);

  return { supported, listening, transcribing, error, start: () => void start(), stop, toggle };
}
