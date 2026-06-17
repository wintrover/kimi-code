import type { ModelCapability } from '@moonshot-ai/kosong';

import type { Agent } from '#/agent';
import type { ExecutableTool, ToolCall } from '#/loop';

/** FSM states for a single agent turn. */
export type TurnState = 'PLANNING' | 'EXECUTION' | 'REVIEW';

/** Events that drive the FSM reducer. */
export type TurnEvent =
  | { readonly kind: 'step_begin' }
  | { readonly kind: 'tool_batch'; readonly toolCalls: readonly ToolCall[] }
  | { readonly kind: 'step_end'; readonly stopReason: 'tool_use' | 'text' };

/** Guardrail configuration, sourced from `execution_guardrails` in config.toml. */
export interface GuardrailConfig {
  readonly enabled: boolean;
  readonly maxRepeats: number;
  readonly windowSize: number;
  readonly requireReviewBetweenToolBatches: boolean;
  readonly requireDeclaredToolUse: boolean;
}

/** Immutable fingerprint of a single tool call. */
export interface ToolCallFingerprint {
  readonly name: string;
  readonly normalizedArgs: unknown;
  readonly timestamp: number;
}

/** Telemetry buffer used by the circuit breaker middleware. */
export interface ToolTelemetryBuffer {
  /** Read-only view of recorded fingerprints. */
  readonly records: readonly ToolCallFingerprint[];
  /** Record a new tool call. */
  record(name: string, args: unknown): void;
  /**
   * Count how many of the most recent `window` records match the given tool
   * name and normalized arguments.
   */
  recentMatches(name: string, args: unknown, window: number): number;
}

/** Guardrail middleware function type. */
export type GuardrailMiddleware = (ctx: GuardrailContext) => GuardrailContext | Promise<GuardrailContext>;

/** Mutable context object passed through the guardrail pipeline. */
export interface GuardrailContext {
  readonly agent: Agent;
  readonly modelCapabilities: ModelCapability;
  /** Tools exposed to the model after capability filtering. */
  tools: readonly ExecutableTool[];
  /** Tool calls about to be executed (only present during `beforeToolBatch`). */
  toolCalls?: readonly ToolCall[];
  /** Current FSM state. */
  state: TurnState;
  /** Telemetry buffer for the current turn. */
  telemetry: ToolTelemetryBuffer;
  readonly config: GuardrailConfig;
}
