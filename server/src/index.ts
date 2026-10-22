import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { ObligationService } from './service/obligations.js';
import { createStore } from './store/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const store = createStore(config);
const service = new ObligationService(store, {
  timeZone: config.HOUSEHOLD_TIMEZONE,
  defaultCurrency: config.DEFAULT_CURRENCY,
});

const app = createApp({ config, service, logger });

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info('fridge-door listening', {
    mcp: `http://${config.HOST}:${config.PORT}/mcp`,
    api: `http://${config.HOST}:${config.PORT}/api`,
    storage: store.describe(),
    timeZone: config.HOUSEHOLD_TIMEZONE,
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
