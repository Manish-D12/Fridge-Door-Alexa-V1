import { randomUUID } from 'node:crypto';
import {
  IsoDate,
  ObligationSchema,
  type ActionLink,
  type AddObligationInput,
  type AddObligationResult,
  type ConfirmItemInput,
  type ConfirmItemResult,
  type DueRange,
  type EmailRef,
  type ExtractedObligation,
  type GetSourceInput,
  type GetSourceResult,
  type IngestImageInput,
  type IngestResult,
  type IngestTextInput,
  type ListObligationsResult,
  type MarkDoneInput,
  type MarkDoneResult,
  type NextUpInput,
  type NextUpResult,
  type Obligation,
  type ObligationAction,
  type ObligationType,
  type Source,
  type Status,
  type SyncInboxResult,
  type WhatsDueInput,
  type WhatsDueResult,
  type WhoHandledInput,
  type WhoHandledResult,
} from '@fridge-door/shared';
import type { ExtractionResult, Extractor } from '../extract/extractor.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import {
  addLocalDays,
  endOfLocalDay,
  localDateOf,
  localDayDiff,
  onLocalDate,
  parseIsoDate,
  spokenWhen,
  startOfLocalDay,
} from '../lib/time.js';
import type { ObligationStore } from '../store/types.js';
import { joinSpoken, normalize, resolveObligation, similarTitles, type ResolveOptions } from './match.js';
import { proposedInstant, proposedTime, readReply, replyEffect } from './replies.js';

/** Who is asking. Derived from the transport (headers), never from tool arguments. */
export interface RequestContext {
  householdId: string;
  /** The identified household member, or null if unknown (sees no private items). */
  userId: string | null;
}

export interface ServiceOptions {
  timeZone: string;
  defaultCurrency: string;
  /** Powers ingest_text / ingest_image. Without it those tools report that extraction isn't set up. */
  extractor?: Extractor;
  now?: () => number;
  newId?: () => string;
}

/** Types `next_up` considers when no type is given. */
export const NEXT_UP_DEFAULT_TYPES: ObligationType[] = ['appointment', 'booking', 'order'];

const RANGE_DAYS: Record<DueRange, { offset: number; days: number; phrase: string }> = {
  today: { offset: 0, days: 1, phrase: 'today' },
  tomorrow: { offset: 1, days: 1, phrase: 'tomorrow' },
  week: { offset: 0, days: 7, phrase: 'in the next 7 days' },
  month: { offset: 0, days: 30, phrase: 'in the next 30 days' },
};

const TYPE_NOUN: Record<ObligationType, string> = {
  bill: 'bill',
  order: 'delivery',
  booking: 'booking',
  appointment: 'appointment',
  deadline: 'deadline',
  renewal: 'renewal',
};

const SOURCE_PHRASE: Record<Source, string> = {
  gmail: 'an email',
  whatsapp: 'a WhatsApp message',
  photo: 'a photo',
  manual: 'a manual entry',
};

/** How each type reads before its date: "due tomorrow", "arriving today at 8:00 PM", "on Sunday at 3:30 PM". */
const DUE_VERB: Record<ObligationType, string> = {
  bill: 'due ',
  order: 'arriving ',
  booking: '',
  appointment: '',
  deadline: 'due ',
  renewal: 'due ',
};

/** Long lists are hard to follow by ear; the rest is in structured content. */
const MAX_SPOKEN_ITEMS = 3;
const MAX_SPOKEN_SNIPPET = 240;

/** Image signatures, to reject mislabelled or non-image uploads early. */
const IMAGE_MAGIC: Partial<Record<IngestImageInput['mimeType'], (b: Buffer) => boolean>> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
};

interface IngestMeta {
  kind: IngestResult['kind'];
  source: Source;
  transcript: string | null;
  now: number;
  /** What "nothing found" refers to; defaults to "that photo" or "that". */
  subject?: string;
}

/** One email for ingestEmails: its document text, and what replying to it needs. */
export interface IncomingEmail {
  text: string;
  email: EmailRef | null;
  links: ActionLink[];
}

