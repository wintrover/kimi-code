import type { EnvSnapshot } from './types';

/**
 * Immutable environment state machine.
 *
 * Every mutation (set, delete, append) produces a new frozen snapshot.
 * Previous snapshots are preserved in history for rollback capability.
 *
 * Design principles:
 * - Immutability: Object.freeze() on every env map
 * - Version tracking: full snapshot history with cause annotations
 * - Deterministic injection: snapshots are read-only at injection time
 */
export class AgentEnvStore {
  private _current: EnvSnapshot;
  private readonly _history: EnvSnapshot[] = [];

  constructor(initialEnv?: Record<string, string>) {
    this._current = {
      env: Object.freeze({ ...initialEnv }),
      timestamp: Date.now(),
      cause: 'initial',
    };
    this._history.push(this._current);
  }

  /** Current immutable snapshot. */
  get snapshot(): Readonly<EnvSnapshot> {
    return this._current;
  }

  /** Full snapshot history (oldest first). */
  get history(): readonly EnvSnapshot[] {
    return this._history;
  }

  /** Number of mutations applied so far (excludes initial). */
  get version(): number {
    return this._history.length - 1;
  }

  /** Get a single env value. */
  get(key: string): string | undefined {
    return this._current.env[key];
  }

  /** Set an environment variable. Returns the new snapshot. */
  set(key: string, value: string, cause?: string): EnvSnapshot {
    const newEnv = Object.freeze({ ...this._current.env, [key]: value });
    this._current = {
      env: newEnv,
      timestamp: Date.now(),
      cause: cause ?? `set_env(${key})`,
    };
    this._history.push(this._current);
    return this._current;
  }

  /** Delete an environment variable. Returns the new snapshot. */
  delete(key: string, cause?: string): EnvSnapshot {
    const { [key]: _, ...rest } = this._current.env;
    const newEnv = Object.freeze(rest);
    this._current = {
      env: newEnv,
      timestamp: Date.now(),
      cause: cause ?? `delete_env(${key})`,
    };
    this._history.push(this._current);
    return this._current;
  }

  /** Append a value to an existing env var using the platform separator (:). Returns the new snapshot. */
  append(key: string, value: string, separator = ':', cause?: string): EnvSnapshot {
    const current = this._current.env[key];
    const newValue = current !== undefined ? `${current}${separator}${value}` : value;
    return this.set(key, newValue, cause ?? `append_env(${key})`);
  }

  /** Rollback to a specific history index. Returns the restored snapshot. */
  rollback(index: number): EnvSnapshot {
    if (index < 0 || index >= this._history.length) {
      throw new Error(`Invalid rollback index: ${index} (history size: ${this._history.length})`);
    }
    const target = this._history[index]!;
    this._current = target;
    return this._current;
  }

  /** Rollback to the previous snapshot. Returns the restored snapshot. */
  rollbackLast(): EnvSnapshot {
    if (this._history.length <= 1) {
      throw new Error('Cannot rollback: only initial snapshot exists');
    }
    return this.rollback(this._history.length - 2);
  }

  /**
   * Create a mutable copy of the current env for injection into processes.
   * This is the ONLY point where immutability is broken, and it happens
   * at the injection boundary (BashTool.spawn).
   */
  toMutable(): Record<string, string> {
    return { ...this._current.env };
  }
}
