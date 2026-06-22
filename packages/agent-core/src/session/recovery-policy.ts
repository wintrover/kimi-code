/**
 * RecoveryPolicy — compaction / emergency cleave 후 복구 주입 결정.
 *
 * Strategy pattern으로 언제, 어떤 복구 컨텍스트를 주입할지 결정한다.
 * - evaluate(): budget cleave 후 복구 주입 결정
 * - evaluateAfterCompaction(): compaction 완료 후 복구 주입 결정
 */

import type { TurnContextSnapshot } from '#/session/checkpoint';
import {
  buildRecoveryContext,
  buildIdempotencyInjection,
  buildRecoveryInjection,
} from '#/session/hydrator';

export interface RecoveryDecision {
  readonly shouldInject: boolean;
  readonly injections: readonly string[];
}

export class RecoveryPolicy {
  /**
   * Budget cleave 후 복구 주입 결정.
   * 스냅샷이 없으면 주입 없음.
   * sideEffectState === 'pending'이면 멱등성 가이드 포함.
   */
  evaluate(snapshot: TurnContextSnapshot | null): RecoveryDecision {
    if (!snapshot) return { shouldInject: false, injections: [] };

    const recovery = buildRecoveryContext(snapshot);
    const injections: string[] = [];

    // Idempotency guide (highest priority)
    const idempotency = buildIdempotencyInjection(recovery);
    if (idempotency) injections.push(idempotency);

    // Recovery context (goal + pending steps + interrupted tool)
    const recoveryText = buildRecoveryInjection(recovery);
    if (recoveryText) injections.push(recoveryText);

    return {
      shouldInject: injections.length > 0,
      injections,
    };
  }

  /**
   * Compaction 완료 후 복구 주입 결정.
   * Immediate Next Action 섹션을 compaction summary에 추가.
   */
  evaluateAfterCompaction(snapshot: TurnContextSnapshot | null): RecoveryDecision {
    if (!snapshot) return { shouldInject: false, injections: [] };

    const recovery = buildRecoveryContext(snapshot);
    const injections: string[] = [];

    // Idempotency guide if side-effect pending
    const idempotency = buildIdempotencyInjection(recovery);
    if (idempotency) injections.push(idempotency);

    // Immediate Next Action section
    if (recovery.pendingSteps.length > 0 || recovery.goal) {
      const parts = ['## ⚠️ Immediate Next Action'];
      if (recovery.goal) parts.push(`- **Goal**: ${recovery.goal}`);
      if (recovery.pendingSteps.length > 0) {
        parts.push(`- **Next Step**: ${recovery.pendingSteps[0]}`);
        if (recovery.pendingSteps.length > 1) {
          parts.push(`- **Pending Steps**: ${recovery.pendingSteps.slice(1).join(', ')}`);
        }
      }
      injections.push(parts.join('\n'));
    }

    return {
      shouldInject: injections.length > 0,
      injections,
    };
  }
}
