/**
 * Turn Boundary — atomic turn lifecycle management.
 *
 * Guards concurrent turn execution, tracks the active turn signal,
 * provides emergency cleaving for hard token limit breaches,
 * and coordinates compaction via request/receipt flow.
 *
 * Replaces the ad-hoc "defer if compaction requested while busy" logic
 * with a structured boundary that never deadlocks.
 */

import { TurnStateMachine } from './turn-state';

export interface TurnBoundaryOptions {
  readonly turnId?: string;
  readonly compactionTimeoutMs?: number;
}

export interface CompactionRequest {
  readonly promise: Promise<void>;
  readonly resolver: () => void;
  readonly rejecter: (err: Error) => void;
}

export class TurnBoundary {
  private _isActive = false;
  private _compactionRequested = false;
  private _compactionRequest: CompactionRequest | undefined;
  private _abortController: AbortController | undefined;
  readonly state: TurnStateMachine;
  private readonly compactionTimeoutMs: number;

  constructor(options: TurnBoundaryOptions = {}) {
    this.state = new TurnStateMachine();
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? 30_000;
  }

  /**
   * 턴 시작. 이미 진행 중이면 false 반환.
   */
  start(): boolean {
    if (this._isActive) return false;
    this._isActive = true;
    this.state.startTurn();
    return true;
  }

  /**
   * 턴 종료. compaction 요청이 pending이면 병합하여 완료.
   */
  async end(): Promise<void> {
    if (!this._isActive) return;

    // compaction 요청이 있으면 먼저 처리 (상태가 허용할 때만)
    if (this._compactionRequested && this._compactionRequest) {
      if (this.state.canCompact()) {
        this.state.transition('compacting');
        await this.compactionRequestWithTimeout();
      } else {
        // 현재 상태에서 compaction 불가 — deferred 요청을 resolve하고 건너뜀
        this._compactionRequest.resolver();
      }
    }

    // compacting/emergency_cleaving 상태에서 recovering으로 먼저 전환
    const phase = this.state.getPhase();
    if (phase === 'compacting' || phase === 'emergency_cleaving') {
      this.state.transition('recovering');
    }

    this.state.transition('completed');
    this.state.transition('idle');
    this._isActive = false;
    this._compactionRequested = false;
    this._compactionRequest = undefined;
    this._abortController = undefined;
  }

  /**
   * 턴을 즉시 취소한다 (에러 포함).
   */
  cancel(error?: Error): void {
    if (!this._isActive) return;
    this._abortController?.abort(error);
    this.state.transition('failed');
    this._isActive = false;
    this._compactionRequested = false;
    this._compactionRequest?.rejecter(error ?? new Error('Turn cancelled'));
    this._compactionRequest = undefined;
  }

  /**
   * compaction을 요청한다.
   * 턴이 진행 중이면 deferred compaction으로 설정하고 Promise를 반환한다.
   * 턴이 진행 중이 아니면 즉시 compaction을 허용한다.
   */
  requestCompaction(): { shouldCompactNow: boolean; waitForTurnComplete?: Promise<void> } {
    if (!this._isActive || !this.state.isMidTurn()) {
      // 턴이 진행 중이 아니면 compaction 즉시 허용
      return { shouldCompactNow: true };
    }

    // 턴 진행 중 — deferred compaction 설정
    if (!this._compactionRequested) {
      this._compactionRequested = true;
      let resolver: () => void;
      let rejecter: (err: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolver = resolve;
        rejecter = reject;
      });
      this._compactionRequest = {
        promise,
        resolver: resolver!,
        rejecter: rejecter!,
      };
    }

    return {
      shouldCompactNow: false,
      waitForTurnComplete: this._compactionRequest!.promise,
    };
  }

  /**
   * compaction이 요청되었는지 확인한다.
   */
  get compactionRequested(): boolean {
    return this._compactionRequested;
  }

  /**
   * 턴이 진행 중인지 확인한다.
   */
  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Emergency Turn Cleaving — 하드 리밋(95%) 돌파 시 즉시 턴을 분할한다.
   *
   * AbortController를 통해 진행 중인 I/O를 안전하게 취소하고,
   * compaction 후 복구할 수 있는 컨텍스트를 제공한다.
   */
  cleave(): { snapshot: ReturnType<TurnBoundary['state']['getSnapshot']>; signal: AbortSignal } {
    const controller = new AbortController();
    this._abortController = controller;
    this.state.transition('emergency_cleaving');
    return {
      snapshot: this.state.getSnapshot(),
      signal: controller.signal,
    };
  }

  /**
   * compaction 완료 후 복구 단계로 전환한다.
   */
  recover(): void {
    if (this.state.getPhase() === 'compacting' || this.state.getPhase() === 'emergency_cleaving') {
      this.state.transition('recovering');
      // deferred compaction resolver 실행
      if (this._compactionRequest) {
        this._compactionRequest.resolver();
      }
    }
  }

  /**
   * 턴 시작 시 새 AbortController를 생성한다.
   */
  get signal(): AbortSignal | undefined {
    return this._abortController?.signal;
  }

  /**
   * compaction timeout 처리
   */
  private async compactionRequestWithTimeout(): Promise<void> {
    if (!this._compactionRequest) return;
    await Promise.race([
      this._compactionRequest.promise,
      new Promise<void>((resolve) => {
        setTimeout(() => { resolve(); }, this.compactionTimeoutMs);
      }),
    ]);
  }
}
