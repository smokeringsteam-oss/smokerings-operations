// The Android app's bridge (see push.ts). addEventListener rather than
// onmessage, because push.ts owns onmessage and assigning it elsewhere would
// cut push off.
export type NativeBridge = {
  postMessage(message: string): void;
  addEventListener?: (type: 'message', listener: (event: { data: string }) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: { data: string }) => void) => void;
};

export const nativeBridge = (): NativeBridge | null =>
  typeof window === 'undefined' ? null : ((window as unknown as { NativePush?: NativeBridge }).NativePush ?? null);

// Inside the Android app (see isNativeApp in push.ts).
export const inNativeApp = (): boolean => nativeBridge() !== null;
