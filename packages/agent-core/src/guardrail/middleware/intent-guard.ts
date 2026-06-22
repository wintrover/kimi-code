import type { GuardrailMiddleware } from '../context.js';

/**
 * Intent guard middleware.
 *
 * Analyses the user's intent and applies guardrails based on the classification.
 * Placeholder for future intent-based security controls.
 */
export function createIntentGuardMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    // Placeholder — no-op until the intent classifier is fully wired.
    return ctx;
  };
}
