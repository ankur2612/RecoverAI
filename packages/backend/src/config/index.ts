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
 * Shortest token accepted when authentication is enabled.
 */
export const MIN_AUTH_TOKEN_LENGTH = 16;

export type AiProviderName = 'mock' | 'claude' | 'openai' | 'gemini';
export type PaymentProviderName = 'mock' | 'razorpay';

export interface PolicyConfig {
  maxRetryAttempts: number;
  maxAutomatedAmount: number;
  minRecoveryConfidence: number;
  retryCooldownSeconds: number;
  highValueThreshold: number;
  recoveryWindowHours: number;
  maxRemindersPerPayment: number;
}

export interface DatasetConfig {
  seed: number;
  recordCount: number;
  evalSplit: number;
  avgTransactionValue: number;
  customerRepeatRate: number;
}

export interface AuthConfig {
  enabled: boolean;
  token: string | undefined;
}

export interface RateLimitConfig {
  enabled: boolean;
  max: number;
  windowMs: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;

  databaseUrl: string;

  /**
   * Exact browser origins allowed to access the API.
   *
   * Example:
   * https://recover-ai-frontend-phi.vercel.app
   */
  corsOrigins: string[];

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
    apiTimeoutRate: number;
  };
}

class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function readString(
  env: Env,
  key: string,
  fallback: string,
): string {
  const raw = env[key];

  return raw === undefined || raw.trim() === ''
    ? fallback
    : raw.trim();
}

function readOptional(
  env: Env,
  key: string,
): string | undefined {
  const raw = env[key];

  return raw === undefined || raw.trim() === ''
    ? undefined
    : raw.trim();
}

function readInt(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readOptional(env, key);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new ConfigError(
      `${key} must be an integer, received "${raw}"`,
    );
  }

  if (value < min || value > max) {
    throw new ConfigError(
      `${key} must be between ${min} and ${max}, received ${value}`,
    );
  }

  return value;
}

function readFloat(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readOptional(env, key);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new ConfigError(
      `${key} must be a number, received "${raw}"`,
    );
  }

  if (value < min || value > max) {
    throw new ConfigError(
      `${key} must be between ${min} and ${max}, received ${value}`,
    );
  }

  return value;
}

function readEnum<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readOptional(env, key);

  if (raw === undefined) {
    return fallback;
  }

  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `${key} must be one of ${allowed.join(' | ')}, received "${raw}"`,
    );
  }

  return raw as T;
}

function readBool(
  env: Env,
  key: string,
  fallback: boolean,
): boolean {
  const raw = readOptional(env, key);

  if (raw === undefined) {
    return fallback;
  }

  const lowered = raw.toLowerCase();

  if (lowered === 'true' || lowered === '1') {
    return true;
  }

  if (lowered === 'false' || lowered === '0') {
    return false;
  }

  throw new ConfigError(
    `${key} must be one of true | false | 1 | 0, received "${raw}"`,
  );
}

/**
 * Read CORS_ORIGINS.
 *
 * Multiple origins can be separated with commas.
 *
 * Example:
 *
 * CORS_ORIGINS=https://example.com,https://app.example.com
 */
function readCorsOrigins(env: Env): string[] {
  const raw = readOptional(env, 'CORS_ORIGINS');

  if (raw === undefined) {
    return [];
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => origin.replace(/\/$/, ''));

  for (const origin of origins) {
    try {
      const url = new URL(origin);

      if (
        url.protocol !== 'http:' &&
        url.protocol !== 'https:'
      ) {
        throw new Error('invalid protocol');
      }

      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        throw new Error('origin must not include path');
      }
    } catch {
      throw new ConfigError(
        `CORS_ORIGINS contains an invalid origin: "${origin}"`,
      );
    }
  }

  return [...new Set(origins)];
}

/**
 * Whether production has explicitly acknowledged running mock providers.
 */
function allowMockInProduction(env: Env): boolean {
  return readBool(
    env,
    'ALLOW_MOCK_PROVIDERS_IN_PRODUCTION',
    false,
  );
}