type Extra = Pick<Obligation, 'needsConfirmation' | 'confirmationQuestion' | 'confirmationOptions'> & Partial<Pick<Obligation, 'email' | 'links'>>;

interface Saved {
  added: Obligation[];
  duplicates: Obligation[];
  skipped: IngestResult['skipped'];
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isVisibleTo(o: Obligation, ctx: RequestContext): boolean {
  return !o.private || sameName(o.addedBy, ctx.userId);
}

/** Whether a follow-up email went out about an item, and whether it was answered. */
export function followupState(o: Obligation): 'none' | 'waiting' | 'replied' {
  const sent = o.actions.findLastIndex((a) => a.type === 'email_sent');
  if (sent < 0) return 'none';
  return o.actions.findLastIndex((a) => a.type === 'reply_received') > sent ? 'replied' : 'waiting';
}

/** "Thursday, October 29 at 4:00 PM" in the household time zone. */
export function longWhen(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** Not done yet: pending, waiting for a reply, or mid-renewal. */
export const isOpen = (o: Obligation) => o.status !== 'done';

/** The latest follow-up still in flight, for "you asked to move it to Thursday, waiting for a reply". */
function pendingAction(o: Obligation): ObligationAction | null {
  if (o.status !== 'awaiting_reply' && o.status !== 'renewal_in_progress') return null;
  return o.actions.findLast((a) => a.type === 'email_sent' || a.type === 'renewal_started') ?? null;
}

const byDueDate = (a: Obligation, b: Obligation) => Date.parse(a.dueDate) - Date.parse(b.dueDate);

export class ObligationService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly store: ObligationStore,
    private readonly opts: ServiceOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  get timeZone(): string {
    return this.opts.timeZone;
  }

  async list(ctx: RequestContext): Promise<ListObligationsResult> {
    return { items: (await this.visible(ctx)).sort(byDueDate) };
  }

  async whatsDue(ctx: RequestContext, input: WhatsDueInput): Promise<WhatsDueResult> {
    const { timeZone } = this.opts;
    const now = this.now();
    const today = localDateOf(now, timeZone);
    const spec = RANGE_DAYS[input.range];
    const start = startOfLocalDay(addLocalDays(today, spec.offset), timeZone);
    const end = endOfLocalDay(addLocalDays(today, spec.offset + spec.days - 1), timeZone);
    const startOfToday = startOfLocalDay(today, timeZone);

    const pending = (await this.visible(ctx)).filter(
      (o) => isOpen(o) && (!input.forWhom || sameName(o.forWhom, input.forWhom)),
    );
    const items = pending
      .filter((o) => {
        const due = Date.parse(o.dueDate);
        return due >= start && due <= end;
      })
      .sort(byDueDate);
    const overdue = pending.filter((o) => Date.parse(o.dueDate) < startOfToday).sort(byDueDate);

    const who = input.forWhom ? ` for ${input.forWhom}` : '';
    let speech: string;
    if (items.length === 0) {
      speech = `Nothing is due${who} ${spec.phrase}.`;
    } else {
      const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map((o) => this.describe(o, now, undefined, ctx));
      if (items.length > MAX_SPOKEN_ITEMS) spoken.push(`${items.length - MAX_SPOKEN_ITEMS} more`);
      const count = items.length === 1 ? 'One thing is' : `${items.length} things are`;
      speech = `${count} due${who} ${spec.phrase}: ${joinSpoken(spoken, 'and', '; ')}.`;
      // Follow-ups in flight are worth hearing even when the item is past the first few.
      const waiting = items.slice(MAX_SPOKEN_ITEMS).flatMap((o) => {
        const pending = this.pendingPhrase(o, ctx);
        return pending ? [`for ${o.title}, ${pending}`] : [];
      });
      if (waiting.length > 0) speech += ` Also, ${joinSpoken(waiting.slice(0, 2), 'and', '; ')}.`;
    }
    if (overdue.length > 0) {
      const spoken = overdue.slice(0, MAX_SPOKEN_ITEMS).map((o) => this.describe(o, now, 'due ', ctx));
      if (overdue.length > MAX_SPOKEN_ITEMS) spoken.push(`${overdue.length - MAX_SPOKEN_ITEMS} more`);
      speech += ` Also overdue: ${joinSpoken(spoken, 'and', '; ')}.`;
    }

    return {
      speech,
      range: input.range,
      timeZone,
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      forWhom: input.forWhom ?? null,
      items,
      overdue,
    };
  }

  async nextUp(ctx: RequestContext, input: NextUpInput): Promise<NextUpResult> {
    const now = this.now();
    const types = input.type ? [input.type] : NEXT_UP_DEFAULT_TYPES;
    const item =
      (await this.visible(ctx))
        .filter((o) => isOpen(o) && types.includes(o.type) && Date.parse(o.dueDate) >= now)
        .sort(byDueDate)[0] ?? null;

    const nouns = joinSpoken(types.map((t) => `${TYPE_NOUN[t]}s`), 'or');
    let speech: string;
    if (!item) speech = `There are no upcoming ${nouns}.`;
    else if (input.type) speech = `The next ${TYPE_NOUN[input.type]} is ${this.describe(item, now, undefined, ctx)}.`;
    else speech = `Next up: ${this.describe(item, now, undefined, ctx)}.`;
    return { speech, types, item };
  }

  async add(ctx: RequestContext, input: AddObligationInput): Promise<AddObligationResult> {
    const now = this.now();
    const item = await this.create(ctx, input, now);
    let speech = `Added ${this.describe(item, now)}.`;
    if (item.private) speech += ` Only ${item.addedBy} can see it.`;
    return { speech, item };
  }

  async markDone(ctx: RequestContext, input: MarkDoneInput): Promise<MarkDoneResult> {
    const now = this.now();
    const target = resolveObligation(await this.visible(ctx), input.idOrTitle, { prefer: 'open', now, timeZone: this.opts.timeZone });
    const doneBy = input.doneBy.trim();

    if (target.status === 'done') {
      return {
        speech: `${target.title} was already handled by ${target.doneBy ?? 'someone'} ${spokenWhen(target.doneAt ?? target.dueDate, now, this.opts.timeZone)}.`,
        alreadyDone: true,
        item: target,
      };
    }

    const doneAt = new Date(now).toISOString();
    const item = await this.store.markDone(ctx.householdId, target.id, doneBy, doneAt);
    if (!item) throw notFound(`${target.title} no longer exists.`);
    // Someone else may have finished it between our read and write.
    const alreadyDone = item.doneAt !== doneAt || !sameName(item.doneBy, doneBy);
    const speech = alreadyDone
      ? `${item.title} was already handled by ${item.doneBy ?? 'someone'}.`
      : `Done. ${item.title} is marked as handled by ${doneBy}.`;
    return { speech, alreadyDone, item };
  }

  async whoHandled(ctx: RequestContext, input: WhoHandledInput): Promise<WhoHandledResult> {
    const now = this.now();
    const item = resolveObligation(await this.visible(ctx), input.idOrTitle, { prefer: 'done', now, timeZone: this.opts.timeZone });
    const handled = item.status === 'done';
    const speech = handled
      ? `${item.doneBy ?? 'Someone'} handled ${item.title} ${spokenWhen(item.doneAt ?? item.dueDate, now, this.opts.timeZone)}.`
      : `Nobody has handled ${item.title} yet. It's due ${spokenWhen(item.dueDate, now, this.opts.timeZone)}.`;
    return { speech, handled, doneBy: item.doneBy, doneAt: item.doneAt, item };
  }

  async getSource(ctx: RequestContext, input: GetSourceInput): Promise<GetSourceResult> {
    const item = await this.store.get(ctx.householdId, input.id.trim());
    // Hidden private items are reported exactly like missing ones.
    if (!item || !isVisibleTo(item, ctx)) throw notFound(`I couldn't find an item with id "${input.id}".`);

    const snippet =
      item.sourceSnippet.length > MAX_SPOKEN_SNIPPET
        ? `${item.sourceSnippet.slice(0, MAX_SPOKEN_SNIPPET).trimEnd()}…`
        : item.sourceSnippet;
    const origin =
      item.source === 'manual' ? `was added by ${item.addedBy}, who said` : `came from ${SOURCE_PHRASE[item.source]}. It says`;
    const pending = this.pendingPhrase(item, ctx);
    return {
      speech: `${item.title} ${origin}: "${snippet}"${pending ? ` Since then, ${pending}.` : ''}`,
      id: item.id,
      title: item.title,
      source: item.source,
      sourceSnippet: item.sourceSnippet,
      confidence: item.confidence,
      addedBy: item.addedBy,
      createdAt: item.createdAt,
      status: item.status,
      actions: item.actions,
    };
  }

  async ingestText(ctx: RequestContext, input: IngestTextInput): Promise<IngestResult> {
    const extractor = this.requireExtractor();
    const now = this.now();
    const extracted = await reading(() => extractor.extract(input.text, { sourceDescription: SOURCE_PHRASE[input.source], now }));
    const meta = { kind: 'text' as const, source: input.source, transcript: null, now };
    return this.ingestResult(await this.saveExtracted(ctx, extracted, meta), meta);
  }

  /**
   * Several emails at once (an inbox sync), answered with one result. Each is
   * extracted on its own, so snippets quote that email and the cache works per
   * email. `onSaved(i)` runs once email i is saved. If the model fails (quota,
   * overload), reading stops: what was saved stays, `read` says how many got
   * through and `error` says why, so the caller can keep the rest for later.
   */
  async ingestEmails(
    ctx: RequestContext,
    emails: IncomingEmail[],
    onSaved: (index: number) => Promise<void> = async () => undefined,
  ): Promise<{ result: IngestResult; read: number; error: AppError | null }> {
    const extractor = this.requireExtractor();
    const now = this.now();
    const meta: IngestMeta = { kind: 'text', source: 'gmail', transcript: null, now, subject: emails.length === 1 ? 'that email' : 'those emails' };
    const all: Saved = { added: [], duplicates: [], skipped: [] };
    let read = 0;
    let error: AppError | null = null;
    for (const [i, { text, email, links }] of emails.entries()) {
      let extracted: ExtractionResult;
      try {
        extracted = await reading(() => extractor.extract(text, { sourceDescription: SOURCE_PHRASE.gmail, now }));
      } catch (err) {
        // reading() turns every model failure into an AppError.
        error = err as AppError;
        break;
      }
      const saved = await this.saveExtracted(ctx, extracted, meta, { email, links });
      all.added.push(...saved.added);
      all.duplicates.push(...saved.duplicates);
      all.skipped.push(...saved.skipped);
      read++;
      await onSaved(i);
    }
    return { result: this.ingestResult(all, meta), read, error };
  }

  /** Transcribes the photo first, so every sourceSnippet quotes real text from it. */
  async ingestImage(ctx: RequestContext, input: IngestImageInput): Promise<IngestResult> {
    const bytes = Buffer.from(input.base64.replace(/\s+/g, ''), 'base64');
    if (bytes.length === 0) throw badRequest('The image is empty.');
    const check = IMAGE_MAGIC[input.mimeType];
    if (check && !check(bytes)) throw badRequest(`That doesn't look like a ${input.mimeType} image.`);

    const extractor = this.requireExtractor();
    const now = this.now();
    const transcript = await reading(() => extractor.transcribe({ bytes, mimeType: input.mimeType }));
    const meta = { kind: 'image' as const, source: 'photo' as const, transcript, now };
    if (!transcript) {
      return { ...this.ingestResult({ added: [], duplicates: [], skipped: [] }, meta), speech: "I couldn't read any text in that photo." };
    }
    const extracted = await reading(() => extractor.extract(transcript, { sourceDescription: 'text transcribed from a photo', now }));
    return this.ingestResult(await this.saveExtracted(ctx, extracted, meta), meta);
  }

  async confirmItem(ctx: RequestContext, input: ConfirmItemInput): Promise<ConfirmItemResult> {
    const now = this.now();
    const existing = await this.store.get(ctx.householdId, input.id.trim());
    if (!existing || !isVisibleTo(existing, ctx)) throw notFound(`I couldn't find an item with id "${input.id}".`);

    const dueDate = IsoDate.safeParse(input.chosenDate).success
      ? new Date(onLocalDate(Date.parse(existing.dueDate), parseIsoDate(input.chosenDate), this.opts.timeZone)).toISOString()
      : this.normalizeDueDate(input.chosenDate);
    const item = ObligationSchema.parse({ ...existing, dueDate, needsConfirmation: false, confirmationQuestion: null, confirmationOptions: [] });
    await this.store.put(item);
    return {
      speech: `Got it. ${item.title} is ${DUE_VERB[item.type]}${spokenWhen(item.dueDate, now, this.opts.timeZone)}.`,
      item,
    };
  }

  /** One visible obligation by id or title words (plus any day or sender hints); ties are asked about, not guessed. */
  async resolve(ctx: RequestContext, idOrTitle: string, opts: Partial<Pick<ResolveOptions, 'prefer' | 'hints' | 'preferEmail' | 'preferFollowup'>> = {}): Promise<Obligation> {
    return resolveObligation(await this.visible(ctx), idOrTitle, { prefer: 'open', ...opts, now: this.now(), timeZone: this.opts.timeZone });
  }

  /** Appends to the item's action history and optionally moves its status. Returns the saved item. */
  async logAction(
    ctx: RequestContext,
    id: string,
    action: ObligationAction,
    status?: Status,
    patch: Partial<Pick<Obligation, 'dueDate' | 'doneBy' | 'doneAt'>> = {},
  ): Promise<Obligation> {
    const existing = await this.store.get(ctx.householdId, id);
    if (!existing || !isVisibleTo(existing, ctx)) throw notFound(`I couldn't find an item with id "${id}".`);
    // Done stays done: a late reply or a renewal click doesn't reopen it.
    const keepDone = existing.status === 'done';
    const item = ObligationSchema.parse({
      ...existing,
      ...(keepDone ? {} : patch),
      status: status && !keepDone ? status : existing.status,
      actions: [...existing.actions, action].slice(-50),
    });
    await this.store.put(item);
    return item;
  }

  /** Items from real Gmail with a follow-up email that hasn't been answered yet. */
  async followupsWaiting(ctx: RequestContext): Promise<Obligation[]> {
    return (await this.visible(ctx)).filter((o) => o.email && !o.email.demo && followupState(o) === 'waiting');
  }

  /** Threads we have written into: messages there are conversation about an item, not new items. */
  async followupThreads(ctx: RequestContext): Promise<Set<string>> {
    const items = (await this.visible(ctx)).filter((o) => o.email && !o.email.demo && o.actions.some((a) => a.type === 'email_sent'));
    return new Set(items.map((o) => o.email!.threadId));
  }

  /**
   * Applies a reply to our follow-up, without a model: a yes to a reschedule
   * moves the item to the time our email proposed; a yes to a cancel closes
   * it; anything else is recorded as said. Their other words are kept as a note.
   */
  async applyReply(
    ctx: RequestContext,
    item: Obligation,
    sent: ObligationAction,
    reply: { id: string; from: string; text: string; receivedAt: number; ours: string },
  ): Promise<SyncInboxResult['replies'][number]> {
    const { timeZone } = this.opts;
    const reading = readReply(reply.text);
    const due = Date.parse(item.dueDate);
    const proposed = sent.intent === 'reschedule' && reply.ours ? proposedTime(reply.ours, due, this.now(), timeZone) : null;
    const newDue = proposed ? proposedInstant(proposed, due, timeZone) : null;
    const effect = replyEffect(sent.intent, reading, newDue);
    const quote = `"${reading.gist.replace(/[.!?]+$/, '')}"`;
    const summary =
      effect === 'move'
        ? `agreed to move it to ${longWhen(newDue!, timeZone)}`
        : effect === 'cancel'
          ? 'confirmed the cancellation'
          : reading.outcome === 'declined'
            ? `said no: ${quote}`
            : reading.outcome === 'accepted'
              ? `said yes: ${quote}`
              : `wrote: ${quote}`;
    const at = new Date(reply.receivedAt || this.now()).toISOString();
    await this.logAction(
      ctx,
      item.id,
      { type: 'reply_received', intent: sent.intent, at, by: reply.from, summary, to: null, note: reading.note, messageId: reply.id },
      effect === 'cancel' ? 'done' : 'pending',
      effect === 'move' ? { dueDate: new Date(newDue!).toISOString() } : effect === 'cancel' ? { doneBy: sent.by, doneAt: at } : {},
    );
    return { id: item.id, title: item.title, from: reply.from, summary, note: reading.note, updated: effect !== 'none' };
  }

  // -------------------------------------------------------------------------

  /** "you asked to move it to Thursday, waiting for a reply" for an item with a follow-up in flight. */
  private pendingPhrase(o: Obligation, ctx: RequestContext): string | null {
    const action = pendingAction(o);
    if (!action) return null;
    const who = sameName(action.by, ctx.userId) ? 'you' : action.by;
    return o.status === 'awaiting_reply' ? `${who} ${action.summary}, waiting for a reply` : `${who} ${action.summary}`;
  }

  private requireExtractor(): Extractor {
    if (!this.opts.extractor) {
      throw new AppError('internal', "Reading emails and photos isn't set up on this server yet, so nothing was added.");
    }
    return this.opts.extractor;
  }

  private async create(
    ctx: RequestContext,
    input: AddObligationInput,
    now: number,
    extra: Extra = { needsConfirmation: false, confirmationQuestion: null, confirmationOptions: [] },
  ): Promise<Obligation> {
    const addedBy = input.addedBy?.trim() || ctx.userId;
    const isPrivate = input.private ?? false;
    if (isPrivate && !addedBy) {
      throw badRequest('Private items need to know who is adding them. Say who you are, or make it shared.');
    }
    const source = input.source ?? 'manual';

    const candidate: Obligation = {
      id: this.newId(),
      householdId: ctx.householdId,
      type: input.type,
      title: input.title.trim(),
      dueDate: this.normalizeDueDate(input.dueDate),
      amount: input.amount ?? null,
      currency: (input.currency ?? this.opts.defaultCurrency).toUpperCase(),
      forWhom: input.forWhom?.trim() || null,
      source,
      sourceSnippet: input.sourceSnippet,
      confidence: input.confidence ?? (source === 'manual' ? 1 : 0.5),
      private: isPrivate,
      addedBy: addedBy ?? 'household',
      status: 'pending',
      doneBy: null,
      doneAt: null,
      createdAt: new Date(now).toISOString(),
      email: null,
      links: [],
      actions: [],
      ...extra,
    };
    const item = ObligationSchema.parse(candidate);
    await this.store.put(item);
    return item;
  }

  /**
   * Adds extracted items, skipping any already on the list: same type, same
   * local due date and a similar title. Only checks what the caller can see,
   * so a private item never leaks through a "duplicate" message.
   */
  private async saveExtracted(
    ctx: RequestContext,
    extracted: ExtractionResult,
    meta: IngestMeta,
    origin: Pick<Extra, 'email' | 'links'> = {},
  ): Promise<Saved> {
    const known = await this.visible(ctx);
    const added: Obligation[] = [];
    const duplicates: { item: ExtractedObligation; existing: Obligation }[] = [];

    for (const e of extracted.items) {
      const dueDate = this.normalizeDueDate(e.dueDate);
      const existing = known.find(
        (o) =>
          o.type === e.type &&
          localDayDiff(Date.parse(o.dueDate), Date.parse(dueDate), this.opts.timeZone) === 0 &&
          similarTitles(o.title, e.title),
      );
      if (existing) {
        duplicates.push({ item: e, existing });
        continue;
      }
      const { needsConfirmation, confirmationQuestion, confirmationOptions, ...fields } = e;
      const item = await this.create(ctx, { ...fields, source: meta.source }, meta.now, { needsConfirmation, confirmationQuestion, confirmationOptions, ...origin });
      added.push(item);
      known.push(item);
    }

    const skipped: IngestResult['skipped'] = [
      ...duplicates.map(({ item, existing }) => ({ title: item.title, reason: 'duplicate' as const, existingId: existing.id })),
      ...extracted.rejected.map((r) => ({ title: r.title, reason: r.reason, existingId: null })),
    ];
    return { added, duplicates: duplicates.map((d) => d.existing), skipped };
  }

  private ingestResult({ added, duplicates, skipped }: Saved, meta: IngestMeta): IngestResult {
    const { now } = meta;
    const confirm = added.filter((o) => o.needsConfirmation && o.confirmationQuestion);
    const parts: string[] = [];

    if (added.length > 0) {
      const spoken = added.slice(0, MAX_SPOKEN_ITEMS).map((o) => this.describe(o, now));
      if (added.length > MAX_SPOKEN_ITEMS) spoken.push(`${added.length - MAX_SPOKEN_ITEMS} more`);
      const count = added.length === 1 ? 'one thing' : `${added.length} things`;
      parts.push(`I found ${count}: ${joinSpoken(spoken, 'and', '; ')}.`);
    }
    if (duplicates.length > 0) {
      const titles = joinSpoken([...new Set(duplicates.map((o) => o.title))], 'and');
      const verb = duplicates.length === 1 ? 'was' : 'were';
      parts.push(added.length > 0 ? `${titles} ${verb} already on the list.` : `I found ${titles}, but ${duplicates.length === 1 ? 'it was' : 'they were'} already on the list.`);
    }
    if (parts.length === 0) {
      parts.push(`I didn't find anything with a date to keep track of in ${meta.subject ?? (meta.kind === 'image' ? 'that photo' : 'that')}.`);
    }
    if (confirm.length > 0) {
      parts.push(confirm.length === 1 ? 'One needs checking.' : `${confirm.length} need checking.`);
      parts.push(...confirm.slice(0, MAX_SPOKEN_ITEMS).map((o) => o.confirmationQuestion!));
    }

    return {
      speech: parts.join(' '),
      kind: meta.kind,
      source: meta.source,
      items: added,
      needsConfirmation: confirm.map((o) => ({ id: o.id, title: o.title, question: o.confirmationQuestion!, options: o.confirmationOptions })),
      skipped,
      transcript: meta.transcript,
    };
  }

  private async visible(ctx: RequestContext): Promise<Obligation[]> {
    return (await this.store.list(ctx.householdId)).filter((o) => isVisibleTo(o, ctx));
  }

  /** "Water bill, $84.20, due tomorrow" style phrase for speech; given ctx, plus any follow-up in flight. */
  private describe(o: Obligation, now: number, verb = DUE_VERB[o.type], ctx?: RequestContext): string {
    let s = o.title;
    if (o.amount !== null) {
      s += `, ${new Intl.NumberFormat('en-US', { style: 'currency', currency: o.currency }).format(o.amount)}`;
    }
    if (o.forWhom && !normalize(o.title).split(' ').includes(normalize(o.forWhom))) s += `, for ${o.forWhom}`;
    s += `, ${verb}${spokenWhen(o.dueDate, now, this.opts.timeZone)}`;
    const pending = ctx && this.pendingPhrase(o, ctx);
    return pending ? `${s} (${pending})` : s;
  }

  /** Date-only values mean "by the end of that day" in the household time zone. */
  private normalizeDueDate(value: string): string {
    if (IsoDate.safeParse(value).success) {
      return new Date(endOfLocalDay(parseIsoDate(value), this.opts.timeZone)).toISOString();
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw badRequest(`"${value}" is not a valid date.`);
    return new Date(ms).toISOString();
  }
}

/** Model failures (quota, overload, network) become a message a person can act on; nothing has been saved yet. */
async function reading<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw Object.assign(
      new AppError('internal', "I couldn't read that just now. The reading service is busy or has hit its limit, so nothing was added. Please try again later."),
      { cause: err },
    );
  }
}
