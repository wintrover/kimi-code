import { describe, it, expect } from 'vitest';

import { createCircuitBreakerMiddleware } from '../middleware/circuit-breaker.js';
import { TurnTelemetryBuffer } from '../telemetry.js';
import { GuardrailViolationError } from '../error.js';
import { canonicalizeCommand } from '../normalize-command.js';
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
    overrides: config.overrides,
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

  describe('output normalization', () => {
    it('treats outputs with different timestamps as identical', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      async function recordPair(id: string, output: string) {
        const action = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output }],
        );
        obs.telemetry = telemetry;
        return mw(obs);
      }

      // Two outputs with different ISO timestamps should hash the same after normalization.
      await expect(
        recordPair('1', 'Server started at 2024-01-15T10:30:00Z'),
      ).resolves.toBeDefined();
      await expect(
        recordPair('2', 'Server started at 2024-01-15T10:31:00Z'),
      ).rejects.toThrow(GuardrailViolationError);
    });

    it('treats outputs with different PIDs as identical', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      async function recordPair(id: string, output: string) {
        const action = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output }],
        );
        obs.telemetry = telemetry;
        return mw(obs);
      }

      await expect(
        recordPair('1', 'Process [1234] finished'),
      ).resolves.toBeDefined();
      await expect(
        recordPair('2', 'Process [5678] finished'),
      ).rejects.toThrow(GuardrailViolationError);
    });

    it('treats outputs with different UUIDs as identical', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      async function recordPair(id: string, output: string) {
        const action = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output }],
        );
        obs.telemetry = telemetry;
        return mw(obs);
      }

      await expect(
        recordPair('1', 'id: a1b2c3d4-e5f6-7890-abcd-ef1234567890 done'),
      ).resolves.toBeDefined();
      await expect(
        recordPair('2', 'id: 11111111-2222-3333-4444-555555555555 done'),
      ).rejects.toThrow(GuardrailViolationError);
    });

    it('treats outputs with different pid= values as identical', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      async function recordPair(id: string, output: string) {
        const action = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 2, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output }],
        );
        obs.telemetry = telemetry;
        return mw(obs);
      }

      await expect(
        recordPair('1', 'worker pid=1234 ready'),
      ).resolves.toBeDefined();
      await expect(
        recordPair('2', 'worker pid=5678 ready'),
      ).rejects.toThrow(GuardrailViolationError);
    });

    it('still distinguishes semantically different outputs', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
          [{ output: `result-${id}` }],
        );
        obs.telemetry = telemetry;
        await expect(mw(obs)).resolves.toBeDefined();
      }
    });
  });

  describe('Smart Destructive Check', () => {
    it('invalidates fingerprints after successful mutation command (git push → rm → git push)', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      // Simulate: git push (failed), then rm (succeeds, invalidates), then git push again.
      // Step 1: Record action — git push
      const push1Action = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"git push"}' } as unknown as ToolCall],
      );
      push1Action.telemetry = telemetry;
      await mw(push1Action);

      // Step 1: Record observation — git push failed
      const push1Obs = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"git push"}' } as unknown as ToolCall],
        [{ output: 'error: failed to push', isError: true }],
      );
      push1Obs.telemetry = telemetry;
      await mw(push1Obs);

      // Step 2: Record action — rm
      const rmAction = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"rm -f file"}' } as unknown as ToolCall],
      );
      rmAction.telemetry = telemetry;
      await mw(rmAction);

      // Step 2: Record observation — rm succeeded (invalidates all prior Bash fingerprints)
      const rmObs = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"rm -f file"}' } as unknown as ToolCall],
        [{ output: '' }],
      );
      rmObs.telemetry = telemetry;
      await mw(rmObs);

      // Step 3: Record action — git push again
      const push2Action = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '3', type: 'tool', name: 'Bash', arguments: '{"command":"git push"}' } as unknown as ToolCall],
      );
      push2Action.telemetry = telemetry;
      await mw(push2Action);

      // Step 3: Record observation — git push succeeded
      const push2Obs = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '3', type: 'tool', name: 'Bash', arguments: '{"command":"git push"}' } as unknown as ToolCall],
        [{ output: 'Everything up-to-date' }],
      );
      push2Obs.telemetry = telemetry;
      // Should NOT throw — rm invalidated the prior git push fingerprints.
      await expect(mw(push2Obs)).resolves.toBeDefined();
    });

    it('does NOT invalidate fingerprints on failed mutation commands', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      // Use a non-destructive command (echo) for the repeated pair,
      // so its fingerprints won't be invalidated by isDestructiveCommand.
      for (let i = 0; i < 2; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hello"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"echo hello"}' } as unknown as ToolCall],
          [{ output: 'hello' }],
        );
        obs.telemetry = telemetry;
        await mw(obs);
      }

      // Now run a FAILED rm — should NOT invalidate fingerprints.
      const rmAction = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '3', type: 'tool', name: 'Bash', arguments: '{"command":"rm /nonexistent"}' } as unknown as ToolCall],
      );
      rmAction.telemetry = telemetry;
      await mw(rmAction);

      const rmObs = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '3', type: 'tool', name: 'Bash', arguments: '{"command":"rm /nonexistent"}' } as unknown as ToolCall],
        [{ output: 'No such file', isError: true }],
      );
      rmObs.telemetry = telemetry;
      await mw(rmObs);

      // The count for "echo hello → hello" should still be 2.
      // One more identical pair should hit maxRepeats=3 and throw.
      const echo3Action = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '4', type: 'tool', name: 'Bash', arguments: '{"command":"echo hello"}' } as unknown as ToolCall],
      );
      echo3Action.telemetry = telemetry;
      await mw(echo3Action);

      const echo3Obs = makeContext(
        { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
        [{ id: '4', type: 'tool', name: 'Bash', arguments: '{"command":"echo hello"}' } as unknown as ToolCall],
        [{ output: 'hello' }],
      );
      echo3Obs.telemetry = telemetry;
      await expect(mw(echo3Obs)).rejects.toThrow(GuardrailViolationError);
    });

    it('still trips on pure read-only command loops (ls → ls → ls)', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);

      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ls -la"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { maxRepeats: 3, windowSize: 10, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ls -la"}' } as unknown as ToolCall],
          [{ output: 'total 0\ndrwxr-xr-x 2 user user 40 Jan 1 00:00 .' }],
        );
        obs.telemetry = telemetry;
        if (i === 2) {
          await expect(mw(obs)).rejects.toThrow(GuardrailViolationError);
        } else {
          await expect(mw(obs)).resolves.toBeDefined();
        }
      }
    });
  });

  describe('scoped policy overrides', () => {
    it('allows repeated commands when override has repeat_policy = "allow"', async () => {
      const mw = createCircuitBreakerMiddleware();
      const config = {
        maxRepeats: 2,
        windowSize: 5,
        overrides: [{ match: 'ax prove *', repeatPolicy: 'allow' as const }],
      };

      for (let i = 0; i < 5; i += 1) {
        const ctx = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id: String(i + 1), type: 'tool', name: 'Bash', arguments: '{"command":"ax prove --limit 25"}' } as unknown as ToolCall],
        );
        ctx.telemetry = new TurnTelemetryBuffer(10);
        await expect(mw(ctx)).resolves.not.toThrow();
      }
    });

    it('warns but does not throw when override has repeat_policy = "warn"', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(10);
      const config = {
        maxRepeats: 2,
        windowSize: 5,
        overrides: [{ match: 'ax prove *', repeatPolicy: 'warn' as const }],
      };

      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ax prove --limit 25"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ax prove --limit 25"}' } as unknown as ToolCall],
          [{ output: 'All proofs passed' }],
        );
        obs.telemetry = telemetry;
        await expect(mw(obs)).resolves.toBeDefined();
      }
    });

    it('uses custom max_repeats from override', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(20);
      const config = {
        maxRepeats: 2,
        windowSize: 20,
        overrides: [{ match: 'pnpm test *', repeatPolicy: 'block' as const, maxRepeats: 4 }],
      };

      // 3 identical calls should NOT trip (global maxRepeats=2, but override is 4)
      for (let i = 0; i < 3; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"pnpm test --all"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"pnpm test --all"}' } as unknown as ToolCall],
          [{ output: 'all passed' }],
        );
        obs.telemetry = telemetry;
        await expect(mw(obs)).resolves.toBeDefined();
      }
    });

    it('falls back to default policy for non-matched commands', async () => {
      const mw = createCircuitBreakerMiddleware();
      const telemetry = new TurnTelemetryBuffer(5);
      const config = {
        maxRepeats: 2,
        windowSize: 5,
        overrides: [{ match: 'ax prove *', repeatPolicy: 'allow' as const }],
      };

      // "ls -la" does NOT match "ax prove *" -> should use default block policy
      for (let i = 0; i < 2; i += 1) {
        const id = String(i + 1);
        const action = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ls -la"}' } as unknown as ToolCall],
        );
        action.telemetry = telemetry;
        await mw(action);

        const obs = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id, type: 'tool', name: 'Bash', arguments: '{"command":"ls -la"}' } as unknown as ToolCall],
          [{ output: 'total 0' }],
        );
        obs.telemetry = telemetry;
        if (i === 1) {
          await expect(mw(obs)).rejects.toThrow(GuardrailViolationError);
        } else {
          await expect(mw(obs)).resolves.toBeDefined();
        }
      }
    });

    it('first override match wins', async () => {
      const mw = createCircuitBreakerMiddleware();
      const config = {
        maxRepeats: 2,
        windowSize: 5,
        overrides: [
          { match: 'ax*', repeatPolicy: 'block' as const },
          { match: 'ax prove *', repeatPolicy: 'allow' as const },
        ],
      };

      // "ax prove --limit 25" matches both, but first match ("ax*") says block
      const ctx = makeContext(
        { ...config, detectionMode: 'input-only' },
        [
          { id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"ax prove --limit 25"}' },
          { id: '2', type: 'tool', name: 'Bash', arguments: '{"command":"ax prove --limit 25"}' },
        ] as unknown as ToolCall[],
      );
      await expect(mw(ctx)).rejects.toThrow();
    });

    it('stateless_search behavior defaults to allow', async () => {
      const mw = createCircuitBreakerMiddleware();
      const config = {
        maxRepeats: 2,
        windowSize: 5,
        overrides: [{ match: 'cargo test *', behavior: 'stateless_search' as const }],
      };

      for (let i = 0; i < 5; i += 1) {
        const ctx = makeContext(
          { ...config, detectionMode: 'action-observation' },
          [{ id: String(i + 1), type: 'tool', name: 'Bash', arguments: '{"command":"cargo test"}' } as unknown as ToolCall],
        );
        ctx.telemetry = new TurnTelemetryBuffer(10);
        await expect(mw(ctx)).resolves.not.toThrow();
      }
    });

    it('no-op with empty overrides array', async () => {
      const mw = createCircuitBreakerMiddleware();
      const ctx = makeContext(
        { maxRepeats: 2, windowSize: 5, overrides: [] },
        [{ id: '1', type: 'tool', name: 'Bash', arguments: '{"command":"echo hi"}' } as unknown as ToolCall],
      );
      await expect(mw(ctx)).resolves.toBeDefined();
    });
  });
});

