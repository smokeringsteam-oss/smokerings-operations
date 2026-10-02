import { useEffect, useRef, useState } from 'react';
import { micLevel } from './useVoiceInput';

// "Hey Smokey": keep the mic open while the dashboard is on screen and call
// `onWake` when someone says it.
//
// There is no on-device wake-word engine a web page can use without a
// vendor key and a trained model, so this splits the job in two:
//
//   1. On the device, a voice detector. It watches the mic level against the
//      room's own background (the exhaust, the fridge) and starts a short
//      recording only when someone is actually talking. Silence and steady
//      noise never leave the phone.
//   2. On the server, Gemini hears each burst of speech — a few seconds at
//      most — and answers one question: was "Hey Smokey" said. It also hands
//      back anything said after it, so "Hey Smokey, order more gas" goes
//      straight into the box.
//
// The cost is that every burst of talk near the tablet makes one small
// request while this is switched on. It is off by default, and switched on
// per device.
//
// It only works while the dashboard is open and on screen: a phone that is
// locked, or has the app in the background, stops giving the page its mic.
// On a kitchen tablet the screen is kept awake while this is on.

const TICK_MS = 50;
// Talk has to stand this far clear of the room's level to count as speech.
const SPEECH_RATIO = 2.6;
const MIN_SPEECH_LEVEL = 0.025;
// A burst ends after this much quiet...
const END_SILENCE_MS = 650;
// ...or at this length, whichever comes first. Long enough for "Hey Smokey,
// order two more cylinders of gas"; anything longer is conversation.
const MAX_BURST_MS = 6000;
// Coughs, clatter and a dropped tray are shorter than "Hey Smokey".
const MIN_BURST_MS = 350;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor | null {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function wakeWordSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    audioContextCtor() !== null
  );
}

async function checkClip(blob: Blob): Promise<{ wake: boolean; command: string }> {
  const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
  const form = new FormData();
  form.append('audio', blob, `wake.${ext}`);
  const res = await fetch('/api/notes/wake', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Wake check failed (${res.status})`);
  return { wake: data?.wake === true, command: typeof data?.command === 'string' ? data.command : '' };
}

export type WakeState = 'off' | 'starting' | 'listening' | 'paused' | 'blocked';

interface Options {
  enabled: boolean;
  // Held off while the recorder itself has the mic, so the note being
  // dictated is not also sent off as a wake check.
  paused: boolean;
  onWake: (command: string) => void;
}

export function useWakeWord({ enabled, paused, onWake }: Options): { state: WakeState; error: string | null } {
  const [state, setState] = useState<WakeState>('off');
  const [error, setError] = useState<string | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    if (!enabled || !wakeWordSupported()) {
      setState('off');
      return undefined;
    }
    // The recorder has the mic. Let go of it entirely rather than share: on
    // iOS a second capture silently ends the first, and the stream this held
    // would come back dead. Reopened fresh when the recording is done.
    if (paused) {
      setState('paused');
      return undefined;
    }
    let disposed = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let recorder: MediaRecorder | null = null;
    let wakeLock: { release(): Promise<void> } | null = null;
    let checking = false;
    const resume = () => void ctx?.resume().catch(() => undefined);

    const keepAwake = async () => {
      const nav = navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      if (!nav.wakeLock || document.visibilityState !== 'visible') return;
      try {
        wakeLock = await nav.wakeLock.request('screen');
      } catch {
        wakeLock = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void keepAwake();
        resume();
      }
    };

    const run = async () => {
      setState('starting');
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        if (disposed) return;
        const name = err instanceof DOMException ? err.name : '';
        setState('blocked');
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Hey Smokey needs the microphone — allow it for this app, then switch it on again.'
            : 'Hey Smokey could not open the microphone.',
        );
        return;
      }
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const AudioCtx = audioContextCtor()!;
      ctx = new AudioCtx();
      // Opened without a tap (the switch was left on from last time), the
      // context starts suspended and hears nothing; the first touch wakes it.
      if (ctx.state === 'suspended') {
        resume();
        document.addEventListener('pointerdown', resume);
        document.addEventListener('keydown', resume);
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';

      document.addEventListener('visibilitychange', onVisible);
      void keepAwake();
      setState('listening');

      let floor = 0.01;
      let burstStart = 0;
      let lastLoud = 0;
      let chunks: Blob[] = [];

      const endBurst = () => {
        const rec = recorder;
        recorder = null;
        if (!rec || rec.state === 'inactive') return;
        const spoken = lastLoud - burstStart;
        rec.onstop = async () => {
          if (disposed || spoken < MIN_BURST_MS || checking || pausedRef.current) return;
          const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
          if (!blob.size) return;
          checking = true;
          try {
            const result = await checkClip(blob);
            if (!disposed && result.wake && !pausedRef.current) onWakeRef.current(result.command.trim());
          } catch (err) {
            // One failed check is not worth a banner; a server with no key is.
            if (!disposed && err instanceof Error && /GEMINI_API_KEY/.test(err.message)) setError(err.message);
          } finally {
            checking = false;
          }
        };
        rec.stop();
      };

      interval = setInterval(() => {
        if (!stream || !ctx) return;
        if (pausedRef.current) {
          if (recorder) {
            recorder.onstop = null;
            recorder.stop();
            recorder = null;
          }
          return;
        }
        const level = micLevel(analyser, samples);
        const now = Date.now();
        const loud = level > Math.max(MIN_SPEECH_LEVEL, floor * SPEECH_RATIO);
        if (!loud && !recorder) floor = floor * 0.98 + level * 0.02;

        if (loud) {
          lastLoud = now;
          if (!recorder && !checking) {
            chunks = [];
            try {
              recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            } catch {
              recorder = null;
              return;
            }
            recorder.ondataavailable = (event) => {
              if (event.data?.size) chunks.push(event.data);
            };
            burstStart = now;
            recorder.start();
          }
        }
        if (recorder && (now - lastLoud > END_SILENCE_MS || now - burstStart > MAX_BURST_MS)) endBurst();
      }, TICK_MS);
    };

    void run();

    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close().catch(() => undefined);
      void wakeLock?.release().catch(() => undefined);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
    };
  }, [enabled, paused]);

  return { state, error };
}
