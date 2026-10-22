/**
 * Runs every file in /samples through ingest_text with the real LLM provider,
 * against a throwaway copy of the demo household (your own data is untouched).
 *   npm run samples                    # all samples
 *   npm run samples -- 05 06           # only files whose names contain these
 *
 * After each sample it checks that no pre-existing item changed, then ingests
 * the electricity bill a second time to show duplicate detection.
 *
 * Model answers go in the same cache the server uses (EXTRACTION_CACHE_DIR), so
 * re-running a sample costs no quota. Pass --fresh to ignore cached answers.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { IngestResult, Obligation, Source } from '@fridge-door/shared';
import { loadConfig } from '../src/config.js';
import { FileExtractionCache, MemoryExtractionCache } from '../src/extract/cache.js';
import { Extractor } from '../src/extract/extractor.js';
import { createLlmProvider, type LlmProvider } from '../src/llm/index.js';
import { ObligationService, type RequestContext } from '../src/service/obligations.js';

const samplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples');

let provider: LlmProvider;
try {
  provider = createLlmProvider(loadConfig(), {
    onFallback: ({ from, to, reason }) => console.log(`  (${from}: ${reason}; falling back to ${to})`),
  });
} catch (err) {
  console.error(`Can't run samples: ${(err as Error).message}. Set it in server/.env (see .env.example).`);
  process.exit(1);
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'fridge-door-samples-'));

// The seed script reads its target from the environment; point it at a temp file.
process.env.STORAGE = 'local';
process.env.LOCAL_DATA_FILE = path.join(dataDir, 'obligations.json');
const config = loadConfig();
console.log('--- Seeding demo household ---');
await import('./seed.js');

const { createStore } = await import('../src/store/index.js');
const store = createStore(config);
const tz = config.HOUSEHOLD_TIMEZONE;
/** Keeps the model's last raw answer, to show what it quoted when a snippet is rejected. */
type RawAnswer = { items?: { title?: string; sourceSnippet?: string }[] };
let lastRaw: RawAnswer | undefined;
let modelCalls = 0;
const recording: LlmProvider = {
  name: provider.name,
  generateText: (req) => {
    modelCalls++;
    return withRetry(() => provider.generateText(req));
  },
  generateJson: async (req) => {
    modelCalls++;
    const out = await withRetry(() => provider.generateJson(req));
    lastRaw = out as RawAnswer;
    return out;
  },
  chat: (req) => provider.chat(req),
};
const args = process.argv.slice(2);
const cache = args.includes('--fresh') ? new MemoryExtractionCache() : new FileExtractionCache(config.EXTRACTION_CACHE_DIR);
const extractor = new Extractor(recording, tz, cache);
const service = new ObligationService(store, { timeZone: tz, defaultCurrency: config.DEFAULT_CURRENCY, extractor });
const ctx: RequestContext = { householdId: config.DEFAULT_HOUSEHOLD_ID, userId: 'Priya' };

const SOURCES: [RegExp, Source][] = [
  [/whatsapp|ambiguous/i, 'whatsapp'],
  [/.*/, 'gmail'],
];
const local = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

async function run(file: string): Promise<void> {
  const text = await readFile(path.join(samplesDir, file), 'utf8');
  const source = SOURCES.find(([re]) => re.test(file))![1];
  const before = await store.list(ctx.householdId);
  const callsBefore = modelCalls;
  lastRaw = undefined;

  let result: IngestResult;
  try {
    result = await service.ingestText(ctx, { text, source });
  } catch (err) {
    console.log(`\n=== ${file} ===\n  FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const after = new Map((await store.list(ctx.householdId)).map((o) => [o.id, o]));
  const changed = before.filter((o) => !isDeepStrictEqual(after.get(o.id), o));

  const calls = modelCalls - callsBefore;
  console.log(`\n=== ${file} (${source}) ===`);
  console.log(`  model calls: ${calls}${calls === 0 ? ' (answer from cache)' : ''}`);
  console.log(`  speech: ${result.speech}`);
  for (const o of result.items) printItem(o);
  for (const s of result.skipped) {
    console.log(`  - skipped ${JSON.stringify(s.title)}: ${s.reason}${s.existingId ? ` (matches ${s.existingId})` : ''}`);
    if (s.reason === 'snippet_not_found') {
      // Cast: TS narrows lastRaw to undefined after the reset above, not seeing the async write.
      const quoted = (lastRaw as RawAnswer | undefined)?.items?.find((i) => i.title?.trim() === s.title)?.sourceSnippet;
      console.log(`      model quoted: ${JSON.stringify(quoted)}`);
    }
  }
  console.log(`  existing items changed: ${changed.length === 0 ? 'none' : changed.map((o) => o.id).join(', ')}`);
  if (changed.length > 0) process.exitCode = 1;
}

/**
 * Free-tier Gemini allows a few requests a minute; wait out a per-minute 429
 * instead of failing the run. A daily quota (retry in hours) fails at once.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (i >= attempts || !/RESOURCE_EXHAUSTED|429|ThrottlingException/.test(message)) throw err;
      const seconds = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1] ?? 30);
      if (seconds > 120) throw new Error(`Provider quota exhausted; it says to retry in ${Math.round(seconds / 3600)}h.`);
      console.log(`  (rate limited; retrying in ${Math.ceil(seconds)}s)`);
      await new Promise((r) => setTimeout(r, (seconds + 1) * 1000));
    }
  }
}

function printItem(o: Obligation): void {
  const amount = o.amount === null ? '' : ` ${o.currency} ${o.amount.toFixed(2)}`;
  console.log(`  + [${o.type}] ${o.title}${o.forWhom ? ` (for ${o.forWhom})` : ''} | ${local(o.dueDate)}${amount} | confidence ${o.confidence}`);
  console.log(`      snippet: ${JSON.stringify(o.sourceSnippet)}`);
  if (o.needsConfirmation) console.log(`      NEEDS CONFIRMATION: ${o.confirmationQuestion}`);
}

try {
  console.log(`\nProvider: ${extractor.providerName}. Today in ${tz}: ${local(new Date().toISOString())}`);
  const filters = args.filter((a) => !a.startsWith('--'));
  const files = (await readdir(samplesDir)).filter((f) => f.endsWith('.txt') && (filters.length === 0 || filters.some((x) => f.includes(x)))).sort();
  for (const f of files) await run(f);

  const bill = files.find((f) => f.includes('electricity'));
  if (bill) {
    console.log('\n--- Re-ingesting the electricity bill (should be skipped as a duplicate) ---');
    await run(bill);
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
