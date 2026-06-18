import type { ContextMessage } from '../agent/context';
import type { Agent } from '../agent';
import type { SubagentExecutionJournal, ToolInvocationSnapshot } from '@moonshot-ai/protocol';

const MAX_ARGS_SNAPSHOT_LENGTH = 200;

/**
 * Safe JSON serialization.
 * Handles circular references, BigInt, function, and symbol values safely.
 * (Extracted from packages/agent-core/src/agent/compaction/render-messages.ts stringifyJsonish)
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, nested: unknown): unknown => {
    if (typeof nested === 'bigint') return `${nested.toString()}n`;
    if (typeof nested === 'function') return `[Function ${nested.name || 'anonymous'}]`;
    if (typeof nested === 'symbol') return nested.toString();
    if (nested !== null && typeof nested === 'object') {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  };
  try {
    return JSON.stringify(value, replacer) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateArgs(args: unknown): string {
  const json = safeStringify(args ?? {});
  return json.length > MAX_ARGS_SNAPSHOT_LENGTH
    ? json.slice(0, MAX_ARGS_SNAPSHOT_LENGTH) + '…'
    : json;
}

/**
 * Build an immutable execution journal from a completed (or aborted) subagent's
 * context.history.
 *
 * Must be called only after execution completes — history is a snapshot at that point.
 * Tool calls are extracted from Message.toolCalls (not from content).
 */
export function buildExecutionJournal(
  child: Agent,
  turnsCompleted: number,
): SubagentExecutionJournal {
  const toolsExecuted: ToolInvocationSnapshot[] = [];
  const history: readonly ContextMessage[] = child.context.history;

  for (const message of history) {
    if (message.role !== 'assistant') continue;
    if (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0) continue;

    for (const toolCall of message.toolCalls) {
      const toolName = toolCall.name ?? 'unknown';
      const argsSnapshot = truncateArgs(safeParseArgs(toolCall.arguments));

      const result = findToolResult(history, toolCall.id);
      const status: 'success' | 'failed' = result?.isError ? 'failed' : 'success';
      const durationMs = result?.durationMs ?? 0;

      toolsExecuted.push({ toolName, argsSnapshot, status, durationMs });
    }
  }

  const usageStatus = child.usage.data();
  const total = usageStatus.total ?? {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };

  return {
    turnsCompleted,
    toolsExecuted,
    metrics: {
      inputOther: total.inputOther,
      output: total.output,
      inputCacheRead: total.inputCacheRead,
      inputCacheCreation: total.inputCacheCreation,
    },
  };
}

/** Parse arguments if they are a JSON string; return original on failure */
function safeParseArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

/** Find a tool result message matching the given toolCallId (camelCase, kosong Message spec) */
function findToolResult(
  history: readonly ContextMessage[],
  toolCallId: string,
): { isError?: boolean; durationMs?: number } | undefined {
  for (const message of history) {
    if (message.role !== 'tool') continue;
    if (message.toolCallId !== toolCallId) continue;
    return {
      isError: message.isError,
      durationMs: undefined, // Message has no durationMs field currently
    };
  }
  return undefined;
}
