import type { gmail_v1 } from 'googleapis';
import { EmailRef, type ActionLink, type LinkKind } from '@fridge-door/shared';

/** One email, reduced to what extraction and replying need. */
export interface MailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  labels: string[];
  /** Plain-text body (the text/plain part, or the HTML part with tags removed). */
  text: string;
  /** Message-ID and References headers, for threading a reply. */
  messageIdHeader: string | null;
  references: string | null;
  /** Every link in the body, with its text when it came from HTML. Unfiltered. */
  links: { url: string; text: string }[];
}

/** The Gmail calls sync and replies make; tests stand in for it. */
export interface Mailbox {
  account(): Promise<string>;
  /** Message ids matching a Gmail search, newest first. */
  search(query: string, max: number): Promise<string[]>;
  get(id: string): Promise<MailMessage>;
  /** Senders (From headers) of messages in a thread received after `afterMs`, other than `own`. */
  repliesInThread(threadId: string, afterMs: number, own: string): Promise<string[]>;
  /** Sends a raw RFC 5322 message into the thread. Returns the new message id. */
  send(raw: string, threadId: string): Promise<string>;
}

/**
 * Recent emails that may hold an obligation, in every category (a bill can land
 * in Promotions, a booking in Social) and from any sender; only spam, trash,
 * chats and drafts are left out. Gmail's {a b} means "a OR b" and it doesn't
 * stem, so plurals are listed too. Marketing is ruled out later, by keywords.
 */
export const GMAIL_QUERY =
  'newer_than:14d -in:spam -in:trash -in:chats -in:drafts ' +
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

const SKIP_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'CHAT']);

/** Account-security mail: never useful here, and not something to send to a model. */
const SECURITY =
  /\b(verification code|security (alert|code)|one[- ]time (pass(word|code)|code)|sign[- ]in (attempt|alert|code)|new sign-in|login code|password reset|reset your password|2-step verification|two-factor)\b/i;

