/**
 * ContextBudgetManager — 토큰 예산 평가 및 비상 턴 분할.
 *
 * "계" 사망 사건의 직접 원인: 하드 리밋(95%) 돌파 시 모델이 panic하여
 * 즉흥적 종료(계 → end_turn). 이 모듈은 토큰 예산을 5단계로 평가하고,
 * 비상 시 안전한 턴 분할(emergency cleaving)을 수행한다.
 *
 * 평가 5단계:
 * 1. ALLOW      — 예산 내 안전 (≤ softLimit)
 * 2. WARN       — 예산 경고 (softLimit ~ 90%)
 * 3. SOFT_COMPACT — 소프트 컴팩션 권장 (90% ~ 95%)
 * 4. EMERGENCY_CLEAVE — 🚨 비상 턴 분할 (95% ~ hardLimit)
 * 5. HARD_STOP  — 하드 스톱 (≥ hardLimit) — 더 이상 진행 불가
 *
 * Integration points:
 * - ContextMemory.tokenCountWithPending — 실시간 토큰 추적
 * - FullCompaction.strategy — 기존 compaction과 병렬 동작
 * - TurnBoundary — 비상 턴 분할 시 AbortController + 복구 스냅샷
 * - InjectionManager — idempotencyGuide 주입 채널
 */

import type { TurnBoundary } from './turn-boundary';
import type { CheckpointStore, TurnContextSnapshot } from './checkpoint';
import {
  buildRecoveryContext,
  buildIdempotencyInjection,
  buildRecoveryInjection,
  type RecoveryContext,
} from './hydrator';

export const BudgetAction = {
  ALLOW: 'allow',
  WARN: 'warn',
  SOFT_COMPACT: 'soft_compact',
  EMERGENCY_CLEAVE: 'emergency_cleave',
  HARD_STOP: 'hard_stop',
} as const;

export type BudgetAction = (typeof BudgetAction)[keyof typeof BudgetAction];

export interface BudgetEvaluation {
  readonly action: BudgetAction;
  readonly usedTokens: number;
  readonly limit: number;
  readonly ratio: number;
  readonly message?: string;
}

export interface BudgetConfig {
  /** 하드 리밋 — 이 이상은 절대 진행 불가. 기본 100,000 */
  readonly hardLimit: number;
  /** 소프트 리밋 — 경고 시작점. 기본 70,000 */
  readonly softLimit: number;
  /** 안전 마진 — 하드 리밋과의 거리. 기본 20,000 */
  readonly safetyMargin: number;
  /** 비상 임계 비율 — 하드 리밋 대비 비상 분할 시작점. 기본 0.95 */
  readonly emergencyThresholdRatio: number;
  /**
   * 토큰 버퍼 비율 — estimateTokens의 휴리스틱 오차 보정.
   * 기본 0.05 (5%). 통합 테스트 시 벤치마크하여 0.02 (2%)까지 낮출 수 있다.
   */
  readonly tokenBufferRatio: number;
  /** 서브에이전트에 할당할 비율. 기본 0.3 */
  readonly subagentBudgetRatio: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  hardLimit: 100_000,
  softLimit: 70_000,
  safetyMargin: 20_000,
  emergencyThresholdRatio: 0.95,
  tokenBufferRatio: 0.05,
  subagentBudgetRatio: 0.3,
};

