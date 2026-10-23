import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import type { ApiError } from '@fridge-door/shared';
import type { Agent } from '../agent/agent.js';
import type { Config } from '../config.js';
import type { GmailSync } from '../gmail/sync.js';
import { AppError, HTTP_STATUS } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';
import type { ObligationService } from '../service/obligations.js';
import { createAgentRouter } from './agent.js';
import { bearerAuth, requestContext } from './context.js';
import { createGmailRouter, createGoogleAuthRouter } from './google.js';
import { createRestRouter } from './rest.js';

export interface AppDeps {
  config: Pick<Config, 'HOST' | 'ALLOWED_HOSTS' | 'CORS_ORIGINS' | 'API_KEY' | 'DEFAULT_HOUSEHOLD_ID'>;
  service: ObligationService;
  logger: Logger;
  /** Powers /agent for the Echo Show simulator; without it those routes say it isn't set up. */
  agent?: Agent;
  /** Gmail sync: /auth/google, /api/gmail and the sync_inbox tool. Without it the tool says it isn't set up. */
  gmail?: GmailSync;
}

const csv = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Base64 images inflate by ~4/3; leave headroom over MAX_IMAGE_BASE64_LENGTH. */
const JSON_BODY_LIMIT = '12mb';

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0' as const, error: { code, message }, id: null });

export function createApp({ config, service, logger, agent, gmail }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // DNS-rebinding protection (required by the MCP spec for local servers).
  const allowedHosts = csv(config.ALLOWED_HOSTS);
  if (allowedHosts.length > 0) app.use(hostHeaderValidation(allowedHosts));
  else if (['127.0.0.1', 'localhost', '::1'].includes(config.HOST)) app.use(localhostHostValidation());
  else logger.warn('No ALLOWED_HOSTS set while binding to a non-localhost interface; Host header is not validated.');

  app.use(cors(csv(config.CORS_ORIGINS)));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.use(['/mcp', '/api', '/agent'], bearerAuth(config.API_KEY), express.json({ limit: JSON_BODY_LIMIT }));

  // --- MCP: Streamable HTTP, stateless (a fresh server + transport per request).
  app.post('/mcp', async (req, res) => {
    const ctx = requestContext(req, config.DEFAULT_HOUSEHOLD_ID);
    const server = createMcpServer(service, ctx, logger, gmail);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('mcp request failed', { err });
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  });

  // Stateless mode: no server-initiated SSE stream and no sessions to delete.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // --- REST for the web app.
  if (gmail) {
    app.use('/api/gmail', createGmailRouter(gmail, config.DEFAULT_HOUSEHOLD_ID));
    // Browser navigations to and from Google's consent page, so outside bearer auth.
    app.use('/auth', createGoogleAuthRouter(gmail, logger, csv(config.CORS_ORIGINS).find((o) => o !== '*')));
  }
  app.use('/api', createRestRouter(service, config.DEFAULT_HOUSEHOLD_ID));

  // --- The simulator's assistant, an MCP client of /mcp above.
  app.use('/agent', createAgentRouter(agent, config.DEFAULT_HOUSEHOLD_ID));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } } satisfies ApiError);
  });

  app.use(errorHandler(logger));
  return app;
}

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    const isMcp = req.path === '/mcp';

    // express.json() failures
    const bodyError = (err as { type?: string }).type;
    if (bodyError === 'entity.parse.failed' || bodyError === 'entity.too.large') {
      const status = bodyError === 'entity.too.large' ? 413 : 400;
      const message = bodyError === 'entity.too.large' ? 'Request body too large.' : 'Malformed JSON body.';
      if (isMcp) res.status(status).json(jsonRpcError(-32700, message));
      else res.status(status).json({ error: { code: 'bad_request', message } } satisfies ApiError);
      return;
    }

    if (err instanceof AppError) {
      if (isMcp) {
        res.status(HTTP_STATUS[err.code]).json(jsonRpcError(err.code === 'unauthorized' ? -32001 : -32600, err.message));
        return;
      }
      if (err.code === 'unauthorized') res.set('WWW-Authenticate', 'Bearer');
      res.status(HTTP_STATUS[err.code]).json({ error: { code: err.code, message: err.message, ...err.extra } } satisfies ApiError);
      return;
    }

    logger.error('unhandled error', { err, path: req.path });
    if (isMcp) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    else res.status(500).json({ error: { code: 'internal', message: 'Internal server error.' } } satisfies ApiError);
  };
}

/** Minimal CORS for an explicit origin allow-list. */
function cors(origins: string[]): RequestHandler {
  const allowAll = origins.includes('*');
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowAll || origins.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': allowAll ? '*' : origin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Household-Id, X-Household-Member, X-User-Id',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}
