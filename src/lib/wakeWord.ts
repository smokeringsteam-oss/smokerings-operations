// "Hey Smokey" — the hands-free way into the voice command button.
//
// This is the browser's own speech recognition (Chrome's, in practice), left
// running while the app is open, and it is only ever asked one question: was
// the wake phrase said? The command itself still goes to Gemini as audio (see
// voiceRecorder.ts), because the browser's recogniser is fine at two fixed
// words and poor at "Venkateshwara" over a smoker's fan.
//
// On for every device whose browser has the API, with no switch — see
// VoiceCommand.tsx. While it runs, the browser streams the room to its speech
// service.

// "smokey", "smoky", "smokie", and the "smoke" a recogniser hears when the
// last syllable is swallowed. Deliberately not looser than this: a false wake
// opens a live microphone.
const WAKE = /\b(?:hey|hay|hi|ok|okay),?\s+smok(?:ey|ie|y|e)\b[\s,.!?]*/i;

// The words that followed the wake phrase in the same breath, or null when the
// phrase was not said at all. '' means it was said on its own.
export function matchWakeWord(transcript: string): string | null {
  const found = WAKE.exec(transcript);
  if (!found) return null;
  return transcript.slice(found.index + found[0].length).trim();
}

// The slice of the Web Speech API used here. It is not in TypeScript's DOM
// typings, and Chrome still ships it under the webkit prefix.
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const wakeWordSupported = (): boolean => recognitionClass() !== null;

// Listens until the wake phrase is heard, calls onWake once with whatever was
// said after it, and stops — the microphone is about to be wanted by the
// recorder, and two things holding it at once is what Android refuses. Call
// again to listen for the next one. Returns the function that stops it early.
export function listenForWakeWord({
  onWake,
  onError,
}: {
  onWake: (rest: string) => void;
  onError: (message: string) => void;
}): () => void {
  const Ctor = recognitionClass();
  if (!Ctor) {
    onError('This browser cannot listen for “Hey Smokey” — use Chrome, or tap the mic.');
    return () => {};
  }

  let stopped = false;
  let restart: ReturnType<typeof setTimeout> | null = null;
  const recognition = new Ctor();
  recognition.lang = 'en-IN';
  recognition.continuous = true;
  recognition.interimResults = false;

  const stop = () => {
    stopped = true;
    if (restart) clearTimeout(restart);
    try {
      recognition.abort();
    } catch {
      // Already stopped.
    }
  };

  recognition.onresult = (event) => {
    if (stopped) return;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      // Final results only: the rest of the sentence is still arriving in an
      // interim one, and it is the rest of the sentence that gets passed on.
      const rest = result.isFinal ? matchWakeWord(result[0].transcript) : null;
      if (rest !== null) {
        stop();
        onWake(rest);
        return;
      }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stop();
      onError('Microphone access was blocked — allow it for this site to use “Hey Smokey”.');
    }
    // Anything else ("no-speech", "network", "aborted") ends the session and
    // is picked up again by onend below.
  };

  // Chrome ends a recognition session on its own after a stretch of quiet, so
  // "always listening" is really "restarted every time it stops".
  recognition.onend = () => {
    if (stopped) return;
    restart = setTimeout(() => {
      if (stopped) return;
      try {
        recognition.start();
      } catch {
        // Still winding down; the next onend tries again.
      }
    }, 400);
  };

  try {
    recognition.start();
  } catch {
    onError('Could not start listening for “Hey Smokey”.');
    stopped = true;
  }
  return stop;
}
