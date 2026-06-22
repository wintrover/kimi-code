import { describe, expect, it } from 'vitest';
import { RecoveryPolicy } from '#/session/recovery-policy';
import type { TurnContextSnapshot } from '#/session/checkpoint';
import type { TurnStateSnapshot } from '#/session/turn-state';

function makeSnapshot(overrides: Partial<TurnContextSnapshot> = {}): TurnContextSnapshot {
  const turnState: TurnStateSnapshot = {
    phase: 'executing',
    turnId: 1,
    history: [{ phase: 'receiving', at: Date.now() }, { phase: 'executing', at: Date.now() }],
  };
  return {
    turnState,
    agentId: 'test-agent',
    turnId: 1,
    pendingSteps: [],
    sideEffectState: 'none',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('RecoveryPolicy', () => {
  const policy = new RecoveryPolicy();

  describe('evaluate', () => {
    it('returns shouldInject: false for null snapshot', () => {
      const decision = policy.evaluate(null);
      expect(decision.shouldInject).toBe(false);
      expect(decision.injections).toEqual([]);
    });

    it('returns shouldInject: false for empty snapshot with no pending steps or side-effects', () => {
      const decision = policy.evaluate(makeSnapshot({
        pendingSteps: [],
        sideEffectState: 'none',
      }));
      expect(decision.shouldInject).toBe(false);
      expect(decision.injections).toEqual([]);
    });

    it('returns shouldInject: true with idempotency guide for side-effect pending snapshot', () => {
      const decision = policy.evaluate(makeSnapshot({
        sideEffectState: 'pending',
        pendingToolCallId: 'tool-1',
      }));
      expect(decision.shouldInject).toBe(true);
      expect(decision.injections.length).toBeGreaterThan(0);
      const combined = decision.injections.join('\n');
      expect(combined).toContain('[VERIFY]');
    });

    it('returns shouldInject: true with recovery context for normal snapshot with pending steps', () => {
      const decision = policy.evaluate(makeSnapshot({
        goal: 'Complete the feature',
        pendingSteps: ['step-1', 'step-2'],
        sideEffectState: 'none',
      }));
      expect(decision.shouldInject).toBe(true);
      const combined = decision.injections.join('\n');
      expect(combined).toContain('Goal');
      expect(combined).toContain('Pending');
    });

    it('returns shouldInject: true with both injections for fully populated snapshot', () => {
      const decision = policy.evaluate(makeSnapshot({
        goal: 'Implement recovery',
        pendingSteps: ['step-1'],
        sideEffectState: 'pending',
        pendingToolCallId: 'tool-1',
      }));
      expect(decision.shouldInject).toBe(true);
      expect(decision.injections.length).toBeGreaterThanOrEqual(2);
      const combined = decision.injections.join('\n');
      expect(combined).toContain('[VERIFY]');
      expect(combined).toContain('Compaction Recovery');
    });
  });

  describe('evaluateAfterCompaction', () => {
    it('returns shouldInject: false for null snapshot', () => {
      const decision = policy.evaluateAfterCompaction(null);
      expect(decision.shouldInject).toBe(false);
      expect(decision.injections).toEqual([]);
    });

    it('returns shouldInject: true with Immediate Next Action for normal snapshot', () => {
      const decision = policy.evaluateAfterCompaction(makeSnapshot({
        goal: 'Fix the bug',
        pendingSteps: ['step-1', 'step-2'],
      }));
      expect(decision.shouldInject).toBe(true);
      const combined = decision.injections.join('\n');
      expect(combined).toContain('Immediate Next Action');
    });

    it('returns shouldInject: true with both idempotency and recovery for side-effect pending snapshot', () => {
      const decision = policy.evaluateAfterCompaction(makeSnapshot({
        goal: 'Deploy changes',
        pendingSteps: ['step-1'],
        sideEffectState: 'pending',
        pendingToolCallId: 'tool-1',
      }));
      expect(decision.shouldInject).toBe(true);
      expect(decision.injections.length).toBeGreaterThanOrEqual(2);
      const combined = decision.injections.join('\n');
      expect(combined).toContain('[VERIFY]');
      expect(combined).toContain('Immediate Next Action');
    });
  });
});
