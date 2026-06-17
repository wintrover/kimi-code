import type { TurnEvent, TurnState } from './context.js';
import { GuardrailViolationError } from './error.js';

/**
 * Pure FSM reducer for a single agent turn.
 *
 * States:
 *   PLANNING  -> tool_batch -> EXECUTION
 *   EXECUTION -> step_end(tool_use) -> REVIEW
 *   EXECUTION -> step_end(text) -> PLANNING
 *   REVIEW    -> step_end(text) -> PLANNING
 *   REVIEW    -> tool_batch -> GuardrailViolationError
 */
export function reduceTurnState(state: TurnState, event: TurnEvent): TurnState {
  switch (state) {
    case 'PLANNING': {
      if (event.kind === 'tool_batch') {
        return 'EXECUTION';
      }
      if (event.kind === 'step_begin') {
        return state;
      }
      if (event.kind === 'step_end') {
        return event.stopReason === 'tool_use' ? 'REVIEW' : 'PLANNING';
      }
      return state;
    }
    case 'EXECUTION': {
      if (event.kind === 'step_end') {
        return event.stopReason === 'tool_use' ? 'REVIEW' : 'PLANNING';
      }
      if (event.kind === 'tool_batch') {
        // Already in execution; additional batches in the same step are not
        // allowed by the pipeline contract, but we tolerate them here because
        // the middleware will reject consecutive batches across steps.
        return state;
      }
      return state;
    }
    case 'REVIEW': {
      if (event.kind === 'tool_batch') {
        throw new GuardrailViolationError(
          'fsm',
          'Tool batch not allowed in REVIEW state; a review (text) step is required before further execution.',
          { state, event: { kind: event.kind, toolCount: event.toolCalls.length } },
        );
      }
      if (event.kind === 'step_end') {
        return event.stopReason === 'tool_use' ? 'REVIEW' : 'PLANNING';
      }
      return state;
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
