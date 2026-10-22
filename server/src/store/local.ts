import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ObligationSchema, type Obligation } from '@fridge-door/shared';
import type { ObligationStore } from './types.js';

const FileSchema = z.object({
  version: z.literal(1),
  obligations: z.array(ObligationSchema),
});
type FileShape = z.infer<typeof FileSchema>;

/**
 * JSON-file store for running without AWS (STORAGE=local).
 *
 * The file is re-read on every operation so that the seed script and a
 * running server see each other's writes. Writes are serialised within the
 * process and land atomically via write-to-temp + rename.
 */
export class LocalJsonStore implements ObligationStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  describe(): string {
    return `local JSON file (${this.filePath})`;
  }

  async list(householdId: string): Promise<Obligation[]> {
    const data = await this.read();
    return data.obligations.filter((o) => o.householdId === householdId);
  }

  async get(householdId: string, id: string): Promise<Obligation | null> {
    const data = await this.read();
    return data.obligations.find((o) => o.householdId === householdId && o.id === id) ?? null;
  }

  put(obligation: Obligation): Promise<void> {
    return this.mutate((data) => {
      const idx = data.obligations.findIndex((o) => o.householdId === obligation.householdId && o.id === obligation.id);
      if (idx >= 0) data.obligations[idx] = obligation;
      else data.obligations.push(obligation);
    });
  }

  markDone(householdId: string, id: string, doneBy: string, doneAt: string): Promise<Obligation | null> {
    return this.mutate((data) => {
      const existing = data.obligations.find((o) => o.householdId === householdId && o.id === id);
      if (!existing) return null;
      if (existing.status === 'pending') {
        existing.status = 'done';
        existing.doneBy = doneBy;
        existing.doneAt = doneAt;
      }
      return { ...existing };
    });
  }

  clearHousehold(householdId: string): Promise<number> {
    return this.mutate((data) => {
      const before = data.obligations.length;
      data.obligations = data.obligations.filter((o) => o.householdId !== householdId);
      return before - data.obligations.length;
    });
  }

  private async read(): Promise<FileShape> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, obligations: [] };
      throw err;
    }
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`Local data file ${this.filePath} is corrupt: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  private mutate<T>(fn: (data: FileShape) => T): Promise<T> {
    const run = async () => {
      const data = await this.read();
      const result = fn(data);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      await rename(tmp, this.filePath);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
