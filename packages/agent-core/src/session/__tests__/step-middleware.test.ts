import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { FullCompaction } from '#/agent/compaction/full';
import type { ContextBudgetManager } from '#/session/context-budget';
import type { TurnBoundary } from '#/session/turn-boundary';
import type { CheckpointStore } from '#/session/checkpoint';
import type { RecoveryPolicy } from '#/session/recovery-policy';

import {
  CompactionMiddleware,
  BudgetMiddleware,
  RecoveryMiddleware,
  runBeforeStepPipeline,
  type StepContext,
  type StepMiddleware,
  type StepMiddlewareResult,
} from '#/session/step-middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    signal: new AbortController().signal,
    tokenCount: 10_000,
    turnId: 1,
    ...overrides,
  };
}

function abortedCtx(): StepContext {
  const controller = new AbortController();
  controller.abort();
  return { signal: controller.signal, tokenCount: 10_000, turnId: 1 };
}

function makeMiddleware(
  name: string,
  result: StepMiddlewareResult,
  shouldThrow?: boolean,
): StepMiddleware {
  return {
    name,
    process: shouldThrow
      ? vi.fn().mockRejectedValue(new Error(`${name} failed`))
      : vi.fn().mockResolvedValue(result),
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function mockFullCompaction(beforeStepResult: unknown): FullCompaction {
  return {
    beforeStep: vi.fn().mockResolvedValue(beforeStepResult),
  } as unknown as FullCompaction;
}

function mockBudgetManager(
  action: 'allow' | 'warn' | 'soft_compact' | 'emergency_cleave' | 'hard_stop',
): ContextBudgetManager {
  return {
    checkBudget: vi.fn().mockReturnValue({
      action,
      usedTokens: 0,
      limit: 100_000,
      ratio: 0,
    }),
  } as unknown as ContextBudgetManager;
}

function mockTurnBoundary(): TurnBoundary {
  return {} as TurnBoundary;
}

function mockCheckpointStoreForBudget(): CheckpointStore {
  return {} as CheckpointStore;
}

function mockCheckpointStore(loadResult: unknown): CheckpointStore {
  return {
    save: vi.fn(),
    load: vi.fn().mockResolvedValue(loadResult),
    clear: vi.fn(),
  };
}

function mockRecoveryPolicy(decision: {
  shouldInject: boolean;
  injections: readonly string[];
}): RecoveryPolicy {
  return {
    evaluate: vi.fn().mockReturnValue(decision),
    evaluateAfterCompaction: vi.fn().mockReturnValue(decision),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompactionMiddleware', () => {
  it('returns continue when no compaction needed', async () => {
    const fc = mockFullCompaction({ action: 'continue' });
    const middleware = new CompactionMiddleware(fc);
    const result = await middleware.process(makeCtx());

    expect(result).toEqual({ action: 'continue' });
    expect(fc.beforeStep).toHaveBeenCalledOnce();
  });

  it('returns halt when compaction is blocking', async () => {
    const fc = mockFullCompaction({ action: 'blocked' });
    const middleware = new CompactionMiddleware(fc);
    const result = await middleware.process(makeCtx());

    expect(result).toEqual({ action: 'halt' });
    expect(fc.beforeStep).toHaveBeenCalledOnce();
  });

  it('returns continue when compaction is compacting', async () => {
    const fc = mockFullCompaction({ action: 'compacting' });
    const middleware = new CompactionMiddleware(fc);
    const result = await middleware.process(makeCtx());

    expect(result).toEqual({ action: 'continue' });
  });
});

describe('BudgetMiddleware', () => {
  let boundary: TurnBoundary;
  let checkpointStore: CheckpointStore;

  beforeEach(() => {
    boundary = mockTurnBoundary();
    checkpointStore = mockCheckpointStoreForBudget();
  });

  it('returns continue when budget is OK', async () => {
    const bm = mockBudgetManager('allow');
    const middleware = new BudgetMiddleware(bm, boundary, checkpointStore);
    const result = await middleware.process(makeCtx({ tokenCount: 50_000 }));

    expect(result).toEqual({ action: 'continue' });
    expect(bm.checkBudget).toHaveBeenCalledWith(50_000);
  });

  it('returns cleave when emergency threshold exceeded', async () => {
    const bm = mockBudgetManager('emergency_cleave');
    const middleware = new BudgetMiddleware(bm, boundary, checkpointStore);
    const result = await middleware.process(makeCtx({ tokenCount: 95_000 }));

    expect(result).toEqual({ action: 'cleave' });
    expect(bm.checkBudget).toHaveBeenCalledWith(95_000);
  });

  it('returns cleave on hard_stop', async () => {
    const bm = mockBudgetManager('hard_stop');
    const middleware = new BudgetMiddleware(bm, boundary, checkpointStore);
    const result = await middleware.process(makeCtx({ tokenCount: 100_000 }));

    expect(result).toEqual({ action: 'cleave' });
  });

  it('returns continue on soft_compact', async () => {
    const bm = mockBudgetManager('soft_compact');
    const middleware = new BudgetMiddleware(bm, boundary, checkpointStore);
    const result = await middleware.process(makeCtx({ tokenCount: 90_000 }));

    expect(result).toEqual({ action: 'continue' });
  });

  it('returns continue on warn', async () => {
    const bm = mockBudgetManager('warn');
    const middleware = new BudgetMiddleware(bm, boundary, checkpointStore);
    const result = await middleware.process(makeCtx({ tokenCount: 70_000 }));

    expect(result).toEqual({ action: 'continue' });
  });
});

describe('RecoveryMiddleware', () => {
  it('returns continue with no injections when no snapshot exists', async () => {
    const store = mockCheckpointStore(undefined);
    const policy = mockRecoveryPolicy({ shouldInject: false, injections: [] });
    const middleware = new RecoveryMiddleware(policy, store, 'agent-0');
    const result = await middleware.process(makeCtx());

    expect(result).toEqual({ action: 'continue' });
    expect(store.load).toHaveBeenCalledWith('agent-0');
    expect(policy.evaluate).toHaveBeenCalledWith(null);
  });

  it('returns continue with injections when snapshot exists', async () => {
    const snapshot = { agentId: 'agent-0', turnId: 1 } as never;
    const injections = ['recovery-hint-1', 'recovery-hint-2'];
    const store = mockCheckpointStore(snapshot);
    const policy = mockRecoveryPolicy({ shouldInject: true, injections });
    const middleware = new RecoveryMiddleware(policy, store, 'agent-0');
    const result = await middleware.process(makeCtx());

    expect(result).toEqual({
      action: 'continue',
      recoveryInjections: ['recovery-hint-1', 'recovery-hint-2'],
    });
    expect(store.load).toHaveBeenCalledWith('agent-0');
    expect(policy.evaluate).toHaveBeenCalledWith(snapshot);
  });

  it('never halts even when recovery decision is severe', async () => {
    const store = mockCheckpointStore({ agentId: 'x' } as never);
    const policy = mockRecoveryPolicy({ shouldInject: true, injections: ['critical-fix'] });
    const middleware = new RecoveryMiddleware(policy, store, 'agent-0');
    const result = await middleware.process(makeCtx());

    expect(result.action).toBe('continue');
  });
});

describe('runBeforeStepPipeline', () => {
  it('logs error and continues on middleware failure', async () => {
    const errorHandler = vi.fn();
    const failing = makeMiddleware('failing', { action: 'continue' }, true);
    const next = makeMiddleware('next', { action: 'continue' });

    const result = await runBeforeStepPipeline([failing, next], makeCtx(), errorHandler);

    expect(errorHandler).toHaveBeenCalledWith('failing', expect.any(Error));
    expect(result).toEqual({ action: 'continue' });
  });

  it('returns halt when signal is aborted during middleware error', async () => {
    const ctx = abortedCtx();
    const errorHandler = vi.fn();
    const failing = makeMiddleware('failing', { action: 'continue' }, true);

    const result = await runBeforeStepPipeline([failing], ctx, errorHandler);

    expect(result).toEqual({ action: 'halt' });
    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('respects ordering guarantee: Compaction → Budget → Recovery', async () => {
    const order: string[] = [];

    const compaction: StepMiddleware = {
      name: 'compaction',
      process: vi.fn().mockImplementation(async () => {
        order.push('compaction');
        return { action: 'continue' } as StepMiddlewareResult;
      }),
    };

    const budget: StepMiddleware = {
      name: 'budget',
      process: vi.fn().mockImplementation(async () => {
        order.push('budget');
        return { action: 'continue' } as StepMiddlewareResult;
      }),
    };

    const recovery: StepMiddleware = {
      name: 'recovery',
      process: vi.fn().mockImplementation(async () => {
        order.push('recovery');
        return { action: 'continue' } as StepMiddlewareResult;
      }),
    };

    const result = await runBeforeStepPipeline(
      [compaction, budget, recovery],
      makeCtx(),
    );

    expect(order).toEqual(['compaction', 'budget', 'recovery']);
    expect(result).toEqual({ action: 'continue' });
  });

  it('short-circuits on first non-continue action', async () => {
    const order: string[] = [];

    const halting: StepMiddleware = {
      name: 'compaction',
      process: vi.fn().mockImplementation(async () => {
        order.push('compaction');
        return { action: 'halt' } as StepMiddlewareResult;
      }),
    };

    const budget: StepMiddleware = {
      name: 'budget',
      process: vi.fn().mockImplementation(async () => {
        order.push('budget');
        return { action: 'continue' } as StepMiddlewareResult;
      }),
    };

    const result = await runBeforeStepPipeline([halting, budget], makeCtx());

    expect(order).toEqual(['compaction']);
    expect(result).toEqual({ action: 'halt' });
  });

  it('returns continue for empty pipeline', async () => {
    const result = await runBeforeStepPipeline([], makeCtx());
    expect(result).toEqual({ action: 'continue' });
  });

  it('returns the last non-continue result over a continue result', async () => {
    const passThrough: StepMiddleware = {
      name: 'pass-through',
      process: vi.fn().mockResolvedValue({
        action: 'continue',
        recoveryInjections: ['hint-a'],
      }),
    };

    const halting: StepMiddleware = {
      name: 'halting',
      process: vi.fn().mockResolvedValue({
        action: 'halt',
        recoveryInjections: ['hint-b'],
      }),
    };

    const result = await runBeforeStepPipeline([passThrough, halting], makeCtx());

    expect(passThrough.process).toHaveBeenCalledOnce();
    expect(halting.process).toHaveBeenCalledOnce();
    // Pipeline short-circuits on halt, returning that result
    expect(result).toEqual({
      action: 'halt',
      recoveryInjections: ['hint-b'],
    });
  });
});
