/**
 * Turn State Machine — 턴의 생명주기를 명시적 상태 전이로 관리.
 *
 * "계" 사망 사건의 구조적 원인 중 하나인 "턴 상태기 부재"를 해결하기 위해,
 * 턴의 각 단계를 명시적 상태로 추적하고, 허용된 전이만 허용한다.
 *
 * LangGraph의 StateGraph + 노드/엣그래프 패턴에서 영감.
 */

export const TurnPhase = {
  IDLE: 'idle',
  RECEIVING: 'receiving',       // 사용자 메시지 수신 중
  PLANNING: 'planning',         // plan-mode 계획 작성 중
  EXECUTING: 'executing',       // 도구 호출 실행 중
  TOOL_CALLING: 'tool_calling', // 개별 도구 호출 진행 중
  COMPACTING: 'compacting',     // compaction 진행 중
  EMERGENCY_CLEAVING: 'emergency_cleaving', // 🚨 하드 리밋 돌파 — 강제 턴 분할
  RECOVERING: 'recovering',     // compaction 복구 중
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

/**
 * 허용되는 상태 전이 그래프.
 * 정의되지 않은 전이는 transition() 호출 시 에러를 발생시킨다.
 */
const VALID_TRANSITIONS: Record<TurnPhase, readonly TurnPhase[]> = {
  idle:                ['receiving'],
  receiving:           ['planning', 'executing', 'completed', 'failed'],
  planning:            ['executing', 'completed', 'failed'],
  executing:           ['tool_calling', 'compacting', 'emergency_cleaving', 'completed', 'failed'],
  tool_calling:        ['executing', 'compacting', 'emergency_cleaving', 'completed', 'failed'],
  compacting:          ['recovering', 'failed'],
  emergency_cleaving:  ['recovering', 'failed'],
  recovering:          ['executing', 'completed', 'failed'],
  completed:           ['idle'],
  failed:              ['idle'],
};

export interface PhaseHistoryEntry {
  readonly phase: TurnPhase;
  readonly at: number;
}

export interface TurnStateSnapshot {
  readonly phase: TurnPhase;
  readonly turnId: number;
  readonly history: readonly PhaseHistoryEntry[];
}

export class TurnStateMachine {
  private phase: TurnPhase = 'idle';
  private turnId: number = 0;
  private phaseHistory: PhaseHistoryEntry[] = [];

  /**
   * 상태를 전이한다.
   * @throws 유효하지 않은 전이 시 Error 발생
   */
  transition(to: TurnPhase): void {
    const allowed = VALID_TRANSITIONS[this.phase];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid turn state transition: ${this.phase} → ${to}`);
    }
    this.phase = to;
    this.phaseHistory.push({ phase: to, at: Date.now() });
  }

  /**
   * compaction이 안전하게 허용되는 상태인지 확인한다.
   * tool_calling 중에는 compaction을 허용하지 않는다.
   */
  canCompact(): boolean {
    return this.phase === 'executing' || this.phase === 'idle';
  }

  /**
   * 턴이 진행 중인지 확인한다.
   * idle, completed, failed 상태는 턴이 아닌 것으로 간주한다.
   */
  isMidTurn(): boolean {
    return !['idle', 'completed', 'failed'].includes(this.phase);
  }

  /**
   * 현재 턴 ID를 반환한다.
   */
  getTurnId(): number {
    return this.turnId;
  }

  /**
   * 새 턴을 시작한다. IDLE 상태에서만 호출 가능하다.
   */
  startTurn(): void {
    this.transition('receiving');
    this.turnId++;
    this.phaseHistory = [{ phase: 'receiving', at: Date.now() }];
  }

  /**
   * 현재 상태의 스냅샷을 반환한다.
   */
  getSnapshot(): TurnStateSnapshot {
    return {
      phase: this.phase,
      turnId: this.turnId,
      history: [...this.phaseHistory],
    };
  }

  /**
   * 현재 phase를 반환한다.
   */
  getPhase(): TurnPhase {
    return this.phase;
  }

  /**
   * 상태를 리셋한다 (테스트용).
   */
  reset(): void {
    this.phase = 'idle';
    this.turnId = 0;
    this.phaseHistory = [];
  }
}
