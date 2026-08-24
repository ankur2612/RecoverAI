import type { AIProvider } from '../provider.ts';
import { DIAGNOSIS_SYSTEM_PROMPT, renderDiagnosisPrompt } from '../provider.ts';
import {
  assertNoEvaluationData,
  validateDiagnosis,
  DiagnosisValidationError,
  type DiagnosisInput,
  type DiagnosisResult,
} from '../types.ts';

/**
 * ============================================================================
 * GEMINI AI PROVIDER
 * ============================================================================
 *
 * The ONLY module that knows the Gemini API exists. It implements the existing
 * AIProvider interface and changes nothing about what a diagnosis means:
 *
 *   Gemini -> diagnosis -> policy engine -> authorization -> executor
 *
 * Gemini cannot authorize, cannot execute, cannot reach the database, and
 * cannot see ground truth. It receives the same sealed DiagnosisInput MockAI
 * receives — built by the existing builder, not a second one — and its output
 * passes the same strict validator.
 *
 * Uses the REST API via fetch rather than an SDK: the surface needed is one
 * endpoint, and an SDK's types could leak into the domain layer.
 */

/** Gemini's generateContent endpoint. */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The default Gemini model.
 *
 * Declared ONCE here and imported by the config loader, so the default cannot
 * drift between the two. Overridable per-deployment via GEMINI_MODEL.
 *
 * Older Flash generations (gemini-1.5-flash, gemini-2.0-flash) have been
 * retired by Google and must not be defaulted to: a shut-down model turns
 * every diagnosis into a provider error at runtime.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Injectable HTTP surface so unit tests never touch the network. */
export interface GeminiTransport {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    },
  ): Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  transport?: GeminiTransport;
  timeoutMs?: number;
  baseUrl?: string;
}

export class GeminiConfigurationError extends Error {
  override name = 'GeminiConfigurationError';
}

/** Raised for transport/HTTP failures, so analyze can fall back deterministically. */
export class GeminiRequestError extends Error {
  override name = 'GeminiRequestError';
}

/** The response fields we read. Everything else is discarded. */
interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

export class GeminiAIProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;

  readonly #apiKey: string;
  readonly #transport: GeminiTransport;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      // Fail loudly. Falling back to MockAI would let a deployment believe it
      // is using a real model while serving deterministic stubs.
      throw new GeminiConfigurationError(
        'GEMINI_API_KEY is required to construct the Gemini provider.',
      );
    }
    this.#apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.#transport = options.transport ?? defaultTransport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? GEMINI_API_BASE;
  }

  /**
   * Produce a validated recommendation.
   *
   * The input is checked for evaluation data one more time before it leaves
   * the process. The builder already guarantees this, but a leak here would be
   * irreversible — the labels would be on someone else's servers.
   */
  async diagnose(input: DiagnosisInput): Promise<DiagnosisResult> {
    assertNoEvaluationData(input);

    const body = JSON.stringify({
      // The same system prompt every LLM provider must send.
      systemInstruction: { parts: [{ text: DIAGNOSIS_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: renderDiagnosisPrompt(input) }] }],
      // NOTE ON SAMPLING PARAMETERS
      //
      // Gemini 3.x deprecates the classic sampling controls — temperature,
      // topP, topK, candidateCount, thinkingBudget — and they are deliberately
      // NOT sent. An earlier revision passed `temperature: 0` to make decoding
      // deterministic; that lever no longer applies to this model generation.
      //
      // Determinism therefore cannot be assumed from the request. It is
      // enforced downstream instead, where it actually matters: the strict
      // validator rejects anything that is not a well-formed diagnosis, and
      // the deterministic policy engine — not the model — decides whether any
      // action is permitted. A varying recommendation cannot widen a limit.
      generationConfig: {
        // Ask for JSON directly rather than parsing prose out of a reply.
        // This is a response-format control, not a sampling parameter.
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
      },
    });

    const text = await this.#generate(body);
    // The SAME strict validator MockAI uses. Anything malformed, out of range,
    // or carrying an invented field is rejected rather than coerced.
    return validateDiagnosis(text, this.name, this.model);
  }

  /** Issue one generateContent request and return the raw model text. */
  async #generate(body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#transport(
        `${this.#baseUrl}/models/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Header auth, so the key never appears in a URL that could be
            // captured by request logging or a proxy access log.
            'x-goog-api-key': this.#apiKey,
          },
          body,
          signal: controller.signal,
        },
      );

      const raw = await response.text();

      if (!response.ok) {
        throw new GeminiRequestError(
          `Gemini responded ${response.status}: ${sanitiseGeminiError(raw)}`,
        );
      }

      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(raw) as GeminiResponse;
      } catch {
        throw new GeminiRequestError('Gemini returned a response that was not valid JSON.');
      }

      if (parsed.promptFeedback?.blockReason !== undefined) {
        throw new GeminiRequestError(
          `Gemini blocked the prompt (${parsed.promptFeedback.blockReason}).`,
        );
      }

      const candidate = parsed.candidates?.[0];
      const modelText = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

      if (modelText.trim() === '') {
        // An empty completion is a provider failure, not a diagnosis. Throwing
        // lets the analyze pipeline fall back to the deterministic baseline
        // rather than inventing an optimistic recommendation.
        throw new GeminiRequestError(
          `Gemini returned no usable content (finishReason: ${candidate?.finishReason ?? 'none'}).`,
        );
      }

      return modelText;
    } catch (error) {
      if (error instanceof GeminiRequestError || error instanceof DiagnosisValidationError) {
        throw error;
      }
      if ((error as Error).name === 'AbortError') {
        throw new GeminiRequestError(`Gemini request timed out after ${this.#timeoutMs}ms.`);
      }
      throw new GeminiRequestError(
        `Gemini request failed: ${sanitiseGeminiError((error as Error).message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Strip credential-shaped text from anything that will be logged or stored.
 *
 * A Gemini error body can echo the request, and these messages reach the audit
 * trail via DIAGNOSIS_FAILED, so they are scrubbed rather than trusted.
 */
export function sanitiseGeminiError(text: string): string {
  return text
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[redacted-key]')
    .replace(/"(x-goog-api-key|key|api_key|apiKey)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/[?&]key=[^&\s"]+/gi, '?key=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[redacted-auth]')
    .slice(0, 300);
}

const defaultTransport: GeminiTransport = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    status: response.status,
    ok: response.ok,
    text: () => response.text(),
  };
};
