import type { Config } from '../config.js';
import { BedrockProvider } from './bedrock.js';
import { GeminiProvider } from './gemini.js';
import type { LlmProvider } from './types.js';

export type { LlmProvider } from './types.js';

/**
 * Builds the provider named by LLM_PROVIDER. Throws if it is missing required
 * settings; the server catches that and runs with extraction disabled.
 */
export function createLlmProvider(
  config: Pick<Config, 'LLM_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'BEDROCK_MODEL_ID' | 'AWS_REGION'>,
): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'gemini':
      if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
      return new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL);
    case 'bedrock':
      if (!config.BEDROCK_MODEL_ID) throw new Error('BEDROCK_MODEL_ID is not set');
      return new BedrockProvider(config.BEDROCK_MODEL_ID, config.AWS_REGION);
  }
}
