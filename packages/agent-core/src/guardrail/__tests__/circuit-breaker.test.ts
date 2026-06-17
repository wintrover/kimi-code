import { describe, it, expect } from 'vitest';

import { createCircuitBreakerMiddleware } from '../middleware/circuit-breaker.js';
import { TurnTelemetryBuffer } from '../telemetry.js';
import { GuardrailViolationError } from '../error.js';
import type { GuardrailConfig, GuardrailContext } from '../context.js';
import type { ToolCall } from '#/loop';

const UNKNOWN_CAPABILITY = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
};

function makeContext(
  config: Partial<GuardrailConfig> & Pick<GuardrailConfig, 'maxRepeats' | 'windowSize'>,
  toolCalls: ToolCall[],
): GuardrailContext {
  const fullConfig: GuardrailConfig = {
    enabled: true,
    maxRepeats: config.maxRepeats,
    windowSize: config.windowSize,
    requireReviewBetweenToolBatches: true,
    requireDeclaredToolUse: false,
  };
  return {
    agent: {} as GuardrailContext['agent'],
    modelCapabilities: UNKNOWN_CAPABILITY,
    tools: [],
    state: 'PLANNING',
    telemetry: new TurnTelemetryBuffer(config.windowSize),
    config: fullConfig,
    toolCalls,
  };
}

describe('createCircuitBreakerMiddleware', () => {
  it('allows calls below repeat threshold', async () => {
    const mw = createCircuitBreakerMiddleware();
    const ctx = makeContext({ maxRepeats: 3, windowSize: 5 }, [
      { id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' },
    ] as unknown as ToolCall[]);
    await expect(mw(ctx)).resolves.toBeDefined();
  });

  it('throws when the same Bash command repeats', async () => {
    const mw = createCircuitBreakerMiddleware();
    const ctx = makeContext({ maxRepeats: 2, windowSize: 5 }, [
      { id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' },
    ] as unknown as ToolCall[]);
    // First call records count=1.
    await mw(ctx);
    // Second call records count=2, which equals maxRepeats -> violation.
    await expect(mw(ctx)).rejects.toThrow(GuardrailViolationError);
  });

  it('counts no-op Bash commands as repeats', async () => {
    const mw = createCircuitBreakerMiddleware();
    const ctx = makeContext({ maxRepeats: 2, windowSize: 5 }, [
      { id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"  :  "}' },
    ] as unknown as ToolCall[]);
    await mw(ctx);
    const second = makeContext({ maxRepeats: 2, windowSize: 5 }, [
      { id: '2', type: 'tool', name: 'Bash', arguments: '{"command":" : "}' },
    ] as unknown as ToolCall[]);
    second.telemetry = ctx.telemetry;
    await expect(mw(second)).rejects.toThrow(GuardrailViolationError);
  });
});
