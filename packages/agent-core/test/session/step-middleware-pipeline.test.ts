import { describe, expect, it, vi } from 'vitest';

import {
  BudgetMiddleware,
  RecoveryMiddleware,
  runBeforeStepPipeline,
  type StepContext,
  type StepMiddleware,
  type StepMiddlewareResult,
} from '#/session/step-middleware';
import type { ContextBudgetManager } from '#/session/context-budget';
import type { TurnBoundary } from '#/session/turn-boundary';
import type { CheckpointStore } from '#/session/checkpoint';
import type { RecoveryPolicy } from '#/session/recovery-policy';
import type { PipelineServices } from '#/agent/turn/pipeline-services';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    signal: new AbortController().signal,
    tokenCount: 10_000,
    turnId: 1,
    ...overrides,
  };
}

function createMockMiddleware(
  name: string,
  result: StepMiddlewareResult,
): StepMiddleware {
  return {
    name,
    process: vi.fn().mockResolvedValue(result),
  };
}

function createFailingMiddleware(name: string, error?: unknown): StepMiddleware {
  return {
    name,
    process: vi.fn().mockRejectedValue(error ?? new Error(`${name} failed`)),
  };
}

function createMockServices(
  overrides: Partial<PipelineServices> = {},
): PipelineServices {
  return {
    budgetManager: {
      checkBudget: vi.fn().mockReturnValue({ action: 'allow' }),
    } as unknown as ContextBudgetManager,
    turnBoundary: {} as unknown as TurnBoundary,
    checkpointStore: {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    } as unknown as CheckpointStore,
    recoveryPolicy: {
      evaluate: vi.fn().mockReturnValue({ shouldInject: false, injections: [] }),
    } as unknown as RecoveryPolicy,
    agentId: 'test-agent',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — runBeforeStepPipeline (pure pipeline runner)
// ---------------------------------------------------------------------------

describe('runBeforeStepPipeline', () => {
  it('returns continue when all middleware pass', async () => {
    const pipeline = [
      createMockMiddleware('a', { action: 'continue' }),
      createMockMiddleware('b', { action: 'continue' }),
      createMockMiddleware('c', { action: 'continue' }),
    ];
    const result = await runBeforeStepPipeline(pipeline, createCtx());
    expect(result.action).toBe('continue');
  });

  it('executes middleware in order', async () => {
    const order: string[] = [];
    const pipeline: StepMiddleware[] = [
      {
        name: 'first',
        process: vi.fn().mockImplementation(async () => {
          order.push('first');
          return { action: 'continue' as const };
        }),
      },
      {
        name: 'second',
        process: vi.fn().mockImplementation(async () => {
          order.push('second');
          return { action: 'continue' as const };
        }),
      },
      {
        name: 'third',
        process: vi.fn().mockImplementation(async () => {
          order.push('third');
          return { action: 'continue' as const };
        }),
      },
    ];
    await runBeforeStepPipeline(pipeline, createCtx());
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('short-circuits on halt', async () => {
    const third = createMockMiddleware('c', { action: 'continue' });
    const pipeline = [
      createMockMiddleware('a', { action: 'continue' }),
      createMockMiddleware('b', { action: 'halt' }),
      third,
    ];
    const result = await runBeforeStepPipeline(pipeline, createCtx());
    expect(result.action).toBe('halt');
    expect(third.process).not.toHaveBeenCalled();
  });

  it('short-circuits on cleave', async () => {
    const third = createMockMiddleware('c', { action: 'continue' });
    const pipeline = [
      createMockMiddleware('a', { action: 'continue' }),
      createMockMiddleware('b', { action: 'cleave' }),
      third,
    ];
    const result = await runBeforeStepPipeline(pipeline, createCtx());
    expect(result.action).toBe('cleave');
    expect(third.process).not.toHaveBeenCalled();
  });

  it('continues past a failing middleware when signal is not aborted', async () => {
    const fallback = createMockMiddleware('fallback', { action: 'continue' });
    const pipeline = [
      createFailingMiddleware('broken'),
      fallback,
    ];
    const onError = vi.fn();
    const result = await runBeforeStepPipeline(pipeline, createCtx(), onError);
    expect(result.action).toBe('continue');
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
    expect(fallback.process).toHaveBeenCalled();
  });

  it('halts when a middleware throws and signal is aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const pipeline = [
      createFailingMiddleware('broken'),
      createMockMiddleware('never', { action: 'continue' }),
    ];
    const onError = vi.fn();
    const result = await runBeforeStepPipeline(
      pipeline,
      createCtx({ signal: abortController.signal }),
      onError,
    );
    expect(result.action).toBe('halt');
  });

  it('forwards recoveryInjections from middleware result', async () => {
    const pipeline = [
      createMockMiddleware('recovery', {
        action: 'continue',
        recoveryInjections: ['injection-a', 'injection-b'],
      }),
    ];
    const result = await runBeforeStepPipeline(pipeline, createCtx());
    expect(result.action).toBe('continue');
    expect(result.recoveryInjections).toEqual(['injection-a', 'injection-b']);
  });

  it('reports multiple errors without crashing', async () => {
    const pipeline = [
      createFailingMiddleware('err-a'),
      createFailingMiddleware('err-b'),
      createMockMiddleware('ok', { action: 'continue' }),
    ];
    const onError = vi.fn();
    const result = await runBeforeStepPipeline(pipeline, createCtx(), onError);
    expect(result.action).toBe('continue');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith('err-a', expect.any(Error));
    expect(onError).toHaveBeenCalledWith('err-b', expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// Tests — BudgetMiddleware with mock services
// ---------------------------------------------------------------------------

describe('BudgetMiddleware', () => {
  it('returns continue when budget is within limits', async () => {
    const services = createMockServices();
    (services.budgetManager.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      action: 'allow',
      usedTokens: 50_000,
      limit: 100_000,
      ratio: 0.5,
    });
    const mw = new BudgetMiddleware(
      services.budgetManager,
      services.turnBoundary,
      services.checkpointStore,
    );
    const result = await mw.process(createCtx({ tokenCount: 50_000 }));
    expect(result.action).toBe('continue');
  });

  it('returns cleave on emergency_cleave', async () => {
    const services = createMockServices();
    (services.budgetManager.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      action: 'emergency_cleave',
      usedTokens: 96_000,
      limit: 100_000,
      ratio: 0.96,
    });
    const mw = new BudgetMiddleware(
      services.budgetManager,
      services.turnBoundary,
      services.checkpointStore,
    );
    const result = await mw.process(createCtx({ tokenCount: 96_000 }));
    expect(result.action).toBe('cleave');
  });

  it('returns cleave on hard_stop', async () => {
    const services = createMockServices();
    (services.budgetManager.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      action: 'hard_stop',
      usedTokens: 100_000,
      limit: 100_000,
      ratio: 1.0,
    });
    const mw = new BudgetMiddleware(
      services.budgetManager,
      services.turnBoundary,
      services.checkpointStore,
    );
    const result = await mw.process(createCtx({ tokenCount: 100_000 }));
    expect(result.action).toBe('cleave');
  });

  it('passes tokenCount to checkBudget', async () => {
    const services = createMockServices();
    (services.budgetManager.checkBudget as ReturnType<typeof vi.fn>).mockReturnValue({
      action: 'allow',
      usedTokens: 30_000,
      limit: 100_000,
      ratio: 0.3,
    });
    const mw = new BudgetMiddleware(
      services.budgetManager,
      services.turnBoundary,
      services.checkpointStore,
    );
    await mw.process(createCtx({ tokenCount: 30_000 }));
    expect(services.budgetManager.checkBudget).toHaveBeenCalledWith(30_000);
  });
});

// ---------------------------------------------------------------------------
// Tests — RecoveryMiddleware with mock services
// ---------------------------------------------------------------------------

describe('RecoveryMiddleware', () => {
  it('returns continue with no injections when no snapshot', async () => {
    const services = createMockServices();
    const mw = new RecoveryMiddleware(
      services.recoveryPolicy,
      services.checkpointStore,
      services.agentId,
    );
    const result = await mw.process(createCtx());
    expect(result.action).toBe('continue');
    expect(result.recoveryInjections).toBeUndefined();
    expect(services.checkpointStore.load).toHaveBeenCalledWith('test-agent');
  });

  it('returns injections when recovery policy decides to inject', async () => {
    const services = createMockServices();
    (services.recoveryPolicy.evaluate as ReturnType<typeof vi.fn>).mockReturnValue({
      shouldInject: true,
      injections: ['recovery-instruction-1', 'recovery-instruction-2'],
    });
    const mw = new RecoveryMiddleware(
      services.recoveryPolicy,
      services.checkpointStore,
      services.agentId,
    );
    const result = await mw.process(createCtx());
    expect(result.action).toBe('continue');
    expect(result.recoveryInjections).toEqual([
      'recovery-instruction-1',
      'recovery-instruction-2',
    ]);
  });

  it('passes loaded snapshot to recovery policy', async () => {
    const services = createMockServices();
    const fakeSnapshot = { agentId: 'test-agent', turnId: 1 } as any;
    (services.checkpointStore.load as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSnapshot);
    const mw = new RecoveryMiddleware(
      services.recoveryPolicy,
      services.checkpointStore,
      services.agentId,
    );
    await mw.process(createCtx());
    expect(services.recoveryPolicy.evaluate).toHaveBeenCalledWith(fakeSnapshot);
  });

  it('passes null to recovery policy when no snapshot', async () => {
    const services = createMockServices();
    (services.checkpointStore.load as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const mw = new RecoveryMiddleware(
      services.recoveryPolicy,
      services.checkpointStore,
      services.agentId,
    );
    await mw.process(createCtx());
    expect(services.recoveryPolicy.evaluate).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// Tests — PipelineServices interface contract
// ---------------------------------------------------------------------------

describe('PipelineServices', () => {
  it('can create a PipelineServices with mock objects', () => {
    const services = createMockServices();
    expect(services.budgetManager).toBeDefined();
    expect(services.turnBoundary).toBeDefined();
    expect(services.checkpointStore).toBeDefined();
    expect(services.recoveryPolicy).toBeDefined();
    expect(services.agentId).toBe('test-agent');
  });
});
