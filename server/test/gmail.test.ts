import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { gmail_v1 } from 'googleapis';
import { MemoryExtractionCache } from '../src/extract/cache.js';
import { Extractor } from '../src/extract/extractor.js';
import {
  GMAIL_QUERY,
  actionLinks,
  baseDomain,
  buildReply,
  emailDocument,
  emailRef,
  htmlToText,
  isNoReply,
  messageFromGmail,
  parseAddress,
  replySubject,
  whyNotRelevant,
  type MailMessage,
  type Mailbox,
} from '../src/gmail/mail.js';
import { GmailState } from '../src/gmail/state.js';
import { GmailSync } from '../src/gmail/sync.js';
import { createApp } from '../src/http/app.js';
import { AppError } from '../src/lib/errors.js';
import { silentLogger } from '../src/lib/logger.js';
import type { JsonRequest } from '../src/llm/types.js';
import { ObligationService } from '../src/service/obligations.js';
import { FakeProvider, HOUSEHOLD, NOW, ob, raw, TZ, tempStore } from './helpers.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A MailMessage with nothing in it; tests fill in what they need. */
const BLANK: MailMessage = { id: '', threadId: 't', subject: '', from: '', date: '', labels: [], text: '', messageIdHeader: null, references: null, links: [] };

describe('messageFromGmail', () => {
  it('takes the plain-text part, skipping attachments', () => {
    const m = messageFromGmail({
      id: 'm1',
      threadId: 'thread-1',
      labelIds: ['INBOX', 'CATEGORY_UPDATES'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'Subject', value: 'Your  PG&E bill is ready' },
          { name: 'From', value: 'PG&E <billing@pge.com>' },
          { name: 'Date', value: 'Wed, 21 Oct 2026 08:00:00 -0700' },
          { name: 'Message-ID', value: '<bill-1@pge.com>' },
          { name: 'References', value: '<earlier@pge.com>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64('Amount due: $142.17\r\nDue date: November 3, 2026\r\n\r\n\r\n\r\nThanks') } },
              { mimeType: 'text/html', body: { data: b64('<p>ignored</p>') } },
            ],
          },
          { mimeType: 'text/plain', filename: 'terms.txt', body: { attachmentId: 'a1' } },
        ],
      },
    });
    assert.deepEqual(m, {
      id: 'm1',
      threadId: 'thread-1',
      subject: 'Your PG&E bill is ready',
      from: 'PG&E <billing@pge.com>',
      date: 'Wed, 21 Oct 2026 08:00:00 -0700',
      labels: ['INBOX', 'CATEGORY_UPDATES'],
      text: 'Amount due: $142.17\nDue date: November 3, 2026\n\nThanks',
      messageIdHeader: '<bill-1@pge.com>',
      references: '<earlier@pge.com>',
      links: [],
    });
  });

  it('falls back to the HTML part when the plain one is only a "view in browser" stub', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body>‌‌<table><tr><td>Order&nbsp;#1234</td><td>Arriving Friday, Oct 30</td></tr></table>' +
      '<p>Total: &#36;54.99 &amp; free returns</p><script>x()</script></body></html>';
    const m = messageFromGmail({
      id: 'm2',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: 'Your order has shipped' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('View this email in your browser.') } },
          { mimeType: 'text/html', body: { data: b64(html) } },
        ],
      },
    } satisfies gmail_v1.Schema$Message);
    assert.equal(m.text, 'Order #1234 Arriving Friday, Oct 30\n\nTotal: $54.99 & free returns');
    assert.equal(htmlToText('a<br>b<!-- c -->'), 'a\nb ');
  });

  it('builds the same document every time, so the extraction cache recognises it', () => {
    const m: MailMessage = { ...BLANK, id: 'x', subject: 'S', from: 'F', date: 'D', text: 'Body' };
    assert.equal(emailDocument(m), 'Subject: S\nFrom: F\nDate: D\n\nBody');
    assert.equal(emailDocument({ ...m }), emailDocument(m));
  });
});

