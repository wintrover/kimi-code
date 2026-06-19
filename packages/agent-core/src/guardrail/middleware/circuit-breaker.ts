import { createHash } from 'node:crypto';

import picomatch from 'picomatch';

import type { ExecutableToolResult } from '#/loop';

import type { GuardrailContext, GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';
import { canonicalizeCommand } from '../normalize-command.js';
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

/** Normalize non-deterministic noise before hashing. */
function normalizeOutput(raw: string): string {
  return raw
    // ISO timestamps
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TS>')
    // UUIDs (must run before Unix timestamps to avoid partial digit matching)
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Unix timestamps (10-13 digits)
    .replaceAll(/\b\d{10,13}\b/g, '<TS>')
    // Bracketed numbers like [1234] (PID-style log output)
    .replaceAll(/\[\d+\]/g, '[<N>]')
    // pid=1234 or pid: 1234
    .replaceAll(/\bpid[=:\s]+\d+/gi, 'pid=<N>')
    // (ID: 12345) patterns
    .replaceAll(/\(ID:\s*\d+\)/gi, '(ID:<N>)')
    // Normalize whitespace
    .replaceAll(/\s+/g, ' ').trim();
}

function hashObservation(result: ExecutableToolResult): string {
  const output = typeof result.output === 'string'
    ? result.output
    : result.output
        .map((part) => (part.type === 'text' ? part.text : stableStringify(part)))
        .join('\n');
  return createHash('sha256').update(normalizeOutput(output)).digest('hex');
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

    const { repeatPolicy, maxRepeats } = getEffectivePolicy(ctx, toolCall.name, parsedArgs);
    if (repeatPolicy === 'allow') continue;

    const matches = ctx.telemetry.recentMatches(
      toolCall.name,
      parsedArgs,
      ctx.config.windowSize,
    );
    if (matches >= maxRepeats) {
      if (repeatPolicy === 'warn') {
        console.warn(`[guardrail] Tool "${toolCall.name}" repeated ${matches} times (warn mode)`);
        continue;
      }
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

/** Commands that mutate the environment when successful. */
const BASH_MUTATION_PATTERN = /\b(rm|mv|mkdir|rmdir|chmod|chown|ln|unlink|git\s+(push|commit|merge|rebase|reset|checkout|clean)|npm\s+install|pip\s+install|cargo\s+(install|build|test)|docker\s+(run|build|rm|stop)|wget|curl\s+(-X|--request)\s+(POST|PUT|DELETE|PATCH))\b/i;

function isDestructiveCommand(toolName: string, parsedArgs: unknown): boolean {
  if (toolName !== 'Bash' || parsedArgs === null || typeof parsedArgs !== 'object') return false;
  const cmd = (parsedArgs as Record<string, unknown>)['command'];
  if (typeof cmd !== 'string') return false;
  return BASH_MUTATION_PATTERN.test(cmd);
}

function getEffectivePolicy(
  ctx: GuardrailContext,
  toolName: string,
  parsedArgs: unknown,
): { repeatPolicy: 'block' | 'warn' | 'allow'; maxRepeats: number } {
  const defaultPolicy = 'block';
  const defaultMax = ctx.config.maxRepeats;

  if (!ctx.config.overrides?.length) {
    return { repeatPolicy: defaultPolicy, maxRepeats: defaultMax };
  }

  // Extract matchable subject with semantic normalization
  let subject = toolName;
  if (toolName === 'Bash' && parsedArgs !== null && typeof parsedArgs === 'object') {
    const cmd = (parsedArgs as Record<string, unknown>)['command'];
    if (typeof cmd === 'string') subject = canonicalizeCommand(cmd);
  }

  for (const override of ctx.config.overrides) {
    if (picomatch.isMatch(subject, override.match)) {
      const effectivePolicy = override.repeatPolicy
        ?? (override.behavior === 'stateless_search' ? 'allow' : defaultPolicy);
      return {
        repeatPolicy: effectivePolicy,
        maxRepeats: override.maxRepeats ?? defaultMax,
      };
    }
  }

  return { repeatPolicy: defaultPolicy, maxRepeats: defaultMax };
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

    const parsedArgs = parseArgs(toolCall.arguments);

    const { repeatPolicy, maxRepeats } = getEffectivePolicy(ctx, toolCall.name, parsedArgs);
    if (repeatPolicy === 'allow') continue;

    // Smart Destructive Check: invalidate prior fingerprints when a mutation command succeeds
    if (isDestructiveCommand(toolCall.name, parsedArgs) && !result.isError) {
      ctx.telemetry.invalidateFingerprints(toolCall.name);
    }

    const outputHash = hashObservation(result);
    ctx.telemetry.recordObservation(toolCall.id, outputHash);
    const matches = ctx.telemetry.recentMatches(
      toolCall.name,
      parsedArgs,
      ctx.config.windowSize,
      outputHash,
    );

    if (matches >= maxRepeats) {
      if (repeatPolicy === 'warn') {
        console.warn(`[guardrail] Tool "${toolCall.name}" repeated ${matches} times (warn mode)`);
        continue;
      }
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
