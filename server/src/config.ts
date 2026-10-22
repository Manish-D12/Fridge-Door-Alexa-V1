import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// When compiled, this file lives in dist/src, so step up once more.
const packageRoot = path.basename(serverRoot) === 'dist' ? path.dirname(serverRoot) : serverRoot;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** Comma-separated Host header allow-list, required for DNS-rebinding protection when HOST is not localhost. */
  ALLOWED_HOSTS: z.string().optional(),
  /** Comma-separated browser origins allowed to call /api and /mcp (e.g. the web simulator). */
  CORS_ORIGINS: z.string().optional(),
  STORAGE: z.enum(['dynamodb', 'local']).default('dynamodb'),
  LOCAL_DATA_FILE: z.string().default(path.join(packageRoot, '.data', 'obligations.json')),
  DYNAMODB_TABLE: z.string().default('fridge-door-obligations'),
  /** Optional, e.g. http://localhost:8000 for DynamoDB Local. */
  DYNAMODB_ENDPOINT: z.string().url().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  DEFAULT_HOUSEHOLD_ID: z.string().min(1).default('demo-household'),
  HOUSEHOLD_TIMEZONE: z
    .string()
    .default('America/Los_Angeles')
    .refine(isValidTimeZone, 'HOUSEHOLD_TIMEZONE must be an IANA time zone such as America/New_York'),
  DEFAULT_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  /** If set, /mcp and /api require `Authorization: Bearer <API_KEY>`. */
  API_KEY: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Model used by ingest_text / ingest_image. */
  LLM_PROVIDER: z.enum(['gemini', 'bedrock']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
  /** Tried in order, once each, when a model answers 429 / quota exhausted. */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default('gemini-2.5-flash-lite,gemini-2.0-flash')
    .transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean)),
  /** Bedrock model or inference profile id, e.g. us.anthropic.claude-haiku-4-5-20251001-v1:0. Uses AWS_REGION. */
  BEDROCK_MODEL_ID: z.string().optional(),
  /** Model answers are cached here by content hash, so the same document is never sent twice. */
  EXTRACTION_CACHE_DIR: z.string().default(path.join(packageRoot, '.data', 'extraction-cache')),
});

export type Config = z.infer<typeof EnvSchema>;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (common in copied .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return parsed.data;
}
