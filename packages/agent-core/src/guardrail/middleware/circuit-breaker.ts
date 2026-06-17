import type { GuardrailContext, GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';

function parseArgs(raw: string | null): unknown {
  if (raw === null || raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/**
 * Circuit-breaker middleware.
 *
 * Records every tool call in the turn telemetry buffer. If the same call
 * (name + normalized args) appears `maxRepeats` or more times within the
 * configured window, the pipeline throws a {@link GuardrailViolationError}.
 */
export function createCircuitBreakerMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled || ctx.toolCalls === undefined || ctx.toolCalls.length === 0) {
      return ctx;
    }

    for (const toolCall of ctx.toolCalls) {
      const parsedArgs = parseArgs(toolCall.arguments);
      ctx.telemetry.record(toolCall.name, parsedArgs);
      const matches = ctx.telemetry.recentMatches(
        toolCall.name,
        parsedArgs,
        ctx.config.windowSize,
      );
      if (matches >= ctx.config.maxRepeats) {
        throw new GuardrailViolationError(
          'circuit_breaker',
          `Tool "${toolCall.name}" repeated ${String(matches)} times within the telemetry window.`,
          {
            toolName: toolCall.name,
            args: parsedArgs,
            repeatCount: matches,
            windowSize: ctx.config.windowSize,
            maxRepeats: ctx.config.maxRepeats,
          },
        );
      }
    }

    return ctx;
  };
}
