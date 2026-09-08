import { useEffect, useRef, useState } from 'react';

// A useState whose value survives the page going away.
//
// The sibling of usePersistedChoice next door, for the cases it deliberately
// refuses: that one stores a single id validated against a fixed list, and its
// own rule 3 says never a draft or anything typed. But a service-day board
// holds more than a breadcrumb — a date range, which wizard step you are on,
// which sections are open — and losing that is the same complaint. On a phone
// in a kitchen a backgrounded tab is evicted whenever the OS wants the memory,
// and every one of those screens came back at step 1 on the default week.
//
// Three properties, all of which are the point:
//
//   1. The read happens at mount, synchronously, as the initial state. Not in
//      an effect — an effect runs after the first render, which leaves a frame
//      where the value is the fallback, and any autosave wired to the same
//      value would write that fallback out over the stored one. That is the
//      failure that lost a reel on 2026-09-04; doing the read as initial state
//      makes it unrepresentable rather than guarded against.
//
//   2. Every read and write is wrapped. localStorage throws rather than
//      returning null in real situations — Safari private browsing, blocked
//      cookies, a full quota — and a board that will not render because it
//      could not remember a date range would be far worse than one that
//      forgets.
//
//   3. A stored value is only used if `revive` says it is still usable. What
//      counts as usable is the caller's business and it is rarely just "is it
//      the right type": a date range from three weeks ago parses perfectly and
//      is still the wrong thing to reopen on. Returning undefined falls back,
//      silently, which is the only sane behaviour for something nobody can
//      reach into the browser to clear.
export function usePersistedState<T>(
  key: string,
  fallback: T,
  revive: (stored: unknown) => T | undefined,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const revived = revive(JSON.parse(raw));
        if (revived !== undefined) return revived;
      }
    } catch {
      // Unreadable or unparseable storage is the same as empty storage.
    }
    return fallback;
  });

  // `revive` is almost always an inline closure, so it is a new function on
  // every render; holding it in a ref keeps it out of the write effect's deps,
  // where it would fire a write per render.
  const reviveRef = useRef(revive);
  reviveRef.current = revive;

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Out of quota or a locked-down browser. The screen still works; only
      // the memory of it is gone.
    }
  }, [key, value]);

  return [value, setValue];
}

// Clears one persisted value. For the explicit "start again" controls, which
// need the stored copy gone rather than overwritten with a default that would
// then read back as a deliberate choice.
export function clearPersistedState(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do, and nothing worth saying about it.
  }
}

// The revive every string-shaped setting wants: a string, and one the caller
// still recognises.
export const revivedString =
  (isValid: (value: string) => boolean = () => true) =>
  (stored: unknown): string | undefined =>
    typeof stored === 'string' && isValid(stored) ? stored : undefined;

export const revivedBoolean = (stored: unknown): boolean | undefined =>
  typeof stored === 'boolean' ? stored : undefined;