describe('whyNotRelevant', () => {
  const mail = (subject: string, text: string, labels: string[] = []): MailMessage => ({ ...BLANK, id: 'x', subject, from: 'a@b.c', labels, text });

  it('lets through emails with an obligation word and a date or amount', () => {
    assert.equal(whyNotRelevant(mail('Your bill is ready', 'Amount due: $84.20')), null);
    assert.equal(whyNotRelevant(mail('Appointment reminder', 'See you Tuesday at 3:30 PM')), null);
    assert.equal(whyNotRelevant(mail('Order shipped', 'Arriving Oct 30')), null);
    assert.equal(whyNotRelevant(mail('Field trip', 'Please return the permission slip by 10/30')), null);
  });

  it('rules out the rest without a model call', () => {
    assert.equal(whyNotRelevant(mail('Your bill', 'Due $5', ['SPAM'])), 'spam_or_trash');
    assert.equal(whyNotRelevant(mail('Your bill', 'Due $5', ['TRASH'])), 'spam_or_trash');
    assert.equal(whyNotRelevant(mail('Re: Your appointment', 'Could we move it to Thursday, Oct 29?', ['SENT'])), 'outgoing', 'our own replies');
    assert.equal(whyNotRelevant(mail('Your verification code', 'Your code is 123456. It expires in 10 minutes. Order 12/3')), 'security');
    assert.equal(whyNotRelevant(mail('50% off everything this weekend', 'Order by Sunday, Oct 25')), 'promotional');
    assert.equal(whyNotRelevant(mail('Weekly newsletter', 'Our team news')), 'promotional');
    assert.equal(whyNotRelevant(mail('Lunch?', 'Want to grab lunch on Friday?')), 'no_keywords');
    assert.equal(whyNotRelevant(mail('Your order', 'Thanks for shopping with us!')), 'no_date_or_amount');
  });

  it('reads every category and any sender: only spam, trash and our own outgoing mail are skipped by label', () => {
    assert.equal(whyNotRelevant(mail('Your bill', 'Due $5', ['CATEGORY_PROMOTIONS'])), null);
    assert.equal(whyNotRelevant(mail('Booking confirmed', 'See you Oct 30', ['CATEGORY_SOCIAL'])), null);
    // In the bulk tabs, marketing needs an actionable subject to cost a model call.
    assert.equal(whyNotRelevant(mail('Hi Shopper, one last reminder from Crocs', 'Order by Oct 30 for $20 off', ['CATEGORY_PROMOTIONS'])), 'promotional');
    assert.equal(whyNotRelevant(mail('The MAX Online scheduler is open', 'Book sessions from Oct 28', ['CATEGORY_PROMOTIONS'])), 'promotional');
    assert.equal(whyNotRelevant(mail('Dentist appointment confirmation', 'Booked for Tuesday, October 27 at 3:30 PM', ['CATEGORY_PERSONAL', 'INBOX'])), null);
    assert.equal(whyNotRelevant(mail('Note to self: bill', 'Due Oct 30', ['SENT', 'INBOX'])), null, 'sent to yourself still arrives');
    assert.match(GMAIL_QUERY, /^newer_than:14d -in:spam -in:trash -in:chats -in:drafts {/);
    assert.doesNotMatch(GMAIL_QUERY, /category:|in:sent|from:/);
  });

  it('keeps an actionable subject even with a sale word in it', () => {
    assert.equal(whyNotRelevant(mail('Sale order #4521 shipped', 'Arriving Oct 30')), null);
  });
});

// ---------------------------------------------------------------------------

/** Answers each email with the items whose snippet it contains, and records every request. */
class PerEmailProvider extends FakeProvider {
  failOn: string | null = null;

  constructor(private readonly byEmail: Record<string, unknown[]>) {
    super();
  }

  override async generateJson(req: JsonRequest): Promise<unknown> {
    this.jsonRequests.push(req);
    if (this.failOn && req.prompt.includes(this.failOn)) throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    const [, items] = Object.entries(this.byEmail).find(([key]) => req.prompt.includes(key)) ?? [null, []];
    return { items };
  }
}

class FakeMailbox implements Mailbox {
  readonly fetched: string[] = [];
  searches = 0;

  constructor(private readonly messages: MailMessage[]) {}

  async account() {
    return 'family@example.com';
  }

  async search(_query: string, max: number) {
    this.searches++;
    return this.messages.slice(0, max).map((m) => m.id);
  }

  async get(id: string) {
    this.fetched.push(id);
    return this.messages.find((m) => m.id === id)!;
  }

  /** threadId -> senders that replied, and the times asked about. */
  readonly replies = new Map<string, string[]>();
  readonly threadChecks: { threadId: string; afterMs: number; own: string }[] = [];
  readonly sent: { raw: string; threadId: string }[] = [];

  async repliesInThread(threadId: string, afterMs: number, own: string) {
    this.threadChecks.push({ threadId, afterMs, own });
    return this.replies.get(threadId) ?? [];
  }

  async send(raw: string, threadId: string) {
    this.sent.push({ raw, threadId });
    return `sent-${this.sent.length}`;
  }
}

const email = (id: string, subject: string, text: string, labels: string[] = []): MailMessage => ({
  ...BLANK,
  id,
  threadId: `thread-${id}`,
  subject,
  from: 'Sender <sender@example.com>',
  date: 'Wed, 21 Oct 2026 08:00:00 -0700',
  labels,
  text,
  messageIdHeader: `<${id}@example.com>`,
});

const WATER = 'Water bill: $84.20 due Nov 2, 2026.';
const DENTIST = 'Reminder: Maya has a dentist appointment on Tuesday, Oct 27 at 4:00 PM.';
const PARCEL = 'Your order has shipped and is arriving Oct 29.';
const LIBRARY = 'Reminder: library books are due Oct 31.';

describe('GmailSync', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fridge-door-gmail-'));
  const cleanups: (() => Promise<void>)[] = [];
  after(async () => {
    for (const c of cleanups) await c();
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = { householdId: HOUSEHOLD, userId: 'Priya' };

  async function setup(messages: MailMessage[], { maxEmails = 3, connected = true } = {}) {
    const { store, cleanup } = await tempStore();
    cleanups.push(cleanup);
    const provider = new PerEmailProvider({
      [WATER]: [raw({ title: 'Water bill', dueDate: '2026-11-02', amount: 84.2, sourceSnippet: WATER })],
      [DENTIST]: [raw({ type: 'appointment', title: 'Dentist', forWhom: 'Maya', dueDate: '2026-10-27', dueTime: '16:00', sourceSnippet: DENTIST })],
      [PARCEL]: [raw({ type: 'order', title: 'Parcel', dueDate: '2026-10-29', sourceSnippet: PARCEL })],
      [LIBRARY]: [raw({ type: 'deadline', title: 'Library books', dueDate: '2026-10-31', sourceSnippet: LIBRARY })],
    });
    const cache = new MemoryExtractionCache();
    const service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD', extractor: new Extractor(provider, TZ, cache), now: () => NOW });
    const state = new GmailState(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), () => NOW);
    if (connected) await state.update((s) => Object.assign(s, { account: 'family@example.com', refreshToken: 'refresh-token' }));
    const mailbox = new FakeMailbox(messages);
    const sync = new GmailSync({
      oauth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
      state,
      service,
      logger: silentLogger,
      maxEmails,
      mailbox: () => mailbox,
      now: () => NOW,
    });
    return { sync, state, store, provider, mailbox };
  }

  const inbox = [
    email('code', 'Your verification code', 'Your code is 123456 and expires today.'),
    email('water', 'Your water bill', WATER),
    email('promo', 'Flash sale: 40% off', 'Order by Friday, Oct 23!'),
    email('dentist', 'Appointment reminder', DENTIST),
    email('parcel', 'Shipped', PARCEL),
    email('library', 'Library', LIBRARY),
  ];

  it('reads at most maxEmails relevant emails, one model call each, and skips the rest without one', async () => {
    const { sync, store, provider, mailbox } = await setup(inbox);
    const r = await sync.sync(ctx);

    assert.equal(provider.jsonRequests.length, 3, 'one model call per email read');
    assert.deepEqual(r.emails, { matched: 6, alreadyRead: 0, notRelevant: 2, read: 3, failed: 0, remaining: 1 });
    assert.deepEqual(mailbox.fetched, ['code', 'water', 'promo', 'dentist', 'parcel'], 'stops fetching once the limit is reached');
    assert.deepEqual(r.items.map((o) => [o.title, o.source]), [['Water bill', 'gmail'], ['Dentist', 'gmail'], ['Parcel', 'gmail']]);
    assert.equal(r.items[0]!.sourceSnippet, WATER, 'snippets are verified against the email');
    assert.equal(r.account, 'family@example.com');
    assert.match(r.speech, /^I read 3 new emails\. I found 3 things: Water bill/);
    assert.equal((await store.list(HOUSEHOLD)).length, 3);
  });

  it('never sends an email to the model twice: handled ids are skipped, and a reset falls back on the cache', async () => {
    const { sync, state, provider, mailbox } = await setup(inbox);
    await sync.sync(ctx);
    const second = await sync.sync(ctx);
    assert.deepEqual(second.emails, { matched: 6, alreadyRead: 5, notRelevant: 0, read: 1, failed: 0, remaining: 0 });
    assert.deepEqual(second.items.map((o) => o.title), ['Library books']);
    assert.equal(provider.jsonRequests.length, 4);
    assert.equal(mailbox.fetched.filter((id) => id === 'water').length, 1, 'a handled email is not even fetched again');

    const third = await sync.sync(ctx);
    assert.deepEqual(third.emails, { matched: 6, alreadyRead: 6, notRelevant: 0, read: 0, failed: 0, remaining: 0 });
    assert.equal(third.speech, 'No new emails about bills, orders or appointments since I last checked.');

    // What `npm run seed` does: forget handled ids. Same content, so the cache answers.
    await state.update((s) => {
      s.processed = {};
    });
    const again = await sync.sync(ctx);
    assert.equal(again.emails.read, 3);
    assert.equal(provider.jsonRequests.length, 4, 'no new model calls');
    assert.deepEqual(again.skipped.map((s) => s.reason), ['duplicate', 'duplicate', 'duplicate'], 'and nothing is added twice');
  });

  it('runs one sync at a time', async () => {
    const { sync, provider } = await setup(inbox);
    const [a, b] = await Promise.all([sync.sync(ctx), sync.sync(ctx)]);
    assert.equal(a, b);
    assert.equal(provider.jsonRequests.length, 3);
  });

  it('keeps what was read when the model gives out part way, and retries the rest next time', async () => {
    const { sync, provider, state } = await setup(inbox);
    provider.failOn = DENTIST;
    const r = await sync.sync(ctx);
    assert.equal(r.emails.read, 1);
    assert.equal(r.emails.failed, 2);
    assert.equal(r.emails.remaining, 1);
    assert.deepEqual(r.items.map((o) => o.title), ['Water bill']);
    assert.match(r.speech, /I couldn't read 2 more right now; I'll retry later.$/);
    const { processed } = await state.read();
    assert.deepEqual(Object.keys(processed).sort(), ['code', 'promo', 'water']);

    provider.failOn = WATER; // already read: never asked again
    const next = await sync.sync(ctx);
    assert.deepEqual(next.items.map((o) => o.title), ['Dentist', 'Parcel', 'Library books']);
  });

  it('says when nothing new is worth reading, and when the first email fails', async () => {
    const { sync, provider } = await setup([inbox[0]!, inbox[2]!]);
    const r = await sync.sync(ctx);
    assert.equal(r.speech, "I looked at 2 new emails, but none of them had a bill, order or appointment in them.");
    assert.equal(provider.jsonRequests.length, 0);

  });

  it('says it found an email it could not read (quota), and keeps it for the next sync', async () => {
    const dentistOnly = [email('dentist', 'Dentist appointment confirmation', DENTIST, ['CATEGORY_PERSONAL', 'INBOX'])];
    const { sync, provider, state, store } = await setup(dentistOnly);
    provider.failOn = DENTIST; // 429 RESOURCE_EXHAUSTED
    const r = await sync.sync(ctx);
    assert.equal(r.speech, "I found 1 new email but couldn't read it right now. I'll retry later.");
    assert.deepEqual(r.emails, { matched: 1, alreadyRead: 0, notRelevant: 0, read: 0, failed: 1, remaining: 0 });
    assert.deepEqual(r.items, []);
    assert.deepEqual((await state.read()).processed, {}, 'not marked processed');

    provider.failOn = null; // quota back
    const retry = await sync.sync(ctx);
    assert.deepEqual(retry.items.map((o) => o.title), ['Dentist']);
    assert.equal(retry.emails.alreadyRead, 0);
    assert.equal((await store.list(HOUSEHOLD)).length, 1);
    assert.ok((await state.read()).processed.dentist);
  });

  it('asks to connect first, and stores the token file with only what it needs', async () => {
    const { sync, state } = await setup(inbox, { connected: false });
    await assert.rejects(sync.sync(ctx), /Gmail isn't connected yet/);
    assert.deepEqual(await sync.status(), { configured: true, connected: false, canSend: false, account: null, connectedAt: null, lastSyncAt: null });

    const file = (state as unknown as { file: string }).file;
    await state.markProcessed(['a']);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['account', 'connectedAt', 'lastSyncAt', 'processed', 'refreshToken', 'scopes']);
  });

  it('builds a Google consent URL for read plus send-only, nothing broader', async () => {
    const { sync } = await setup([]);
    const url = new URL(sync.authUrl('state-123'));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('state'), 'state-123');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/cb');
  });
});

