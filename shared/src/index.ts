/**
 * Schemas shared by the fridge-door server (MCP + REST) and the web app.
 *
 * Input schemas deliberately avoid zod transforms so they convert cleanly to
 * JSON Schema for MCP tool definitions; normalisation (defaults, casing,
 * date-only -> date-time) happens in the server's service layer.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const OBLIGATION_TYPES = ['bill', 'order', 'booking', 'appointment', 'deadline', 'renewal'] as const;
export const ObligationType = z.enum(OBLIGATION_TYPES);
export type ObligationType = z.infer<typeof ObligationType>;

export const SOURCES = ['gmail', 'whatsapp', 'photo', 'manual'] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const STATUSES = ['pending', 'done'] as const;
export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const DUE_RANGES = ['today', 'tomorrow', 'week', 'month'] as const;
export const DueRange = z.enum(DUE_RANGES);
export type DueRange = z.infer<typeof DueRange>;

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif'] as const;
export const ImageMimeType = z.enum(IMAGE_MIME_TYPES);
export type ImageMimeType = z.infer<typeof ImageMimeType>;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 8601 date-time; `Z` or an explicit offset is required. */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** ISO 8601 calendar date, e.g. 2026-10-24. */
export const IsoDate = z.iso.date();

export const CurrencyCode = z.string().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO 4217 code such as USD');

const PersonName = z.string().trim().min(1).max(100);

// ---------------------------------------------------------------------------
// Obligation record
// ---------------------------------------------------------------------------

export const ObligationSchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  type: ObligationType,
  title: z.string().trim().min(1).max(200),
  /** Normalised to a full ISO date-time (UTC) when stored. */
  dueDate: IsoDateTime,
  amount: z.number().nonnegative().nullable(),
  /** Upper-case ISO 4217 code. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  forWhom: PersonName.nullable(),
  source: Source,
  /** The exact text the obligation was extracted from (or what the user said). */
  sourceSnippet: z.string().min(1).max(5000),
  confidence: z.number().min(0).max(1),
  /** Private items are only visible to the member who added them. */
  private: z.boolean(),
  addedBy: PersonName,
  status: Status,
  doneBy: PersonName.nullable(),
  doneAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  /** True when the source was ambiguous about the date (e.g. "10/11") and a person should pick one. */
  needsConfirmation: z.boolean().default(false),
  /** Spoken question naming every interpretation, e.g. "Is the bake sale on Sunday, October 11 or Tuesday, November 10?" */
  confirmationQuestion: z.string().min(1).max(500).nullable().default(null),
  /** The local dates (YYYY-MM-DD) to offer when needsConfirmation is set, earliest first. */
  confirmationOptions: z.array(IsoDate).max(4).default([]),
});
export type Obligation = z.infer<typeof ObligationSchema>;

// ---------------------------------------------------------------------------
// Operation inputs (used as MCP tool input schemas and REST body/query schemas)
// ---------------------------------------------------------------------------

export const WhatsDueInput = z.object({
  range: DueRange.describe(
    'Time window: "today", "tomorrow", "week" (today plus the next 6 days) or "month" (today plus the next 29 days).',
  ),
  forWhom: PersonName.optional().describe(
    'Only include items for this household member, e.g. "Maya". Omit for everyone.',
  ),
});
export type WhatsDueInput = z.infer<typeof WhatsDueInput>;

export const NextUpInput = z.object({
  type: ObligationType.optional().describe(
    'Restrict to one kind, e.g. "appointment", "booking" or "order" (a delivery). Omit to get the next appointment, booking or delivery.',
  ),
});
export type NextUpInput = z.infer<typeof NextUpInput>;

