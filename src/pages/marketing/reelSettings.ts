// The two settings a reel is built with: where it is going, and how it is
// graded.
//
// These lived in reelDraft.ts, which was the localStorage machinery behind the
// manual timeline editor. The editor is gone — a reel is now cut automatically
// from a Drive folder — and the draft machinery went with it, but these two
// unions outlived it, because they are not about drafts at all. They are the
// vocabulary the Export step, the Share step and the render route all have to
// agree on, and the compiler is what stops a target or a look the renderer has
// never heard of reaching the server.
//
// Both mirror tables in server/marketing/reelStudio.js, which is the copy that
// decides the canvas, the length cap and the filter chain. The server also
// sends the whole target table down with the toolchain status, so no number
// from it is repeated here — only the ids.

// The four places a finished reel can go. In step with REEL_TARGETS.
export type ReelTarget = 'ig-story' | 'ig-reel' | 'yt-short' | 'yt-video';

export const REEL_TARGET_IDS: ReelTarget[] = ['ig-story', 'ig-reel', 'yt-short', 'yt-video'];

export const DEFAULT_REEL_TARGET: ReelTarget = 'ig-story';

// A choice remembered from a tab that was open before there were four targets
// says 'story' or 'reel', and it means what it always meant.
const LEGACY_TARGETS: Record<string, ReelTarget> = { story: 'ig-story', reel: 'ig-reel' };

export function asReelTarget(value: unknown): ReelTarget {
  const id = LEGACY_TARGETS[String(value)] ?? String(value);
  return (REEL_TARGET_IDS as string[]).includes(id) ? (id as ReelTarget) : DEFAULT_REEL_TARGET;
}

// The colour grade, mirroring REEL_LOOKS.
export type ReelLook = 'none' | 'warm' | 'cinematic' | 'punch';

export const REEL_LOOK_IDS: ReelLook[] = ['none', 'warm', 'cinematic', 'punch'];

export const DEFAULT_REEL_LOOK: ReelLook = 'none';

export function asReelLook(value: unknown): ReelLook {
  const id = String(value);
  return (REEL_LOOK_IDS as string[]).includes(id) ? (id as ReelLook) : DEFAULT_REEL_LOOK;
}

// Seconds as m:ss, for durations that are read rather than calculated with.
// Every screen in the reel feature shows lengths, and three of them used to
// import this from the timeline module.
export function fmtSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function fmtBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}
