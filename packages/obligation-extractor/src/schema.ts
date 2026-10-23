import { z } from 'zod';

export const OBLIGATION_TYPES = ['bill', 'order', 'booking', 'appointment', 'deadline', 'renewal'] as const;
export type ObligationType = (typeof OBLIGATION_TYPES)[number];

/** A plain JSON Schema object. */
export type JsonSchema = Record<string, unknown>;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

/**
 * What to ask the model for (structured output / JSON mode). Kept to the JSON
 * Schema subset that Gemini `responseJsonSchema` and Bedrock/Anthropic tool
 * input schemas both accept.
 */
export const RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceSnippet: { type: 'string', description: 'Verbatim passage from the document containing the action and its date.' },
          type: { type: 'string', enum: [...OBLIGATION_TYPES] },
          title: { type: 'string', description: 'Short spoken-friendly title, 2 to 6 words.' },
          dueDate: { type: 'string', description: 'YYYY-MM-DD in household local time.' },
          dueTime: { ...nullableString, description: '24-hour HH:MM local time if the document states one, else null.' },
          amount: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Amount owed as stated, else null.' },
          currency: { ...nullableString, description: 'ISO 4217 code if an amount is given, else null.' },
          forWhom: { ...nullableString, description: 'First name of the household member it is for, else null.' },
          confidence: { type: 'number', description: '0 to 1.' },
          needsConfirmation: { type: 'boolean' },
          alternativeDueDate: { ...nullableString, description: 'The other reading of an ambiguous date, YYYY-MM-DD, else null.' },
          confirmationQuestion: { ...nullableString, description: 'Question naming both readings, else null.' },
        },
        required: [
          'sourceSnippet', 'type', 'title', 'dueDate', 'dueTime', 'amount', 'currency', 'forWhom',
          'confidence', 'needsConfirmation', 'alternativeDueDate', 'confirmationQuestion',
        ],
      },
    },
  },
  required: ['items'],
};

const IsoDate = z.iso.date();

/** One item as the model returns it, before any checks. Models often send "" for null; that is handled before parsing. */
export const ModelItem = z.object({
  sourceSnippet: z.string().min(1),
  type: z.enum(OBLIGATION_TYPES),
  title: z.string().trim().min(1).max(200),
  dueDate: IsoDate,
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  amount: z.number().nonnegative().nullish(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).nullish(),
  forWhom: z.string().trim().min(1).max(100).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  needsConfirmation: z.boolean().nullish(),
  alternativeDueDate: IsoDate.nullish(),
  confirmationQuestion: z.string().trim().min(1).max(500).nullish(),
});
export type ModelItem = z.infer<typeof ModelItem>;

/** A verified obligation: every field has passed the checks in verify.ts. */
export interface Obligation {
  type: ObligationType;
  title: string;
  /** "2026-11-03" (due by the end of that local day) or an ISO instant when a time was stated. */
  dueDate: string;
  amount: number | null;
  /** Upper-case ISO 4217 code, only when there is an amount. */
  currency: string | null;
  forWhom: string | null;
  /** An exact substring of the document. */
  sourceSnippet: string;
  confidence: number;
  needsConfirmation: boolean;
  confirmationQuestion: string | null;
  /** The dates to offer the person (YYYY-MM-DD), earliest first. Empty unless needsConfirmation. */
  confirmationOptions: string[];
}

export type RejectReason = 'invalid' | 'snippet_not_found' | 'instruction_text';

export interface Rejected {
  title: string | null;
  reason: RejectReason;
}
