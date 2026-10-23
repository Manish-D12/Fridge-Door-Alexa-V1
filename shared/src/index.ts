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

/** Everything except "done" is still open: it shows in whats_due and can be marked done. */
export const STATUSES = ['pending', 'awaiting_reply', 'renewal_in_progress', 'done'] as const;
export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const FOLLOWUP_INTENTS = ['reschedule', 'cancel', 'request_extension', 'confirm', 'ask_question'] as const;
export const FollowupIntent = z.enum(FOLLOWUP_INTENTS);
export type FollowupIntent = z.infer<typeof FollowupIntent>;

export const LINK_KINDS = ['renewal', 'payment', 'manage'] as const;
export const LinkKind = z.enum(LINK_KINDS);
export type LinkKind = z.infer<typeof LinkKind>;

export const ACTION_TYPES = ['email_sent', 'reply_received', 'renewal_started'] as const;
export const ActionType = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionType>;

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

/** The Gmail message an obligation was read from: what a reply needs. */
export const EmailRef = z.object({
  gmailMessageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  /** The original's RFC 5322 Message-ID, for In-Reply-To and References. */
  messageIdHeader: z.string().max(1000).nullable(),
  references: z.string().max(4000).nullable(),
  /** Replies only ever go here. */
  fromAddress: z.email(),
  fromName: z.string().max(200).nullable(),
  subject: z.string().max(500),
  /** Seed data, not a real message: replies go to the local demo outbox instead of Gmail. */
  demo: z.boolean().default(false),
});
export type EmailRef = z.infer<typeof EmailRef>;

/** A renewal, payment or account link found in the source email (https, on the sender's or a known biller's domain). */
export const ActionLink = z.object({
  url: z.string().max(2000).regex(/^https:\/\/\S+$/),
  kind: LinkKind,
  /** The link text, or the host when there was none. */
  label: z.string().max(200),
});
export type ActionLink = z.infer<typeof ActionLink>;

/** Something done about an obligation, newest last. */
export const ObligationAction = z.object({
  type: ActionType,
  intent: FollowupIntent.nullable(),
  at: IsoDateTime,
  /** Household member, or the sender for reply_received. */
  by: z.string().min(1).max(200),
  /** Past tense, readable after a name: "asked to move it to Thursday". */
  summary: z.string().min(1).max(300),
  /** Recipient of email_sent. */
  to: z.string().max(320).nullable(),
});
export type ObligationAction = z.infer<typeof ObligationAction>;

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
  /** Set for items read from Gmail; follow-up emails reply to it. */
  email: EmailRef.nullable().default(null),
  links: z.array(ActionLink).max(5).default([]),
  actions: z.array(ObligationAction).max(50).default([]),
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

/** Which item, when several share a title: what the person said about the existing item, not the change they want. */
const ItemHints = {
  when: z
    .string()
    .trim()
    .max(50)
    .optional()
    .describe('The day or date of the EXISTING item if the person mentioned it, e.g. "Tuesday" in "I can’t make the dentist on Tuesday". Not the new time they want.'),
  from: z.string().trim().max(100).optional().describe('Who the item came from, if the person said, e.g. "Bright Smiles" or "the email".'),
};

export const DraftFollowupInput = z.object({
  idOrTitle: z.string().trim().min(1).describe('The obligation id, or words from its title such as "dentist".'),
  ...ItemHints,
  intent: FollowupIntent.describe(
    'What the email asks for: "reschedule", "cancel", "request_extension" (more time to pay or submit), "confirm" (yes, we will be there), or "ask_question".',
  ),
  details: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe('The person\'s own words about what they want, e.g. "move it to Thursday afternoon" or "ask if they take card". Omit if they said nothing more.'),
});
export type DraftFollowupInput = z.infer<typeof DraftFollowupInput>;

export const SendFollowupInput = z.object({
  draftId: z.string().trim().min(1).describe('The draft id from draft_followup.'),
  confirmedBy: PersonName.describe('The household member who said to send it. Must be the person who asked for the draft.'),
});
export type SendFollowupInput = z.infer<typeof SendFollowupInput>;

