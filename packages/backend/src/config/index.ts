/**
 * Central configuration, loaded from environment variables.
 *
 * Two rules this module enforces (PRD sections 10, 12, 30):
 *   1. All business policy values are configurable here, never hardcoded into
 *      an LLM prompt.
 *   2. Secrets are read server-side only and are never serialised into logs,
 *      API responses, or AI prompts. Use `redactedConfig()` for anything that
 *      leaves the process.
 */

export type AiProviderName = 'mock' | 'claude' | 'openai';
export type PaymentProviderName = 'mock' | 'razorpay';

export interface PolicyConfig {
  /** Hard ceiling on automated retry attempts per payment. */
  maxRetryAttempts: number;
  /** Above this amount (minor units) automation is not permitted. */
  maxAutomatedAmount: number;
  /** AI confidence below this is never auto-executed. */
  minRecoveryConfidence: number;
  /** Minimum seconds between successive retries of the same payment. */
  retryCooldownSeconds: number;
  /** At or above this amount (minor units) a human must approve. */
  highValueThreshold: number;
  /** Checkout recovery is only valid within this many hours of creation. */
  recoveryWindowHours: number;
  /** Cap on reminder messages sent for one payment. */
  maxRemindersPerPayment: number;
}

export interface DatasetConfig {
  seed: number;
  recordCount: number;
  /** Fraction of records reserved for the held-out evaluation split. */
  evalSplit: number;
  avgTransactionValue: number;
  customerRepeatRate: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  ai: {
    provider: AiProviderName;
    anthropicApiKey: string | undefined;
    claudeModel: string;
    openaiApiKey: string | undefined;
    openaiModel: string | undefined;
  };
  payments: {
    provider: PaymentProviderName;
    razorpayKeyId: string | undefined;
    razorpayKeySecret: string | undefined;
  };
  policy: PolicyConfig;
  dataset: DatasetConfig;
  demo: {
    /** Probability the mock provider returns an unconfirmed timeout. */
    apiTimeoutRate: number;
  };
}

class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function readOptional(env: Env, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer, received "${raw}"`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received ${value}`);
  }
  return value;
}

function readFloat(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} must be a number, received "${raw}"`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received ${value}`);
  }
  return value;
}

function readEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(' | ')}, received "${raw}"`);
  }
  return raw as T;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const aiProvider = readEnum(env, 'AI_PROVIDER', ['mock', 'claude', 'openai'] as const, 'mock');
  const paymentProvider = readEnum(env, 'PAYMENT_PROVIDER', ['mock', 'razorpay'] as const, 'mock');

  const anthropicApiKey = readOptional(env, 'ANTHROPIC_API_KEY');
  const openaiApiKey = readOptional(env, 'OPENAI_API_KEY');
  const razorpayKeyId = readOptional(env, 'RAZORPAY_KEY_ID');
  const razorpayKeySecret = readOptional(env, 'RAZORPAY_KEY_SECRET');

  // Fail fast rather than discovering a missing key mid-batch.
  if (aiProvider === 'claude' && anthropicApiKey === undefined) {
    throw new ConfigError('AI_PROVIDER=claude requires ANTHROPIC_API_KEY to be set');
  }
  if (aiProvider === 'openai' && openaiApiKey === undefined) {
    throw new ConfigError('AI_PROVIDER=openai requires OPENAI_API_KEY to be set');
  }
  if (paymentProvider === 'razorpay' && (!razorpayKeyId || !razorpayKeySecret)) {
    throw new ConfigError(
      'PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test mode)',
    );
  }
  // Guard against a live key reaching a system that moves money.
  if (razorpayKeyId !== undefined && !razorpayKeyId.startsWith('rzp_test_')) {
    throw new ConfigError(
      'RAZORPAY_KEY_ID must be a Test Mode key (expected prefix "rzp_test_"). ' +
        'RecoverAI refuses to start with live credentials.',
    );
  }

  const policy: PolicyConfig = {
    maxRetryAttempts: readInt(env, 'POLICY_MAX_RETRY_ATTEMPTS', 3, 0, 10),
    maxAutomatedAmount: readInt(env, 'POLICY_MAX_AUTOMATED_AMOUNT', 1_000_000, 0, 1_000_000_000),
    minRecoveryConfidence: readFloat(env, 'POLICY_MIN_RECOVERY_CONFIDENCE', 0.75, 0, 1),
    retryCooldownSeconds: readInt(env, 'POLICY_RETRY_COOLDOWN_SECONDS', 3600, 0, 86_400 * 30),
    highValueThreshold: readInt(env, 'POLICY_HIGH_VALUE_THRESHOLD', 1_000_000, 0, 1_000_000_000),
    recoveryWindowHours: readInt(env, 'POLICY_RECOVERY_WINDOW_HOURS', 72, 1, 24 * 90),
    maxRemindersPerPayment: readInt(env, 'POLICY_MAX_REMINDERS_PER_PAYMENT', 2, 0, 10),
  };

  const dataset: DatasetConfig = {
    seed: readInt(env, 'DATASET_SEED', 42, 0, 2_147_483_647),
    recordCount: readInt(env, 'DATASET_RECORD_COUNT', 1000, 1, 1_000_000),
    evalSplit: readFloat(env, 'DATASET_EVAL_SPLIT', 0.3, 0.05, 0.9),
    avgTransactionValue: readInt(env, 'DATASET_AVG_TRANSACTION_VALUE', 250_000, 100, 100_000_000),
    customerRepeatRate: readFloat(env, 'DATASET_CUSTOMER_REPEAT_RATE', 0.45, 0, 0.95),
  };

  return {
    nodeEnv: readString(env, 'NODE_ENV', 'development'),
    port: readInt(env, 'PORT', 8080, 1, 65_535),
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    databaseUrl: readString(
      env,
      'DATABASE_URL',
      'postgres://recoverai:recoverai@localhost:5432/recoverai',
    ),
    ai: {
      provider: aiProvider,
      anthropicApiKey,
      claudeModel: readString(env, 'CLAUDE_MODEL', 'claude-sonnet-5'),
      openaiApiKey,
      openaiModel: readOptional(env, 'OPENAI_MODEL'),
    },
    payments: {
      provider: paymentProvider,
      razorpayKeyId,
      razorpayKeySecret,
    },
    policy,
    dataset,
    demo: {
      apiTimeoutRate: readFloat(env, 'DEMO_API_TIMEOUT_RATE', 0.05, 0, 1),
    },
  };
}

/**
 * Config safe to log or return over HTTP. Secrets are reduced to a presence
 * flag so operators can debug configuration without exposing key material.
 */
export function redactedConfig(config: AppConfig) {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    logLevel: config.logLevel,
    databaseConfigured: config.databaseUrl.length > 0,
    ai: {
      provider: config.ai.provider,
      model: config.ai.provider === 'claude' ? config.ai.claudeModel : config.ai.openaiModel,
      credentialPresent:
        config.ai.provider === 'mock' ||
        (config.ai.provider === 'claude' && config.ai.anthropicApiKey !== undefined) ||
        (config.ai.provider === 'openai' && config.ai.openaiApiKey !== undefined),
    },
    payments: {
      provider: config.payments.provider,
      credentialPresent:
        config.payments.provider === 'mock' || config.payments.razorpayKeyId !== undefined,
      mode: 'test' as const,
    },
    policy: config.policy,
    dataset: config.dataset,
  };
}

export { ConfigError };
