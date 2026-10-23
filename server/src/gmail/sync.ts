import { google } from 'googleapis';
import type { GmailStatus, SyncInboxResult } from '@fridge-door/shared';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { IncomingEmail, ObligationService, RequestContext } from '../service/obligations.js';
import type { Mailer } from '../service/followups.js';
import {
  actionLinks,
  buildReply,
  emailDocument,
  emailRef,
  GMAIL_QUERY,
  messageFromGmail,
  parseAddress,
  whyNotRelevant,
  type Mailbox,
  type MailMessage,
  type OutgoingMail,
} from './mail.js';
import type { GmailState } from './state.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** Send only: it can't read, change or delete anything. Used for replies a person approved. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const RECONNECT_FOR_REPLIES = 'Reconnect Gmail to enable replies: open settings on the screen and tap Reconnect.';

/** How many matching ids to look through per sync; only `maxEmails` of them reach the model. */
const SEARCH_LIMIT = 50;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GmailSyncOptions {
  /** Unset when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing: sync then says it isn't set up. */
  oauth?: GoogleOAuthConfig;
  state: GmailState;
  service: ObligationService;
  logger: Logger;
  /** Emails sent to extraction per sync, at most. */
  maxEmails: number;
  /** The Gmail API by default; tests pass a fake. */
  mailbox?: (refreshToken: string) => Mailbox;
  now?: () => number;
}

/**
 * Reads recent Gmail into the household list. An email reaches the model only
 * if it passes the keyword check and no earlier sync has handled it; even then
 * the extraction cache answers for content it has seen before.
 */