/** Marketing words in a subject, unless it also names something to act on. */
const PROMO_SUBJECT = /(\d+\s?% off|\bsale\b|\bdeals?\b|\bcoupons?\b|promo code|\bdiscount|limited time|\bnewsletter\b|\bwebinar\b)/i;
const ACTIONABLE_SUBJECT = /\b(due|invoice|bill|statement|payment|appointment|booking|reservation|confirm(ed|ation)|tickets?|order\s*#?\d|shipped|delivery|renew|expir)/i;
/** Gmail's bulk tabs: searched, but there only an actionable subject earns a model call. */
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

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

export type SkipReason = 'spam_or_trash' | 'outgoing' | 'security' | 'promotional' | 'no_keywords' | 'no_date_or_amount';

/** Why an email isn't worth a model call, or null if it is. */
export function whyNotRelevant(m: MailMessage): SkipReason | null {
  if (m.labels.some((l) => SKIP_LABELS.has(l))) return 'spam_or_trash';
  // Mail this account sent (our own follow-up replies among it), unless it also arrived, as a note to self does.
  if (m.labels.includes('SENT') && !m.labels.includes('INBOX')) return 'outgoing';
  const head = `${m.subject}\n${m.text.slice(0, 1500)}`;
  if (SECURITY.test(head)) return 'security';
  const bulk = m.labels.some((l) => BULK_LABELS.includes(l));
  if ((PROMO_SUBJECT.test(m.subject) || bulk) && !ACTIONABLE_SUBJECT.test(m.subject)) return 'promotional';
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
  const links = [...html.flatMap(hrefs), ...plain.flatMap((p) => [...p.matchAll(BARE_URL)].map((x) => ({ url: x[0], text: '' })))];

  // Some senders put only "view this email in your browser" in the plain part.
  const plainText = clean(plain.join('\n'));
  const htmlText = clean(htmlToText(html.join('\n')));
  let text = plainText.length >= 200 || plainText.length >= htmlText.length ? plainText : htmlText;
  if (!text) text = clean(decodeEntities(m.snippet ?? ''));
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS).trimEnd()}\n[…]`;

  const date = headers.get('date') || (m.internalDate ? new Date(Number(m.internalDate)).toUTCString() : '');
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? m.id ?? '',
    subject: clean(headers.get('subject') ?? '') || '(no subject)',
    from: headers.get('from') ?? '',
    date,
    labels: m.labelIds ?? [],
    text,
    messageIdHeader: headers.get('message-id')?.trim() || null,
    references: headers.get('references')?.trim() || null,
    links,
  };
}

const BARE_URL = /https?:\/\/[^\s<>"')\]]+/g;

/** <a href="...">text</a> pairs, entities decoded. */
function hrefs(html: string): { url: string; text: string }[] {
  return [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].map((x) => ({
    url: decodeEntities(x[2]!.trim()),
    text: clean(htmlToText(x[3]!)).replace(/\s+/g, ' '),
  }));
}

// ---------------------------------------------------------------------------
// Replying: who sent it, and which of its links are worth keeping.
// ---------------------------------------------------------------------------

/** "Bright Smiles <dr.smile@brightsmiles.com>" -> address and display name. Null without a valid address. */
export function parseAddress(from: string): { address: string; name: string | null } | null {
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  const address = (angle ? angle[1]! : from.trim()).toLowerCase();
  if (!EmailRef.shape.fromAddress.safeParse(address).success) return null;
  const name = angle ? from.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1').trim() : '';
  return { address, name: name || null };
}

/** Senders that don't read replies. */
const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)([+._-][^@]*)?@/i;

export function isNoReply(address: string): boolean {
  return NO_REPLY.test(address);
}

/** What a reply needs, or null when the sender has no usable address. */
export function emailRef(m: MailMessage): EmailRef | null {
  const sender = parseAddress(m.from);
  if (!sender || !m.id || !m.threadId) return null;
  return {
    gmailMessageId: m.id,
    threadId: m.threadId,
    messageIdHeader: m.messageIdHeader?.slice(0, 1000) ?? null,
    references: m.references?.slice(-4000) ?? null,
    fromAddress: sender.address,
    fromName: sender.name?.slice(0, 200) ?? null,
    subject: m.subject.slice(0, 500),
    demo: false,
  };
}

/** Payment sites that bills commonly link to from another domain. */
export const BILLER_DOMAINS = [
  'paypal.com', 'stripe.com', 'square.link', 'squareup.com', 'paymentus.com', 'invoicecloud.com', 'doxo.com',
  'billdesk.com', 'razorpay.com', 'paytm.com', 'phonepe.com', 'payu.in',
];

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/** "mail.billing.pge.com" -> "pge.com"; "accounts.example.co.uk" -> "example.co.uk". Good enough to match a sender. */
export function baseDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const keep = labels.length >= 3 && SECOND_LEVEL.has(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

const LINK_KINDS: [LinkKind, RegExp][] = [
  ['renewal', /renew/i],
  ['payment', /\b(pay|payment|pay now|bill|billing|invoice|checkout)\b|\/(pay|billing|invoice)/i],
  ['manage', /\b(manage|my account|account|policy|subscription|reschedule|appointment|booking|reservation|view order|order details)\b|\/(manage|account|policy|subscriptions?)\b/i],
];
const NOT_ACTION = /unsubscribe|opt[- ]?out|privacy|terms|preferences|\b(facebook|twitter|instagram|linkedin|youtube|tiktok|help|support|contact us)\b|view (this email )?in (your )?browser/i;

const MAX_LINKS = 5;

/**
 * The renewal, payment and account links in an email: https only, on the
 * sender's domain or a known payment site, and named like an action. Each URL
 * once, renewal links first.
 */
export function actionLinks(m: MailMessage): ActionLink[] {
  const sender = parseAddress(m.from);
  if (!sender) return [];
  const senderDomain = baseDomain(sender.address.split('@')[1]!);
  const seen = new Set<string>();
  const found: ActionLink[] = [];
  for (const { url, text } of m.links) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 2000 || seen.has(u.href)) continue;
    const domain = baseDomain(u.hostname);
    if (domain !== senderDomain && !BILLER_DOMAINS.includes(domain)) continue;
    if (NOT_ACTION.test(`${text} ${u.pathname}`)) continue;
    const kind = LINK_KINDS.find(([, re]) => re.test(text))?.[0] ?? LINK_KINDS.find(([, re]) => re.test(u.pathname))?.[0];
    if (!kind) continue;
    seen.add(u.href);
    found.push({ url: u.href, kind, label: (text || u.hostname).slice(0, 200) });
  }
  const order: LinkKind[] = ['renewal', 'payment', 'manage'];
  return found.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, MAX_LINKS);
}

// ---------------------------------------------------------------------------
// Outgoing replies
// ---------------------------------------------------------------------------

/** A reply, ready for Gmail. Only the body ever comes from a model; the rest is from the stored source email. */
export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyTo: string | null;
  references: string | null;
}

/** "Re: X" once, however many times it has been replied to. */
export function replySubject(subject: string): string {
  const base = subject.replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim() || '(no subject)';
  return `Re: ${base}`;
}

/** No line breaks in a header value: a newline there would start a new header. */
const headerValue = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 for non-ASCII header text. */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** The raw RFC 5322 message Gmail's send takes, base64url-encoded. In-Reply-To and References keep it in the thread. */
export function buildReply(m: OutgoingMail): string {
  const to = headerValue(m.to);
  if (!EmailRef.shape.fromAddress.safeParse(to).success) throw new Error('reply needs a single valid recipient address');
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(headerValue(m.subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (m.inReplyTo) {
    const parent = headerValue(m.inReplyTo);
    lines.push(`In-Reply-To: ${parent}`, `References: ${headerValue(`${m.references ?? ''} ${parent}`)}`);
  }
  const body = Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8').toString('base64url');
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
