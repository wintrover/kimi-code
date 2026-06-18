import { createHash } from 'node:crypto';

import type { ExecutableToolResult } from '#/loop';

import type { GuardrailContext, GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';
import { stableStringify } from '../telemetry.js';

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

function hashObservation(result: ExecutableToolResult): string {
  const output = typeof result.output === 'string'
    ? result.output
    : result.output
        .map((part) => (part.type === 'text' ? part.text : stableStringify(part)))
        .join('\n');
  return createHash('sha256').update(output).digest('hex');
}

function makeViolation(
  ctx: GuardrailContext,
  toolName: string,
  parsedArgs: unknown,
  matches: number,
  outputHash?: string,
): GuardrailViolationError {
  return new GuardrailViolationError(
    'circuit_breaker',
    `Tool "${toolName}" repeated ${String(matches)} times within the telemetry window.`,
    {
      toolName,
      args: parsedArgs,
      repeatCount: matches,
      windowSize: ctx.config.windowSize,
      maxRepeats: ctx.config.maxRepeats,
      ...(outputHash !== undefined ? { outputHash } : {}),
    },
  );
}

function checkInputOnlyPhase(
  ctx: GuardrailContext,
): GuardrailContext {
  for (const toolCall of ctx.toolCalls!) {
    const parsedArgs = parseArgs(toolCall.arguments);
    ctx.telemetry.record(toolCall.name, parsedArgs, toolCall.id);
    const matches = ctx.telemetry.recentMatches(
      toolCall.name,
      parsedArgs,
      ctx.config.windowSize,
    );
    if (matches >= ctx.config.maxRepeats) {
      throw makeViolation(ctx, toolCall.name, parsedArgs, matches);
    }
  }
  return ctx;
}

function recordActions(ctx: GuardrailContext): GuardrailContext {
  for (const toolCall of ctx.toolCalls!) {
    const parsedArgs = parseArgs(toolCall.arguments);
    ctx.telemetry.record(toolCall.name, parsedArgs, toolCall.id);
  }
  return ctx;
}

function checkActionObservationPhase(
  ctx: GuardrailContext,
): GuardrailContext {
  const toolCalls = ctx.toolCalls!;
  const toolResults = ctx.toolResults!;

  for (let i = 0; i < toolCalls.length; i += 1) {
    const toolCall = toolCalls[i]!;
    const result = toolResults[i];
    if (result === undefined) continue;

    const outputHash = hashObservation(result);
    ctx.telemetry.recordObservation(toolCall.id, outputHash);

    const parsedArgs = parseArgs(toolCall.arguments);
    const matches = ctx.telemetry.recentMatches(
      toolCall.name,
      parsedArgs,
      ctx.config.windowSize,
      outputHash,
    );

    if (matches >= ctx.config.maxRepeats) {
      throw makeViolation(ctx, toolCall.name, parsedArgs, matches, outputHash);
    }
  }

  return ctx;
}

/**
 * Circuit-breaker middleware.
 *
 * Records every tool call in the turn telemetry buffer. In `input-only` mode
 * (default), it trips when the same call (name + normalized args) appears
 * `maxRepeats` or more times within the configured window.
 *
 * In `action-observation` mode, the middleware records actions in the
 * `beforeToolBatch` phase and evaluates them together with their observations
 * in the `afterToolBatch` phase. It trips only when identical inputs produce
 * identical outputs, which is a deterministic signal that the agent is stuck
 * in a closed loop.
 */
export function createCircuitBreakerMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled) {
      return ctx;
    }

    const detectionMode = ctx.config.detectionMode ?? 'input-only';

    if (detectionMode === 'action-observation') {
      if (ctx.toolResults !== undefined && ctx.toolResults.length > 0) {
        return checkActionObservationPhase(ctx);
      }
      if (ctx.toolCalls !== undefined && ctx.toolCalls.length > 0) {
        return recordActions(ctx);
      }
      return ctx;
    }

    if (ctx.toolCalls !== undefined && ctx.toolCalls.length > 0) {
      return checkInputOnlyPhase(ctx);
    }

    return ctx;
  };
}