export class GmailSync implements Mailer {
  private running: Promise<SyncInboxResult> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: GmailSyncOptions) {
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.opts.oauth;
  }

  /** The Google consent page. `state` comes back on the callback, to tie it to this request. */
  authUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [GMAIL_SCOPE, GMAIL_SEND_SCOPE],
      state,
    });
  }

  /** Swaps the callback's code for a refresh token and stores it. Returns the Gmail address. */
  async connect(code: string): Promise<string> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    const scopes = tokens.scope?.split(' ').filter(Boolean) ?? [];
    if (!scopes.includes(GMAIL_SCOPE)) {
      throw new AppError('bad_request', 'Gmail read access was not granted. Try again and leave the Gmail box ticked.');
    }
    if (!tokens.refresh_token) {
      throw new AppError('bad_request', "Google didn't return a refresh token. Remove the app's access in your Google account settings, then connect again.");
    }
    client.setCredentials(tokens);
    const account = await new GoogleMailbox(client).account();
    const refreshToken = tokens.refresh_token;
    await this.opts.state.update((s) => {
      s.account = account;
      s.refreshToken = refreshToken;
      s.scopes = scopes;
      s.connectedAt = new Date(this.now()).toISOString();
    });
    // Reading still works without send; replies say to reconnect.
    this.opts.logger.info('gmail connected', { account, canSend: scopes.includes(GMAIL_SEND_SCOPE) });
    return account;
  }

  async status(): Promise<GmailStatus> {
    const s = await this.opts.state.read();
    return {
      configured: this.configured,
      connected: !!s.refreshToken,
      canSend: !!s.refreshToken && !!s.scopes?.includes(GMAIL_SEND_SCOPE),
      account: s.account,
      connectedAt: s.connectedAt,
      lastSyncAt: s.lastSyncAt,
    };
  }

  /** Sends one approved reply into its thread. Callers decide what to send; this only refuses when it can't. */
  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const state = await this.opts.state.read();
    if (!this.opts.oauth || !state.refreshToken) {
      throw new AppError('bad_request', "Gmail isn't connected, so I can't send replies. Open settings on the screen and tap Connect Gmail.");
    }
    if (!state.scopes?.includes(GMAIL_SEND_SCOPE)) throw new AppError('bad_request', RECONNECT_FOR_REPLIES);
    const mailbox = this.mailboxFor(state.refreshToken);
    const messageId = await this.gmail(() => mailbox.send(buildReply(mail), mail.threadId));
    this.opts.logger.info('gmail reply sent', { threadId: mail.threadId });
    return { messageId };
  }

  /** One sync at a time, so two quick "check my email"s can't send the same email to the model twice. */
  sync(ctx: RequestContext): Promise<SyncInboxResult> {
    this.running ??= this.exclusive(() => this.syncOnce(ctx)).finally(() => (this.running = undefined));
    return this.running;
  }

  /**
   * For "did they reply?": looks at follow-up threads now, and nothing else.
   * Metadata and text only, no model calls. Runs after any sync in progress,
   * so a reply is never applied twice.
   */
  async refreshFollowups(ctx: RequestContext): Promise<SyncInboxResult['replies']> {
    if (!this.opts.oauth) return [];
    return this.exclusive(async () => {
      const state = await this.opts.state.read();
      if (!state.refreshToken) return [];
      const { replies, handled } = await this.handleReplies(ctx, this.mailboxFor(state.refreshToken), state.account);
      if (handled.length > 0) await this.opts.state.markProcessed(handled);
      return replies;
    });
  }

  /** Syncs and follow-up checks run one after another, never side by side. */
  private lock: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async syncOnce(ctx: RequestContext): Promise<SyncInboxResult> {
    if (!this.opts.oauth) {
      throw new AppError('internal', "Gmail isn't set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env.");
    }
    const state = await this.opts.state.read();
    if (!state.refreshToken) {
      throw new AppError('bad_request', "Gmail isn't connected yet. Open settings on the screen and tap Connect Gmail.");
    }
    const mailbox = this.mailboxFor(state.refreshToken);
    // Follow-up threads first: a reply belongs to the item it answers, so it is
    // applied there and never classified as a new bill or appointment.
    const { replies, handled, threads } = await this.handleReplies(ctx, mailbox, state.account);

    const found = await this.gmail(() => mailbox.search(GMAIL_QUERY, SEARCH_LIMIT));
    const ids = found.map((m) => m.id);
    const conversation = found.filter((m) => threads.has(m.threadId) && !state.processed[m.id]).map((m) => m.id);
    const skip = new Set([...handled, ...conversation]);
    if (skip.size > 0) await this.opts.state.markProcessed([...skip]);
    const fresh = ids.filter((id) => !state.processed[id] && !skip.has(id));
    const toRead: ({ id: string } & IncomingEmail)[] = [];
    const ruledOut: string[] = [];
    // One line per sync saying what happened to each matching email, for "why didn't it see my email?".
    const decisions: Record<string, string> = {};
    for (const id of ids) if (state.processed[id]) decisions[id] = `already handled ${state.processed[id]}`;
    for (const id of skip) if (ids.includes(id)) decisions[id] = 'reply in a follow-up thread: applied to its item, not read as new';
    let looked = 0;
    for (const id of fresh) {
      if (toRead.length >= this.opts.maxEmails) break;
      const message = await this.gmail(() => mailbox.get(id));
      looked++;
      const reason = whyNotRelevant(message);
      decisions[id] = reason ? `skipped: ${reason}` : 'to read';
      if (reason) ruledOut.push(id);
      else toRead.push({ id, text: emailDocument(message), email: emailRef(message), links: actionLinks(message) });
    }
    for (const id of fresh.slice(looked)) decisions[id] = 'over the per-sync limit';
    if (ruledOut.length > 0) await this.opts.state.markProcessed(ruledOut);

    // Emails the model couldn't read stay unprocessed, so the next sync retries them.
    const { result, read, error } =
      toRead.length > 0
        ? await this.opts.service.ingestEmails(ctx, toRead, async (i) => {
            await this.opts.state.markProcessed([toRead[i]!.id]);
          })
        : { result: null, read: 0, error: null };
    for (const [i, e] of toRead.entries()) decisions[e.id] = i < read ? 'read' : 'not read: model unavailable, will retry';
    await this.opts.state.update((s) => {
      s.lastSyncAt = new Date(this.now()).toISOString();
    });

    const failed = toRead.length - read;
    const emails = {
      matched: ids.length,
      alreadyRead: ids.length - fresh.length,
      notRelevant: ruledOut.length,
      read,
      failed,
      remaining: fresh.length - looked,
    };
    this.opts.logger.info('gmail sync', { query: GMAIL_QUERY, ...emails, added: result?.items.length ?? 0, replies: replies.length, decisions });
    if (error) this.opts.logger.warn('gmail sync: the model could not read some emails; they will be retried', { failed, err: error.cause ?? error.message });

    const plural = (n: number) => `${n} new email${n === 1 ? '' : 's'}`;
    let speech: string;
    if (read === 0 && failed > 0) {
      speech = `I found ${plural(failed)} but couldn't read ${failed === 1 ? 'it' : 'them'} right now. I'll retry later.`;
    } else if (!result) {
      speech =
        looked === 0
          ? 'No new emails about bills, orders or appointments since I last checked.'
          : `I looked at ${plural(looked)}, but none of them had a bill, order or appointment in them.`;
    } else {
      speech = `I read ${plural(read)}. ${result.speech}`;
      if (failed > 0) speech += ` I couldn't read ${failed} more right now; I'll retry later.`;
    }
    if (replies.length > 0) {
      const heard = replies.slice(0, 3).map(replySpeech).join(' ');
      speech = !result && looked === 0 ? `${heard} Nothing else new.` : `${heard} ${speech}`;
    }
    const ingest = result ?? { kind: 'text' as const, source: 'gmail' as const, items: [], needsConfirmation: [], skipped: [], transcript: null };
    return { ...ingest, speech, account: state.account, emails, replies };
  }

  /**
   * Reads the thread of every follow-up still waiting for an answer. The first
   * message from someone else after the one we sent (by Gmail's own order and
   * clock, never ours) is the reply: it is read without a model, applied to the
   * item (a yes to a reschedule moves it; a yes to a cancel closes it), and kept
   * in its history with anything else they said. A failing thread is skipped.
   *
   * Returns the replies, the message ids it handled, and every follow-up thread,
   * so the rest of the sync leaves those conversations alone.
   */
  private async handleReplies(
    ctx: RequestContext,
    mailbox: Mailbox,
    account: string | null,
  ): Promise<{ replies: SyncInboxResult['replies']; handled: string[]; threads: Set<string> }> {
    const replies: SyncInboxResult['replies'] = [];
    const handled: string[] = [];
    const threads = await this.opts.service.followupThreads(ctx);
    const own = (account ?? '').toLowerCase();
    const mine = (m: MailMessage) => m.labels.includes('SENT') || parseAddress(m.from)?.address === own;

    for (const item of await this.opts.service.followupsWaiting(ctx)) {
      const sent = item.actions.findLast((a) => a.type === 'email_sent')!;
      let messages: MailMessage[];
      try {
        messages = await this.gmail(() => mailbox.thread(item.email!.threadId));
      } catch (err) {
        this.opts.logger.warn('gmail: could not read a follow-up thread', { item: item.id, err: (err as Error).message });
        continue;
      }
      // Our message: by id when we have it, else ours from around the time we sent it.
      let at = sent.messageId ? messages.findIndex((m) => m.id === sent.messageId) : -1;
      if (at < 0) at = messages.findLastIndex((m) => mine(m) && m.receivedAt >= Date.parse(sent.at) - 10 * 60_000);
      const theirs = (at >= 0 ? messages.slice(at + 1) : messages.filter((m) => m.receivedAt > Date.parse(sent.at))).filter((m) => !mine(m));
      this.opts.logger.info('gmail: follow-up thread checked', { item: item.id, thread: item.email!.threadId, messages: messages.length, replies: theirs.length });
      if (theirs.length === 0) continue;

      const reply = theirs[0]!;
      const applied = await this.opts.service.applyReply(ctx, item, sent, {
        id: reply.id,
        from: parseAddress(reply.from)?.name ?? parseAddress(reply.from)?.address ?? item.email!.fromName ?? item.email!.fromAddress,
        text: reply.text,
        receivedAt: reply.receivedAt,
        ours: at >= 0 ? messages[at]!.text : '',
      });
      replies.push(applied);
      handled.push(...theirs.map((m) => m.id));
    }
    return { replies, handled, threads };
  }

  private mailboxFor(refreshToken: string): Mailbox {
    return (this.opts.mailbox ?? ((token) => this.googleMailbox(token)))(refreshToken);
  }

  private oauthClient() {
    const o = this.opts.oauth;
    if (!o) throw new AppError('internal', "Gmail isn't set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env.");
    return new google.auth.OAuth2(o.clientId, o.clientSecret, o.redirectUri);
  }

  private googleMailbox(refreshToken: string): Mailbox {
    const client = this.oauthClient();
    client.setCredentials({ refresh_token: refreshToken });
    return new GoogleMailbox(client);
  }

  /** Gmail failures, worded for the person at the screen. */
  private async gmail<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      const e = err as { message?: string; response?: { data?: { error?: unknown } } };
      const status = (err as { response?: { status?: number } }).response?.status ?? (err as { status?: number }).status;
      if (status === 403 && /insufficient|scope|permission/i.test(e.message ?? '')) {
        this.opts.logger.warn('gmail permission missing');
        throw new AppError('bad_request', RECONNECT_FOR_REPLIES);
      }
      if (e.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(e.message ?? '')) {
        this.opts.logger.warn('gmail access revoked or expired');
        throw new AppError('bad_request', 'Gmail access has expired or was turned off. Open settings and connect Gmail again.');
      }
      this.opts.logger.error('gmail request failed', { err });
      throw new AppError('internal', "I couldn't reach Gmail just now. Please try again in a moment.");
    }
  }
}

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