describe('TurnTelemetryBuffer', () => {
  describe('invalidateFingerprints', () => {
    it('removes all fingerprints matching the given tool name', () => {
      const buf = new TurnTelemetryBuffer(10);
      buf.record('Bash', { command: 'echo a' }, '1');
      buf.record('Read', { path: '/file' }, '2');
      buf.record('Bash', { command: 'echo b' }, '3');
      buf.record('Read', { path: '/file2' }, '4');

      expect(buf.records).toHaveLength(4);

      buf.invalidateFingerprints('Bash');

      expect(buf.records).toHaveLength(2);
      expect(buf.records[0]!.name).toBe('Read');
      expect(buf.records[1]!.name).toBe('Read');
    });

    it('is a no-op when no fingerprints match', () => {
      const buf = new TurnTelemetryBuffer(10);
      buf.record('Read', { path: '/file' }, '1');
      buf.record('Write', { path: '/file2' }, '2');

      buf.invalidateFingerprints('Bash');

      expect(buf.records).toHaveLength(2);
    });

    it('works on an empty buffer', () => {
      const buf = new TurnTelemetryBuffer(10);
      buf.invalidateFingerprints('Bash');
      expect(buf.records).toHaveLength(0);
    });
  });
});

describe('canonicalizeCommand', () => {
  it('strips ./ prefix', () => {
    expect(canonicalizeCommand('./ax prove --limit 25')).toBe('ax prove --limit 25');
  });

  it('strips inline env var', () => {
    expect(canonicalizeCommand('ENV=prod ax prove --limit 25')).toBe('ax prove --limit 25');
  });

  it('strips sudo prefix', () => {
    expect(canonicalizeCommand('sudo ax prove --limit 25')).toBe('ax prove --limit 25');
  });

  it('handles order-independent prefixes (fixed-point)', () => {
    expect(canonicalizeCommand('ENV=prod sudo ax prove')).toBe('ax prove');
    expect(canonicalizeCommand('sudo ENV=prod ax prove')).toBe('ax prove');
  });

  it('handles multiple env vars', () => {
    expect(canonicalizeCommand('A=1 B=2 ax prove')).toBe('ax prove');
  });

  it('handles mixed prefixes and paths', () => {
    expect(canonicalizeCommand('A=1 B=2 sudo ./bin/ax prove')).toBe('ax prove');
  });

  it('unwraps bash -c subshell', () => {
    expect(canonicalizeCommand('bash -c "ax prove"')).toBe('ax prove');
  });

  it('unwraps sh -c subshell', () => {
    expect(canonicalizeCommand("sh -c 'ax prove --limit 25'")).toBe('ax prove --limit 25');
  });

  it('handles subshell with nested prefixes (fixed-point)', () => {
    expect(canonicalizeCommand('sudo bash -c "ENV=prod ./bin/ax prove --limit 25"')).toBe('ax prove --limit 25');
  });

  it('strips absolute path prefix', () => {
    expect(canonicalizeCommand('/usr/local/bin/ax prove')).toBe('ax prove');
    expect(canonicalizeCommand('/usr/bin/ax prove')).toBe('ax prove');
    expect(canonicalizeCommand('/bin/ax prove')).toBe('ax prove');
  });

  it('collapses whitespace', () => {
    expect(canonicalizeCommand('  ax   prove   --limit  25  ')).toBe('ax prove --limit 25');
  });

  it('does not modify simple commands', () => {
    expect(canonicalizeCommand('ax prove --limit 25')).toBe('ax prove --limit 25');
  });

  it('strips export prefix', () => {
    expect(canonicalizeCommand('export PATH="/foo:$PATH"')).toBe('PATH="/foo:$PATH"');
  });

  it('strips export prefix and inline env var', () => {
    expect(canonicalizeCommand('export NODE_ENV=production npm start')).toBe('npm start');
  });

  it('strips declare -x prefix', () => {
    expect(canonicalizeCommand('declare -x HOME="/home/user"')).toBe('HOME="/home/user"');
  });

  it('handles export with sudo', () => {
    expect(canonicalizeCommand('sudo export PATH="/foo:$PATH"')).toBe('PATH="/foo:$PATH"');
  });
});