export const DiscardDraftInput = z.object({
  draftId: z.string().trim().min(1).describe('The draft id from draft_followup.'),
});
export type DiscardDraftInput = z.infer<typeof DiscardDraftInput>;

export const UpdateDraftInput = z.object({
  draftId: z.string().trim().min(1).describe('The draft id from draft_followup.'),
  body: z.string().trim().min(1).max(4000).describe('The edited email body.'),
});
export type UpdateDraftInput = z.infer<typeof UpdateDraftInput>;

export const StartRenewalInput = z.object({
  idOrTitle: z.string().trim().min(1).describe('The obligation id, or words from its title such as "car insurance".'),
  ...ItemHints,
});
export type StartRenewalInput = z.infer<typeof StartRenewalInput>;

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
  status: Status,
  /** What has been done about it so far, oldest first. */
  actions: z.array(ObligationAction),
});
export type GetSourceResult = z.infer<typeof GetSourceResult>;

export const FollowupDraft = z.object({
  id: z.string(),
  obligationId: z.string(),
  intent: FollowupIntent,
  /** Always the sender of the obligation's source email. */
  to: z.string(),
  toName: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  /** What the email asks for, e.g. "move Maya's cleaning to Thursday". */
  gist: z.string(),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  /** After this the draft can't be sent; ask for a new one. */
  expiresAt: IsoDateTime,
  /** Seed data: sending saves to the demo outbox instead of Gmail. */
  demo: z.boolean(),
  sentAt: IsoDateTime.nullable(),
});
export type FollowupDraft = z.infer<typeof FollowupDraft>;

export const DraftFollowupResult = z.object({
  speech: Speech,
  draft: FollowupDraft.nullable().describe('Null when there is nobody to email; speech says why and what to do instead.'),
  item: ObligationSchema,
  reason: z.enum(['no_sender', 'no_reply_address']).nullable(),
});
export type DraftFollowupResult = z.infer<typeof DraftFollowupResult>;

export const SendFollowupResult = z.object({
  speech: Speech,
  draft: FollowupDraft,
  item: ObligationSchema,
  delivery: z.enum(['gmail', 'demo_outbox']),
});
export type SendFollowupResult = z.infer<typeof SendFollowupResult>;

export const DiscardDraftResult = z.object({
  speech: Speech,
  draftId: z.string(),
});
export type DiscardDraftResult = z.infer<typeof DiscardDraftResult>;

export const UpdateDraftResult = z.object({
  speech: Speech,
  draft: FollowupDraft,
  item: ObligationSchema,
});
export type UpdateDraftResult = z.infer<typeof UpdateDraftResult>;

export const StartRenewalResult = z.object({
  speech: Speech,
  item: ObligationSchema,
  link: ActionLink.nullable().describe('Null when the source email had no renewal or account link.'),
});
export type StartRenewalResult = z.infer<typeof StartRenewalResult>;

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

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export const SyncInboxInput = z.object({});
export type SyncInboxInput = z.infer<typeof SyncInboxInput>;

/** An ingest result over every email read in one sync, plus what happened to the rest. */
export const SyncInboxResult = IngestResult.extend({
  account: z.string().nullable().describe('The connected Gmail address.'),
  emails: z.object({
    matched: z.number().int().describe('Recent emails matching the search.'),
    alreadyRead: z.number().int().describe('Skipped: read by an earlier sync.'),
    notRelevant: z.number().int().describe('Skipped by the keyword check, without calling the model.'),
    read: z.number().int().describe('Sent to extraction this time.'),
    failed: z.number().int().describe('Relevant, but the model could not read them now (quota or overload). Kept unread; the next sync retries them.'),
    remaining: z.number().int().describe('Not looked at yet: over the per-sync limit. The next sync reads them.'),
  }),
  replies: z
    .array(z.object({ id: z.string(), title: z.string(), from: z.string() }))
    .describe('Items awaiting a reply whose thread now has one.'),
});
export type SyncInboxResult = z.infer<typeof SyncInboxResult>;