class GoogleMailbox implements Mailbox {
  private readonly api;

  constructor(auth: OAuth2Client) {
    this.api = google.gmail({ version: 'v1', auth });
  }

  async account(): Promise<string> {
    const { data } = await this.api.users.getProfile({ userId: 'me' });
    return data.emailAddress ?? 'your Gmail';
  }

  async search(query: string, max: number) {
    const { data } = await this.api.users.messages.list({ userId: 'me', q: query, maxResults: max });
    return (data.messages ?? []).flatMap((m) => (m.id ? [{ id: m.id, threadId: m.threadId ?? m.id }] : []));
  }

  async get(id: string) {
    const { data } = await this.api.users.messages.get({ userId: 'me', id, format: 'full' });
    return messageFromGmail(data);
  }

  async thread(threadId: string) {
    const { data } = await this.api.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    return (data.messages ?? []).map(messageFromGmail).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  async send(raw: string, threadId: string): Promise<string> {
    const { data } = await this.api.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
    return data.id ?? '';
  }
}

/** "Dr. Lee replied about Dentist appointment: they agreed to move it to Thursday, October 29 at 4:00 PM. They added: "Please be on time."" */
export function replySpeech(r: SyncInboxResult['replies'][number]): string {
  return `${r.from} replied about ${r.title}: they ${r.summary}.${r.note ? ` They added: "${r.note}"` : ''}`;
}
