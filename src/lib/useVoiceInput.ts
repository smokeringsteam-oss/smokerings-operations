import { useCallback, useEffect, useRef, useState } from 'react';

// Dictation for a text box, on the browser's own speech recogniser.
//
// The Web Speech API rather than a recording sent to a transcription service:
// it needs no key, no server route and no upload over kitchen wifi, and the
// words land in the box as they are spoken rather than after a round trip.
// Chrome, Edge and Safari carry it (Android and iOS included); Firefox does
// not, and there `supported` is false and the caller simply hides the mic.
//
// It only ever hands text back. What to do with it — append to a draft,
// replace a search term — is the caller's, so the same hook can serve any box.

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionErrorEvent = { error: string };

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked — allow it in the browser to dictate.';
    case 'no-speech':
      return "Didn't catch anything — tap the mic and try again.";
    case 'audio-capture':
      return 'No microphone found on this device.';
    case 'network':
      return 'Voice input needs a connection — type it instead for now.';
    default:
      return 'Voice input stopped unexpectedly.';
  }
}

export interface VoiceInput {
  supported: boolean;
  listening: boolean;
  // Words heard but not yet settled; shown live, replaced as they firm up.
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
  toggle(): void;
}

// `onFinal` is called once per settled phrase. Held in a ref so a caller
// passing a fresh closure each render does not restart the recogniser.
export function useVoiceInput(onFinal: (text: string) => void, lang?: string): VoiceInput {
  const [supported] = useState(() => recognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.lang = lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-IN';
    // Keeps listening through a pause for breath; the person taps to stop.
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          const settled = text.trim();
          if (settled) onFinalRef.current(settled);
        } else {
          pending += text;
        }
      }
      setInterim(pending.trim());
    };
    rec.onerror = (event) => {
      // An abort is ours (unmount or a second tap), not something to report.
      if (event.error !== 'aborted') setError(describeError(event.error));
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim('');
    };
    setError(null);
    setInterim('');
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      setError('Voice input could not start.');
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // A recogniser left running after the panel closes keeps the mic light on.
  useEffect(
    () => () => {
      const rec = recRef.current;
      if (rec) {
        rec.onend = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.abort();
        recRef.current = null;
      }
    },
    [],
  );

  return { supported, listening, interim, error, start, stop, toggle };
}
