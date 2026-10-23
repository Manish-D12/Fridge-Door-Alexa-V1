import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Mailer } from '../service/followups.js';
import { buildReply, type OutgoingMail } from './mail.js';

/**
 * Where replies to seed items go. Their "emails" were never in anyone's
 * Gmail, so a real send would bounce; each reply is saved as an .eml file
 * (gitignored, under .data) and the speech says it wasn't sent.
 */
export class FileOutbox implements Mailer {
  constructor(private readonly dir: string) {}

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const messageId = `demo-${randomUUID()}`;
    await mkdir(this.dir, { recursive: true });
    const raw = Buffer.from(buildReply(mail), 'base64url').toString('utf8');
    await writeFile(path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${messageId}.eml`), raw);
    return { messageId };
  }
}
