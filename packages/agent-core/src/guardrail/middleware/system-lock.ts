import { createHash } from 'node:crypto';

import type { GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';

/**
 * Patterns that indicate prompt injection or system prompt tampering.
 *
 * Each entry is tested case-insensitively against the JSON-serialized
 * arguments of every tool call in the current turn.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now/i,
  /\bsystem\s*:/i,
  /<system>/i,
  /<\/untrusted_content_policy>/i,
  /disregard\s+(all\s+)?prior\s+(instructions|prompts)/i,
  /override\s+(the\s+)?system\s+prompt/i,
  /\bforget\s+(everything|all)\b/i,
  /new\s+instructions?\s*:/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if\s+you/i,
  /your\s+new\s+role/i,
  /<tool_manifest>/i,
  /<\/tool_manifest>/i,
];

/**
 * Scan a string against all known injection patterns.
 *
 * @returns The first matching pattern description, or `null` if clean.
 */
function detectInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Recursively extract all string values from an arbitrary JSON value.
 * This ensures injection attempts hidden in nested objects or arrays
 * are caught.
 */
function extractStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(extractStrings);
  if (typeof value === 'object') {
    return Object.values(value).flatMap(extractStrings);
  }
  return [];
}

/**
 * System-lock middleware.
 *
 * Protects the system prompt against tampering and detects prompt injection
 * attempts carried through tool call arguments.
 *
 * **Tamper detection**: On the first execution, computes a SHA-256 hash of
 * the system prompt. On every subsequent execution, verifies the hash has
 * not changed — if it has, the system prompt was modified mid-session, which
 * is a security violation.
 *
 * **Injection detection**: Scans tool call arguments for known injection
 * patterns (e.g. `ignore previous instructions`, `you are now`, XML tag
 * injection). Throws on detection before the tool is executed.
 */
export function createSystemLockMiddleware(): GuardrailMiddleware {
  let expectedHash: string | undefined;

  return async (ctx) => {
    if (!ctx.config.enabled) {
      return ctx;
    }

    const systemPrompt = ctx.agent.config.systemPrompt;

    // ── Tamper detection ────────────────────────────────────────────────
    if (systemPrompt.length > 0) {
      const currentHash = createHash('sha256').update(systemPrompt).digest('hex');

      if (expectedHash === undefined) {
        // First execution — record baseline.
        expectedHash = currentHash;
      } else if (currentHash !== expectedHash) {
        throw new GuardrailViolationError(
          'system_lock',
          'System prompt hash changed after session start — possible tampering detected.',
          {
            expectedHash,
            currentHash,
          },
        );
      }
    }

    // ── Injection detection ─────────────────────────────────────────────
    if (ctx.toolCalls !== undefined && ctx.toolCalls.length > 0) {
      for (const toolCall of ctx.toolCalls) {
        let parsedArgs: unknown;
        try {
          parsedArgs =
            toolCall.arguments !== null && toolCall.arguments.length > 0
              ? (JSON.parse(toolCall.arguments) as unknown)
              : {};
        } catch {
          // Malformed JSON — let the tool executor handle it.
          continue;
        }

        const strings = extractStrings(parsedArgs);
        for (const str of strings) {
          const matchedPattern = detectInjection(str);
          if (matchedPattern !== null) {
            throw new GuardrailViolationError(
              'system_lock',
              `Prompt injection pattern detected in tool call arguments for "${toolCall.name}".`,
              {
                toolName: toolCall.name,
                matchedPattern,
                toolCallId: toolCall.id,
              },
            );
          }
        }
      }
    }

    return ctx;
  };
}
