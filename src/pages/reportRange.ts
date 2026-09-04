// Where every dated report on the dashboard opens.
//
// The reports used to open on a rolling window — last 12 weeks, last 30 days,
// this month — which reaches back past the SQLite cutover of 30 August 2026
// into records that were never reconciled. Everything from 1 September 2026
// onwards is trustworthy, so that is where the screens start. It is a fixed
// date rather than "1 September of this year" on purpose: a rolling version
// would point at a future date for the first eight months of every year.
//
// The presets on each screen still reach wherever the user clicks — this is
// only the range a report shows before anyone touches it.
export const REPORT_START = '2026-09-01';
