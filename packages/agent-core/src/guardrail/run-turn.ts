/**
 * Guardrail-aware wrapper around the stateless `runTurn` loop.
 *
 * This is the single integration point between AgentCore and the guardrail
 * pipeline. The pipeline filters tools, detects loops, and enforces the FSM
 * before any tool is executed.
 */

import type { Agent } from '#/agent';
import { runTurn, type RunTurnInput, type TurnResult } from '../loop/index';

import type { GuardrailConfig, GuardrailContext, TurnEvent } from './context.js';
import { GuardrailPipeline } from './pipeline.js';
import { ToolRegistryProxy } from './tool-proxy.js';
import {
  createCapabilityMiddleware,
  createCircuitBreakerMiddleware,
  createFsmMiddleware,
} from './middleware/index.js';
import { reduceTurnState } from './state.js';
import { TurnTelemetryBuffer } from './telemetry.js';

export function createGuardedRunTurn(
  agent: Agent,
  guardrailConfig: GuardrailConfig,
): (input: RunTurnInput) => Promise<TurnResult> {
  return async (input: RunTurnInput): Promise<TurnResult> => {
    if (!guardrailConfig.enabled) {
      return runTurn(input);
    }

    const useFsm = guardrailConfig.requireReviewBetweenToolBatches;

    const pipeline = new GuardrailPipeline();
    const toolRegistry = new ToolRegistryProxy(agent.tools);
    pipeline.use(createCapabilityMiddleware(toolRegistry));
    pipeline.use(createCircuitBreakerMiddleware());
    if (useFsm) {
      pipeline.use(createFsmMiddleware());
    }

    const ctx: GuardrailContext = {
      agent,
      modelCapabilities: agent.config.data().modelCapabilities,
      tools: input.tools ?? [],
      state: 'PLANNING',
      telemetry: new TurnTelemetryBuffer(guardrailConfig.windowSize),
      config: guardrailConfig,
    };

    // First pass: capability filtering before the loop starts.
    await pipeline.execute(ctx);

    const baseHooks = input.hooks;

    return runTurn({
      ...input,
      tools: ctx.tools,
      hooks: {
        ...baseHooks,
        beforeStep: async (stepCtx) => {
          const original = await baseHooks?.beforeStep?.(stepCtx);
          if (!useFsm || original?.block === true) {
            return original;
          }
          const event: TurnEvent = { kind: 'step_begin' };
          ctx.state = reduceTurnState(ctx.state, event);
          return original;
        },
        beforeToolBatch: async (batchCtx) => {
          await pipeline.execute({ ...ctx, toolCalls: batchCtx.toolCalls });
          await baseHooks?.beforeToolBatch?.(batchCtx);
        },
        afterStep: async (stepCtx) => {
          if (useFsm) {
            const event: TurnEvent = {
              kind: 'step_end',
              stopReason: stepCtx.stopReason === 'tool_use' ? 'tool_use' : 'text',
            };
            ctx.state = reduceTurnState(ctx.state, event);
          }
          return baseHooks?.afterStep?.(stepCtx);
        },
      },
    });
  };
}
