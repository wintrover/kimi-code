/**
 * Guardrail violation error.
 *
 * Thrown by a guardrail middleware when the agent attempts an action that
 * violates a deterministic policy. The error carries enough context for both
 * human debugging and model-facing remediation messages.
 */
export class GuardrailViolationError extends Error {
  constructor(
    /** Policy identifier, e.g. `capability`, `circuit_breaker`, `fsm`. */
    readonly policy: string,
    /** Human-readable reason for the block. */
    readonly reason: string,
    /** Structured context captured at the point of violation. */
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(`[Guardrail:${policy}] ${reason}`);
    this.name = 'GuardrailViolationError';
  }

  /** Returns a message suitable for injection into the agent context. */
  toContextMessage(): string {
    return (
      `[Guardrail Violation — ${this.policy}] ${this.reason}\n` +
      `Context: ${JSON.stringify(this.context, Object.keys(this.context).sort())}`
    );
  }
}
