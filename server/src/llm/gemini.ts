import { GoogleGenAI, type Part } from '@google/genai';
import type { JsonRequest, LlmImage, LlmProvider, TextRequest } from './types.js';

/** Called when a model is out of quota and the next one is tried. */
export type FallbackListener = (info: { from: string; to: string; reason: string }) => void;

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
    this.client = new GoogleGenAI({ apiKey });
    this.models = [...new Set([model, ...fallbackModels])];
    this.name = `gemini:${this.models.join('>')}`;
  }

  async generateText(req: TextRequest): Promise<string> {
    const res = await withModelFallback(this.models, (model) =>
      this.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: parts(req.prompt, req.image) }],
        config: { systemInstruction: req.system, temperature: 0 },
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
}

/**
 * Calls each model once, in order, moving on only when one answers with a
 * 429 / RESOURCE_EXHAUSTED (free-tier quotas are per model). Any other error,
 * or a quota error from the last model, is thrown as-is.
 */
export async function withModelFallback<T>(models: string[], call: (model: string) => Promise<T>, onFallback?: FallbackListener): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call(models[i]!);
    } catch (err) {
      const next = models[i + 1];
      if (!next || !isQuotaError(err)) throw err;
      onFallback?.({ from: models[i]!, to: next, reason: quotaReason(err) });
    }
  }
}

export function isQuotaError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 429 || /RESOURCE_EXHAUSTED|\b429\b/.test((err as Error)?.message ?? '');
}

/** "quota exceeded, retry in 17h" style detail for logs, from the error body when present. */
function quotaReason(err: unknown): string {
  const message = (err as Error)?.message ?? '';
  const delay = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1];
  return delay ? `quota exceeded; retry in ${Math.round(Number(delay))}s` : 'quota exceeded';
}

function parts(prompt: string, image?: LlmImage): Part[] {
  const out: Part[] = [];
  if (image) out.push({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } });
  out.push({ text: prompt });
  return out;
}
