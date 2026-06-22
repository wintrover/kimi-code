/**
 * DeterministicHydrator — compaction 복구 컨텍스트 생성.
 *
 * compaction 후 세션 복구 시, 충분한 컨텍스트를 재구성하여
 * "계" 같은 즉흥적 종료를 방지한다.
 *
 * 핵심 특징:
 * - idempotencyGuide: side-effect 도구 실행 중단 시 [VERIFY] 단계를 pendingSteps[0]에 주입
 * - priority 기반 컨텍스트 조립: idempotencyGuide > goal/steps > interrupted tool > compaction summary
 * - 반환 문자열은 기존 DynamicInjector 패턴에 맞춰
 *   `agent.context.appendSystemReminder(text, origin)`으로 주입한다.
 */

import type { TurnContextSnapshot } from './checkpoint';

export interface RecoveryContext {
  readonly goal: string;
  readonly pendingSteps: readonly string[];
  readonly interruptedTool?: string;
  readonly idempotencyGuide?: string;
  readonly compactionSummary: string;
  readonly priority: 'idempotent-first' | 'default';
  /** Tool names that were involved during the compacted turn. */
  readonly toolNamesInvolved?: readonly string[];
}

/**
 * 복구 컨텍스트를 구성한다.
 *
 * priority 순서 (높은 것이 먼저):
 * 1. idempotencyGuide — side-effect 도구 중단 시 [VERIFY] 가이드
 * 2. goal + pendingSteps — 원래 작업 목표와 남은 단계
 * 3. interrupted tool — 중단된 도구 호출 정보
 * 4. compaction summary — compaction 요약
 */
export function buildRecoveryContext(snapshot: TurnContextSnapshot): RecoveryContext {
  const parts: string[] = [];
  let idempotencyGuide: string | undefined;

  // idempotency guide: side-effect가 pending 상태면 [VERIFY] 단계 삽입
  if (snapshot.sideEffectState === 'pending' && snapshot.pendingToolCallId) {
    const verifyStep = [
      `[VERIFY] Tool "${snapshot.pendingToolCallId}" execution was interrupted.`,
      'Before proceeding, verify its partial effects:',
      'check if the file was partially written, the edit was applied,',
      'or the command produced side-effects.',
      'Re-run the tool with idempotent parameters if needed.',
    ].join(' ');
    idempotencyGuide = verifyStep;
  }

  // goal + steps
  if (snapshot.goal) {
    parts.push(`## Goal\n${snapshot.goal}`);
  }
  if (snapshot.pendingSteps.length > 0) {
    parts.push(`## Pending Steps\n${snapshot.pendingSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }

  // interrupted tool
  if (snapshot.pendingToolCallId && snapshot.sideEffectState !== 'none') {
    parts.push(`## Interrupted Tool\nTool call "${snapshot.pendingToolCallId}" was in progress when compaction occurred.`);
  }

  const compactionSummary = parts.join('\n\n');
  const priority = idempotencyGuide ? 'idempotent-first' : 'default';

  return {
    goal: snapshot.goal ?? '',
    pendingSteps: [...snapshot.pendingSteps],
    interruptedTool: snapshot.pendingToolCallId,
    idempotencyGuide,
    compactionSummary,
    priority,
    toolNamesInvolved: snapshot.toolNamesInvolved,
  };
}

/**
 * RecoveryContext에서 idempotency guide 주입 문자열을 반환한다.
 * 반환값은 `agent.context.appendSystemReminder(result, { kind: 'injection', variant: 'idempotency-guide' })`으로 주입한다.
 *
 * 없으면 undefined 반환.
 */
export function buildIdempotencyInjection(context: RecoveryContext): string | undefined {
  return context.idempotencyGuide;
}

/**
 * RecoveryContext에서 compaction recovery 주입 문자열을 반환한다.
 * 반환값은 `agent.context.appendSystemReminder(result, { kind: 'injection', variant: 'compaction-recovery' })`으로 주입한다.
 */
export function buildRecoveryInjection(context: RecoveryContext): string | undefined {
  if (!context.compactionSummary) return undefined;
  return `## Compaction Recovery\n\nThis turn was compacted. Here is the recovery context:\n\n${context.compactionSummary}`;
}