export class ContextBudgetManager {
  private config: BudgetConfig;
  private _lastAction: BudgetAction = 'allow';
  private _emergencyCleaveCount = 0;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * 현재 토큰 사용량을 평가하여 적절한 액션을 반환한다.
   *
   * @param usedTokens 실시간 토큰 사용량 (ContextMemory.tokenCountWithPending 등)
   * @param bufferApplied 이미 버퍼가 적용되었는지 여부
   */
  checkBudget(usedTokens: number, bufferApplied = false): BudgetEvaluation {
    // 버퍼 적용: estimateTokens의 휴리스틱 오차 보정
    const adjustedTokens = bufferApplied
      ? usedTokens
      : Math.ceil(usedTokens * (1 + this.config.tokenBufferRatio));

    const ratio = adjustedTokens / this.config.hardLimit;
    const hardThreshold = this.config.hardLimit;
    const emergencyThreshold = this.config.hardLimit * this.config.emergencyThresholdRatio;
    const softCompactThreshold = this.config.hardLimit * 0.90;
    const softLimit = this.config.softLimit;

    let action: BudgetAction;
    let message: string | undefined;

    if (adjustedTokens >= hardThreshold) {
      action = BudgetAction.HARD_STOP;
      message = `Hard token limit reached (${adjustedTokens}/${hardThreshold}). Cannot proceed.`;
    } else if (adjustedTokens >= emergencyThreshold) {
      action = BudgetAction.EMERGENCY_CLEAVE;
      message = `Emergency: ${ratio.toFixed(1)}% of hard limit. Initiating emergency turn cleaving.`;
    } else if (adjustedTokens >= softCompactThreshold) {
      action = BudgetAction.SOFT_COMPACT;
      message = `Context at ${ratio.toFixed(1)}%. Soft compaction recommended.`;
    } else if (adjustedTokens >= softLimit) {
      action = BudgetAction.WARN;
      message = `Context at ${ratio.toFixed(1)}%. Approaching limits.`;
    } else {
      action = BudgetAction.ALLOW;
    }

    this._lastAction = action;
    return { action, usedTokens: adjustedTokens, limit: this.config.hardLimit, ratio, message };
  }

  /**
   * Emergency Turn Cleaving — 비상 턴 분할 수행.
   *
   * 1. AbortController로 진행 중인 I/O 안전 취소
   * 2. 턴 상태 스냅샷 보존 (CheckpointStore)
   * 3. compaction 실행 유도
   * 4. idempotencyGuide 생성 (side-effect 도구 보호)
   *
   * @returns 복구 컨텍스트 — caller가 appendSystemReminder로 주입
   */
  async emergencyCleave(
    boundary: TurnBoundary,
    checkpointStore: CheckpointStore,
    agentId: string,
    goal?: string,
    pendingSteps?: readonly string[],
    pendingToolCallId?: string,
  ): Promise<RecoveryContext> {
    this._emergencyCleaveCount++;

    // 1. 비상 턴 분할 — AbortController로 I/O 취소
    const { snapshot } = boundary.cleave();

    // 2. 턴 상태 스냅샷 보존
    const contextSnapshot: TurnContextSnapshot = {
      turnState: snapshot,
      agentId,
      turnId: snapshot.turnId,
      pendingToolCallId,
      pendingSteps: pendingSteps ? [...pendingSteps] : [],
      goal,
      sideEffectState: pendingToolCallId ? 'pending' : (pendingSteps && pendingSteps.length > 0 ? 'pending' : 'none'),
      timestamp: Date.now(),
    };
    await checkpointStore.save(contextSnapshot);

    // 3. 복구 컨텍스트 생성 (idempotencyGuide 포함)
    return buildRecoveryContext(contextSnapshot);
  }

  /**
   * 복구 컨텍스트에서 appendSystemReminder용 주입 문자열 쌍을 반환한다.
   *
   * caller는 우선순위에 따라:
   *   1. idempotency (highest priority) → appendSystemReminder(text, { kind: 'injection', variant: 'idempotency-guide' })
   *   2. recovery (high priority) → appendSystemReminder(text, { kind: 'injection', variant: 'compaction-recovery' })
   * 순서로 주입해야 한다.
   */
  getInjections(recoveryContext: RecoveryContext): {
    idempotency?: string;
    recovery?: string;
  } {
    return {
      idempotency: buildIdempotencyInjection(recoveryContext),
      recovery: buildRecoveryInjection(recoveryContext),
    };
  }

  /**
   * 서브에이전트에 할당할 예산을 계산한다.
   */
  getSubagentBudget(): number {
    return Math.floor(this.config.hardLimit * this.config.subagentBudgetRatio);
  }

  /**
   * 현재 설정을 반환한다.
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * 마지막 평가 액션을 반환한다.
   */
  getLastAction(): BudgetAction {
    return this._lastAction;
  }

  /**
   * 비상 분할 횟수를 반환한다.
   */
  getEmergencyCleaveCount(): number {
    return this._emergencyCleaveCount;
  }

  /**
   * 설정을 업데이트한다 (런타임 조정용).
   */
  updateConfig(partial: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
