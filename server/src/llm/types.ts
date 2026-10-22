import type { ImageMimeType } from '@fridge-door/shared';

export interface LlmImage {
  /** Raw bytes; providers encode them as they need. */
  bytes: Buffer;
  mimeType: ImageMimeType;
}

/** A plain JSON Schema object (the subset both Gemini and Bedrock tool schemas accept). */
export type JsonSchema = Record<string, unknown>;

export interface TextRequest {
  system: string;
  prompt: string;
  image?: LlmImage;
}

export interface JsonRequest {
  system: string;
  prompt: string;
  /** Short identifier for the output, used as the Bedrock tool name. */
  name: string;
  schema: JsonSchema;
}

/**
 * The only two things extraction needs from a model. Implementations must be
 * stateless and must not expose tools that act on household data: the model
 * can only return text or JSON, never change anything.
 */
export interface LlmProvider {
  readonly name: string;
  generateText(req: TextRequest): Promise<string>;
  /** Returns the parsed JSON value. Callers validate its shape. */
  generateJson(req: JsonRequest): Promise<unknown>;
}
