import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** What Gmail sync remembers between runs, in one JSON file (gitignored, under .data). */
export interface GmailStateData {
  account: string | null;
  refreshToken: string | null;
  /** Scopes Google granted with the token. Missing on tokens stored before replies existed. */
  scopes: string[] | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  /** Message id -> when a sync handled it (read or ruled out), so no email reaches the model twice. */
  processed: Record<string, string>;
}

const EMPTY: GmailStateData = { account: null, refreshToken: null, scopes: null, connectedAt: null, lastSyncAt: null, processed: {} };

/** Sync only looks back 14 days, so older ids can go. */
const PROCESSED_TTL_MS = 30 * 24 * 60 * 60_000;

export class GmailState {
  /** Writes run one after another, so concurrent updates can't lose each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<GmailStateData> {
    try {
      return { ...EMPTY, ...(JSON.parse(await readFile(this.file, 'utf8')) as Partial<GmailStateData>) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, processed: {} };
      throw err;
    }
  }

  update(change: (s: GmailStateData) => void): Promise<GmailStateData> {
    const next = this.queue.then(async () => {
      const s = await this.read();
      change(s);
      const cutoff = this.now() - PROCESSED_TTL_MS;
      s.processed = Object.fromEntries(Object.entries(s.processed).filter(([, at]) => Date.parse(at) >= cutoff));
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      // It holds a refresh token: owner-only where the OS supports it.
      await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
      return s;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  markProcessed(ids: string[]): Promise<GmailStateData> {
    const at = new Date(this.now()).toISOString();
    return this.update((s) => {
      for (const id of ids) s.processed[id] = at;
    });
  }
}
