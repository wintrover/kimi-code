import { StateVerifier } from '#/guard/verifier';
import type { StateVector } from '#/guard/ranking';

/**
 * State tracker that builds StateVectors from agent activity.
 *
 * Maintains a rolling window of tool calls, insights, and errors to
 * construct the state vector that the RankingFunction evaluates.
 */
export class GuardStateTracker {
  private taskCompletion = 0;
  private uniqueInsights = 0;
  private toolCallsSinceProgress = 0;
  private errorRecoveryAttempts = 0;
  private insightHashes = new Set<string>();
  private readonly verifier: StateVerifier;

  constructor(verifier: StateVerifier) {
    this.verifier = verifier;
  }

  /**
   * Snapshot the current state as an immutable StateVector.
   */
  snapshot(): StateVector {
    return {
      taskCompletion: this.taskCompletion,
      uniqueInsights: this.uniqueInsights,
      toolCallsSinceProgress: this.toolCallsSinceProgress,
      errorRecoveryAttempts: this.errorRecoveryAttempts,
    };
  }

  /**
   * Record a tool call result and return whether the formal guard
   * accepts this as a valid state transition.
   *
   * Call this from the `finalizeToolResult` hook.
   */
  async recordToolCall(toolName: string, args: string, result: string): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    const prevState = this.snapshot();

    // Update state based on the tool call outcome.
    this.toolCallsSinceProgress++;

    // Detect if this tool call produced a new insight (structural hash).
    const insightHash = this.verifier['ranking'].structuralHash(
      `${toolName}:${result.slice(0, 500)}`,
    );
    if (!this.insightHashes.has(insightHash)) {
      this.insightHashes.add(insightHash);
      this.uniqueInsights++;
      this.toolCallsSinceProgress = 0; // Reset — meaningful progress was made.
    }

    // Detect error-recovery patterns.
    if (result.includes('error') || result.includes('Error')) {
      this.errorRecoveryAttempts++;
    }

    const nextState = this.snapshot();

    // Verify the transition through the formal gate.
    const verification = await this.verifier.verify({
      prevState,
      nextState,
      actionDescription: `tool:${toolName}(${args.slice(0, 200)})`,
      timestamp: Date.now(),
    });

    if (!verification.accepted) {
      // Roll back state to pre-transition.
      this.restoreState(prevState);
      return {
        accepted: false,
        reason: verification.rejectionReason,
      };
    }

    return { accepted: true };
  }

  /**
   * Advance task completion (e.g., when a goal is achieved or a milestone hit).
   */
  advanceCompletion(delta: number): void {
    this.taskCompletion = Math.min(1, this.taskCompletion + delta);
    this.toolCallsSinceProgress = 0;
  }

  /**
   * Roll back to a specific state.
   */
  restoreState(state: StateVector): void {
    this.taskCompletion = state.taskCompletion;
    this.uniqueInsights = state.uniqueInsights;
    this.toolCallsSinceProgress = state.toolCallsSinceProgress;
    this.errorRecoveryAttempts = state.errorRecoveryAttempts;
  }

  /**
   * Dispose of the underlying verifier.
   */
  dispose(): void {
    this.verifier.dispose();
    this.insightHashes.clear();
  }
}
