import { GoogleGenAI, type Part } from '@google/genai';
import type { JsonRequest, LlmImage, LlmProvider, TextRequest } from './types.js';

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.name = `gemini:${model}`;
  }

  async generateText(req: TextRequest): Promise<string> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: parts(req.prompt, req.image) }],
      config: { systemInstruction: req.system, temperature: 0 },
    });
    return res.text ?? '';
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: parts(req.prompt) }],
      config: {
        systemInstruction: req.system,
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: req.schema,
      },
    });
    const text = res.text;
    if (!text) throw new Error(`Gemini returned no content (finish reason: ${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
    return JSON.parse(text);
  }
}

function parts(prompt: string, image?: LlmImage): Part[] {
  const out: Part[] = [];
  if (image) out.push({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } });
  out.push({ text: prompt });
  return out;
}
