import type { GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';

/**
 * Tool allowlist middleware.
 *
 * Validates tool calls against the set of tools exposed to the model. Any tool
 * call whose name is not in the allowlist is blocked with a
 * {@link GuardrailViolationError}. This catches hallucinated tool names or
 * stale references from prior turns.
 */
export function createToolAllowlistMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled) return ctx;

    // Only validate during the beforeToolBatch phase.
    const { toolCalls } = ctx;
    if (!toolCalls || toolCalls.length === 0) return ctx;

    const allowed = new Set(ctx.tools.map((t) => t.name));

    for (const call of toolCalls) {
      if (!allowed.has(call.name)) {
        throw new GuardrailViolationError(
          'tool_allowlist',
          `Tool '${call.name}' is not in the allowlist.`,
          {
            toolName: call.name,
            allowedTools: ctx.tools.map((t) => t.name),
          },
        );
      }
    }

    return ctx;
  };
}