export function loadConfig(
  env: Env = process.env,
): AppConfig {
  /**
   * Load CORS origins from the environment.
   */
  const corsOrigins = readCorsOrigins(env);

  const aiProvider = readEnum(
    env,
    'AI_PROVIDER',
    ['mock', 'claude', 'openai', 'gemini'] as const,
    'mock',
  );

  const paymentProvider = readEnum(
    env,
    'PAYMENT_PROVIDER',
    ['mock', 'razorpay'] as const,
    'mock',
  );

  const anthropicApiKey = readOptional(
    env,
    'ANTHROPIC_API_KEY',
  );

  const openaiApiKey = readOptional(
    env,
    'OPENAI_API_KEY',
  );

  const geminiApiKey = readOptional(
    env,
    'GEMINI_API_KEY',
  );

  const razorpayKeyId = readOptional(
    env,
    'RAZORPAY_KEY_ID',
  );

  const razorpayKeySecret = readOptional(
    env,
    'RAZORPAY_KEY_SECRET',
  );

  /**
   * AI provider validation.
   */

  if (
    aiProvider === 'claude' &&
    anthropicApiKey === undefined
  ) {
    throw new ConfigError(
      'AI_PROVIDER=claude requires ANTHROPIC_API_KEY to be set',
    );
  }

  if (
    aiProvider === 'openai' &&
    openaiApiKey === undefined
  ) {
    throw new ConfigError(
      'AI_PROVIDER=openai requires OPENAI_API_KEY to be set',
    );
  }

  if (
    aiProvider === 'gemini' &&
    geminiApiKey === undefined
  ) {
    throw new ConfigError(
      'AI_PROVIDER=gemini requires GEMINI_API_KEY to be set. ' +
        'RecoverAI will not fall back to the mock provider.',
    );
  }

  /**
   * Razorpay validation.
   */

  if (
    paymentProvider === 'razorpay' &&
    (!razorpayKeyId || !razorpayKeySecret)
  ) {
    throw new ConfigError(
      'PAYMENT_PROVIDER=razorpay requires ' +
        'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test mode)',
    );
  }

  if (razorpayKeyId !== undefined) {
    if (razorpayKeyId.startsWith('rzp_live_')) {
      throw new ConfigError(
        'RAZORPAY_KEY_ID is a LIVE Mode key. ' +
          'RecoverAI refuses to start with live credentials.',
      );
    }

    if (!/^rzp_test_[A-Za-z0-9]+$/.test(razorpayKeyId)) {
      throw new ConfigError(
        'RAZORPAY_KEY_ID must be a Test Mode key of the form ' +
          '"rzp_test_<alphanumeric>".',
      );
    }
  }

  /**
   * Authentication configuration.
   */

  const authEnabled = readBool(
    env,
    'AUTH_ENABLED',
    false,
  );

  const authToken = readOptional(
    env,
    'API_AUTH_TOKEN',
  );

  if (
    authEnabled &&
    authToken === undefined
  ) {
    throw new ConfigError(
      'AUTH_ENABLED=true requires API_AUTH_TOKEN to be set.',
    );
  }

  if (
    authEnabled &&
    authToken !== undefined &&
    authToken.length < MIN_AUTH_TOKEN_LENGTH
  ) {
    throw new ConfigError(
      `API_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters.`,
    );
  }

  /**
   * Environment.
   */

  const nodeEnv = readString(
    env,
    'NODE_ENV',
    'development',
  );

  if (
    nodeEnv === 'production' &&
    readOptional(env, 'DATABASE_URL') === undefined
  ) {
    throw new ConfigError(
      'NODE_ENV=production requires DATABASE_URL to be set explicitly.',
    );
  }

  if (
    nodeEnv === 'production' &&
    !authEnabled
  ) {
    throw new ConfigError(
      'NODE_ENV=production requires AUTH_ENABLED=true.',
    );
  }

  /**
   * Mock provider production guard.
   */

  if (
    nodeEnv === 'production' &&
    paymentProvider === 'mock' &&
    !allowMockInProduction(env)
  ) {
    throw new ConfigError(
      'NODE_ENV=production with PAYMENT_PROVIDER=mock requires ' +
        'ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true.',
    );
  }

  if (
    nodeEnv === 'production' &&
    aiProvider === 'mock' &&
    !allowMockInProduction(env)
  ) {
    throw new ConfigError(
      'NODE_ENV=production with AI_PROVIDER=mock requires ' +
        'ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true.',
    );
  }

  /**
   * Rate limiting.
   */

  const rateLimit: RateLimitConfig = {
    enabled: readBool(
      env,
      'RATE_LIMIT_ENABLED',
      true,
    ),

    max: readInt(
      env,
      'RATE_LIMIT_MAX',
      120,
      1,
      100_000,
    ),

    windowMs: readInt(
      env,
      'RATE_LIMIT_WINDOW_MS',
      60_000,
      100,
      3_600_000,
    ),
  };

  /**
   * Recovery policy.
   */

  const policy: PolicyConfig = {
    maxRetryAttempts: readInt(
      env,
      'POLICY_MAX_RETRY_ATTEMPTS',
      3,
      0,
      10,
    ),

    maxAutomatedAmount: readInt(
      env,
      'POLICY_MAX_AUTOMATED_AMOUNT',
      1_000_000,
      0,
      1_000_000_000,
    ),

    minRecoveryConfidence: readFloat(
      env,
      'POLICY_MIN_RECOVERY_CONFIDENCE',
      0.75,
      0,
      1,
    ),

    retryCooldownSeconds: readInt(
      env,
      'POLICY_RETRY_COOLDOWN_SECONDS',
      3600,
      0,
      86_400 * 30,
    ),

    highValueThreshold: readInt(
      env,
      'POLICY_HIGH_VALUE_THRESHOLD',
      1_000_000,
      0,
      1_000_000_000,
    ),

    recoveryWindowHours: readInt(
      env,
      'POLICY_RECOVERY_WINDOW_HOURS',
      72,
      1,
      24 * 90,
    ),

    maxRemindersPerPayment: readInt(
      env,
      'POLICY_MAX_REMINDERS_PER_PAYMENT',
      2,
      0,
      10,
    ),
  };

  /**
   * Dataset configuration.
   */

  const dataset: DatasetConfig = {
    seed: readInt(
      env,
      'DATASET_SEED',
      42,
      0,
      2_147_483_647,
    ),

    recordCount: readInt(
      env,
      'DATASET_RECORD_COUNT',
      1000,
      1,
      1_000_000,
    ),

    evalSplit: readFloat(
      env,
      'DATASET_EVAL_SPLIT',
      0.3,
      0.05,
      0.9,
    ),

    avgTransactionValue: readInt(
      env,
      'DATASET_AVG_TRANSACTION_VALUE',
      250_000,
      100,
      100_000_000,
    ),

    customerRepeatRate: readFloat(
      env,
      'DATASET_CUSTOMER_REPEAT_RATE',
      0.45,
      0,
      0.95,
    ),
  };

  /**
   * Final configuration.
   */

  return {
    nodeEnv,

    port: readInt(
      env,
      'PORT',
      8080,
      1,
      65_535,
    ),

    logLevel: readString(
      env,
      'LOG_LEVEL',
      'info',
    ),

    databaseUrl: readString(
      env,
      'DATABASE_URL',
      'postgres://recoverai:recoverai@localhost:5432/recoverai',
    ),

    /**
     * IMPORTANT:
     * This is what makes CORS_ORIGINS available to app.ts.
     */
    corsOrigins,

    ai: {
      provider: aiProvider,

      anthropicApiKey,

      claudeModel: readString(
        env,
        'CLAUDE_MODEL',
        'claude-sonnet-5',
      ),

      openaiApiKey,

      openaiModel: readOptional(
        env,
        'OPENAI_MODEL',
      ),

      geminiApiKey,

      geminiModel: readString(
        env,
        'GEMINI_MODEL',
        DEFAULT_GEMINI_MODEL,
      ),
    },

    payments: {
      provider: paymentProvider,
      razorpayKeyId,
      razorpayKeySecret,
    },

    auth: {
      enabled: authEnabled,
      token: authEnabled
        ? authToken
        : undefined,
    },

    rateLimit,

    policy,

    dataset,

    demo: {
      apiTimeoutRate: readFloat(
        env,
        'DEMO_API_TIMEOUT_RATE',
        0.05,
        0,
        1,
      ),
    },
  };
}

