import { formatIsoDate, type LocalDate, parseIsoDate, spokenDate, zonedTimeToInstant } from './dates.js';
import { findInjectionMarkers, paragraphAround } from './guard.js';
import { ModelItem, type Obligation, type Rejected } from './schema.js';

/** A runaway answer is more likely an attack or a misread than a real document. */
export const DEFAULT_MAX_ITEMS = 20;

export interface VerifyOptions {
  /** IANA time zone the model's YYYY-MM-DD and HH:MM are in. */
  timeZone: string;
  /** Candidates beyond this are ignored. Default 20. */
  maxItems?: number;
}

export interface Verified {
  items: Obligation[];
  rejected: Rejected[];
}

/**
 * Re-checks a model's answer against the document it came from. The model
 * only proposes; nothing it says is trusted:
 *   - shape: validated with zod, malformed items rejected ("invalid")
 *   - sourceSnippet must occur in the document, allowing only whitespace and
 *     quote/dash style differences; the stored snippet is the document's own
 *     text ("snippet_not_found")
 *   - a quote whose paragraph addresses an AI ("ignore previous
 *     instructions", "for the assistant") is rejected ("instruction_text")
 *   - amounts must be a number written in the document, else cleared
 *   - numeric dates like 10/11 that read both ways are flagged
 *     needsConfirmation with both dates, even if the model missed it, and
 *     same-day items from the document are flagged with them
 */
export function verifyExtraction(answer: unknown, document: string, opts: VerifyOptions): Verified {
  const candidates = Array.isArray((answer as { items?: unknown })?.items) ? (answer as { items: unknown[] }).items : [];
  const result: Verified = { items: [], rejected: [] };
  const dated: Dated[] = [];

  for (const candidate of candidates.slice(0, opts.maxItems ?? DEFAULT_MAX_ITEMS)) {
    const parsed = ModelItem.safeParse(blankToNull(candidate));
    if (!parsed.success) {
      result.rejected.push({ title: titleOf(candidate), reason: 'invalid' });
      continue;
    }
    const raw = parsed.data;
    const snippet = locateSnippet(document, raw.sourceSnippet);
    if (!snippet) {
      result.rejected.push({ title: raw.title, reason: 'snippet_not_found' });
      continue;
    }
    const at = document.indexOf(snippet);
    if (findInjectionMarkers(paragraphAround(document, at, at + snippet.length)).length > 0) {
      result.rejected.push({ title: raw.title, reason: 'instruction_text' });
      continue;
    }

    // A numeric date's other reading is worked out in code; the model's guess
    // is only used when code can't tell.
    const derived = ambiguousAlternative(snippet, raw.dueDate);
    const needsConfirmation = (raw.needsConfirmation ?? false) || derived !== null;
    const alternative =
      derived ?? (needsConfirmation && raw.alternativeDueDate && raw.alternativeDueDate !== raw.dueDate ? raw.alternativeDueDate : null);
    const amount = raw.amount != null && amountAppears(document, raw.amount) ? raw.amount : null;

    const item: Obligation = {
      type: raw.type,
      title: raw.title,
      dueDate: raw.dueTime ? atTime(raw.dueDate, raw.dueTime, opts.timeZone) : raw.dueDate,
      amount,
      currency: amount !== null ? (raw.currency?.toUpperCase() ?? null) : null,
      forWhom: raw.forWhom ?? null,
      sourceSnippet: snippet.slice(0, 5000),
      confidence: raw.confidence ?? 0.5,
      needsConfirmation,
      confirmationQuestion: needsConfirmation
        ? alternative
          ? `Is ${raw.title} on ${joinDates(raw.dueDate, alternative)}?`
          : (raw.confirmationQuestion ?? `What date is ${raw.title}? I have ${spokenDate(raw.dueDate)}, but the date wasn't clear.`)
        : null,
      confirmationOptions: needsConfirmation ? options(raw.dueDate, alternative) : [],
    };
    result.items.push(item);
    dated.push({ item, date: raw.dueDate, alternative });
  }

  flagSameDayItems(dated);
  return result;
}

interface Dated {
  item: Obligation;
  date: string;
  alternative: string | null;
}

/**
 * Items from the same document on the same day as an ambiguous one usually
 * took their date from it ("drop off goods by 8:30 that morning"), so they
 * are just as uncertain. Flag them too, offering the same two days.
 */
