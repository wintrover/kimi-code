import { describe, it, expect } from 'vitest';

import { GuardrailPipeline } from '../pipeline.js';
import { GuardrailViolationError } from '../error.js';
import { TurnTelemetryBuffer } from '../telemetry.js';
import type { GuardrailContext, GuardrailConfig, GuardrailMiddleware } from '../context.js';

const UNKNOWN_CAPABILITY = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
};

function makeContext(partial?: Partial<GuardrailContext>): GuardrailContext {
  const config: GuardrailConfig = {
    enabled: true,
    maxRepeats: 3,
    windowSize: 5,
    requireReviewBetweenToolBatches: true,
    requireDeclaredToolUse: false,
  };
  return {
    agent: {} as GuardrailContext['agent'],
    modelCapabilities: UNKNOWN_CAPABILITY,
    tools: [],
    state: 'PLANNING',
    telemetry: new TurnTelemetryBuffer(config.windowSize),
    config,
    ...partial,
  };
}

describe('GuardrailPipeline', () => {
  it('executes middlewares in order', async () => {
    const pipeline = new GuardrailPipeline();
    const order: string[] = [];
    pipeline.use(async (ctx: GuardrailContext) => {
      order.push('a');
      return ctx;
    });
    pipeline.use(async (ctx: GuardrailContext) => {
      order.push('b');
      return ctx;
    });
    await pipeline.execute(makeContext());
    expect(order).toEqual(['a', 'b']);
  });

  it('allows middlewares to mutate ctx', async () => {
    const pipeline = new GuardrailPipeline();
    pipeline.use(async (ctx: GuardrailContext) => {
      ctx.state = 'EXECUTION';
      return ctx;
    });
    const ctx = makeContext();
    const result = await pipeline.execute(ctx);
    expect(result.state).toBe('EXECUTION');
  });

  it('stops execution and throws on violation', async () => {
    const pipeline = new GuardrailPipeline();
    const order: string[] = [];
    pipeline.use(async (ctx) => {
      order.push('a');
      return ctx;
    });
    pipeline.use(async () => {
      throw new GuardrailViolationError('test_policy', 'blocked for test', { foo: 'bar' });
    });
    pipeline.use(async (ctx: GuardrailContext) => {
      order.push('c');
      return ctx;
    });
    await expect(pipeline.execute(makeContext())).rejects.toThrow(GuardrailViolationError);
    expect(order).toEqual(['a']);
  });
});
