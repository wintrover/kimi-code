import { describe, expect, it } from 'vitest';
import {
  buildRecoveryContext,
  buildIdempotencyInjection,
  buildRecoveryInjection,
} from '#/session/hydrator';
import type { TurnContextSnapshot } from '#/session/checkpoint';
import type { TurnStateSnapshot } from '#/session/turn-state';

function makeSnapshot(overrides: Partial<TurnContextSnapshot> = {}): TurnContextSnapshot {
  const turnState: TurnStateSnapshot = {
    phase: 'executing',
    turnId: 3,
    history: [{ phase: 'receiving', at: Date.now() }, { phase: 'executing', at: Date.now() }],
  };
  return {
    turnState,
    agentId: 'agent-0',
    turnId: 3,
    pendingSteps: ['Write src/foo.ts', 'Run tests'],
    goal: 'Implement feature X',
    sideEffectState: 'none',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildRecoveryContext', () => {
  it('builds context from a basic snapshot', () => {
    const ctx = buildRecoveryContext(makeSnapshot());
    expect(ctx.goal).toBe('Implement feature X');
    expect(ctx.pendingSteps).toEqual(['Write src/foo.ts', 'Run tests']);
    expect(ctx.compactionSummary).toContain('Implement feature X');
    expect(ctx.compactionSummary).toContain('1. Write src/foo.ts');
    expect(ctx.idempotencyGuide).toBeUndefined();
    expect(ctx.priority).toBe('default');
  });

  it('generates idempotencyGuide when sideEffectState is pending', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'pending',
      pendingToolCallId: 'tool-abc',
    }));
    expect(ctx.idempotencyGuide).toBeDefined();
    expect(ctx.idempotencyGuide).toContain('[VERIFY]');
    expect(ctx.idempotencyGuide).toContain('tool-abc');
    expect(ctx.priority).toBe('idempotent-first');
  });

  it('does not generate idempotencyGuide when sideEffectState is none', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'none',
      pendingToolCallId: 'tool-abc',
    }));
    expect(ctx.idempotencyGuide).toBeUndefined();
    expect(ctx.priority).toBe('default');
  });

  it('does not generate idempotencyGuide when no pendingToolCallId', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'pending',
    }));
    expect(ctx.idempotencyGuide).toBeUndefined();
  });

  it('includes interrupted tool info when sideEffectState is pending', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'pending',
      pendingToolCallId: 'tool-xyz',
    }));
    expect(ctx.interruptedTool).toBe('tool-xyz');
    expect(ctx.compactionSummary).toContain('Interrupted Tool');
    expect(ctx.compactionSummary).toContain('tool-xyz');
  });

  it('handles empty goal and empty pendingSteps', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      goal: undefined,
      pendingSteps: [],
    }));
    expect(ctx.goal).toBe('');
    expect(ctx.pendingSteps).toEqual([]);
    expect(ctx.compactionSummary).toBe('');
  });

  it('includes toolNamesInvolved when present on snapshot', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      toolNamesInvolved: ['Bash', 'Read'],
    }));
    expect(ctx.toolNamesInvolved).toEqual(['Bash', 'Read']);
  });

  it('omits toolNamesInvolved when not present on snapshot', () => {
    const ctx = buildRecoveryContext(makeSnapshot());
    expect(ctx.toolNamesInvolved).toBeUndefined();
  });

  it('includes toolNamesInvolved alongside pending side-effect recovery', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'pending',
      pendingToolCallId: 'tool-abc',
      toolNamesInvolved: ['Edit', 'Bash'],
    }));
    expect(ctx.toolNamesInvolved).toEqual(['Edit', 'Bash']);
    expect(ctx.idempotencyGuide).toBeDefined();
    expect(ctx.priority).toBe('idempotent-first');
  });
});

describe('buildIdempotencyInjection', () => {
  it('returns undefined when no idempotencyGuide', () => {
    const ctx = buildRecoveryContext(makeSnapshot());
    expect(buildIdempotencyInjection(ctx)).toBeUndefined();
  });

  it('returns verify string when idempotencyGuide exists', () => {
    const ctx = buildRecoveryContext(makeSnapshot({
      sideEffectState: 'pending',
      pendingToolCallId: 'tool-abc',
    }));
    const injection = buildIdempotencyInjection(ctx);
    expect(injection).toBeDefined();
    expect(injection).toContain('[VERIFY]');
    expect(injection).toContain('tool-abc');
  });
});

describe('buildRecoveryInjection', () => {
  it('returns undefined when compactionSummary is empty', () => {
    const ctx = buildRecoveryContext(makeSnapshot({ goal: undefined, pendingSteps: [] }));
    expect(buildRecoveryInjection(ctx)).toBeUndefined();
  });

  it('returns compaction recovery text when summary exists', () => {
    const ctx = buildRecoveryContext(makeSnapshot());
    const injection = buildRecoveryInjection(ctx);
    expect(injection).toBeDefined();
    expect(injection).toContain('Compaction Recovery');
    expect(injection).toContain('Implement feature X');
  });
});
