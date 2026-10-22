import type { Config } from '../config.js';
import { BedrockProvider } from './bedrock.js';
import { type FallbackListener, GeminiProvider } from './gemini.js';
import type { LlmProvider } from './types.js';

export type { LlmProvider } from './types.js';
export type { FallbackListener } from './gemini.js';

export interface ProviderOptions {
  /** Told when Gemini falls back to the next model after a quota error. */
  onFallback?: FallbackListener;
}

/**
 * Builds the provider named by LLM_PROVIDER. Throws if it is missing required
 * settings; the server catches that and runs with extraction disabled.
 */
export function createLlmProvider(
  config: Pick<Config, 'LLM_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'GEMINI_FALLBACK_MODELS' | 'BEDROCK_MODEL_ID' | 'AWS_REGION'>,
  options: ProviderOptions = {},
): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'gemini':
      if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
      return new GeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, config.GEMINI_FALLBACK_MODELS, options.onFallback);
    case 'bedrock':
      if (!config.BEDROCK_MODEL_ID) throw new Error('BEDROCK_MODEL_ID is not set');
      return new BedrockProvider(config.BEDROCK_MODEL_ID, config.AWS_REGION);
  }
}