export const AddObligationInput = z.object({
  type: ObligationType.describe('What kind of obligation this is.'),
  title: z.string().trim().min(1).max(200).describe('Short spoken-friendly title, e.g. "Water bill" or "Maya dentist".'),
  dueDate: z
    .union([IsoDateTime, IsoDate])
    .describe(
      'When it is due. ISO 8601 date-time with offset (2026-10-24T15:30:00-07:00) or a plain date (2026-10-24), which means the end of that day in the household time zone.',
    ),
  amount: z.number().nonnegative().nullable().optional().describe('Amount owed, if any. Omit for non-payments.'),
  currency: CurrencyCode.optional().describe('ISO 4217 currency code. Defaults to the household currency.'),
  forWhom: PersonName.nullable().optional().describe('Household member this is for, if it is for someone specific.'),
  source: Source.optional().describe('Where this came from. Defaults to "manual" (spoken or typed by a person).'),
  sourceSnippet: z
    .string()
    .min(1)
    .max(5000)
    .describe('The exact text this was taken from. For a voice request, pass the user\'s own words verbatim.'),
  confidence: z.number().min(0).max(1).optional().describe('Extraction confidence from 0 to 1. Defaults to 1 for manual entries.'),
  private: z.boolean().optional().describe('If true, only the person who added it can see it. Defaults to false.'),
  addedBy: PersonName.optional().describe('Household member adding it. Defaults to the identified speaker.'),
});
export type AddObligationInput = z.infer<typeof AddObligationInput>;

export const MarkDoneInput = z.object({
  idOrTitle: z.string().trim().min(1).describe('The obligation id, or words from its title such as "water bill".'),
  doneBy: PersonName.describe('Who handled it, e.g. "Dan".'),
});
export type MarkDoneInput = z.infer<typeof MarkDoneInput>;

export const WhoHandledInput = z.object({
  idOrTitle: z.string().trim().min(1).describe('The obligation id, or words from its title such as "rent".'),
});
export type WhoHandledInput = z.infer<typeof WhoHandledInput>;

export const GetSourceInput = z.object({
  id: z.string().trim().min(1).describe('The obligation id (from a previous result).'),
});
export type GetSourceInput = z.infer<typeof GetSourceInput>;

export const IngestTextInput = z.object({
  text: z.string().min(1).max(20_000).describe('Raw text of an email, chat message or note to extract obligations from.'),
  source: Source.describe('Where the text came from.'),
});
export type IngestTextInput = z.infer<typeof IngestTextInput>;

export const ConfirmItemInput = z.object({
  id: z.string().trim().min(1).describe('The id of the item that needs confirmation (from an ingest result).'),
  chosenDate: z
    .union([IsoDateTime, IsoDate])
    .describe(
      "The date the person picked. A plain date (2026-11-10) keeps the item's original time of day, or means the end of that day if it had none.",
    ),
});
export type ConfirmItemInput = z.infer<typeof ConfirmItemInput>;

/**
 * One obligation found by automatic extraction: the add_obligation fields plus
 * the date-confirmation flags. Produced by the server, never accepted from clients.
 */
export const ExtractedObligation = AddObligationInput.pick({
  type: true,
  title: true,
  dueDate: true,
  amount: true,
  currency: true,
  forWhom: true,
  sourceSnippet: true,
  confidence: true,
}).extend({
  needsConfirmation: z.boolean(),
  confirmationQuestion: z.string().min(1).max(500).nullable(),
  confirmationOptions: z.array(IsoDate).max(4),
});
export type ExtractedObligation = z.infer<typeof ExtractedObligation>;

/** ~7.5 MB of decoded image data. */
export const MAX_IMAGE_BASE64_LENGTH = 10_000_000;

export const IngestImageInput = z.object({
  base64: z
    .string()
    .min(1)
    .max(MAX_IMAGE_BASE64_LENGTH)
    .regex(/^[A-Za-z0-9+/\r\n]+={0,2}\s*$/, 'Must be raw base64 without a data: URL prefix')
    .describe('Base64-encoded image bytes (no data: URL prefix), e.g. a photo of a school slip or a bill.'),
  mimeType: ImageMimeType.describe('Image MIME type.'),
});
export type IngestImageInput = z.infer<typeof IngestImageInput>;

