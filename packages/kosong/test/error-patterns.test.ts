import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  isRetryableGenerateError,
} from '#/errors';
import { classifyTransportError } from '#/providers/error-patterns';
import { describe, it, expect } from 'vitest';

describe('classifyTransportError', () => {
  const networkCases: Array<{ message: string; id: string }> = [
    { message: 'terminated', id: 'undici_terminated' },
    { message: 'read ECONNRESET', id: 'ECONNRESET' },
    { message: 'write EPIPE', id: 'EPIPE' },
    { message: 'socket hang up', id: 'socket_hang_up' },
    { message: 'connect ECONNREFUSED', id: 'ECONNREFUSED' },
    { message: 'getaddrinfo ENOTFOUND', id: 'ENOTFOUND' },
    { message: 'network connection lost', id: 'network_keyword' },
    { message: 'connection reset by peer', id: 'connection_keyword' },
    { message: 'disconnected from server', id: 'disconnect_keyword' },
    { message: 'fetch failed', id: 'fetch_failed' },
  ];

  for (const { message, id } of networkCases) {
    it(`classifies "${id}" as APIConnectionError`, () => {
      const result = classifyTransportError(message);
      expect(result).toBeInstanceOf(APIConnectionError);
      expect(isRetryableGenerateError(result)).toBe(true);
    });
  }

  const timeoutCases: Array<{ message: string; id: string }> = [
    { message: 'request timed out', id: 'timed_out' },
    { message: 'connection timeout', id: 'timeout' },
    { message: 'deadline exceeded', id: 'deadline' },
    { message: 'connection timed out', id: 'timeout_priority_over_network' },
  ];

  for (const { message, id } of timeoutCases) {
    it(`classifies "${id}" as APITimeoutError (priority over network)`, () => {
      const result = classifyTransportError(message);
      expect(result).toBeInstanceOf(APITimeoutError);
      expect(isRetryableGenerateError(result)).toBe(true);
    });
  }

  it('classifies unrelated message as non-retryable ChatProviderError', () => {
    const result = classifyTransportError('something completely unrelated');
    expect(result.constructor).toBe(ChatProviderError);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('classifies "Your session has been reset" as ChatProviderError (bare reset too broad)', () => {
    const result = classifyTransportError('Your session has been reset');
    expect(result.constructor).toBe(ChatProviderError);
  });
});
