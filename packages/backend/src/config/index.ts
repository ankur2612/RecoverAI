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

import { DEFAULT_GEMINI_MODEL } from '../agents/diagnosis/providers/gemini.ts';

/**
 * Shortest token accepted when authentication is enabled. Not a strength
 * guarantee — just a floor that rejects obviously trivial values like "x".
 */
export const MIN_AUTH_TOKEN_LENGTH = 16;

export type AiProviderName = 'mock' | 'claude' | 'openai' | 'gemini';
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

/**
 * HTTP authentication settings.
 *
 * This is AUTHENTICATION only — "who may call this API". It is NOT
 * authorization: whether a specific recovery action is permitted remains the
 * exclusive job of the deterministic policy engine. A valid token buys access
 * to the endpoint, never permission to move money.
 */
export interface AuthConfig {
  /** When false, the API is open — development and test posture only. */
  enabled: boolean;
  /**
   * The shared secret. Present only when `enabled` is true; `loadConfig`
   * refuses to produce an enabled-but-tokenless configuration, so an enabled
   * deployment can never accidentally accept every caller.
   */
  token: string | undefined;
}

/**
 * HTTP rate limiting.
 *
 * Bounds how many requests one client may make per window. This is a brute
 * force guard, not authorization: it can only refuse, never permit.
 */
