/** Calendar-date helpers built on Intl, so "today" means today in the household's time zone. */

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: number, timeZone: string) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instant))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

function tzOffset(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (instant - (instant % 1000));
}

/** UTC instant of a wall-clock time in `timeZone`. DST-safe except inside the skipped hour. */
export function zonedTimeToInstant(d: LocalDate, timeZone: string, hour = 0, minute = 0): number {
  const guess = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  return guess - tzOffset(guess - tzOffset(guess, timeZone), timeZone);
}

export function localDateOf(instant: number, timeZone: string): LocalDate {
  const { year, month, day } = wallClock(instant, timeZone);
  return { year, month, day };
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** "2026-10-24" -> LocalDate */
export function parseIsoDate(s: string): LocalDate {
  const [year, month, day] = s.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/** LocalDate -> "2026-10-24" */
export function formatIsoDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

const utcNoon = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day, 12);
const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
const longDateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

/** "Saturday" */
export const weekdayName = (d: LocalDate) => weekdayFormat.format(utcNoon(d));
/** "Saturday, October 24" */
export const spokenDate = (iso: string) => longDateFormat.format(utcNoon(parseIsoDate(iso)));
