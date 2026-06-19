/**
 * Immutable snapshot of the agent's environment state.
 * Each mutation creates a new snapshot; previous snapshots are never modified.
 */
export interface EnvSnapshot {
  /** Frozen environment map at this point in time. */
  readonly env: Readonly<Record<string, string>>;
  /** Timestamp when this snapshot was created. */
  readonly timestamp: number;
  /** Human-readable cause for this snapshot (e.g. "initial", "set_env(PATH)", "delete_env(HOME)", "rollback(2)"). */
  readonly cause: string;
}

/**
 * Version metadata for a single env entry change.
 */
export interface EnvChangeRecord {
  readonly key: string;
  readonly action: 'set' | 'delete' | 'append';
  readonly previousValue: string | undefined;
  readonly newValue: string | undefined;
  readonly timestamp: number;
}
