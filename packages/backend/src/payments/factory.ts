import type { AppConfig } from '../config/index.ts';
import type { RecoveryProvider } from './provider.ts';
import { MockRecoveryProvider } from './providers/mock.ts';

/**
 * Select the configured recovery provider.
 *
 * The API layer never constructs a provider implementation directly; it asks
 * here, so swapping providers changes no call site and no route imports a
 * vendor module.
 *
 * Razorpay is intentionally NOT implemented in this phase. Rather than a stub
 * that silently behaves like the mock, requesting it throws: a deployment
 * configured for Razorpay fails loudly instead of quietly simulating money
 * movement while an operator believes real actions are occurring.
 */
export function createRecoveryProvider(config: AppConfig): RecoveryProvider {
  switch (config.payments.provider) {
    case 'mock':
      return new MockRecoveryProvider();
    case 'razorpay':
      throw new UnimplementedRecoveryProviderError(
        'The Razorpay recovery provider is not implemented yet. Set PAYMENT_PROVIDER=mock ' +
          'to use the deterministic provider.',
      );
  }
}

export class UnimplementedRecoveryProviderError extends Error {
  override name = 'UnimplementedRecoveryProviderError';
}
