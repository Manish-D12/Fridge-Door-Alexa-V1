import type { gmail_v1 } from 'googleapis';

/** One email, reduced to what extraction needs. */
export interface MailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  labels: string[];
  /** Plain-text body (the text/plain part, or the HTML part with tags removed). */
  text: string;
}

/** The Gmail calls sync makes; tests stand in for it. */
export interface Mailbox {
  account(): Promise<string>;
  /** Message ids matching a Gmail search, newest first. */
  search(query: string, max: number): Promise<string[]>;
  get(id: string): Promise<MailMessage>;
}

/**
 * Recent emails that may hold an obligation. Gmail's {a b} means "a OR b" and
 * it doesn't stem, so plurals are listed too. Promotions and social are skipped.
 */
export const GMAIL_QUERY =
  'newer_than:14d -category:promotions -category:social -in:chats -in:sent ' +
  '{bill bills invoice invoices due appointment appointments booking bookings confirmation order orders delivery deliveries renewal reminder school}';

/** Long bodies are mostly footers; this keeps model input (and cost) bounded. */
const MAX_BODY_CHARS = 6000;

/** What the extractor reads: headers a person would see, then the body. Stable, so the cache recognises it. */
export function emailDocument(m: MailMessage): string {
  return `Subject: ${m.subject}\nFrom: ${m.from}\nDate: ${m.date}\n\n${m.text}`;
}

// ---------------------------------------------------------------------------
// Keyword pre-filter: decides, without the model, whether an email is worth a model call.
// ---------------------------------------------------------------------------

const SKIP_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH', 'SENT', 'DRAFT']);

/** Account-security mail: never useful here, and not something to send to a model. */
const SECURITY =
  /\b(verification code|security (alert|code)|one[- ]time (pass(word|code)|code)|sign[- ]in (attempt|alert|code)|new sign-in|login code|password reset|reset your password|2-step verification|two-factor)\b/i;

/** Marketing words in a subject, unless it also names something to act on. */
const PROMO_SUBJECT = /(\d+\s?% off|\bsale\b|\bdeals?\b|\bcoupons?\b|promo code|\bdiscount|limited time|\bnewsletter\b|\bwebinar\b)/i;
const ACTIONABLE_SUBJECT = /\b(due|invoice|bill|appointment|booking|reservation|order\s*#?\d|shipped|delivery|renewal|expir)/i;

const OBLIGATION_WORDS =
  /\b(bills?|invoices?|statements?|payments?|payable|due|balance|amount|appointments?|appt|bookings?|booked|reservations?|reserved|check-?in|confirm(ed|ation)?|orders?|ordered|ship(ped|ping|ment)|deliver(y|ies|ed|ing)?|arriv(e|es|ing)|renew(al|als|s)?|expir(e|es|ing|y|ation)|reminders?|school|class(room)?|teacher|field trip|permission slip|subscriptions?|tickets?|rsvp)\b/i;

const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)';
/** A date or an amount: what turns a mention into something with a "when" or a "how much". */
const DATE_OR_MONEY = new RegExp(
  [
    `\\b${MONTH}\\.?\\s+\\d{1,2}\\b`,
    `\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MONTH}\\b`,
    '\\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\\b',
    '\\b\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?\\b',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '\\b(today|tomorrow|tonight|this (week|weekend)|next (week|month))\\b',
    '[$€£₹]\\s?\\d',
    '\\b\\d+[.,]\\d{2}\\b',
    '\\b(usd|inr|eur|gbp|rs\\.?)\\s?\\d',
  ].join('|'),
  'i',
);

export type SkipReason = 'category' | 'security' | 'promotional' | 'no_keywords' | 'no_date_or_amount';

/** Why an email isn't worth a model call, or null if it is. */
export function whyNotRelevant(m: MailMessage): SkipReason | null {
  if (m.labels.some((l) => SKIP_LABELS.has(l))) return 'category';
  const head = `${m.subject}\n${m.text.slice(0, 1500)}`;
  if (SECURITY.test(head)) return 'security';
  if (PROMO_SUBJECT.test(m.subject) && !ACTIONABLE_SUBJECT.test(m.subject)) return 'promotional';
  const all = `${m.subject}\n${m.text}`;
  if (!OBLIGATION_WORDS.test(all)) return 'no_keywords';
  if (!DATE_OR_MONEY.test(all)) return 'no_date_or_amount';
  return null;
}

// ---------------------------------------------------------------------------
// Gmail API message -> MailMessage
// ---------------------------------------------------------------------------

export function messageFromGmail(m: gmail_v1.Schema$Message): MailMessage {
  const headers = new Map((m.payload?.headers ?? []).map((h) => [(h.name ?? '').toLowerCase(), h.value ?? '']));
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    const isAttachment = !!part.filename || !!part.body?.attachmentId;
    if (!isAttachment && part.body?.data) {
      if (part.mimeType === 'text/plain') plain.push(decode(part.body.data));
      else if (part.mimeType === 'text/html') html.push(decode(part.body.data));
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(m.payload);

  // Some senders put only "view this email in your browser" in the plain part.
  const plainText = clean(plain.join('\n'));
  const htmlText = clean(htmlToText(html.join('\n')));
  let text = plainText.length >= 200 || plainText.length >= htmlText.length ? plainText : htmlText;
  if (!text) text = clean(decodeEntities(m.snippet ?? ''));
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS).trimEnd()}\n[…]`;

  const date = headers.get('date') || (m.internalDate ? new Date(Number(m.internalDate)).toUTCString() : '');
  return {
    id: m.id ?? '',
    subject: clean(headers.get('subject') ?? '') || '(no subject)',
    from: headers.get('from') ?? '',
    date,
    labels: m.labelIds ?? [],
    text,
  };
}

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

/** Tags out, line breaks kept where blocks end. Good enough to quote from; not a renderer. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section|blockquote)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', euro: '€', pound: '£', rupee: '₹' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** Invisible preheader padding out, spaces collapsed per line, at most one blank line in a row. */
function clean(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[­͏​-‏⁠﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
