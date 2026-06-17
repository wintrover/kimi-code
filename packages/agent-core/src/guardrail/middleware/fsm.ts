import type { GuardrailContext, GuardrailMiddleware, TurnEvent } from '../context.js';
import { reduceTurnState } from '../state.js';

/**
 * FSM middleware.
 *
 * Ensures that consecutive tool batches are separated by a text (review) step.
 * The middleware drives the reducer with a `tool_batch` event; the wrapper
 * around `runTurn` drives it with `step_begin` / `step_end` events.
 */
export function createFsmMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled || !ctx.config.requireReviewBetweenToolBatches) {
      return ctx;
    }
    if (ctx.toolCalls === undefined || ctx.toolCalls.length === 0) {
      return ctx;
    }

    const event: TurnEvent = { kind: 'tool_batch', toolCalls: ctx.toolCalls };
    ctx.state = reduceTurnState(ctx.state, event);
    return ctx;
  };
}
