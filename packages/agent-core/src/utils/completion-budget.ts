import type {
  ChatProvider,
  Message,
  ModelCapability,
  Tool,
} from '@moonshot-ai/kosong';

import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from './tokens';

/**
 * Desired completion-token budget for the next LLM step.
 *
 * The budget is a request, not a guarantee: it is clamped against the
 * current input size and the model's context window before being applied
 * to the provider. This avoids two failure modes for Kimi reasoning
 * models:
 *   1. A small cap can return HTTP 200 with empty `content` because the
 *      whole budget was spent on `reasoning_content`.
 *   2. A large cap may exceed the remaining context window and trigger
 *      `Invalid request: Your request exceeded model token limit`.
 */
export interface CompletionBudget {
  /** Desired completion budget when the model context window allows it. */
  readonly desired: number;
  /**
   * Safety margin reserved between current input and the context limit,
   * to absorb tokenizer estimation error and provider-side overhead.
   */
  readonly safetyMargin?: number | undefined;
}

const MIN_FLOOR = 1;
const DEFAULT_SAFETY_MARGIN = 1024;
const DEFAULT_DESIRED_BUDGET = 32000;

/**
 * Resolve the completion budget for a turn from configuration and Kimi
 * environment variables.
 *
 * Priority (first wins): `KIMI_MODEL_MAX_COMPLETION_TOKENS`,
 * `KIMI_MODEL_MAX_TOKENS` (legacy alias), `reservedContextSize`,
 * `DEFAULT_DESIRED_BUDGET` (32000, preserves pre-PR-2332 behavior).
 *
 * Operators can opt out of clamping entirely by setting the env var to
 * `0` or a negative integer; in that case this function returns
 * `undefined`, which `applyCompletionBudget` treats as a no-op.
 */
export function resolveCompletionBudget(args: {
  readonly reservedContextSize?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): CompletionBudget | undefined {
  const env = args.env ?? process.env;
  const fromNew = parseEnvBudget(env['KIMI_MODEL_MAX_COMPLETION_TOKENS']);
  if (fromNew !== 'absent') {
    return fromNew === 'disabled' ? undefined : { desired: fromNew };
  }
  const fromLegacy = parseEnvBudget(env['KIMI_MODEL_MAX_TOKENS']);
  if (fromLegacy !== 'absent') {
    return fromLegacy === 'disabled' ? undefined : { desired: fromLegacy };
  }
  if (args.reservedContextSize !== undefined && args.reservedContextSize > 0) {
    return { desired: args.reservedContextSize };
  }
  return { desired: DEFAULT_DESIRED_BUDGET };
}

type EnvBudget = number | 'disabled' | 'absent';

function parseEnvBudget(raw: string | undefined): EnvBudget {
  if (raw === undefined || raw === '') return 'absent';
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'absent';
  if (n <= 0) return 'disabled';
  return n;
}

/**
 * Compute the effective `max_completion_tokens` cap for the next request.
 *
 *   cap = clamp(desired, MIN_FLOOR, max_context_tokens - input - safetyMargin)
 *
 * `input` accounts for everything the provider will actually serialize:
 * the conversation history, the system prompt, and the tool schemas.
 * Counting only `messages` underestimates by enough to push a near-limit
 * request past the model context window.
 *
 * When the model context size is unknown, the desired value is returned
 * unchanged (floored at `MIN_FLOOR`).
 *
 * When the remaining window is non-positive (input already at or above
 * the limit), `MIN_FLOOR` is returned — we can't honor a meaningful cap
 * and the API will surface the overflow on its own.
 *
 * Note: the floor never exceeds `remaining`, so a near-full context
 * cannot be pushed past the limit by `MIN_FLOOR` itself.
 */
export function computeCompletionBudgetCap(args: {
  readonly budget: CompletionBudget;
  readonly capability: ModelCapability | undefined;
  readonly messages: readonly Message[];
  readonly systemPrompt?: string | undefined;
  readonly tools?: readonly Tool[] | undefined;
}): number {
  const desired = args.budget.desired;
  const safetyMargin = args.budget.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const maxCtx = args.capability?.max_context_tokens ?? 0;
  if (maxCtx <= 0) {
    return Math.max(MIN_FLOOR, desired);
  }
  const input =
    estimateTokensForMessages([...args.messages]) +
    estimateTokens(args.systemPrompt ?? '') +
    estimateTokensForTools(args.tools ?? []);
  const remaining = maxCtx - input - safetyMargin;
  if (remaining <= 0) {
    return MIN_FLOOR;
  }
  return Math.max(MIN_FLOOR, Math.min(desired, remaining));
}

/**
 * Apply a completion budget to a provider via its optional
 * `withMaxCompletionTokens` capability. Returns the original provider
 * unchanged when no budget is configured or the provider opts out.
 *
 * The returned provider is intentionally a shallow clone that shares the
 * original's HTTP client. Callers MUST treat it as a single-step value
 * and NOT persist it back to durable agent state — see the F3 discussion
 * in `KimiChatProvider._clone()`.
 */
export function applyCompletionBudget(args: {
  readonly provider: ChatProvider;
  readonly budget: CompletionBudget | undefined;
  readonly capability: ModelCapability | undefined;
  readonly messages: readonly Message[];
  readonly systemPrompt?: string | undefined;
  readonly tools?: readonly Tool[] | undefined;
}): ChatProvider {
  if (args.budget === undefined) return args.provider;
  if (args.provider.withMaxCompletionTokens === undefined) return args.provider;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
    messages: args.messages,
    systemPrompt: args.systemPrompt,
    tools: args.tools,
  });
  return args.provider.withMaxCompletionTokens(cap);
}