describe('Google OAuth routes', async () => {
  const { store, cleanup } = await tempStore();
  const dir = await mkdtemp(path.join(tmpdir(), 'fridge-door-oauth-'));
  const service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD' });
  const gmail = new GmailSync({
    oauth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/auth/google/callback' },
    state: new GmailState(path.join(dir, 'gmail.json')),
    service,
    logger: silentLogger,
    maxEmails: 5,
  });
  const app = createApp({
    config: { HOST: '127.0.0.1', ALLOWED_HOSTS: undefined, CORS_ORIGINS: 'http://localhost:5173', API_KEY: 'test-key-0123456789abcdef', DEFAULT_HOUSEHOLD_ID: HOUSEHOLD },
    service,
    logger: silentLogger,
    gmail,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(async () => {
    server.close();
    await cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the browser to Google with a one-time state, and refuses callbacks without it', async () => {
    const res = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const consent = new URL(res.headers.get('location')!);
    assert.equal(consent.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
    const state = consent.searchParams.get('state')!;
    assert.match(state, /^[0-9a-f]{32}$/);

    const forged = await fetch(`${base}/auth/google/callback?state=nope&code=abc`);
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /That link has expired/);

    const denied = await fetch(`${base}/auth/google/callback?state=${state}&error=access_denied`);
    assert.equal(denied.status, 400);
    const page = await denied.text();
    assert.match(page, /Access was declined/);
    assert.match(page, /href="http:\/\/localhost:5173"/);

    const replay = await fetch(`${base}/auth/google/callback?state=${state}&code=abc`);
    assert.equal(replay.status, 400, 'a state works once');
  });

  it('keeps /api/gmail behind the API key and reports status', async () => {
    assert.equal((await fetch(`${base}/api/gmail/status`)).status, 401);
    const res = await fetch(`${base}/api/gmail/status`, { headers: { Authorization: 'Bearer test-key-0123456789abcdef' } });
    assert.deepEqual(await res.json(), { configured: true, connected: false, canSend: false, account: null, connectedAt: null, lastSyncAt: null });
    const sync = await fetch(`${base}/api/gmail/sync`, { method: 'POST', headers: { Authorization: 'Bearer test-key-0123456789abcdef' } });
    assert.equal(sync.status, 400);
    assert.match(((await sync.json()) as { error: { message: string } }).error.message, /Connect Gmail/);
  });
});

// ---------------------------------------------------------------------------
// Follow-up support: senders, links, replies
// ---------------------------------------------------------------------------

describe('replying to an email', () => {
  it('finds renewal, payment and account links on the sender’s or a biller’s domain, and nothing else', () => {
    const html =
      '<p>Your policy renews soon.</p>' +
      '<a href="https://www.harborline.com/policy/HL-1/renew?utm=x&amp;y=1">Renew now</a>' +
      '<a href="https://click.harborline.com/pay">Pay your bill</a>' +
      '<a href="http://www.harborline.com/account">Manage your account</a>' + // not https
      '<a href="https://harborline-secure.evil.com/renew">Renew here</a>' + // another domain
      '<a href="https://www.paypal.com/invoice/p/123">View invoice</a>' + // known biller
      '<a href="https://www.harborline.com/unsubscribe">Unsubscribe</a>' +
      '<a href="https://www.harborline.com/privacy">Privacy</a>' +
      '<a href="https://www.harborline.com/policy/HL-1/renew?utm=x&y=1">Renew</a>' + // same URL again
      '<a href="https://facebook.com/harborline">Facebook</a>';
    const m = messageFromGmail({
      id: 'r1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: '"Harborline Insurance" <Renewals@Harborline.com>' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Renew at https://www.harborline.com/policy/HL-1/renew?utm=x&y=1 before Nov 15. '.repeat(4)) } },
          { mimeType: 'text/html', body: { data: b64(html) } },
        ],
      },
    });
    assert.equal(m.links.length, 13, 'every link is collected first: 9 anchors and 4 in the plain text');
    assert.deepEqual(actionLinks(m), [
      { url: 'https://www.harborline.com/policy/HL-1/renew?utm=x&y=1', kind: 'renewal', label: 'Renew now' },
      { url: 'https://click.harborline.com/pay', kind: 'payment', label: 'Pay your bill' },
      { url: 'https://www.paypal.com/invoice/p/123', kind: 'payment', label: 'View invoice' },
    ]);
    assert.deepEqual(emailRef(m), {
      gmailMessageId: 'r1',
      threadId: 't1',
      messageIdHeader: null,
      references: null,
      fromAddress: 'renewals@harborline.com',
      fromName: 'Harborline Insurance',
      subject: '(no subject)',
      demo: false,
    });
  });

  it('reads sender addresses and spots no-reply ones', () => {
    assert.deepEqual(parseAddress('Bright Smiles <dr.smile@brightsmiles.com>'), { address: 'dr.smile@brightsmiles.com', name: 'Bright Smiles' });
    assert.deepEqual(parseAddress('billing@pge.com'), { address: 'billing@pge.com', name: null });
    assert.equal(parseAddress('Undisclosed recipients'), null);
    assert.equal(emailRef({ ...BLANK, id: 'x', from: 'nobody' }), null);
    assert.equal(isNoReply('no-reply@shop.com'), true);
    assert.equal(isNoReply('donotreply@bank.com'), true);
    assert.equal(isNoReply('noreply+orders@shop.com'), true);
    assert.equal(isNoReply('dr.smile@brightsmiles.com'), false);
    assert.equal(isNoReply('replies@shop.com'), false);
    assert.equal(baseDomain('mail.billing.pge.com'), 'pge.com');
    assert.equal(baseDomain('accounts.example.co.uk'), 'example.co.uk');
  });

  it('builds a threaded plain-text reply, with no way to add headers', () => {
    assert.equal(replySubject("RE: Re: Fwd: Maya's cleaning"), "Re: Maya's cleaning");
    const raw = buildReply({
      to: 'dr.smile@brightsmiles.com',
      subject: 'Re: Cleaning\r\nBcc: attacker@evil.com',
      body: 'Hi,\nThursday works. Café at 4?\n\nPriya',
      threadId: 't1',
      inReplyTo: '<appt-1@brightsmiles.com>',
      references: '<first@brightsmiles.com>',
    });
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = text.split('\r\n\r\n');
    assert.deepEqual(head!.split('\r\n'), [
      'To: dr.smile@brightsmiles.com',
      'Subject: Re: Cleaning Bcc: attacker@evil.com',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      'In-Reply-To: <appt-1@brightsmiles.com>',
      'References: <first@brightsmiles.com> <appt-1@brightsmiles.com>',
    ]);
    assert.equal(Buffer.from(body!, 'base64').toString('utf8'), 'Hi,\r\nThursday works. Café at 4?\r\n\r\nPriya');
    assert.throws(() => buildReply({ to: 'a@b.com, c@d.com', subject: 's', body: 'b', threadId: 't', inReplyTo: null, references: null }));
    assert.match(Buffer.from(buildReply({ to: 'a@b.com', subject: 'Re: Ünïcode', body: 'b', threadId: 't', inReplyTo: null, references: null }), 'base64url').toString(), /Subject: =\?UTF-8\?B\?/);
  });
});

