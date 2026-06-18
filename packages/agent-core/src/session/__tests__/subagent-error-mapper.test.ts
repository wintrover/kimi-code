import { describe, expect, it } from 'vitest';
import {
  APITimeoutError,
  APIProviderRateLimitError,
} from '@moonshot-ai/kosong';
import { GuardrailViolationError } from '#/guardrail/error';
import { ErrorCodes } from '#/errors/codes';

import { classifySubagentError } from '../subagent-error-mapper';

describe('classifySubagentError', () => {
  // --- GuardrailViolationError ---

  it('maps circuit_breaker GuardrailViolationError to CIRCUIT_BREAKER_TRIPPED', () => {
    const error = new GuardrailViolationError(
      'circuit_breaker',
      'too many repeated calls',
      {
        policy: 'circuit_breaker',
        toolName: 'bash',
        repeatCount: 5,
        maxRepeats: 3,
        argsHash: 'abc123',
      },
    );

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'CIRCUIT_BREAKER_TRIPPED',
      policy: 'circuit_breaker',
      toolName: 'bash',
      repeatCount: 5,
      maxRepeats: 3,
      argsHash: 'abc123',
    });
  });

  it('uses defaults for missing circuit_breaker context fields', () => {
    const error = new GuardrailViolationError(
      'circuit_breaker',
      'repeated',
      {},
    );

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'CIRCUIT_BREAKER_TRIPPED',
      policy: 'circuit_breaker',
      toolName: 'unknown',
      repeatCount: 0,
      maxRepeats: 0,
      argsHash: undefined,
    });
  });

  it('omits argsHash when null in context', () => {
    const error = new GuardrailViolationError(
      'circuit_breaker',
      'repeated',
      {
        policy: 'circuit_breaker',
        toolName: 'read',
        repeatCount: 2,
        maxRepeats: 3,
        argsHash: null,
      },
    );

    const result = classifySubagentError(error);

    expect(result.code).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect((result as Record<string, unknown>).argsHash).toBeUndefined();
  });

  it('maps non-circuit_breaker GuardrailViolationError to UNEXPECTED_CRASH', () => {
    const error = new GuardrailViolationError(
      'capability',
      'not allowed',
      {},
    );

    const result = classifySubagentError(error);

    expect(result.code).toBe('UNEXPECTED_CRASH');
    expect(result).toHaveProperty('message');
    expect(typeof (result as { message: string }).message).toBe('string');
  });

  // --- APITimeoutError ---

  it('maps APITimeoutError to TIMEOUT', () => {
    const error = new APITimeoutError('request timed out after 30s');

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'TIMEOUT',
      provider: 'api',
      originalMessage: 'request timed out after 30s',
    });
  });

  // --- APIProviderRateLimitError ---

  it('maps APIProviderRateLimitError to API_RATE_LIMIT with statusCode 429', () => {
    const error = new APIProviderRateLimitError('too many requests', 'req-123');

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'API_RATE_LIMIT',
      provider: 'api',
      statusCode: 429,
    });
  });

  // --- KimiError with error code (PROVIDER_CONNECTION_ERROR) ---

  it('maps Error with PROVIDER_CONNECTION_ERROR code to CONNECTION_ERROR', () => {
    const error = Object.assign(new Error('connection refused'), {
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
      provider: 'openai',
    });

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'CONNECTION_ERROR',
      provider: 'openai',
      originalMessage: 'connection refused',
    });
  });

  it('defaults provider to unknown when not present on connection error', () => {
    const error = Object.assign(new Error('network unreachable'), {
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
    });

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'CONNECTION_ERROR',
      provider: 'unknown',
      originalMessage: 'network unreachable',
    });
  });

  // --- KimiError with error code (PROVIDER_RATE_LIMIT) ---

  it('maps Error with PROVIDER_RATE_LIMIT code to API_RATE_LIMIT with 429', () => {
    const error = Object.assign(new Error('rate limited'), {
      code: ErrorCodes.PROVIDER_RATE_LIMIT,
      provider: 'anthropic',
    });

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'API_RATE_LIMIT',
      provider: 'anthropic',
      statusCode: 429,
    });
  });

  // --- Max tokens message matching ---

  it('maps Error with max tokens message to MAX_TOKENS_EXCEEDED', () => {
    const error = new Error('Subagent max tokens exceeded: limit reached');

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'MAX_TOKENS_EXCEEDED',
      reason: 'Subagent max tokens exceeded: limit reached',
    });
  });

  // --- AbortError ---

  it('maps DOMException AbortError to USER_INTERRUPTED', () => {
    const error = new DOMException('The operation was aborted', 'AbortError');

    const result = classifySubagentError(error);

    expect(result).toEqual({ code: 'USER_INTERRUPTED' });
  });

  it('maps Error with name AbortError to USER_INTERRUPTED', () => {
    const error = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });

    const result = classifySubagentError(error);

    expect(result).toEqual({ code: 'USER_INTERRUPTED' });
  });

  // --- Fallback: UNEXPECTED_CRASH ---

  it('maps a plain Error to UNEXPECTED_CRASH', () => {
    const error = new Error('something broke');

    const result = classifySubagentError(error);

    expect(result.code).toBe('UNEXPECTED_CRASH');
    expect(result).toHaveProperty('message', 'something broke');
    expect(result).toHaveProperty('stack');
  });

  it('maps a non-Error value to UNEXPECTED_CRASH with string coercion', () => {
    const error = 'raw string error';

    const result = classifySubagentError(error);

    expect(result).toEqual({
      code: 'UNEXPECTED_CRASH',
      message: 'raw string error',
      stack: undefined,
    });
  });

  it('maps a null error to UNEXPECTED_CRASH', () => {
    const result = classifySubagentError(null);

    expect(result).toEqual({
      code: 'UNEXPECTED_CRASH',
      message: 'null',
      stack: undefined,
    });
  });

  it('maps an unknown object to UNEXPECTED_CRASH', () => {
    const result = classifySubagentError({ custom: 'info' });

    expect(result).toEqual({
      code: 'UNEXPECTED_CRASH',
      message: '[object Object]',
      stack: undefined,
    });
  });

  // --- Priority ordering ---

  it('prioritizes GuardrailViolationError over Error with code', () => {
    const error = Object.assign(
      new GuardrailViolationError('circuit_breaker', 'blocked', {
        policy: 'circuit_breaker',
        toolName: 'bash',
        repeatCount: 1,
        maxRepeats: 1,
      }),
      { code: ErrorCodes.PROVIDER_CONNECTION_ERROR },
    );

    const result = classifySubagentError(error);

    expect(result.code).toBe('CIRCUIT_BREAKER_TRIPPED');
  });

  it('prioritizes APITimeoutError over Error with code', () => {
    const error = Object.assign(
      new APITimeoutError('timeout'),
      { code: ErrorCodes.PROVIDER_CONNECTION_ERROR },
    );

    const result = classifySubagentError(error);

    expect(result.code).toBe('TIMEOUT');
  });
});
