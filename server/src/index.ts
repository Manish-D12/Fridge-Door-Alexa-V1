import { Agent } from './agent/agent.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { FileExtractionCache } from './extract/cache.js';
import { Extractor } from './extract/extractor.js';
import { FileOutbox } from './gmail/outbox.js';
import { GmailState } from './gmail/state.js';
import { GmailSync } from './gmail/sync.js';
import { createLogger } from './lib/logger.js';
import { createLlmProvider, type LlmProvider } from './llm/index.js';
import { FollowUps } from './service/followups.js';
import { ObligationService } from './service/obligations.js';
import { createStore } from './store/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const store = createStore(config);

const cache = new FileExtractionCache(config.EXTRACTION_CACHE_DIR);
let provider: LlmProvider | undefined;
let extractor: Extractor | undefined;
let agent: Agent | undefined;
try {
  provider = createLlmProvider(config, {
    onFallback: (info) => logger.warn('model quota exhausted; trying the next model', info),
    onRequest: ({ total, model, modelTotal, kind }) =>
      logger.info(`gemini request #${total} (${model}: ${modelTotal} since start)`, { kind }),
  });
  extractor = new Extractor(provider, config.HOUSEHOLD_TIMEZONE, cache);
  agent = new Agent({
    provider,
    mcpUrl: config.AGENT_MCP_URL ?? `http://127.0.0.1:${config.PORT}/mcp`,
    apiKey: config.API_KEY,
    timeZone: config.HOUSEHOLD_TIMEZONE,
    logger,
  });
} catch (err) {
  logger.warn('extraction and the simulator agent are disabled; they will report it', { provider: config.LLM_PROVIDER, reason: (err as Error).message });
}

const service = new ObligationService(store, {
  timeZone: config.HOUSEHOLD_TIMEZONE,
  defaultCurrency: config.DEFAULT_CURRENCY,
  extractor,
});

const gmail = new GmailSync({
  oauth:
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? {
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          redirectUri: config.GOOGLE_REDIRECT_URI ?? `http://localhost:${config.PORT}/auth/google/callback`,
        }
      : undefined,
  state: new GmailState(config.GMAIL_STATE_FILE),
  service,
  logger,
  maxEmails: config.GMAIL_SYNC_MAX_EMAILS,
});

const followups = new FollowUps({
  service,
  provider,
  cache,
  gmail: gmail.configured ? gmail : undefined,
  outbox: new FileOutbox(config.DEMO_OUTBOX_DIR),
  timeZone: config.HOUSEHOLD_TIMEZONE,
  logger,
});

const app = createApp({ config, service, logger, agent, gmail, followups });

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info('fridge-door listening', {
    mcp: `http://${config.HOST}:${config.PORT}/mcp`,
    api: `http://${config.HOST}:${config.PORT}/api`,
    storage: store.describe(),
    timeZone: config.HOUSEHOLD_TIMEZONE,
    extraction: extractor?.providerName ?? 'disabled',
    extractionCache: extractor ? config.EXTRACTION_CACHE_DIR : undefined,
    agent: agent ? `http://${config.HOST}:${config.PORT}/agent` : 'disabled',
    gmail: gmail.configured ? `http://localhost:${config.PORT}/auth/google` : 'not set up',
    auth: config.API_KEY ? 'bearer' : 'none',
  });
});

server.on('error', (err) => {
  logger.error('server failed to start', { err });
  process.exit(1);
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