export const GmailStatus = z.object({
  /** Google OAuth client settings are present on the server. */
  configured: z.boolean(),
  connected: z.boolean(),
  /** The stored grant includes gmail.send; without it, reconnect to enable replies. */
  canSend: z.boolean(),
  account: z.string().nullable(),
  connectedAt: IsoDateTime.nullable(),
  lastSyncAt: IsoDateTime.nullable(),
});
export type GmailStatus = z.infer<typeof GmailStatus>;

export const ListObligationsResult = z.object({
  items: z.array(ObligationSchema),
});
export type ListObligationsResult = z.infer<typeof ListObligationsResult>;

// ---------------------------------------------------------------------------
// Agent (the "Alexa+" simulator brain behind POST /agent/*)
// ---------------------------------------------------------------------------

export const AgentChatInput = z.object({
  message: z.string().trim().min(1).max(2000),
  /** From a previous reply, to continue the conversation. A new one is started if unknown or expired. */
  sessionId: z.string().max(100).optional(),
});
export type AgentChatInput = z.infer<typeof AgentChatInput>;

const SessionId = z.string().max(100).optional();

/** Screen actions that call MCP tools directly, without the model choosing. */
export const AgentActionInput = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('ingest_image'), arguments: IngestImageInput, sessionId: SessionId }),
  z.object({ tool: z.literal('confirm_item'), arguments: ConfirmItemInput, sessionId: SessionId }),
  /** The Send button. With `body`, the edited text is saved to the draft first, then exactly that is sent. */
  z.object({
    tool: z.literal('send_followup'),
    arguments: SendFollowupInput.extend({ body: UpdateDraftInput.shape.body.optional() }),
    sessionId: SessionId,
  }),
  z.object({ tool: z.literal('discard_draft'), arguments: DiscardDraftInput, sessionId: SessionId }),
  /** "Mark renewed" and similar buttons. */
  z.object({ tool: z.literal('mark_done'), arguments: MarkDoneInput, sessionId: SessionId }),
]);
export type AgentActionInput = z.infer<typeof AgentActionInput>;

const Candidate = z.object({
  id: z.string(),
  title: z.string(),
  dueDate: IsoDateTime,
  /** What tells it apart: "for Maya", "from Bright Smiles". */
  detail: z.string().optional(),
});

/** Structured data for the screen, built from the last tool result of a turn. */
export const AgentCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('due'), result: WhatsDueResult }),
  z.object({ kind: z.literal('item'), heading: z.string(), item: ObligationSchema }),
  z.object({ kind: z.literal('source'), result: GetSourceResult, item: ObligationSchema.nullable() }),
  z.object({ kind: z.literal('ingest'), result: IngestResult }),
  z.object({ kind: z.literal('choices'), heading: z.string(), candidates: z.array(Candidate) }),
  z.object({ kind: z.literal('draft'), draft: FollowupDraft, item: ObligationSchema }),
  z.object({ kind: z.literal('sent'), draft: FollowupDraft, item: ObligationSchema, delivery: SendFollowupResult.shape.delivery }),
  z.object({ kind: z.literal('renewal'), item: ObligationSchema, link: ActionLink }),
]);
export type AgentCard = z.infer<typeof AgentCard>;

export const AgentReply = z.object({
  speech: Speech,
  card: AgentCard.nullable(),
  sessionId: z.string(),
  /** The MCP tools called this turn, in order. */
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()), isError: z.boolean() })),
});
export type AgentReply = z.infer<typeof AgentReply>;

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
    candidates: z.array(z.object({ id: z.string(), title: z.string(), dueDate: IsoDateTime, detail: z.string().optional() })).optional(),
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
export const MEMBER_HEADER = 'x-household-member';
/** Older name for MEMBER_HEADER, still accepted. */
export const USER_HEADER = 'x-user-id';
