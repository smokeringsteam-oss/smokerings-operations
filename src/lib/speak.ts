// The voice command talking back: one sentence out loud when a command is done,
// for whoever is across the kitchen and not looking at the screen to see the ✓.
//
// In a browser this is the Web Speech synthesiser. Inside the Android app the
// WebView has the same API with no voice behind it, so there the sentence goes
// over the NativePush bridge to Android's own TextToSpeech, which answers
// "speak-done" when it has finished saying it.
//
// The promise settles once the sentence has been said (or could not be), never
// rejects: a command that worked is not a failure because the speaker did not.
import { inNativeApp, nativeBridge } from './nativeBridge';

// An app build from before native speech ignores "speak" without a word, and a
// browser can drop an utterance without ever firing onend. Roughly how long the
// sentence takes to say, plus slack, is when to stop waiting for it.
const fallbackMs = (text: string) => 2000 + text.length * 90;

let nextId = 0;

function speakNative(text: string): Promise<void> {
  const bridge = nativeBridge();
  if (!bridge?.addEventListener) return Promise.resolve();
  const id = String(++nextId);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      bridge.removeEventListener?.('message', onMessage);
      resolve();
    };
    const onMessage = (event: { data: string }) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === 'speak-done' && msg.id === id) finish();
      } catch {
        // Not ours.
      }
    };
    const timer = setTimeout(finish, fallbackMs(text));
    bridge.addEventListener!('message', onMessage);
    bridge.postMessage(JSON.stringify({ type: 'speak', id, text }));
  });
}

function speakBrowser(text: string): Promise<void> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, fallbackMs(text));
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-IN';
      const voice = synth.getVoices().find((v) => v.lang === 'en-IN');
      if (voice) utterance.voice = voice;
      utterance.onend = finish;
      utterance.onerror = finish;
      // Whatever was still being said belongs to an older command.
      synth.cancel();
      synth.speak(utterance);
    } catch {
      finish();
    }
  });
}

export function speak(text: string): Promise<void> {
  const sentence = text.trim();
  if (!sentence) return Promise.resolve();
  return inNativeApp() ? speakNative(sentence) : speakBrowser(sentence);
}

// Stops whatever is being said, for a panel closed mid-sentence.
export function stopSpeaking(): void {
  if (inNativeApp()) nativeBridge()?.postMessage(JSON.stringify({ type: 'speak-stop' }));
  else if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
}