/**
 * Config safe to return over HTTP.
 *
 * Secrets are NEVER returned.
 */
export function redactedConfig(config: AppConfig) {
  return {
    nodeEnv: config.nodeEnv,

    port: config.port,

    logLevel: config.logLevel,

    databaseConfigured:
      config.databaseUrl.length > 0,

    simulated:
      config.payments.provider === 'mock' ||
      config.ai.provider === 'mock',

    /**
     * Safe to expose because these are origins, not secrets.
     */
    corsOrigins: config.corsOrigins,

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
        (config.ai.provider === 'claude' &&
          config.ai.anthropicApiKey !== undefined) ||
        (config.ai.provider === 'openai' &&
          config.ai.openaiApiKey !== undefined) ||
        (config.ai.provider === 'gemini' &&
          config.ai.geminiApiKey !== undefined),
    },

    payments: {
      provider: config.payments.provider,

      credentialPresent:
        config.payments.provider === 'mock' ||
        config.payments.razorpayKeyId !== undefined,

      mode: 'test' as const,
    },

    auth: {
      enabled: config.auth.enabled,

      credentialPresent:
        config.auth.token !== undefined,
    },

    rateLimit: config.rateLimit,

    policy: config.policy,

    dataset: config.dataset,
  };
}

export { ConfigError };