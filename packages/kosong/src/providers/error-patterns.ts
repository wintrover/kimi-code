/**
 * Shared transport-level error classification patterns.
 *
 * Providers receive low-level transport errors (undici `TypeError: terminated`,
 * Node `ECONNRESET`, `fetch failed`, etc.) that must be mapped to the correct
 * `ChatProviderError` subclass so the retry layer can handle them.
 *
 * This module centralises the regex heuristics so every provider stays
 * consistent and future pattern additions land in one place.
 */

import { APIConnectionError, APITimeoutError, ChatProviderError } from '#/errors';

/**
 * Matches undici `TypeError: terminated`, Node `ECONNRESET`,
 * `socket hang up`, `EPIPE`, `ECONNREFUSED`, `ENOTFOUND`, etc.
 */
const NETWORK_RE =
  /network|connection|connect|disconnect|terminated|fetch failed|ECONNRESET|EPIPE|socket hang up|ECONNREFUSED|ENOTFOUND/i;

/**
 * Matches explicit timeout wording.
 */
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * Classify a transport-level error message into the correct
 * `ChatProviderError` subclass.  Callers should only reach this for errors
 * that are **not** already an `APIConnectionError` / `APITimeoutError` /
 * `APIStatusError` instance — this covers the "unknown Error" fall-through.
 */
export function classifyTransportError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}
