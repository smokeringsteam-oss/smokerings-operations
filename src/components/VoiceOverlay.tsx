import { useEffect, useRef } from 'react';
import { micLevel, type VoiceInput } from '../lib/useVoiceInput';

// The listening screen, in the manner of Google's voice search: the panel
// gives way to one big mic in the middle, with rings that swell with your
// voice. A small mic glowing in the corner of the composer was easy to miss
// from arm's length in a kitchen — nobody could tell whether it was
// listening — and this is the one moment the screen has nothing else to say.
//
// Tap the mic when you are done; the words go into the box. The cross throws
// the recording away.

const MicIcon = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
    />
  </svg>
);

const VoiceOverlay = ({ voice }: { voice: VoiceInput }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const { analyser, listening, transcribing, error } = voice;

  // The mic level, read every frame and written straight onto a CSS variable
  // rather than through state: sixty re-renders a second of the whole panel
  // to grow a ring would be the slowest way to draw it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !analyser) {
      stage?.style.setProperty('--voice-level', '0');
      return undefined;
    }
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      // Speech sits low on this scale; stretched so a normal voice fills it.
      const level = Math.min(1, micLevel(analyser, samples) * 4);
      // Quick to rise, slow to fall, so the rings breathe rather than flicker.
      smoothed = level > smoothed ? level : smoothed * 0.88 + level * 0.12;
      stage.style.setProperty('--voice-level', smoothed.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  if (!listening && !transcribing && !error) return null;

  const state = error ? 'error' : transcribing ? 'transcribing' : 'listening';
  const heading = error ? 'Didn’t get that' : transcribing ? 'Writing it down…' : 'Listening…';
  const hint =
    error ??
    (transcribing
      ? 'One moment'
      : voice.handsFree
        ? 'Speak now — I’ll stop when you pause'
        : 'Speak now — tap the mic when you’re done');

  return (
    <div
      className={`voice-overlay is-${state}`}
      role="dialog"
      aria-modal="true"
      aria-label="Voice input"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (error) voice.clearError();
          else voice.cancel();
        }
      }}
    >
      <button
        type="button"
        className="voice-overlay-close"
        aria-label={error ? 'Close' : 'Cancel voice input'}
        onClick={() => (error ? voice.clearError() : voice.cancel())}
      >
        ×
      </button>

      <p className="voice-overlay-heading" role="status" aria-live="polite">
        {heading}
      </p>

      <div className="voice-stage" ref={stageRef}>
        <span className="voice-ring voice-ring-outer" aria-hidden="true" />
        <span className="voice-ring voice-ring-inner" aria-hidden="true" />
        <button
          type="button"
          className="voice-mic"
          autoFocus
          disabled={transcribing}
          aria-label={error ? 'Try again' : listening ? 'Done speaking' : 'Writing it down'}
          onClick={() => {
            if (error) {
              voice.clearError();
              voice.start();
            } else voice.stop();
          }}
        >
          {transcribing ? <span className="voice-spinner" aria-hidden="true" /> : <MicIcon size={44} />}
        </button>
      </div>

      <p className="voice-overlay-hint">{hint}</p>
      {error ? <p className="voice-overlay-retry">Tap the mic to try again</p> : null}
    </div>
  );
};

export default VoiceOverlay;
