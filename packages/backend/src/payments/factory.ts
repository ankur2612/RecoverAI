import type { AppConfig } from '../config/index.ts';
import type { RecoveryProvider } from './provider.ts';
import { MockRecoveryProvider } from './providers/mock.ts';
import { RazorpayTestProvider } from './providers/razorpay.ts';

/**
 * Select the configured recovery provider.
 *
 * The API layer never constructs a provider implementation directly; it asks
 * here, so swapping providers changes no call site and no route imports a
 * vendor module.
 *
 * Razorpay runs in TEST MODE ONLY. A missing or non-test credential throws
 * rather than falling back to the mock: a deployment configured for Razorpay
 * must fail loudly instead of quietly simulating money movement while an
 * operator believes real actions are occurring.
 */
export function createRecoveryProvider(config: AppConfig): RecoveryProvider {
  switch (config.payments.provider) {
    case 'mock':
      return new MockRecoveryProvider();
    case 'razorpay': {
      // loadConfig already enforces both credentials and the test-mode prefix;
      // this guard covers a config object built by hand. The provider's own
      // constructor checks the key format a third time.
      const { razorpayKeyId, razorpayKeySecret } = config.payments;
      if (razorpayKeyId === undefined || razorpayKeySecret === undefined) {
        throw new UnimplementedRecoveryProviderError(
          'PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. ' +
            'RecoverAI will not fall back to the mock provider.',
        );
      }
      return new RazorpayTestProvider({
        keyId: razorpayKeyId,
        keySecret: razorpayKeySecret,
      });
    }
  }
}

export class UnimplementedRecoveryProviderError extends Error {
  override name = 'UnimplementedRecoveryProviderError';
}
