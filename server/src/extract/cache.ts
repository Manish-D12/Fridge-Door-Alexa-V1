import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Remembers model answers by content hash, so the same document or photo
 * never costs a second model call. Values are the model's raw output; the
 * extractor's code-side checks still run on every read.
 */
export interface ExtractionCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** sha256 over the parts, each length-prefixed so ("ab","c") and ("a","bc") differ. */
export function cacheKey(...parts: (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    hash.update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

interface Entry {
  savedAt: string;
  value: unknown;
}

/**
 * One JSON file per key under `dir`. A cache is an optimisation, so read and
 * write failures (missing dir, read-only disk, corrupt file) count as a miss
 * rather than failing the ingest.
 */
export class FileExtractionCache implements ExtractionCache {
  constructor(private readonly dir: string) {}

  async get(key: string): Promise<unknown | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as Entry;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const entry: Entry = { savedAt: new Date().toISOString(), value };
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(entry, null, 2));
      await rename(tmp, file);
    } catch {
      // Not cached; the next identical document calls the model again.
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}

export class MemoryExtractionCache implements ExtractionCache {
  readonly entries = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.entries.set(key, value);
  }
}
