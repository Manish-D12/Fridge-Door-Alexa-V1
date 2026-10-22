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

/** A tool the model may call, described by a JSON Schema for its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  /** Provider's call id when it has one, otherwise generated. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque provider data that must be sent back with the call (Gemini thought signatures). */
  signature?: string;
}

export interface ToolOutcome {
  callId: string;
  name: string;
  /** What the tool returned (or its error message), as JSON. */
  content: unknown;
  isError: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolOutcome[] };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * What extraction and the agent need from a model. Implementations must be
 * stateless and never run tools themselves: chat() only reports the calls the
 * model asks for, and the caller decides what to run. Extraction passes no
 * tools at all, so a document can never change anything.
 */
export interface LlmProvider {
  readonly name: string;
  generateText(req: TextRequest): Promise<string>;
  /** Returns the parsed JSON value. Callers validate its shape. */
  generateJson(req: JsonRequest): Promise<unknown>;
  /** One model turn with tools: either text, tool calls, or both. The caller runs the tools. */
  chat(req: ChatRequest): Promise<ChatResponse>;
}
