import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of agent state at a point in time. */
export interface StateVector {
  /** Task completion progress in [0, 1]. */
  readonly taskCompletion: number;
  /** Number of unique insights discovered so far. */
  readonly uniqueInsights: number;
  /** Tool calls made since last progress in taskCompletion. */
  readonly toolCallsSinceProgress: number;
  /** Error recovery attempts so far. */
  readonly errorRecoveryAttempts: number;
}

/** A proposed transition between two states. */
export interface TransitionProposal {
  readonly prevState: StateVector;
  readonly nextState: StateVector;
  readonly actionDescription: string;
  readonly timestamp: number;
}

export interface TransitionValidationResult {
  readonly valid: boolean;
  readonly reason: string;
  readonly monotonicIncrease: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEIGHT_TASK_COMPLETION = 0.5;
const WEIGHT_UNIQUE_INSIGHTS = 0.3;
const WEIGHT_TOOL_CALLS_PENALTY = -0.1;
const WEIGHT_ERROR_RECOVERY_PENALTY = -0.1;

export const MAX_TOOL_CALLS_WITHOUT_PROGRESS = 10;

// ---------------------------------------------------------------------------
// RankingFunction
// ---------------------------------------------------------------------------

/**
 * Ranking Function (Loop Variant) engine.
 *
 * Provides a weighted distance metric over state vectors, transition
 * validation with monotonicity / liveness checks, and a structural hash
 * that is resilient to cosmetic rewording.
 */
export class RankingFunction {
  /**
   * Weighted distance metric — higher values are closer to the goal.
   */
  distance(state: StateVector): number {
    return (
      state.taskCompletion * WEIGHT_TASK_COMPLETION +
      state.uniqueInsights * WEIGHT_UNIQUE_INSIGHTS +
      state.toolCallsSinceProgress * WEIGHT_TOOL_CALLS_PENALTY +
      state.errorRecoveryAttempts * WEIGHT_ERROR_RECOVERY_PENALTY
    );
  }

  /**
   * Validate that a proposed transition respects monotonicity and liveness
   * invariants.
   */
  validateTransition(prev: StateVector, next: StateVector): TransitionValidationResult {
    // (a) taskCompletion must not decrease
    if (next.taskCompletion < prev.taskCompletion) {
      return {
        valid: false,
        reason: 'taskCompletion decreased',
        monotonicIncrease: false,
      };
    }

    const monotonicIncrease = next.taskCompletion > prev.taskCompletion;

    // (b) When taskCompletion is unchanged, uniqueInsights must increase
    //     OR toolCallsSinceProgress must reset (indicating a meaningful action).
    if (!monotonicIncrease) {
      const insightsIncreased = next.uniqueInsights > prev.uniqueInsights;
      const toolCallsReset = next.toolCallsSinceProgress < prev.toolCallsSinceProgress;

      if (!insightsIncreased && !toolCallsReset) {
        return {
          valid: false,
          reason:
            'taskCompletion unchanged but neither uniqueInsights increased nor toolCallsSinceProgress reset',
          monotonicIncrease: false,
        };
      }
    }

    // (c) toolCallsSinceProgress must not exceed the limit
    if (next.toolCallsSinceProgress >= MAX_TOOL_CALLS_WITHOUT_PROGRESS) {
      return {
        valid: false,
        reason: `toolCallsSinceProgress exceeded limit of ${MAX_TOOL_CALLS_WITHOUT_PROGRESS}`,
        monotonicIncrease,
      };
    }

    return { valid: true, reason: '', monotonicIncrease };
  }

  /**
   * Structural hash of text content.
   *
   * Instead of hashing raw bytes, this extracts key-value pairs and entity
   * tuples, sorts the tokens, and hashes the normalised representation.
   * This means cosmetic rewording that preserves structure produces the same
   * hash, catching semantic duplicates.
   */
  structuralHash(text: string): string {
    const tokens = extractStructuralTokens(text);
    tokens.sort();

    const normalised = tokens.join('|');
    return createHash('sha256').update(normalised, 'utf8').digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Extract key-value pairs and entity tuples from text.
 *
 * Patterns recognised:
 *  - `key: value` / `key=value` / `key: "value"` → `key=value`
 *  - Quoted strings `"..."` or `'...'` as entity tokens
 *  - Bare words that look like identifiers or numbers
 */
function extractStructuralTokens(text: string): string[] {
  const tokens: string[] = [];

  // Key-value pairs: `key: value` or `key=value`
  const kvPattern = /(\w+)\s*[:=]\s*(".*?"|'.*?'|\S+)/g;
  let match = kvPattern.exec(text);
  while (match) {
    const key = match[1]!;
    const raw = match[2]!;
    const value = raw.replace(/^["']|["']$/g, '');
    tokens.push(`${key}=${value}`);
    match = kvPattern.exec(text);
  }

  // Entity tuples — quoted strings (already captured in kv, so deduplicate
  // by only adding standalone ones).
  const quotedPattern = /(?<!\w\s*[:=]\s*)(".*?"|'.*?')/g;
  let qMatch = quotedPattern.exec(text);
  while (qMatch) {
    const entity = qMatch[1]!.replace(/^["']|["']$/g, '');
    tokens.push(`entity:${entity}`);
    qMatch = quotedPattern.exec(text);
  }

  // Bare number tokens (standalone numbers that aren't part of kv values).
  const numberPattern = /(?<=\s|^)(-?\d+(?:\.\d+)?)(?=\s|$|[.,;:!?])/g;
  let nMatch = numberPattern.exec(text);
  while (nMatch) {
    tokens.push(`num:${nMatch[1]}`);
    nMatch = numberPattern.exec(text);
  }

  // If no structural tokens were found, fall back to lowercased words so the
  // hash is still deterministic rather than empty.
  if (tokens.length === 0) {
    const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    for (const word of words) {
      tokens.push(`word:${word}`);
    }
  }

  return tokens;
}
