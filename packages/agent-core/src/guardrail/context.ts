import type { ModelCapability } from '@moonshot-ai/kosong';

import type { Agent } from '#/agent';
import type { ExecutableTool, ExecutableToolResult, ToolCall } from '#/loop';

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
  /**
   * Detection mode for the circuit breaker:
   * - `'input-only'`: legacy behavior; trips on repeated identical tool inputs.
   * - `'action-observation'`: trips only when identical inputs produce identical
   *   outputs, i.e. the agent made no observable progress.
   */
  readonly detectionMode?: 'input-only' | 'action-observation';
}

/** Immutable fingerprint of a single tool call. */
export interface ToolCallFingerprint {
  readonly name: string;
  readonly normalizedArgs: unknown;
  /** Provider tool-call id used to pair a pending action with its observation. */
  readonly toolCallId?: string;
  /** Hash of the tool output/observation; undefined until the result is recorded. */
  readonly outputHash?: string;
  readonly timestamp: number;
}

/** Telemetry buffer used by the circuit breaker middleware. */
export interface ToolTelemetryBuffer {
  /** Read-only view of recorded fingerprints. */
  readonly records: readonly ToolCallFingerprint[];
  /** Record a new tool call. */
  record(name: string, args: unknown, toolCallId?: string): void;
  /**
   * Attach an observation hash to a previously recorded pending action.
   */
  recordObservation(toolCallId: string, outputHash: string): void;
  /** Remove all fingerprints matching the given tool name from the buffer. */
  invalidateFingerprints(toolName: string): void;
  /**
   * Count how many of the most recent `window` records match the given tool
   * name and normalized arguments. If `outputHash` is provided, only records
   * with a matching observation hash are counted.
   */
  recentMatches(name: string, args: unknown, window: number, outputHash?: string): number;
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
  /** Tool results after execution (only present during `afterToolBatch`). */
  toolResults?: readonly ExecutableToolResult[];
  /** Current FSM state. */
  state: TurnState;
  /** Telemetry buffer for the current turn. */
  telemetry: ToolTelemetryBuffer;
  readonly config: GuardrailConfig;
}