function flagSameDayItems(dated: Dated[]): void {
  const anchors = dated.filter((d) => d.item.needsConfirmation);
  for (const d of dated) {
    if (d.item.needsConfirmation) continue;
    const anchor = anchors.find((a) => a.date === d.date);
    if (!anchor) continue;
    d.item.needsConfirmation = true;
    d.item.confirmationOptions = options(d.date, anchor.alternative);
    d.item.confirmationQuestion = anchor.alternative
      ? `Is ${d.item.title} on ${joinDates(d.date, anchor.alternative)}?`
      : `What date is ${d.item.title}? I have ${spokenDate(d.date)}, the same day as ${anchor.item.title}, but that date wasn't clear.`;
  }
}

const QUOTE_CLASSES: Record<string, string> = {
  "'": "['‘’]", '‘': "['‘’]", '’': "['‘’]",
  '"': '["“”]', '“': '["“”]', '”': '["“”]',
  '-': '[-–—]', '–': '[-–—]', '—': '[-–—]',
};

/**
 * Finds the model's snippet in the document and returns the document's own
 * text for it, so what you store is always an exact substring. Tolerates only
 * whitespace and quote/dash style differences (models re-flow line breaks and
 * straighten quotes). Returns null if it isn't there.
 */
export function locateSnippet(document: string, snippet: string): string | null {
  const trimmed = snippet.trim();
  if (!trimmed) return null;
  if (document.includes(trimmed)) return trimmed;
  const pattern = trimmed
    .split(/\s+/)
    .map((word) => [...word].map((c) => QUOTE_CLASSES[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''))
    .join('\\s+');
  return new RegExp(pattern).exec(document)?.[0] ?? null;
}

/** True if `amount` is one of the numbers written in the document ("$1,243.57" counts for 1243.57). */
export function amountAppears(document: string, amount: number): boolean {
  const numbers = document.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [];
  return numbers.some((n) => Math.abs(Number(n) - amount) < 0.005);
}

/** Index = getUTCDay(). */
const WEEKDAYS = [
  /\bsun(?:day)?\b/i,
  /\bmon(?:day)?\b/i,
  /\btue(?:s|sday)?\b/i,
  /\bwed(?:s|nesday)?\b/i,
  /\bthu(?:r|rs|rsday)?\b/i,
  /\bfri(?:day)?\b/i,
  /\bsat(?:urday)?\b/i,
];

/**
 * If the snippet writes `dueDate` as a numeric day/month pair that reads both
 * ways ("10/11"), returns the other reading as YYYY-MM-DD. Returns null when
 * the pair reads only one way, isn't the due date, or a weekday in the
 * snippet fits only one reading ("Sun 10/11" in 2026 can only be October 11).
 */
export function ambiguousAlternative(snippet: string, dueDate: string): string | null {
  const due = parseIsoDate(dueDate);
  const mentioned = new Set(WEEKDAYS.flatMap((re, day) => (re.test(snippet) ? [day] : [])));
  for (const m of snippet.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === b || a < 1 || b < 1 || a > 12 || b > 12) continue;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : due.year;
    const readings: LocalDate[] = [
      { year, month: a, day: b },
      { year, month: b, day: a },
    ];
    const idx = readings.findIndex((r) => r.month === due.month && r.day === due.day && r.year === due.year);
    if (idx < 0) continue;
    if (mentioned.size > 0) {
      const fits = readings.map((r) => mentioned.has(new Date(Date.UTC(r.year, r.month - 1, r.day)).getUTCDay()));
      if (fits[0] !== fits[1]) continue;
    }
    return formatIsoDate(readings[1 - idx]!);
  }
  return null;
}

function atTime(date: string, time: string, timeZone: string): string {
  const [h, m] = time.split(':').map(Number);
  return new Date(zonedTimeToInstant(parseIsoDate(date), timeZone, h, m)).toISOString();
}

const options = (date: string, alternative: string | null) => (alternative ? [date, alternative].sort() : [date]);

/** "Sunday, October 11, or Tuesday, November 10", earliest first. */
function joinDates(a: string, b: string): string {
  const [first, second] = [a, b].sort();
  return `${spokenDate(first!)}, or ${spokenDate(second!)}`;
}

/** Models often send "" where they mean null. */
function blankToNull(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : v]));
}

function titleOf(value: unknown): string | null {
  const t = (value as { title?: unknown })?.title;
  return typeof t === 'string' && t.trim() ? t.trim().slice(0, 200) : null;
}
