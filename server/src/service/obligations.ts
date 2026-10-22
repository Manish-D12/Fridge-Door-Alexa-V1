import { randomUUID } from 'node:crypto';
import {
  IsoDate,
  ObligationSchema,
  type AddObligationInput,
  type AddObligationResult,
  type DueRange,
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
  type ObligationType,
  type Source,
  type WhatsDueInput,
  type WhatsDueResult,
  type WhoHandledInput,
  type WhoHandledResult,
} from '@fridge-door/shared';
import { badRequest, notFound } from '../lib/errors.js';
import {
  addLocalDays,
  endOfLocalDay,
  localDateOf,
  parseIsoDate,
  spokenWhen,
  startOfLocalDay,
} from '../lib/time.js';
import type { ObligationStore } from '../store/types.js';
import { joinSpoken, normalize, resolveObligation } from './match.js';

/** Who is asking. Derived from the transport (headers), never from tool arguments. */
export interface RequestContext {
  householdId: string;
  /** The identified household member, or null if unknown (sees no private items). */
  userId: string | null;
}

export interface ServiceOptions {
  timeZone: string;
  defaultCurrency: string;
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

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function isVisibleTo(o: Obligation, ctx: RequestContext): boolean {
  return !o.private || sameName(o.addedBy, ctx.userId);
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
      (o) => o.status === 'pending' && (!input.forWhom || sameName(o.forWhom, input.forWhom)),
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
      const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map((o) => this.describe(o, now));
      if (items.length > MAX_SPOKEN_ITEMS) spoken.push(`${items.length - MAX_SPOKEN_ITEMS} more`);
      const count = items.length === 1 ? 'One thing is' : `${items.length} things are`;
      speech = `${count} due${who} ${spec.phrase}: ${joinSpoken(spoken, 'and', '; ')}.`;
    }
    if (overdue.length > 0) {
      const spoken = overdue.slice(0, MAX_SPOKEN_ITEMS).map((o) => this.describe(o, now, 'due '));
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
        .filter((o) => o.status === 'pending' && types.includes(o.type) && Date.parse(o.dueDate) >= now)
        .sort(byDueDate)[0] ?? null;

    const nouns = joinSpoken(types.map((t) => `${TYPE_NOUN[t]}s`), 'or');
    let speech: string;
    if (!item) speech = `There are no upcoming ${nouns}.`;
    else if (input.type) speech = `The next ${TYPE_NOUN[input.type]} is ${this.describe(item, now)}.`;
    else speech = `Next up: ${this.describe(item, now)}.`;
    return { speech, types, item };
  }

  async add(ctx: RequestContext, input: AddObligationInput): Promise<AddObligationResult> {
    const now = this.now();
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
    };
    const item = ObligationSchema.parse(candidate);
    await this.store.put(item);

    let speech = `Added ${this.describe(item, now)}.`;
    if (item.private) speech += ` Only ${item.addedBy} can see it.`;
    return { speech, item };
  }

  async markDone(ctx: RequestContext, input: MarkDoneInput): Promise<MarkDoneResult> {
    const now = this.now();
    const target = resolveObligation(await this.visible(ctx), input.idOrTitle, 'pending', now);
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
    const item = resolveObligation(await this.visible(ctx), input.idOrTitle, 'done', now);
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
    return {
      speech: `${item.title} ${origin}: "${snippet}"`,
      id: item.id,
      title: item.title,
      source: item.source,
      sourceSnippet: item.sourceSnippet,
      confidence: item.confidence,
      addedBy: item.addedBy,
      createdAt: item.createdAt,
    };
  }

  // TODO(bedrock): send text to a Bedrock model with a structured-output prompt,
  // validate each candidate with AddObligationInput, and persist via add().
  async ingestText(_ctx: RequestContext, input: IngestTextInput): Promise<IngestResult> {
    return {
      speech: "I've received that text, but automatic extraction isn't connected yet, so nothing was added.",
      status: 'pending_bedrock',
      kind: 'text',
      source: input.source,
      receivedBytes: Buffer.byteLength(input.text, 'utf8'),
      extracted: [],
    };
  }

  // TODO(bedrock): send the image to a Bedrock vision model (same pipeline as ingestText).
  async ingestImage(_ctx: RequestContext, input: IngestImageInput): Promise<IngestResult> {
    const bytes = Buffer.from(input.base64.replace(/\s+/g, ''), 'base64');
    if (bytes.length === 0) throw badRequest('The image is empty.');
    const check = IMAGE_MAGIC[input.mimeType];
    if (check && !check(bytes)) throw badRequest(`That doesn't look like a ${input.mimeType} image.`);
    return {
      speech: "I've received that photo, but automatic extraction isn't connected yet, so nothing was added.",
      status: 'pending_bedrock',
      kind: 'image',
      source: 'photo',
      receivedBytes: bytes.length,
      extracted: [],
    };
  }

  // -------------------------------------------------------------------------

  private async visible(ctx: RequestContext): Promise<Obligation[]> {
    return (await this.store.list(ctx.householdId)).filter((o) => isVisibleTo(o, ctx));
  }

  /** "Water bill, $84.20, due tomorrow" style phrase for speech. */
  private describe(o: Obligation, now: number, verb = DUE_VERB[o.type]): string {
    let s = o.title;
    if (o.amount !== null) {
      s += `, ${new Intl.NumberFormat('en-US', { style: 'currency', currency: o.currency }).format(o.amount)}`;
    }
    if (o.forWhom && !normalize(o.title).split(' ').includes(normalize(o.forWhom))) s += `, for ${o.forWhom}`;
    return `${s}, ${verb}${spokenWhen(o.dueDate, now, this.opts.timeZone)}`;
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
