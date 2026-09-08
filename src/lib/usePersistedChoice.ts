import { useCallback, useState } from 'react';

// A useState for "which screen am I on", that survives the page going away.
//
// Every navigation choice in this app lived in plain component state, which
// meant a reload put you back on Daily View no matter where you were. That is
// not a small annoyance here: during development Vite reloads the tab on
// every save, so working on the B2B dashboard meant re-selecting it — sidebar,
// then module — after each edit. On the floor it is worse, because a phone is
// free to discard a background tab, and coming back to a smoking session
// meant navigating in from the top again with sticky hands.
//
// Three rules, and the second is the one that matters:
//
//   1. Every read and write is wrapped. localStorage throws rather than
//      returning null in real situations — Safari private browsing, blocked
//      cookies, a full quota — and a dashboard that fails to render because
//      it could not remember a tab would be far worse than one that forgets.
//
//   2. A stored value is only used if it is still a real choice. Rename a
//      module or drop a sidebar entry and the id saved in someone's browser
//      becomes a screen that no longer exists — which renders as nothing at
//      all, with no way back except knowing to clear site data. Validating
//      against the list of ids the code actually has turns that into a
//      silent fall back to the default.
//
//   3. It stores a single short string, never a draft or anything typed.
//      Unsaved work has its own machinery (see reelDraft.ts and the smoking
//      session draft); this is only ever a breadcrumb of where you were.
export function usePersistedChoice<T extends string>(
  key: string,
  fallback: T,
  known: readonly T[],
): [T, (next: T) => void] {
  const [choice, setChoice] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      // The cast is checked on the very next line — `known` is the source of
      // truth for what a valid choice is, not the type.
      if (stored && known.includes(stored as T)) return stored as T;
    } catch {
      // Unreadable storage is the same as empty storage.
    }
    return fallback;
  });

  const choose = useCallback(
    (next: T) => {
      setChoice(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Not being able to remember it is not a reason to refuse to go there.
      }
    },
    [key],
  );

  return [choice, choose];
}
