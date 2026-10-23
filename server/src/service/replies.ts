import type { FollowupIntent } from '@fridge-door/shared';
import { addLocalDays, localDateOf, zonedTimeToInstant, type LocalDate } from '../lib/time.js';

/**
 * Reading a reply to one of our follow-up emails, without a model: did they
 * say yes, which time did we propose, and what else did they say. Only the
 * time comes from our own (person-approved) email; their text decides yes or
 * no and is kept verbatim as a note.
 */

export interface ReplyReading {
  outcome: 'accepted' | 'declined' | 'other';
  /** Their first sentence, e.g. "Yes, we can do that." */
  gist: string;
  /** The rest of what they wrote, if anything ("Please be on time ..."). */
  note: string | null;
}

/** Their new text only: quoted history ("On ... wrote:", "> ..." lines) and signatures cut off. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Gmail wraps "On Sat, 24 Oct 2026 at 02:04, Name <a@b>\nwrote:" over two lines.
    if (/^\s*On .{4,200}(wrote:)?\s*$/i.test(line) && /wrote:\s*$/i.test(`${line} ${lines[i + 1] ?? ''}`)) break;
    if (/^\s*>/.test(line) || /^-{2,}\s*$/.test(line) || /^-+\s*Original Message\s*-+/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

const AFFIRM = /\b(yes|yeah|yep|sure|of course|certainly|absolutely|no problem|no worries|that works|works for (us|me)|we can do (that|it)|can do|confirmed|sounds good|that'?s fine|done|see you)\b/i;
const NEGATE = /\b(no|not|can'?t|cannot|unable|unfortunately|fully booked|booked up|isn'?t available|unavailable|sorry)\b/i;
const SIGN_OFF = /\s*\b(thanks|thank you|regards|best|best regards|cheers|sincerely|warm regards|kind regards)\b[,.!]?(\s+\S+){0,4}\s*$/i;

export function readReply(text: string): ReplyReading {
  const fresh = stripQuoted(text);
  const flat = fresh.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const gist = (m ? m[1]! : flat).slice(0, 200);
  // "No problem" says yes; "no", "can't", "sorry" otherwise say no.
  const negated = NEGATE.test(gist.replace(/\bno (problem|worries)\b/gi, ''));
  const outcome = AFFIRM.test(gist) && !negated ? 'accepted' : negated ? 'declined' : 'other';
  // Everything after the first sentence, minus a trailing "Thanks, Dr. Lee".
  const note = flat.slice(gist.length).replace(SIGN_OFF, '').trim().slice(0, 400);
  return { outcome, gist, note: note || null };
}

// ---------------------------------------------------------------------------
// The time we proposed
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TIME = '(?:\\s*,?\\s*(?:at|@|from)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)|\\s*,?\\s*(?:at\\s+)?(noon))?';
const MONTH_DAY = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?${TIME}`, 'gi');
const WEEKDAY_TIME = new RegExp(`\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)${TIME}`, 'gi');

export interface ProposedTime {
  date: LocalDate;
  /** Null when no time of day was given: keep the item's own time. */
  hour: number | null;
  minute: number;
}

function hourOf(h: string | undefined, min: string | undefined, ampm: string | undefined, noon: string | undefined) {
  if (noon) return { hour: 12, minute: 0 };
  if (!h || !ampm) return { hour: null, minute: 0 };
  let hour = Number(h) % 12;
  if (/^p/i.test(ampm)) hour += 12;
  return { hour, minute: Number(min ?? 0) };
}

/**
 * The one new date (and time) our email asked for. Our email usually names
 * the current date too ("move Wednesday, October 28th at 3:30 PM to Thursday,
 * October 29th at 4 PM"), so dates equal to the item's current date are
 * ignored. Null unless exactly one other date is named.
 */
export function proposedTime(ourText: string, currentDue: number, now: number, timeZone: string): ProposedTime | null {
  const text = stripQuoted(ourText);
  const current = localDateOf(currentDue, timeZone);
  const today = localDateOf(now, timeZone);
  const found: ProposedTime[] = [];
  for (const m of text.matchAll(MONTH_DAY)) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(m[2]);
    // No year: the next one on or after today ("January 5" said in December is next year).
    let year = m[3] ? Number(m[3]) : today.year;
    if (!m[3] && Date.UTC(year, month - 1, day) < Date.UTC(today.year, today.month - 1, today.day)) year++;
    found.push({ date: { year, month, day }, ...hourOf(m[4], m[5], m[6], m[7]) });
  }
  if (found.length === 0) {
    // "Thursday at 4 PM": the next such day after today.
    for (const m of text.matchAll(WEEKDAY_TIME)) {
      const target = WEEKDAYS.indexOf(m[1]!.toLowerCase());
      let d = addLocalDays(today, 1);
      while (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() !== target) d = addLocalDays(d, 1);
      found.push({ date: d, ...hourOf(m[2], m[3], m[4], m[5]) });
    }
  }
  const same = (a: LocalDate, b: LocalDate) => a.year === b.year && a.month === b.month && a.day === b.day;
  const others = found.filter((p) => !same(p.date, current));
  const distinct = others.filter((p, i) => others.findIndex((q) => same(q.date, p.date)) === i);
  return distinct.length === 1 ? distinct[0]! : null;
}

/** The instant for a proposed time, keeping the item's time of day when none was given. */
export function proposedInstant(p: ProposedTime, currentDue: number, timeZone: string): number {
  if (p.hour !== null) return zonedTimeToInstant(p.date, timeZone, p.hour, p.minute);
  const w = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(currentDue);
  const get = (t: string) => Number(w.find((x) => x.type === t)?.value ?? 0);
  return zonedTimeToInstant(p.date, timeZone, get('hour'), get('minute'));
}

/** What a reply means for the item, by intent. */
export function replyEffect(intent: FollowupIntent | null, reading: ReplyReading, proposed: number | null): 'move' | 'cancel' | 'none' {
  if (reading.outcome !== 'accepted') return 'none';
  if (intent === 'reschedule' && proposed !== null) return 'move';
  if (intent === 'cancel') return 'cancel';
  return 'none';
}