describe('GmailSync and follow-ups', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fridge-door-reply-'));
  const cleanups: (() => Promise<void>)[] = [];
  after(async () => {
    for (const c of cleanups) await c();
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = { householdId: HOUSEHOLD, userId: 'Priya' };
  const BILL = 'Your Harborline policy renews on Nov 15, 2026. Premium: $612.00.';

  async function setup(scopes: string[] | null) {
    const { store, cleanup } = await tempStore();
    cleanups.push(cleanup);
    const provider = new PerEmailProvider({ [BILL]: [raw({ type: 'renewal', title: 'Car insurance', dueDate: '2026-11-15', amount: 612, sourceSnippet: BILL })] });
    const service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD', extractor: new Extractor(provider, TZ), now: () => NOW });
    const state = new GmailState(path.join(dir, `${Math.random().toString(36).slice(2)}.json`), () => NOW);
    await state.update((s) => Object.assign(s, { account: 'family@example.com', refreshToken: 'refresh-token', scopes }));
    const insurance: MailMessage = {
      ...email('ins', 'Your policy is up for renewal', BILL),
      from: 'Harborline <renewals@harborline.com>',
      links: [{ url: 'https://www.harborline.com/renew', text: 'Renew online' }],
    };
    const mailbox = new FakeMailbox([insurance]);
    const sync = new GmailSync({
      oauth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
      state,
      service,
      logger: silentLogger,
      maxEmails: 5,
      mailbox: () => mailbox,
      now: () => NOW,
    });
    return { sync, service, store, mailbox };
  }

  it('keeps the sender, thread and links on items read from an email', async () => {
    const { sync } = await setup(null);
    const r = await sync.sync(ctx);
    assert.deepEqual(r.items[0]!.email, {
      gmailMessageId: 'ins',
      threadId: 'thread-ins',
      messageIdHeader: '<ins@example.com>',
      references: null,
      fromAddress: 'renewals@harborline.com',
      fromName: 'Harborline',
      subject: 'Your policy is up for renewal',
      demo: false,
    });
    assert.deepEqual(r.items[0]!.links, [{ url: 'https://www.harborline.com/renew', kind: 'renewal', label: 'Renew online' }]);
    assert.deepEqual(r.replies, []);
  });

  it('says to reconnect when the stored grant predates replies, and sends once it has gmail.send', async () => {
    const mail = { to: 'renewals@harborline.com', subject: 'Re: x', body: 'Hi', threadId: 'thread-ins', inReplyTo: '<ins@example.com>', references: null };
    const old = await setup(null);
    assert.equal((await old.sync.status()).canSend, false);
    await assert.rejects(old.sync.send(mail), /Reconnect Gmail to enable replies/);
    assert.equal(old.mailbox.sent.length, 0);

    const fresh = await setup(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']);
    assert.equal((await fresh.sync.status()).canSend, true);
    assert.deepEqual(await fresh.sync.send(mail), { messageId: 'sent-1' });
    assert.equal(fresh.mailbox.sent[0]!.threadId, 'thread-ins');
    assert.match(Buffer.from(fresh.mailbox.sent[0]!.raw, 'base64url').toString(), /^To: renewals@harborline\.com\r\n/);
  });

  it('notices a reply in the thread of an item waiting on one, without a model call', async () => {
    const { sync, store, mailbox } = await setup(null);
    const sentAt = new Date(NOW - 3_600_000).toISOString();
    await store.put(
      ob({
        id: 'dentist',
        type: 'appointment',
        title: 'Dentist appointment',
        dueDate: '2026-10-24T22:30:00.000Z',
        source: 'gmail',
        status: 'awaiting_reply',
        email: { gmailMessageId: 'd1', threadId: 'thread-d', messageIdHeader: null, references: null, fromAddress: 'dr.smile@brightsmiles.com', fromName: 'Bright Smiles', subject: 'Cleaning', demo: false },
        actions: [{ type: 'email_sent', intent: 'reschedule', at: sentAt, by: 'Priya', summary: 'emailed Bright Smiles to move it', to: 'dr.smile@brightsmiles.com' }],
      }),
    );
    mailbox.replies.set('thread-d', ['Dr. Okafor <dr.smile@brightsmiles.com>']);
    const r = await sync.sync(ctx);
    assert.deepEqual(mailbox.threadChecks, [{ threadId: 'thread-d', afterMs: Date.parse(sentAt), own: 'family@example.com' }]);
    assert.deepEqual(r.replies, [{ id: 'dentist', title: 'Dentist appointment', from: 'Dr. Okafor' }]);
    assert.match(r.speech, /^Dr\. Okafor replied about Dentist appointment\. I read 1 new email\./);
    const item = (await store.get(HOUSEHOLD, 'dentist'))!;
    assert.equal(item.status, 'pending');
    assert.deepEqual(item.actions.at(-1), { type: 'reply_received', intent: null, at: new Date(NOW).toISOString(), by: 'Dr. Okafor', summary: 'replied', to: null });

    mailbox.replies.clear();
    const again = await sync.sync(ctx);
    assert.deepEqual(again.replies, [], 'no longer waiting, so not checked again');
    assert.equal(mailbox.threadChecks.length, 1);
  });
});
