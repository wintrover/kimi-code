import { GuardrailViolationError } from '#/guardrail/error';
import { ErrorCodes } from '#/errors/codes';
import { APITimeoutError, APIProviderRateLimitError } from '@moonshot-ai/kosong';
import type { SubagentFailureReason } from '@moonshot-ai/protocol';

const SUBAGENT_MAX_TOKENS_ERROR = 'Subagent max tokens exceeded';

/**
 * Classifies an unknown error into a structured SubagentFailureReason ADT.
 * Called at the subagent-host boundary to preserve structural error information
 * instead of discarding it to a plain string.
 *
 * Classification priority:
 * 1. GuardrailViolationError (structural — most precise)
 * 2. APITimeoutError (class-based — deterministic)
 * 3. APIProviderRateLimitError (class-based)
 * 4. KimiError with PROVIDER_CONNECTION_ERROR code
 * 5. KimiError with PROVIDER_RATE_LIMIT code
 * 6. Max tokens message matching
 * 7. AbortError (DOMException or Error)
 * 8. Fallback: UNEXPECTED_CRASH
 */
export function classifySubagentError(error: unknown): SubagentFailureReason {
  // 1. GuardrailViolationError — most structural error
  if (error instanceof GuardrailViolationError) {
    if (error.policy === 'circuit_breaker') {
      const ctx = error.context;
      return {
        code: 'CIRCUIT_BREAKER_TRIPPED',
        policy: (ctx['policy'] ?? 'circuit_breaker') as string,
        toolName: (ctx['toolName'] ?? 'unknown') as string,
        repeatCount: Number(ctx['repeatCount'] ?? 0),
        maxRepeats: Number(ctx['maxRepeats'] ?? 0),
        argsHash: ctx['argsHash'] !== null ? (ctx['argsHash'] as string) : undefined,
      };
    }
    return { code: 'UNEXPECTED_CRASH', message: error.toContextMessage() };
  }

  // 2. APITimeoutError — deterministic (no regex needed)
  if (error instanceof APITimeoutError) {
    return {
      code: 'TIMEOUT',
      provider: 'api',
      originalMessage: error.message,
    };
  }

  // 3. APIProviderRateLimitError — deterministic (carries statusCode: 429)
  if (error instanceof APIProviderRateLimitError) {
    return {
      code: 'API_RATE_LIMIT',
      provider: 'api',
      statusCode: error.statusCode,
    };
  }

  // 4. KimiError with connection error code
  if (error instanceof Error && 'code' in error) {
    const errWithCode = error as { code: string; message: string; provider?: string };
    if (errWithCode.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
      return {
        code: 'CONNECTION_ERROR',
        provider: errWithCode.provider ?? 'unknown',
        originalMessage: errWithCode.message,
      };
    }
    if (errWithCode.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      return {
        code: 'API_RATE_LIMIT',
        provider: errWithCode.provider ?? 'unknown',
        statusCode: 429,
      };
    }
  }

  // 5. Max tokens (string matching — internal error pattern)
  if (error instanceof Error && error.message.includes(SUBAGENT_MAX_TOKENS_ERROR)) {
    return { code: 'MAX_TOKENS_EXCEEDED', reason: error.message };
  }

  // 6. AbortError — user cancellation
  if (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return { code: 'USER_INTERRUPTED' };
  }

  // 7. Fallback
  return {
    code: 'UNEXPECTED_CRASH',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
