import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { gmail_v1 } from 'googleapis';
import { MemoryExtractionCache } from '../src/extract/cache.js';
import { Extractor } from '../src/extract/extractor.js';
import { emailDocument, htmlToText, messageFromGmail, whyNotRelevant, type MailMessage, type Mailbox } from '../src/gmail/mail.js';
import { GmailState } from '../src/gmail/state.js';
import { GmailSync } from '../src/gmail/sync.js';
import { createApp } from '../src/http/app.js';
import { AppError } from '../src/lib/errors.js';
import { silentLogger } from '../src/lib/logger.js';
import type { JsonRequest } from '../src/llm/types.js';
import { ObligationService } from '../src/service/obligations.js';
import { FakeProvider, HOUSEHOLD, NOW, raw, TZ, tempStore } from './helpers.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('messageFromGmail', () => {
  it('takes the plain-text part, skipping attachments', () => {
    const m = messageFromGmail({
      id: 'm1',
      labelIds: ['INBOX', 'CATEGORY_UPDATES'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'Subject', value: 'Your  PG&E bill is ready' },
          { name: 'From', value: 'PG&E <billing@pge.com>' },
          { name: 'Date', value: 'Wed, 21 Oct 2026 08:00:00 -0700' },
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
      subject: 'Your PG&E bill is ready',
      from: 'PG&E <billing@pge.com>',
      date: 'Wed, 21 Oct 2026 08:00:00 -0700',
      labels: ['INBOX', 'CATEGORY_UPDATES'],
      text: 'Amount due: $142.17\nDue date: November 3, 2026\n\nThanks',
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
    const m: MailMessage = { id: 'x', subject: 'S', from: 'F', date: 'D', labels: [], text: 'Body' };
    assert.equal(emailDocument(m), 'Subject: S\nFrom: F\nDate: D\n\nBody');
    assert.equal(emailDocument({ ...m }), emailDocument(m));
  });
});

describe('whyNotRelevant', () => {
  const mail = (subject: string, text: string, labels: string[] = []): MailMessage => ({ id: 'x', subject, from: 'a@b.c', date: '', labels, text });

  it('lets through emails with an obligation word and a date or amount', () => {
    assert.equal(whyNotRelevant(mail('Your bill is ready', 'Amount due: $84.20')), null);
    assert.equal(whyNotRelevant(mail('Appointment reminder', 'See you Tuesday at 3:30 PM')), null);
    assert.equal(whyNotRelevant(mail('Order shipped', 'Arriving Oct 30')), null);
    assert.equal(whyNotRelevant(mail('Field trip', 'Please return the permission slip by 10/30')), null);
  });

  it('rules out the rest without a model call', () => {
    assert.equal(whyNotRelevant(mail('Your bill', 'Due $5', ['CATEGORY_PROMOTIONS'])), 'category');
    assert.equal(whyNotRelevant(mail('Your verification code', 'Your code is 123456. It expires in 10 minutes. Order 12/3')), 'security');
    assert.equal(whyNotRelevant(mail('50% off everything this weekend', 'Order by Sunday, Oct 25')), 'promotional');
    assert.equal(whyNotRelevant(mail('Weekly newsletter', 'Our team news')), 'promotional');
    assert.equal(whyNotRelevant(mail('Lunch?', 'Want to grab lunch on Friday?')), 'no_keywords');
    assert.equal(whyNotRelevant(mail('Your order', 'Thanks for shopping with us!')), 'no_date_or_amount');
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
}

const email = (id: string, subject: string, text: string, labels: string[] = []): MailMessage => ({
  id,
  subject,
  from: 'sender@example.com',
  date: 'Wed, 21 Oct 2026 08:00:00 -0700',
  labels,
  text,
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
    assert.deepEqual(r.emails, { matched: 6, alreadyRead: 0, notRelevant: 2, read: 3, remaining: 1 });
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
    assert.deepEqual(second.emails, { matched: 6, alreadyRead: 5, notRelevant: 0, read: 1, remaining: 0 });
    assert.deepEqual(second.items.map((o) => o.title), ['Library books']);
    assert.equal(provider.jsonRequests.length, 4);
    assert.equal(mailbox.fetched.filter((id) => id === 'water').length, 1, 'a handled email is not even fetched again');

    const third = await sync.sync(ctx);
    assert.deepEqual(third.emails, { matched: 6, alreadyRead: 6, notRelevant: 0, read: 0, remaining: 0 });
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
    assert.equal(r.emails.remaining, 3);
    assert.deepEqual(r.items.map((o) => o.title), ['Water bill']);
    assert.match(r.speech, /I'll read the rest next time/);
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

    const failing = await setup(inbox);
    failing.provider.failOn = WATER;
    await assert.rejects(failing.sync.sync(ctx), (err: AppError) => err instanceof AppError && /couldn't read that just now/.test(err.message));
  });

  it('asks to connect first, and stores the token file with only what it needs', async () => {
    const { sync, state } = await setup(inbox, { connected: false });
    await assert.rejects(sync.sync(ctx), /Gmail isn't connected yet/);
    assert.deepEqual(await sync.status(), { configured: true, connected: false, account: null, connectedAt: null, lastSyncAt: null });

    const file = (state as unknown as { file: string }).file;
    await state.markProcessed(['a']);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['account', 'connectedAt', 'lastSyncAt', 'processed', 'refreshToken']);
  });

  it('builds a Google consent URL for gmail.readonly only', async () => {
    const { sync } = await setup([]);
    const url = new URL(sync.authUrl('state-123'));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
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
    assert.equal(consent.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
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
    assert.deepEqual(await res.json(), { configured: true, connected: false, account: null, connectedAt: null, lastSyncAt: null });
    const sync = await fetch(`${base}/api/gmail/sync`, { method: 'POST', headers: { Authorization: 'Bearer test-key-0123456789abcdef' } });
    assert.equal(sync.status, 400);
    assert.match(((await sync.json()) as { error: { message: string } }).error.message, /Connect Gmail/);
  });
});
