// Calendar days as the kitchen means them: YYYY-MM-DD in this device's own
// time zone, never a UTC timestamp. "Tomorrow" at 11pm in Bengaluru is still
// tomorrow, whereas toISOString() would already have rolled it over at 5:30am.
//
// Used by everything that files or lists a to-do by day — the note composer,
// the voice draft and Daily View — so the three agree on what "Friday" is.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const todayIso = (): string => isoDay(new Date());

// Midday rather than midnight, so a daylight-saving shift on a device set to a
// zone that has one can never push the parsed day into its neighbour.
export function parseIsoDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(iso: string, days: number): string {
  const date = parseIsoDay(iso);
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

export const weekdayOf = (iso: string): string => WEEKDAYS[parseIsoDay(iso).getDay()];

// The date a weekday falls on in the current Monday-to-Sunday week — the same
// week Daily View's tabs and the ISO week key cover.
export function dateInThisWeek(weekday: string, now = new Date()): string {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const offset = (WEEKDAYS.indexOf(weekday) + 6) % 7;
  monday.setDate(monday.getDate() + offset);
  return isoDay(monday);
}

// "Today", "Tomorrow", "Yesterday", else "Fri 10 Oct" — with the year only
// when it is not this one, since a task filed for January in October is the
// one case where the bare day is ambiguous.
export function formatDay(iso: string, today = todayIso()): string {
  if (!iso) return '';
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  if (iso === addDays(today, -1)) return 'Yesterday';
  const date = parseIsoDay(iso);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
