import { type Content, GoogleGenAI, type Part } from '@google/genai';
import type { ChatMessage, ChatRequest, ChatResponse, JsonRequest, LlmImage, LlmProvider, TextRequest, ToolCall } from './types.js';

/** Called when a model is out of quota or overloaded and the next one is tried. */
export type FallbackListener = (info: { from: string; to: string; reason: string }) => void;

/** One model request; a fallback model gets its own. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * 2.5 Flash models think before answering by default, which costs seconds a
 * voice turn can't spare. Pro models can't turn it off, so only flash gets it.
 */
const quick = (model: string) => (/flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {});

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  /** The primary model first, then the fallbacks in order, without repeats. */
  readonly models: string[];
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    model: string,
    fallbackModels: string[] = [],
    private readonly onFallback?: FallbackListener,
  ) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
    this.models = [...new Set([model, ...fallbackModels])];
    this.name = `gemini:${this.models.join('>')}`;
  }

  async generateText(req: TextRequest): Promise<string> {
    const res = await withModelFallback(this.models, (model) =>
      this.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: parts(req.prompt, req.image) }],
        config: { systemInstruction: req.system, temperature: 0, ...quick(model) },
      }),
      this.onFallback,
    );
    return res.text ?? '';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const res = await withModelFallback(this.models, (model) =>
      this.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: parts(req.prompt) }],
        config: {
          systemInstruction: req.system,
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: req.schema,
        },
      }),
      this.onFallback,
    );
    const text = res.text;
    if (!text) throw new Error(`Gemini returned no content (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
    return JSON.parse(text);
  }

  /** Function calling with plain declarations: Gemini returns the calls and we run them. */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await withModelFallback(this.models, (model) =>
      this.client.models.generateContent({
        model,
        contents: req.messages.map(toContent),
        config: {
          systemInstruction: req.system,
          temperature: 0.2,
          ...quick(model),
          tools: req.tools.length
            ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
            : undefined,
        },
      }),
      this.onFallback,
    );
    const replyParts = res.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: ToolCall[] = replyParts.flatMap((p, i) =>
      p.functionCall?.name
        ? [{ id: p.functionCall.id ?? `call-${i}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {}, signature: p.thoughtSignature }]
        : [],
    );
    const text = replyParts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    return { text, toolCalls };
  }
}

function toContent(m: ChatMessage): Content {
  switch (m.role) {
    case 'user':
      return { role: 'user', parts: [{ text: m.text }] };
    case 'assistant':
      return {
        role: 'model',
        parts: [
          ...(m.text ? [{ text: m.text }] : []),
          ...m.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.arguments }, thoughtSignature: c.signature })),
        ],
      };
    case 'tool':
      return {
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { id: r.callId, name: r.name, response: r.isError ? { error: r.content } : { output: r.content } },
        })),
      };
  }
}

/**
 * Calls each model once, in order, moving on only when one answers with a
 * 429 / RESOURCE_EXHAUSTED (free-tier quotas are per model) or 503 / UNAVAILABLE
 * (that model is overloaded). A fallback model that no longer exists (404) is
 * skipped too, since Google retires models. Any other error, or one of those
 * from the last model, is thrown as-is.
 */
export async function withModelFallback<T>(models: string[], call: (model: string) => Promise<T>, onFallback?: FallbackListener): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call(models[i]!);
    } catch (err) {
      const next = models[i + 1];
      const retired = i > 0 && isNotFound(err);
      if (!next || !(isCapacityError(err) || retired)) throw err;
      onFallback?.({ from: models[i]!, to: next, reason: retired ? 'model not available' : capacityReason(err) });
    }
  }
}

/** Errors about one model's capacity, which the next model may not share. */
export function isCapacityError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 429 || status === 503 || /RESOURCE_EXHAUSTED|UNAVAILABLE|\b(429|503)\b/.test((err as Error)?.message ?? '');
}

/** The primary model is never treated this way: a 404 there is a configuration mistake to surface. */
function isNotFound(err: unknown): boolean {
  return (err as { status?: unknown })?.status === 404 || /NOT_FOUND/.test((err as Error)?.message ?? '');
}

/** "quota exceeded; retry in 61200s" or "model overloaded", for logs. */
function capacityReason(err: unknown): string {
  const message = (err as Error)?.message ?? '';
  if ((err as { status?: unknown })?.status === 503 || /UNAVAILABLE/.test(message)) return 'model overloaded';
  const delay = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1];
  return delay ? `quota exceeded; retry in ${Math.round(Number(delay))}s` : 'quota exceeded';
}

function parts(prompt: string, image?: LlmImage): Part[] {
  const out: Part[] = [];
  if (image) out.push({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } });
  out.push({ text: prompt });
  return out;
}
