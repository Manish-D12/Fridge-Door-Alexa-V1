/**
 * Time-zone aware helpers built on Intl, so "today" means today in the
 * household's time zone rather than the server's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timeZone);
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
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function wallClock(instant: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (e.g. -7h for PDT). */
function tzOffset(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (instant - (instant % 1000));
}

/** UTC instant of a wall-clock time in `timeZone`. DST-safe for all but the skipped hour. */
export function zonedTimeToInstant(
  d: LocalDate,
  timeZone: string,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  const guess = Date.UTC(d.year, d.month - 1, d.day, hour, minute, second, ms);
  const first = guess - tzOffset(guess, timeZone);
  // Re-evaluate at the candidate instant in case a DST transition sits between.
  return guess - tzOffset(first, timeZone);
}

export function localDateOf(instant: number, timeZone: string): LocalDate {
  const { year, month, day } = wallClock(instant, timeZone);
  return { year, month, day };
}

export function addLocalDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function startOfLocalDay(d: LocalDate, timeZone: string): number {
  return zonedTimeToInstant(d, timeZone);
}

/** Last millisecond of the given local day. */
export function endOfLocalDay(d: LocalDate, timeZone: string): number {
  return startOfLocalDay(addLocalDays(d, 1), timeZone) - 1;
}

/** Whole local days between the local dates of two instants (b - a). */
export function localDayDiff(a: number, b: number, timeZone: string): number {
  const da = localDateOf(a, timeZone);
  const db = localDateOf(b, timeZone);
  return Math.round((Date.UTC(db.year, db.month - 1, db.day) - Date.UTC(da.year, da.month - 1, da.day)) / DAY_MS);
}

/** Parses "2026-10-24" into a LocalDate. */
export function parseIsoDate(s: string): LocalDate {
  const [year, month, day] = s.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * Spoken description of when something is due, relative to `now`:
 * "today at 3:30 PM", "tomorrow", "on Friday", "on November 14", "3 days ago".
 * Times are included only when they are not the end-of-day default.
 */
export function spokenWhen(dueIso: string, now: number, timeZone: string): string {
  const due = Date.parse(dueIso);
  const diff = localDayDiff(now, due, timeZone);
  const w = wallClock(due, timeZone);
  const isEndOfDay = w.hour === 23 && w.minute === 59;
  const time = isEndOfDay
    ? ''
    : ` at ${new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(due)}`;

  if (diff === 0) return `today${time}`;
  if (diff === 1) return `tomorrow${time}`;
  if (diff === -1) return `yesterday${time}`;
  if (diff < -1) return `${-diff} days ago`;
  if (diff < 7) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(due);
    return `on ${weekday}${time}`;
  }
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric' }).format(due);
  return `on ${date}${time}`;
}

/** The same wall-clock time as `instant`, moved to local date `d`. */
export function onLocalDate(instant: number, d: LocalDate, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  return zonedTimeToInstant(d, timeZone, w.hour, w.minute, w.second, ((instant % 1000) + 1000) % 1000);
}

/** "2026-10-24" for a LocalDate. */
export function formatIsoDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
