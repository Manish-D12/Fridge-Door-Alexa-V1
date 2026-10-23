import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, type PromptOptions } from './prompt.js';
import { RESPONSE_SCHEMA, type JsonSchema } from './schema.js';
import { verifyExtraction, type Verified } from './verify.js';

export * from './dates.js';
export * from './guard.js';
export * from './prompt.js';
export * from './schema.js';
export * from './verify.js';

/** Your model call: structured JSON output for a system prompt, a user prompt and a JSON Schema. */
export type GenerateJson = (request: { system: string; prompt: string; schema: JsonSchema }) => Promise<unknown>;

export interface ExtractOptions extends PromptOptions {
  generateJson: GenerateJson;
  maxItems?: number;
}

/**
 * Prompt, call, verify: the whole pipeline for one document. The model is
 * whatever `generateJson` calls (Gemini, Claude, OpenAI, a local model).
 *
 *   const { items, rejected } = await extractObligations(emailText, {
 *     timeZone: 'America/Los_Angeles',
 *     sourceDescription: 'an email',
 *     generateJson: ({ system, prompt, schema }) => callYourModel(system, prompt, schema),
 *   });
 */
export async function extractObligations(document: string, opts: ExtractOptions): Promise<Verified> {
  const answer = await opts.generateJson({
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: buildExtractionPrompt(document, opts),
    schema: RESPONSE_SCHEMA,
  });
  return verifyExtraction(answer, document, { timeZone: opts.timeZone, maxItems: opts.maxItems });
}
