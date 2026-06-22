/**
 * StepMiddleware — beforeStep 파이프라인 패턴.
 *
 * 각 턴의 step 전에 실행되는 미들웨어 파이프라인.
 * Compaction → Budget → Recovery 순서로 평가하고,
 * halt/cleave 액션으로 흐름을 제어한다.
 */

import type { FullCompaction } from '#/agent/compaction/full';

import type { ContextBudgetManager } from './context-budget';
import type { TurnBoundary } from './turn-boundary';
import type { CheckpointStore } from './checkpoint';
import type { RecoveryPolicy } from './recovery-policy';

// ---------------------------------------------------------------------------
// Recovery types — imported from actual implementation
// ---------------------------------------------------------------------------

/** Recovery decision returned by RecoveryPolicy.evaluate(). */
export type { RecoveryDecision } from './recovery-policy';

// ---------------------------------------------------------------------------
// Pipeline interfaces
// ---------------------------------------------------------------------------

/** beforeStep 파이프라인의 단계 컨텍스트 */
export interface StepContext {
  readonly signal: AbortSignal;
  readonly tokenCount: number;
  readonly turnId: number;
}

/** 미들웨어 결과 — 파이프라인 흐름 제어 */
export interface StepMiddlewareResult {
  readonly action: 'continue' | 'halt' | 'cleave';
  readonly recoveryInjections?: readonly string[];
}

/** 파이프라인 미들웨어 인터페이스 */
export interface StepMiddleware {
  readonly name: string;
  process(ctx: StepContext): Promise<StepMiddlewareResult>;
}

// ---------------------------------------------------------------------------
// Concrete middleware implementations
// ---------------------------------------------------------------------------

/**
 * CompactionMiddleware — wraps FullCompaction.beforeStep().
 *
 * Maps 'blocked' to 'halt', everything else to 'continue'.
 */
export class CompactionMiddleware implements StepMiddleware {
  readonly name = 'compaction';

  constructor(private readonly fullCompaction: FullCompaction) {}

  async process(ctx: StepContext): Promise<StepMiddlewareResult> {
    const result = await this.fullCompaction.beforeStep(ctx.signal);
    if (result.action === 'blocked') return { action: 'halt' };
    return { action: 'continue' };
  }
}

/**
 * BudgetMiddleware — wraps ContextBudgetManager.checkBudget().
 *
 * Maps 'emergency_cleave' and 'hard_stop' to 'cleave'.
 */
export class BudgetMiddleware implements StepMiddleware {
  readonly name = 'budget';

  constructor(
    private readonly budgetManager: ContextBudgetManager,
    _turnBoundary: TurnBoundary,
    _checkpointStore: CheckpointStore,
  ) {}

  async process(ctx: StepContext): Promise<StepMiddlewareResult> {
    const evaluation = this.budgetManager.checkBudget(ctx.tokenCount);
    if (evaluation.action === 'emergency_cleave' || evaluation.action === 'hard_stop') {
      return { action: 'cleave' };
    }
    return { action: 'continue' };
  }
}

/**
 * RecoveryMiddleware — wraps RecoveryPolicy.evaluate().
 *
 * Always returns 'continue' — it only injects, never halts.
 * The actual injection is handled by TurnFlow.runRecoveryLogic() after the pipeline.
 */
export class RecoveryMiddleware implements StepMiddleware {
  readonly name = 'recovery';

  constructor(
    private readonly recoveryPolicy: RecoveryPolicy,
    private readonly checkpointStore: CheckpointStore,
    private readonly agentId: string,
  ) {}

  async process(_ctx: StepContext): Promise<StepMiddlewareResult> {
    const snapshot = await this.checkpointStore.load(this.agentId);
    const decision = this.recoveryPolicy.evaluate(snapshot ?? null);
    if (decision.shouldInject) {
      return { action: 'continue', recoveryInjections: decision.injections };
    }
    return { action: 'continue' };
  }
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the beforeStep pipeline with robustness (try/catch per middleware).
 *
 * Executes middleware in order. If a middleware returns a non-'continue'
 * action, the pipeline short-circuits. If a middleware throws, the error
 * is reported via onError and the pipeline continues to the next middleware.
 * If the signal is aborted during error handling, the pipeline halts.
 */
export async function runBeforeStepPipeline(
  pipeline: readonly StepMiddleware[],
  ctx: StepContext,
  onError?: (middlewareName: string, error: unknown) => void,
): Promise<StepMiddlewareResult> {
  for (const middleware of pipeline) {
    try {
      const result = await middleware.process(ctx);
      if (result.action !== 'continue') return result;
    } catch (error) {
      onError?.(middleware.name, error);
      if (ctx.signal.aborted) return { action: 'halt' };
    }
  }
  return { action: 'continue' };
}
