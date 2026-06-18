import { describe, it, expect } from 'vitest';

import { createCircuitBreakerMiddleware } from '../middleware/circuit-breaker.js';
import { TurnTelemetryBuffer } from '../telemetry.js';
import { GuardrailViolationError } from '../error.js';
import type { GuardrailConfig, GuardrailContext } from '../context.js';
import type { ExecutableToolResult, ToolCall } from '#/loop';

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
  toolResults?: ExecutableToolResult[],
): GuardrailContext {
  const fullConfig: GuardrailConfig = {
    enabled: true,
    maxRepeats: config.maxRepeats,
    windowSize: config.windowSize,
    requireReviewBetweenToolBatches: true,
    requireDeclaredToolUse: false,
    detectionMode: config.detectionMode,
  };
  return {
    agent: {} as GuardrailContext['agent'],
    modelCapabilities: UNKNOWN_CAPABILITY,
    tools: [],
    state: 'PLANNING',
    telemetry: new TurnTelemetryBuffer(config.windowSize),
    config: fullConfig,
    toolCalls,
    toolResults,
  };
}

describe('createCircuitBreakerMiddleware', () => {
  describe('input-only mode (default)', () => {
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

  describe('action-observation mode', () => {
    it('does not throw on repeated inputs before observations are recorded', async () => {
      const mw = createCircuitBreakerMiddleware();
      const ctx = makeContext(
        { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
      );
      await expect(mw(ctx)).resolves.toBeDefined();
      await expect(
        mw(
          makeContext(
            { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
            [{ id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('throws when identical inputs produce identical outputs', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(5);

      const action1 = makeContext(
        { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
      );
      action1.telemetry = telemetry;
      await mw(action1);

      const obs1 = makeContext(
        { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        [{ output: 'hi' }],
      );
      obs1.telemetry = telemetry;
      await mw(obs1);

      const action2 = makeContext(
        { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
        [{ id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
      );
      action2.telemetry = telemetry;
      await mw(action2);

      const obs2 = makeContext(
        { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
        [{ id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        [{ output: 'hi' }],
      );
      obs2.telemetry = telemetry;
      await expect(mw(obs2)).rejects.toThrow(GuardrailViolationError);
    });

    it('does not throw when identical inputs produce different outputs', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(5);

      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 2, windowSize: 5, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output: `hi-${id}` }],
        );
        obs.telemetry = telemetry;
        await expect(mw(obs)).resolves.toBeDefined();
      }
    });

    it('trips after maxRepeats identical action-observation pairs', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(5);

      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { maxRepeats: 3, windowSize: 5, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 3, windowSize: 5, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output: 'hi' }],
        );
        obs.telemetry = telemetry;
        // Third identical Bash output should trip.
        if (i === 2) {
          await expect(mw(obs)).rejects.toThrow(GuardrailViolationError);
        } else {
          await expect(mw(obs)).resolves.toBeDefined();
        }
      }
    });
  });
});
