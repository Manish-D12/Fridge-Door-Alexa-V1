import { google } from 'googleapis';
import type { GmailStatus, SyncInboxResult } from '@fridge-door/shared';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ObligationService, RequestContext } from '../service/obligations.js';
import { emailDocument, GMAIL_QUERY, messageFromGmail, whyNotRelevant, type Mailbox } from './mail.js';
import type { GmailState } from './state.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** How many matching ids to look through per sync; only `maxEmails` of them reach the model. */
const SEARCH_LIMIT = 25;

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
export class GmailSync {
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
    return this.oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [GMAIL_SCOPE], state });
  }

  /** Swaps the callback's code for a refresh token and stores it. Returns the Gmail address. */
  async connect(code: string): Promise<string> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.scope?.split(' ').includes(GMAIL_SCOPE)) {
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
      s.connectedAt = new Date(this.now()).toISOString();
    });
    this.opts.logger.info('gmail connected', { account });
    return account;
  }

  async status(): Promise<GmailStatus> {
    const s = await this.opts.state.read();
    return { configured: this.configured, connected: !!s.refreshToken, account: s.account, connectedAt: s.connectedAt, lastSyncAt: s.lastSyncAt };
  }

  /** One sync at a time, so two quick "check my email"s can't send the same email to the model twice. */
  sync(ctx: RequestContext): Promise<SyncInboxResult> {
    this.running ??= this.syncOnce(ctx).finally(() => (this.running = undefined));
    return this.running;
  }

  private async syncOnce(ctx: RequestContext): Promise<SyncInboxResult> {
    if (!this.opts.oauth) {
      throw new AppError('internal', "Gmail isn't set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env.");
    }
    const state = await this.opts.state.read();
    if (!state.refreshToken) {
      throw new AppError('bad_request', "Gmail isn't connected yet. Open settings on the screen and tap Connect Gmail.");
    }
    const mailbox = (this.opts.mailbox ?? ((token) => this.googleMailbox(token)))(state.refreshToken);

    const ids = await this.gmail(() => mailbox.search(GMAIL_QUERY, SEARCH_LIMIT));
    const fresh = ids.filter((id) => !state.processed[id]);
    const toRead: { id: string; text: string }[] = [];
    const ruledOut: string[] = [];
    let looked = 0;
    for (const id of fresh) {
      if (toRead.length >= this.opts.maxEmails) break;
      const message = await this.gmail(() => mailbox.get(id));
      looked++;
      const reason = whyNotRelevant(message);
      if (reason) {
        ruledOut.push(id);
        this.opts.logger.debug('gmail: email skipped without a model call', { reason });
      } else {
        toRead.push({ id, text: emailDocument(message) });
      }
    }
    if (ruledOut.length > 0) await this.opts.state.markProcessed(ruledOut);

    const { result, read } =
      toRead.length > 0
        ? await this.opts.service.ingestEmails(ctx, toRead.map((e) => e.text), async (i) => {
            await this.opts.state.markProcessed([toRead[i]!.id]);
          })
        : { result: null, read: 0 };
    await this.opts.state.update((s) => {
      s.lastSyncAt = new Date(this.now()).toISOString();
    });

    const emails = {
      matched: ids.length,
      alreadyRead: ids.length - fresh.length,
      notRelevant: ruledOut.length,
      read,
      remaining: fresh.length - looked + (toRead.length - read),
    };
    this.opts.logger.info('gmail sync', { ...emails, added: result?.items.length ?? 0 });

    const plural = (n: number) => `${n} new email${n === 1 ? '' : 's'}`;
    let speech: string;
    if (!result) {
      speech =
        looked === 0
          ? 'No new emails about bills, orders or appointments since I last checked.'
          : `I looked at ${plural(looked)}, but none of them had a bill, order or appointment in them.`;
    } else {
      speech = `I read ${plural(read)}. ${result.speech}`;
      if (read < toRead.length) speech += " The reading service is busy, so I'll read the rest next time.";
    }
    const ingest = result ?? { kind: 'text' as const, source: 'gmail' as const, items: [], needsConfirmation: [], skipped: [], transcript: null };
    return { ...ingest, speech, account: state.account, emails };
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

  async search(query: string, max: number): Promise<string[]> {
    const { data } = await this.api.users.messages.list({ userId: 'me', q: query, maxResults: max });
    return (data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
  }

  async get(id: string) {
    const { data } = await this.api.users.messages.get({ userId: 'me', id, format: 'full' });
    return messageFromGmail(data);
  }
}