// ---------------------------------------------------------------------------
// Operation results. Every result carries `speech`: one or two sentences that
// a voice assistant can read aloud as-is.
// ---------------------------------------------------------------------------

const Speech = z.string().describe('Short answer suitable for reading aloud.');

export const WhatsDueResult = z.object({
  speech: Speech,
  range: DueRange,
  timeZone: z.string(),
  window: z.object({ start: IsoDateTime, end: IsoDateTime }),
  forWhom: z.string().nullable(),
  items: z.array(ObligationSchema),
  overdue: z.array(ObligationSchema).describe('Pending items whose due date has already passed.'),
});
export type WhatsDueResult = z.infer<typeof WhatsDueResult>;

export const NextUpResult = z.object({
  speech: Speech,
  types: z.array(ObligationType),
  item: ObligationSchema.nullable(),
});
export type NextUpResult = z.infer<typeof NextUpResult>;

export const AddObligationResult = z.object({
  speech: Speech,
  item: ObligationSchema,
});
export type AddObligationResult = z.infer<typeof AddObligationResult>;

export const MarkDoneResult = z.object({
  speech: Speech,
  alreadyDone: z.boolean(),
  item: ObligationSchema,
});
export type MarkDoneResult = z.infer<typeof MarkDoneResult>;

export const WhoHandledResult = z.object({
  speech: Speech,
  handled: z.boolean(),
  doneBy: z.string().nullable(),
  doneAt: IsoDateTime.nullable(),
  item: ObligationSchema,
});
export type WhoHandledResult = z.infer<typeof WhoHandledResult>;

export const GetSourceResult = z.object({
  speech: Speech,
  id: z.string(),
  title: z.string(),
  source: Source,
  sourceSnippet: z.string(),
  confidence: z.number(),
  addedBy: z.string(),
  createdAt: IsoDateTime,
});
export type GetSourceResult = z.infer<typeof GetSourceResult>;

export const ConfirmItemResult = z.object({
  speech: Speech,
  item: ObligationSchema,
});
export type ConfirmItemResult = z.infer<typeof ConfirmItemResult>;

export const INGEST_SKIP_REASONS = ['duplicate', 'snippet_not_found', 'invalid'] as const;

export const IngestResult = z.object({
  speech: Speech,
  kind: z.enum(['text', 'image']),
  source: Source,
  items: z.array(ObligationSchema).describe('Obligations that were added.'),
  needsConfirmation: z
    .array(z.object({ id: z.string(), title: z.string(), question: z.string(), options: z.array(IsoDate).describe('Dates to offer, YYYY-MM-DD.') }))
    .describe('Added items whose date is ambiguous. Ask the question, then call confirm_item with the answer.'),
  skipped: z
    .array(z.object({ title: z.string().nullable(), reason: z.enum(INGEST_SKIP_REASONS), existingId: z.string().nullable() }))
    .describe('Candidates not added: already on the list, not quoted verbatim from the source, or malformed.'),
  transcript: z.string().nullable().describe('For images, the text read from the photo (snippets quote it). Null for text.'),
});
export type IngestResult = z.infer<typeof IngestResult>;

export const ListObligationsResult = z.object({
  items: z.array(ObligationSchema),
});
export type ListObligationsResult = z.infer<typeof ListObligationsResult>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = ['bad_request', 'unauthorized', 'not_found', 'ambiguous', 'internal'] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    candidates: z.array(z.object({ id: z.string(), title: z.string(), dueDate: IsoDateTime })).optional(),
    issues: z.array(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------
// Identity headers (MCP and REST)
// ---------------------------------------------------------------------------

/** Header naming the household. Falls back to the server's DEFAULT_HOUSEHOLD_ID. */
export const HOUSEHOLD_HEADER = 'x-household-id';
/** Header naming the household member making the request (controls private-item visibility). */
export const USER_HEADER = 'x-user-id';
