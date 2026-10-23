import type { Obligation, Source } from '@fridge-door/shared';
import { ambiguous, notFound } from '../lib/errors.js';
import { addLocalDays, localDateOf, localDayDiff, type LocalDate } from '../lib/time.js';

/**
 * Resolves what a person said ("the water bill", "Maya's dentist") to a single
 * obligation. Voice requests rarely carry ids, so this is deliberately forgiving.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'for', 'to', 'of', 'is', 'was', 'and', 'that', 'this', 'on']);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function tokenMatches(q: string, t: string): boolean {
  if (q === t) return true;
  // Allow prefixes ("appt" -> no, "dent" -> "dentist") but not tiny fragments.
  return q.length >= 4 && t.startsWith(q);
}

/** 0 = no match, 100 = exact title. */
export function score(query: string, o: Obligation): number {
  const q = normalize(query);
  const title = normalize(o.title);
  if (!q) return 0;
  if (title === q) return 100;
  if (` ${title} `.includes(` ${q} `)) return 80;

  const qTokens = tokens(query);
  if (qTokens.length === 0) return 0;
  const haystack = tokens(`${o.title} ${o.forWhom ?? ''} ${o.type === 'order' ? 'delivery package' : o.type}`);
  const matched = qTokens.filter((q) => haystack.some((t) => tokenMatches(q, t))).length;
  if (matched === qTokens.length) return 60;
  const ratio = matched / qTokens.length;
  return ratio >= 0.5 ? Math.round(ratio * 40) : 0;
}

/** Details a person may give to say which item they mean, besides its title. */
export interface MatchHints {
  /** A date or weekday of the item: "Tuesday", "Oct 27", "2026-10-27", "tomorrow". */
  when?: string;
  /** Who it came from: a sender's name or address, or "email", "WhatsApp", "photo". */
  from?: string;
}

export interface ResolveOptions {
  /** On a tie, keep items that are still open, or ones already done. */
  prefer: 'open' | 'done';
  now: number;
  timeZone: string;
  hints?: MatchHints;
  /** On a tie, keep items read from an email: a follow-up can only reply to those. */
  preferEmail?: boolean;
}

/** A title that contains every word the person said ("dentist") counts as fully matching. */
const FULL_MATCH = 60;

/**
 * Picks the one item a person means. Every title that contains all their
 * words is a candidate (an exact title doesn't beat "Dentist cleaning
 * appointment" for "the dentist appointment"). A day, date or sender they
 * mention, in `hints` or in the words themselves ("the dentist on Tuesday"),
 * narrows the candidates; then email sources (if asked) and open/done status
 * break ties. Anything still tied is asked about, naming what tells them apart.
 */
export function resolveObligation(items: Obligation[], idOrTitle: string, opts: ResolveOptions): Obligation {
  const trimmed = idOrTitle.trim();
  const byId = items.find((o) => o.id === trimmed);
  if (byId) return byId;

  const said = splitHints(trimmed);
  const hints = { when: opts.hints?.when?.trim() || said.when, from: opts.hints?.from?.trim() || said.from };
  const query = said.title || trimmed;
  let scored = items.map((o) => ({ o, s: score(query, o) })).filter((x) => x.s > 0);
  if (scored.length === 0 && query !== trimmed) scored = items.map((o) => ({ o, s: score(trimmed, o) })).filter((x) => x.s > 0);
  if (scored.length === 0) throw notFound(`I couldn't find anything matching "${trimmed}".`);

  const when = hints.when ? parseWhen(hints.when, opts.now, opts.timeZone) : null;
  const hinted = when || hints.from;
  let top: Obligation[];
  const fitting = hinted ? scored.filter(({ o }) => (!when || onDay(o, when, opts.timeZone)) && (!hints.from || fromMatches(o, hints.from))) : scored;
  if (fitting.length > 0) {
    const best = Math.max(...fitting.map((x) => x.s));
    top = fitting.filter((x) => x.s >= Math.min(best, FULL_MATCH)).map((x) => x.o);
  } else {
    // They named a day or sender that fits none of them: ask rather than pick by title alone.
    top = scored.map((x) => x.o);
  }

  if (fitting.length > 0 && top.length > 1 && opts.preferEmail) top = narrow(top, (o) => !!o.email);
  if (fitting.length > 0 && top.length > 1) top = narrow(top, (o) => (o.status === 'done') === (opts.prefer === 'done'));
  if (top.length === 1) return top[0]!;

  // Still tied: ask, listing the ones closest to now first.
  top.sort((a, b) => Math.abs(Date.parse(a.dueDate) - opts.now) - Math.abs(Date.parse(b.dueDate) - opts.now));
  throw ambiguous(whichOne(top.slice(0, 3), opts.now, opts.timeZone), top, origin);
}

/** Keeps the items that pass, unless none do. */
function narrow(items: Obligation[], keep: (o: Obligation) => boolean): Obligation[] {
  const kept = items.filter(keep);
  return kept.length > 0 ? kept : items;
}

const SOURCE_FROM: Record<Source, string> = { gmail: 'an email', whatsapp: 'a WhatsApp message', photo: 'a photo', manual: 'a spoken request' };

/** "Do you mean the Monday one for Maya or the Tuesday one from Bright Smiles?" */
function whichOne(items: Obligation[], now: number, timeZone: string): string {
  const alike = items.every((o) => similarTitles(o.title, items[0]!.title));
  const origins = new Set(items.map(origin));
  const parts = items.map((o) => {
    const day = dayWord(o.dueDate, now, timeZone);
    const relative = ['today', 'tomorrow', 'yesterday'].includes(day);
    if (!alike) return relative ? `${o.title} ${day}` : `${o.title} on ${day}`;
    const one = relative ? `the one ${day}` : `the ${day} one`;
    return origins.size > 1 ? `${one} ${origin(o)}` : one;
  });
  return `Do you mean ${joinSpoken(parts, 'or')}?`;
}

