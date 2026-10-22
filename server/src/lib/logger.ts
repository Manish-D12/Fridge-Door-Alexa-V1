/**
 * Minimal structured logger. Writes JSON lines to stderr so stdout stays clean.
 * Never log obligation contents or request bodies: they contain household data.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = LEVELS[level];
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    if (fields?.err instanceof Error) {
      entry.err = { name: fields.err.name, message: fields.err.message, stack: fields.err.stack };
    }
    process.stderr.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
