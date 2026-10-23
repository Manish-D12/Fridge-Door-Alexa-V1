import { randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import { SyncInboxInput } from '@fridge-door/shared';
import type { GmailSync } from '../gmail/sync.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { requestContext } from './context.js';
import { parse } from './rest.js';

/** How long a consent page may stay open before its callback is refused. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Google sign-in for Gmail sync. Browser navigations, so no bearer token: the
 * one-time `state` ties each callback to a /auth/google visit on this server.
 *
 *   GET /auth/google            redirect to Google's consent page (gmail.readonly)
 *   GET /auth/google/callback   store the refresh token, then say so
 */
export function createGoogleAuthRouter(gmail: GmailSync, logger: Logger, homeUrl?: string): Router {
  const router = Router();
  const pending = new Map<string, number>();

  router.get('/google', (_req, res) => {
    if (!gmail.configured) {
      page(res, 500, 'Gmail isn’t set up', 'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to server/.env, then restart the server.', homeUrl);
      return;
    }
    const now = Date.now();
    for (const [s, expires] of pending) if (expires < now) pending.delete(s);
    const state = randomBytes(16).toString('hex');
    pending.set(state, now + STATE_TTL_MS);
    res.redirect(gmail.authUrl(state));
  });

  router.get('/google/callback', async (req, res) => {
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '');
    const state = q('state');
    const expires = pending.get(state);
    pending.delete(state);
    if (!expires || expires < Date.now()) {
      page(res, 400, 'That link has expired', 'Start again from Connect Gmail in the Echo Show settings.', homeUrl);
      return;
    }
    if (q('error') || !q('code')) {
      page(res, 400, 'Gmail wasn’t connected', q('error') === 'access_denied' ? 'Access was declined.' : `Google said: ${q('error') || 'no code'}.`, homeUrl);
      return;
    }
    try {
      const account = await gmail.connect(q('code'));
      page(res, 200, 'Gmail connected', `Fridge Door can now read ${account}. Go back to the Echo Show and say “check my email”.`, homeUrl);
    } catch (err) {
      if (!(err instanceof AppError)) logger.error('gmail connect failed', { err });
      page(res, 400, 'Gmail wasn’t connected', err instanceof AppError ? err.message : 'Google sign-in didn’t finish. Please try again.', homeUrl);
    }
  });

  return router;
}

/**
 *   GET  /api/gmail/status   GmailStatus
 *   POST /api/gmail/sync     SyncInboxResult (same as the sync_inbox tool)
 */
export function createGmailRouter(gmail: GmailSync, defaultHouseholdId: string): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    res.json(await gmail.status());
  });

  router.post('/sync', async (req, res) => {
    parse(SyncInboxInput, req.body);
    res.json(await gmail.sync(requestContext(req, defaultHouseholdId)));
  });

  return router;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: Response, status: number, title: string, message: string, homeUrl?: string): void {
  const ok = status === 200;
  res
    .status(status)
    .type('html')
    .set('Cache-Control', 'no-store')
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Fridge Door</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8ecf5; font: 18px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 520px; }
  h1 { font-size: 28px; margin: 0 0 8px; color: ${ok ? '#5eead4' : '#fda4af'}; }
  a { color: #00caff; }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${homeUrl ? `<p><a href="${escape(homeUrl)}">Back to the Echo Show</a></p>` : ''}</main></body></html>`);
}
