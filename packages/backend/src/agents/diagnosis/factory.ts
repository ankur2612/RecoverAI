import type { AppConfig } from '../../config/index.ts';
import type { AIProvider } from './provider.ts';
import { MockAIProvider } from './providers/mock.ts';

/**
 * Select the configured AI provider.
 *
 * Business logic never calls this directly with a hardcoded name — it receives
 * an AIProvider by injection, so swapping providers changes no call site.
 *
 * Claude and OpenAI providers are intentionally NOT implemented in this phase.
 * Rather than shipping a stub that silently behaves like MockAI, an
 * unimplemented provider throws at construction: a misconfigured deployment
 * fails immediately and visibly instead of producing plausible fake diagnoses.
 */
export function createAIProvider(config: AppConfig): AIProvider {
  switch (config.ai.provider) {
    case 'mock':
      return new MockAIProvider();
    case 'claude':
      throw new UnimplementedProviderError(
        'The Claude provider is not implemented yet. Set AI_PROVIDER=mock to use the ' +
          'deterministic provider.',
      );
    case 'openai':
      throw new UnimplementedProviderError(
        'The OpenAI provider is not implemented yet. Set AI_PROVIDER=mock to use the ' +
          'deterministic provider.',
      );
  }
}

export class UnimplementedProviderError extends Error {
  override name = 'UnimplementedProviderError';
}
