import { Agent } from './agent/agent.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { FileExtractionCache } from './extract/cache.js';
import { Extractor } from './extract/extractor.js';
import { createLogger } from './lib/logger.js';
import { createLlmProvider } from './llm/index.js';
import { ObligationService } from './service/obligations.js';
import { createStore } from './store/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const store = createStore(config);

let extractor: Extractor | undefined;
let agent: Agent | undefined;
try {
  const provider = createLlmProvider(config, {
    onFallback: (info) => logger.warn('model quota exhausted; trying the next model', info),
    onRequest: ({ total, model, modelTotal, kind }) =>
      logger.info(`gemini request #${total} (${model}: ${modelTotal} since start)`, { kind }),
  });
  extractor = new Extractor(provider, config.HOUSEHOLD_TIMEZONE, new FileExtractionCache(config.EXTRACTION_CACHE_DIR));
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

const app = createApp({ config, service, logger, agent });

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info('fridge-door listening', {
    mcp: `http://${config.HOST}:${config.PORT}/mcp`,
    api: `http://${config.HOST}:${config.PORT}/api`,
    storage: store.describe(),
    timeZone: config.HOUSEHOLD_TIMEZONE,
    extraction: extractor?.providerName ?? 'disabled',
    extractionCache: extractor ? config.EXTRACTION_CACHE_DIR : undefined,
    agent: agent ? `http://${config.HOST}:${config.PORT}/agent` : 'disabled',
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
