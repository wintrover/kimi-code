/**
 * PipelineServices — dependencies for the step middleware pipeline.
 *
 * Decouples the middleware pipeline from Agent's internal structure,
 * making the pipeline testable with mocks (no real Agent/Session needed).
 */

import type { ContextBudgetManager } from '#/session/context-budget';
import type { TurnBoundary } from '#/session/turn-boundary';
import type { CheckpointStore } from '#/session/checkpoint';
import type { RecoveryPolicy } from '#/session/recovery-policy';

export interface PipelineServices {
  readonly budgetManager: ContextBudgetManager;
  readonly turnBoundary: TurnBoundary;
  readonly checkpointStore: CheckpointStore;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly agentId: string;
}
