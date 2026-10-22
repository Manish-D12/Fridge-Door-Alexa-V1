import type { Obligation, Status } from '@fridge-door/shared';
import { ambiguous, notFound } from '../lib/errors.js';

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

export function resolveObligation(
  items: Obligation[],
  idOrTitle: string,
  prefer: Status,
  now: number,
): Obligation {
  const trimmed = idOrTitle.trim();
  const byId = items.find((o) => o.id === trimmed);
  if (byId) return byId;

  const scored = items.map((o) => ({ o, s: score(trimmed, o) })).filter((x) => x.s > 0);
  if (scored.length === 0) throw notFound(`I couldn't find anything matching "${trimmed}".`);

  const best = Math.max(...scored.map((x) => x.s));
  let top = scored.filter((x) => x.s === best).map((x) => x.o);
  if (top.length > 1) {
    const preferred = top.filter((o) => o.status === prefer);
    if (preferred.length > 0) top = preferred;
  }
  if (top.length === 1) return top[0]!;

  // Still tied: ask rather than guess, listing the ones closest to now first.
  top.sort((a, b) => Math.abs(Date.parse(a.dueDate) - now) - Math.abs(Date.parse(b.dueDate) - now));
  const names = top.slice(0, 3).map((o) => o.title);
  throw ambiguous(`I found ${top.length} matches for "${trimmed}": ${joinSpoken(names)}. Which one did you mean?`, top);
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
