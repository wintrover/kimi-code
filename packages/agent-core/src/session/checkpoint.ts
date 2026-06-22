/**
 * Checkpoint Store — 턴 상태 스냅샷의 저장/복원.
 *
 * "계" 사망 사건의 근본 원인: compaction 시 턴 상태가 휘발됨.
 * 이 모듈은 compaction 전에 턴 상태를 스냅샷으로 보존하고,
 * 복구 시 정확히 그 시점부터 재개할 수 있게 한다.
 *
 * LangGraph의 MemorySaver/checkpoint 패턴에서 영감.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { join } from 'pathe';

import type { TurnStateSnapshot } from './turn-state';

/**
 * 스냅샷에 보존할 턴 진행 컨텍스트.
 */
export interface TurnContextSnapshot {
  readonly turnState: TurnStateSnapshot;
  readonly agentId: string;
  readonly turnId: number;
  readonly pendingToolCallId?: string;
  readonly pendingSteps: readonly string[];
  readonly goal?: string;
  readonly sideEffectState: 'none' | 'pending' | 'completed';
  readonly timestamp: number;
  /** When the turn started (for staleness detection). */
  readonly turnStartedAt?: number;
  /** Which model was being used. */
  readonly model?: string;
  /** Tool names called during this turn. */
  readonly toolNamesInvolved?: readonly string[];
}

/**
 * CheckpointStore 인터페이스 — 메모리/파일 다양한 구현 가능.
 */
export interface CheckpointStore {
  save(context: TurnContextSnapshot): Promise<void>;
  load(agentId: string): Promise<TurnContextSnapshot | undefined>;
  clear(agentId: string): Promise<void>;
}

/**
 * 메모리 기반 구현 — 테스트 및 기본 사용.
 */
export class MemoryCheckpointer implements CheckpointStore {
  private store = new Map<string, TurnContextSnapshot>();

  async save(context: TurnContextSnapshot): Promise<void> {
    this.store.set(context.agentId, { ...context });
  }

  async load(agentId: string): Promise<TurnContextSnapshot | undefined> {
    const existing = this.store.get(agentId);
    return existing ? { ...existing } : undefined;
  }

  async clear(agentId: string): Promise<void> {
    this.store.delete(agentId);
  }
}

/**
 * 파일 기반 구현 — Kaos 파일시스템에 JSON으로 영속 저장.
 *
 * 각 에이전트의 체크포인트는 `{baseDir}/checkpoints/{agentId}.json`에 저장된다.
 */
export class FileCheckpointer implements CheckpointStore {
  constructor(
    private readonly baseDir: string,
    private readonly kaos: Kaos,
  ) {}

  private _filePath(agentId: string): string {
    return join(this.baseDir, 'checkpoints', `${agentId}.json`);
  }

  async save(context: TurnContextSnapshot): Promise<void> {
    const dir = join(this.baseDir, 'checkpoints');
    await this.kaos.mkdir(dir, { parents: true, existOk: true });
    const filePath = this._filePath(context.agentId);
    await this.kaos.writeText(filePath, JSON.stringify(context, null, 2));
  }

  async load(agentId: string): Promise<TurnContextSnapshot | undefined> {
    const filePath = this._filePath(agentId);
    let raw: string;
    try {
      raw = await this.kaos.readText(filePath);
    } catch {
      return undefined;
    }
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return undefined;
    return parsed as TurnContextSnapshot;
  }

  async clear(agentId: string): Promise<void> {
    const filePath = this._filePath(agentId);
    try {
      await this.kaos.stat(filePath);
    } catch {
      return; // file doesn't exist — no-op
    }
    // Kaos has no unlink; write a null sentinel so load() returns undefined.
    await this.kaos.writeText(filePath, 'null');
  }
}
