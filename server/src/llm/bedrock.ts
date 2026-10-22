import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ImageFormat,
  type Message,
  type ToolInputSchema,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { badRequest } from '../lib/errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, JsonRequest, LlmImage, LlmProvider, TextRequest } from './types.js';

/** Converse's JSON document type. */
type Json = NonNullable<ToolUseBlock['input']>;

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Amazon Bedrock via the Converse API (e.g. Claude Haiku). Structured output
 * uses a single forced tool whose input schema is the requested JSON schema.
 * Credentials come from the standard AWS chain.
 */
export class BedrockProvider implements LlmProvider {
  readonly name: string;
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string,
    region: string,
  ) {
    this.client = new BedrockRuntimeClient({ region });
    this.name = `bedrock:${modelId}`;
  }

  async generateText(req: TextRequest): Promise<string> {
    const res = await this.client.send(new ConverseCommand(this.input(req.system, req.prompt, req.image)));
    return (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('');
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    const input: ConverseCommandInput = {
      ...this.input(req.system, req.prompt),
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: req.name,
              description: 'Return the result in this exact shape.',
              inputSchema: { json: req.schema } as ToolInputSchema,
            },
          },
        ],
        toolChoice: { tool: { name: req.name } },
      },
    };
    const res = await this.client.send(new ConverseCommand(input));
    const toolUse = res.output?.message?.content?.find((b) => b.toolUse?.name === req.name)?.toolUse;
    if (!toolUse) throw new Error(`Bedrock returned no ${req.name} tool call (stop reason: ${res.stopReason ?? 'unknown'})`);
    return toolUse.input;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: req.system }],
        messages: req.messages.map(toMessage),
        toolConfig: req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } as ToolInputSchema },
              })),
            }
          : undefined,
        inferenceConfig: { temperature: 0.2, maxTokens: 1024 },
      }),
    );
    const content = res.output?.message?.content ?? [];
    return {
      text: content.map((b) => b.text ?? '').join('').trim(),
      toolCalls: content.flatMap((b) =>
        b.toolUse?.toolUseId && b.toolUse.name
          ? [{ id: b.toolUse.toolUseId, name: b.toolUse.name, arguments: (b.toolUse.input ?? {}) as Record<string, unknown> }]
          : [],
      ),
    };
  }

  private input(system: string, prompt: string, image?: LlmImage): ConverseCommandInput {
    const content: ContentBlock[] = [];
    if (image) {
      const format = IMAGE_FORMATS[image.mimeType];
      if (!format) throw badRequest(`Photos in ${image.mimeType} format aren't supported yet. Please send a JPEG or PNG.`);
      content.push({ image: { format, source: { bytes: image.bytes } } });
    }
    content.push({ text: prompt });
    return {
      modelId: this.modelId,
      system: [{ text: system }],
      messages: [{ role: 'user', content }],
      inferenceConfig: { temperature: 0, maxTokens: 4096 },
    };
  }
}

function toMessage(m: ChatMessage): Message {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: [{ text: m.text }] };
    case 'assistant':
      return {
        role: 'assistant',
        content: [
          ...(m.text ? [{ text: m.text }] : []),
          ...m.toolCalls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as Json } })),
        ],
      };
    case 'tool':
      return {
        role: 'user',
        content: m.results.map((r) => ({
          toolResult: {
            toolUseId: r.callId,
            // Converse wants a JSON object here, not a bare value.
            content: [{ json: { result: r.content } as Json }],
            status: r.isError ? ('error' as const) : ('success' as const),
          },
        })),
      };
  }
}