export interface RateLimitConfig {
  enabled: boolean;
  /** Maximum requests per window, per client IP. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
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
    geminiApiKey: string | undefined;
    geminiModel: string;
  };
  payments: {
    provider: PaymentProviderName;
    razorpayKeyId: string | undefined;
    razorpayKeySecret: string | undefined;
  };
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
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

/**
 * Strict boolean reader.
 *
 * Accepts only the unambiguous spellings. A typo like AUTH_ENABLED=yes must
 * not silently read as false and quietly disable authentication — it throws.
 */
function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  throw new ConfigError(`${key} must be one of true | false | 1 | 0, received "${raw}"`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const aiProvider = readEnum(
    env,
    'AI_PROVIDER',
    ['mock', 'claude', 'openai', 'gemini'] as const,
    'mock',
  );
  const paymentProvider = readEnum(env, 'PAYMENT_PROVIDER', ['mock', 'razorpay'] as const, 'mock');

  const anthropicApiKey = readOptional(env, 'ANTHROPIC_API_KEY');
  const openaiApiKey = readOptional(env, 'OPENAI_API_KEY');
  const geminiApiKey = readOptional(env, 'GEMINI_API_KEY');
  const razorpayKeyId = readOptional(env, 'RAZORPAY_KEY_ID');
  const razorpayKeySecret = readOptional(env, 'RAZORPAY_KEY_SECRET');

  // Fail fast rather than discovering a missing key mid-batch.
  if (aiProvider === 'claude' && anthropicApiKey === undefined) {
    throw new ConfigError('AI_PROVIDER=claude requires ANTHROPIC_API_KEY to be set');
  }
  if (aiProvider === 'openai' && openaiApiKey === undefined) {
    throw new ConfigError('AI_PROVIDER=openai requires OPENAI_API_KEY to be set');
  }
  // Fail loudly rather than silently serving MockAI. A deployment must never
  // appear to be using a real model while returning deterministic stubs.
  if (aiProvider === 'gemini' && geminiApiKey === undefined) {
    throw new ConfigError(
      'AI_PROVIDER=gemini requires GEMINI_API_KEY to be set. RecoverAI will not fall back ' +
        'to the mock provider: a deployment must never appear to use a real model while ' +
        'serving deterministic stubs.',
    );
  }
  if (paymentProvider === 'razorpay' && (!razorpayKeyId || !razorpayKeySecret)) {
    throw new ConfigError(
      'PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test mode)',
    );
  }
  // Guard against a live key reaching a system that moves money. Checked
  // whenever a key is present at all, not only when razorpay is selected: a
  // live credential sitting in the environment is itself the hazard.
  if (razorpayKeyId !== undefined) {
    if (razorpayKeyId.startsWith('rzp_live_')) {
      throw new ConfigError(
        'RAZORPAY_KEY_ID is a LIVE Mode key. RecoverAI refuses to start with live ' +
          'credentials: this system must never be pointed at real money.',
      );
    }
    // Fail closed on anything that is not recognisably a test key, rather than
    // only rejecting the known-live prefix.
    if (!/^rzp_test_[A-Za-z0-9]+$/.test(razorpayKeyId)) {
      throw new ConfigError(
        'RAZORPAY_KEY_ID must be a Test Mode key of the form "rzp_test_<alphanumeric>". ' +
          'RecoverAI fails closed on any unrecognised credential format.',
      );
    }
  }

  // -- authentication ------------------------------------------------------
  //
  // Default OFF. The repository's existing offline and DB-backed suites call
  // the API with no credentials, and the default posture must match the
  // documented development behaviour rather than silently breaking them.
  // Enabling authentication is an explicit deployment decision.
  const authEnabled = readBool(env, 'AUTH_ENABLED', false);
  const authToken = readOptional(env, 'API_AUTH_TOKEN');

  // FAIL CLOSED. An enabled-but-tokenless configuration is the dangerous
  // middle state: the operator believes the API is protected while every
  // request is compared against nothing. Refuse to start instead.
  //
  // readOptional() already treats a whitespace-only value as absent, so
  // API_AUTH_TOKEN="" and API_AUTH_TOKEN="   " both land here.
  if (authEnabled && authToken === undefined) {
    throw new ConfigError(
      'AUTH_ENABLED=true requires API_AUTH_TOKEN to be set to a non-empty value. ' +
        'RecoverAI fails closed rather than serving an unprotected API that appears protected.',
    );
  }
  // A token short enough to be guessable is worse than no token, because it
  // creates false confidence. The value itself is never echoed.
  if (authEnabled && authToken !== undefined && authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(
      `API_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters. ` +
        'The supplied value is too short to resist guessing. (The value is not shown.)',
    );
  }

  // -- production must not inherit development defaults -------------------
  //
  // A development default is a convenience; silently applying it in
  // production is a fault. A container whose DATABASE_URL is unset or
  // misspelled would otherwise start happily and point at a localhost
  // database that does not exist inside the container.
  //
  // Checked only when NODE_ENV=production, so local development and the test
  // suites keep their existing zero-configuration behaviour.
  const nodeEnv = readString(env, 'NODE_ENV', 'development');
  if (nodeEnv === 'production' && readOptional(env, 'DATABASE_URL') === undefined) {
    throw new ConfigError(
      'NODE_ENV=production requires DATABASE_URL to be set explicitly. RecoverAI will not ' +
        'fall back to the development database URL in production.',
    );
  }

  // Defaults chosen to be generous for an operator dashboard and a batch run
  // while still bounding a brute-force attempt: 120/min is far more than any
  // human workflow needs and far less than a credential-guessing loop wants.
  const rateLimit: RateLimitConfig = {
    enabled: readBool(env, 'RATE_LIMIT_ENABLED', true),
    max: readInt(env, 'RATE_LIMIT_MAX', 120, 1, 100_000),
    windowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', 60_000, 100, 3_600_000),
  };

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
    nodeEnv,
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
      geminiApiKey,
      geminiModel: readString(env, 'GEMINI_MODEL', DEFAULT_GEMINI_MODEL),
    },
    payments: {
      provider: paymentProvider,
      razorpayKeyId,
      razorpayKeySecret,
    },
    auth: {
      enabled: authEnabled,
      // Carried only when authentication is on, so a stray token in the
      // environment of an open deployment is not retained in memory.
      token: authEnabled ? authToken : undefined,
    },
    rateLimit,
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
      model:
        config.ai.provider === 'claude'
          ? config.ai.claudeModel
          : config.ai.provider === 'gemini'
            ? config.ai.geminiModel
            : config.ai.openaiModel,
      credentialPresent:
        config.ai.provider === 'mock' ||
        (config.ai.provider === 'claude' && config.ai.anthropicApiKey !== undefined) ||
        (config.ai.provider === 'openai' && config.ai.openaiApiKey !== undefined) ||
        (config.ai.provider === 'gemini' && config.ai.geminiApiKey !== undefined),
    },
    payments: {
      provider: config.payments.provider,
      credentialPresent:
        config.payments.provider === 'mock' || config.payments.razorpayKeyId !== undefined,
      mode: 'test' as const,
    },
    auth: {
      enabled: config.auth.enabled,
      // Presence ONLY. The token itself must never appear in a health
      // response, a log line, or a serialized config dump.
      credentialPresent: config.auth.token !== undefined,
    },
    // Limits are operational settings, not secrets.
    rateLimit: config.rateLimit,
    policy: config.policy,
    dataset: config.dataset,
  };
}

export { ConfigError };