/** What tells same-titled items apart: "for Maya", "from Bright Smiles", "from a WhatsApp message". */
function origin(o: Obligation): string {
  if (o.forWhom) return `for ${o.forWhom}`;
  if (o.email) return `from ${o.email.fromName ?? o.email.fromAddress}`;
  return `from ${SOURCE_FROM[o.source]}`;
}

/** "today", "Monday" within a week either way, else "October 30". */
export function dayWord(iso: string, now: number, timeZone: string): string {
  const due = Date.parse(iso);
  const diff = localDayDiff(now, due, timeZone);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const opts: Intl.DateTimeFormatOptions = Math.abs(diff) < 7 ? { weekday: 'long' } : { month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(due);
}

// ---------------------------------------------------------------------------
// Hints in what was said
// ---------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY = /\b(monday|tuesday|tues|wednesday|weds|thursday|thurs|friday|saturday|sunday)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'i');
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RELATIVE = /\b(today|tonight|tomorrow)\b/i;
const TIME = /\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/gi;
const FROM = /\bfrom\s+(?:the\s+)?(.+?)(?=\s+(?:on|due|at|for|about)\b|[,.;]|$)/i;

/** Pulls "on Tuesday", "Oct 27", "from Bright Smiles" out of a request, leaving the title words. */
export function splitHints(text: string): { title: string; when?: string; from?: string } {
  let rest = text;
  let from: string | undefined;
  const f = FROM.exec(rest);
  if (f) {
    from = f[1]!.trim();
    rest = rest.replace(f[0], ' ');
  }
  let when: string | undefined;
  for (const re of [ISO, MONTH_DAY, DAY_MONTH, WEEKDAY, RELATIVE]) {
    const m = re.exec(rest);
    if (m) {
      when ??= m[0];
      rest = rest.replace(m[0], ' ');
    }
  }
  rest = rest
    .replace(TIME, ' ')
    .replace(/\b(on|due|this|next|coming|at)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: rest, ...(when ? { when } : {}), ...(from ? { from } : {}) };
}

type When = { kind: 'weekday'; weekday: number } | { kind: 'date'; month: number; day: number; year?: number };

function parseWhen(text: string, now: number, timeZone: string): When | null {
  const t = text.trim().toLowerCase();
  const iso = ISO.exec(t);
  if (iso) return { kind: 'date', year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const rel = RELATIVE.exec(t);
  if (rel) {
    const d = addLocalDays(localDateOf(now, timeZone), rel[1] === 'tomorrow' ? 1 : 0);
    return { kind: 'date', ...d };
  }
  const md = MONTH_DAY.exec(t);
  if (md) return { kind: 'date', month: MONTHS.indexOf(md[1]!.slice(0, 3)) + 1, day: Number(md[2]) };
  const dm = DAY_MONTH.exec(t);
  if (dm) return { kind: 'date', month: MONTHS.indexOf(dm[2]!.slice(0, 3)) + 1, day: Number(dm[1]) };
  const wd = WEEKDAY.exec(t);
  if (wd) return { kind: 'weekday', weekday: WEEKDAYS.findIndex((w) => w.startsWith(wd[1]!.toLowerCase().slice(0, 3))) };
  return null;
}

function onDay(o: Obligation, when: When, timeZone: string): boolean {
  const d: LocalDate = localDateOf(Date.parse(o.dueDate), timeZone);
  if (when.kind === 'weekday') return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() === when.weekday;
  return d.month === when.month && d.day === when.day && (when.year === undefined || d.year === when.year);
}

const SOURCE_WORDS: Record<Source, string> = { gmail: 'email gmail mail', whatsapp: 'whatsapp message chat', photo: 'photo picture notice', manual: '' };

function fromMatches(o: Obligation, from: string): boolean {
  const wanted = tokens(from).filter((t) => !['email', 'mail', 'message'].includes(t) || tokens(from).length === 1);
  if (wanted.length === 0) return true;
  const have = tokens(`${o.email?.fromName ?? ''} ${o.email?.fromAddress.replace(/[@.]/g, ' ') ?? ''} ${SOURCE_WORDS[o.source]}`);
  return wanted.every((w) => have.some((h) => tokenMatches(w, h)));
}

/** "a, b, or c". Pass sep "; " when the parts themselves contain commas. */
export function joinSpoken(parts: string[], conj = 'or', sep = ', '): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2 && sep === ', ') return `${parts[0]} ${conj} ${parts[1]}`;
  return `${parts.slice(0, -1).join(sep)}${sep}${conj} ${parts[parts.length - 1]}`;
}

/** Words that say what kind of thing it is but not which one. */
const GENERIC = new Set(['bill', 'payment', 'appointment', 'appt', 'delivery', 'package', 'order', 'booking', 'renewal', 'deadline', 'due', 'reminder']);

/**
 * True when two titles plausibly name the same thing ("Electricity bill" and
 * "PG&E electricity bill", "Dentist appointment" and "Maya dentist"), but not
 * two different things of the same kind ("Water bill" and "Electricity bill").
 */
export function similarTitles(a: string, b: string): boolean {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const sa = [...ta].filter((t) => !GENERIC.has(t));
  const sb = [...tb].filter((t) => !GENERIC.has(t));
  if (sa.length === 0 || sb.length === 0) return ta.size === tb.size && [...ta].every((t) => tb.has(t));
  const shared = sa.filter((t) => sb.includes(t)).length;
  return shared / Math.min(sa.length, sb.length) >= 0.5;
}
