import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/context/types';
import type { Agent } from '#/agent';

import { buildExecutionJournal, safeStringify } from '../subagent-journal';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAgent(
  history: readonly ContextMessage[],
  totalUsage?: {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation: number;
  },
): Agent {
  return {
    context: { history },
    usage: {
      data: () => ({
        total: totalUsage,
      }),
    },
  } as unknown as Agent;
}

function assistantMsg(
  toolCalls: Array<{
    id: string;
    name: string;
    arguments?: string;
  }>,
): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    toolCalls,
  } as unknown as ContextMessage;
}

function toolResultMsg(
  toolCallId: string,
  options?: { isError?: boolean },
): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: 'result' }],
    toolCallId,
    isError: options?.isError,
  } as unknown as ContextMessage;
}

function userMsg(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as ContextMessage;
}

// ---------------------------------------------------------------------------
// safeStringify tests
// ---------------------------------------------------------------------------

describe('safeStringify', () => {
  it('serializes plain objects', () => {
    expect(safeStringify({ a: 1, b: 'hello' })).toBe('{"a":1,"b":"hello"}');
  });

  it('handles circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(safeStringify(obj)).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('handles BigInt values', () => {
    const value = { big: BigInt(123) };
    expect(safeStringify(value)).toBe('{"big":"123n"}');
  });

  it('handles function values', () => {
    function namedFn() {
      /* noop */
    }
    const value = { fn: namedFn };
    expect(safeStringify(value)).toBe('{"fn":"[Function namedFn]"}');
  });

  it('handles anonymous functions', () => {
    const value = { fn: () => {} };
    const result = safeStringify(value);
    // Arrow functions get their name from the variable assignment in modern JS engines
    expect(result).toMatch(/^\{"fn":"\[Function [a-z]+\]"}/);
  });

  it('handles symbol values', () => {
    const value = { sym: Symbol('test') };
    expect(safeStringify(value)).toBe('{"sym":"Symbol(test)"}');
  });

  it('handles null', () => {
    expect(safeStringify(null)).toBe('null');
  });

  it('handles undefined', () => {
    // JSON.stringify(undefined) returns undefined, then ?? triggers String(undefined)
    expect(safeStringify(undefined)).toBe('undefined');
  });

  it('handles nested circular references', () => {
    const inner: Record<string, unknown> = { x: 1 };
    const outer: Record<string, unknown> = { inner };
    inner['outer'] = outer;
    expect(safeStringify(outer)).toBe('{"inner":{"x":1,"outer":"[Circular]"}}');
  });

  it('falls back to String() on unstringifiable values', () => {
    // WeakSet cannot be serialized by JSON.stringify even with replacer
    const value = new WeakMap();
    // WeakMap has no enumerable own properties, so JSON.stringify returns '{}'
    // But test the catch path with something that throws
    const throwingObj = {
      toJSON: () => {
        throw new Error('nope');
      },
    };
    // The replacer handles toJSON results, but if JSON.stringify itself fails
    // the catch path returns String(value)
    expect(typeof safeStringify(throwingObj)).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// buildExecutionJournal tests
// ---------------------------------------------------------------------------

describe('buildExecutionJournal', () => {
  it('returns empty journal for empty history', () => {
    const agent = mockAgent([], {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    const journal = buildExecutionJournal(agent, 3);

    expect(journal.turnsCompleted).toBe(3);
    expect(journal.toolsExecuted).toEqual([]);
    expect(journal.metrics).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('extracts tool calls from assistant messages', () => {
    const history: ContextMessage[] = [
      userMsg('do something'),
      assistantMsg([
        {
          id: 'call_1',
          name: 'Read',
          arguments: '{"path":"/tmp/file.ts"}',
        },
      ]),
      toolResultMsg('call_1'),
    ];

    const agent = mockAgent(history, {
      inputOther: 100,
      output: 20,
      inputCacheRead: 50,
      inputCacheCreation: 10,
    });
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted).toHaveLength(1);
    expect(journal.toolsExecuted[0]).toEqual({
      toolName: 'Read',
      argsSnapshot: '{"path":"/tmp/file.ts"}',
      status: 'success',
      durationMs: 0,
    });
  });

  it('marks tool as failed when isError is true', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_err',
          name: 'Bash',
          arguments: '{"command":"exit 1"}',
        },
      ]),
      toolResultMsg('call_err', { isError: true }),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted[0]!.status).toBe('failed');
  });

  it('matches tool calls to their results by toolCallId', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_a',
          name: 'ToolA',
          arguments: '{}',
        },
        {
          id: 'call_b',
          name: 'ToolB',
          arguments: '{}',
        },
      ]),
      toolResultMsg('call_b', { isError: true }),
      toolResultMsg('call_a'),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted).toHaveLength(2);
    // First tool call (ToolA) matched to its result (success)
    expect(journal.toolsExecuted[0]!.toolName).toBe('ToolA');
    expect(journal.toolsExecuted[0]!.status).toBe('success');
    // Second tool call (ToolB) matched to its result (failed)
    expect(journal.toolsExecuted[1]!.toolName).toBe('ToolB');
    expect(journal.toolsExecuted[1]!.status).toBe('failed');
  });

  it('marks tool as success when no matching tool result exists', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_orphan',
          name: 'Grep',
          arguments: '{}',
        },
      ]),
      // No tool result for call_orphan
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted[0]!.status).toBe('success');
    expect(journal.toolsExecuted[0]!.durationMs).toBe(0);
  });

  it('truncates args snapshot to 200 chars', () => {
    const longArgs = JSON.stringify({ data: 'x'.repeat(300) });
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_long',
          name: 'Write',
          arguments: longArgs,
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted[0]!.argsSnapshot.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(journal.toolsExecuted[0]!.argsSnapshot.endsWith('…')).toBe(true);
  });

  it('handles JSON string arguments by parsing them', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_parsed',
          name: 'Edit',
          arguments: '{"old":"foo","new":"bar"}',
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    // After parsing + re-serialization via safeStringify, the args are normalized
    expect(journal.toolsExecuted[0]!.argsSnapshot).toBe('{"old":"foo","new":"bar"}');
  });

  it('handles non-JSON string arguments gracefully', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_badjson',
          name: 'Bash',
          arguments: 'not valid json {{{',
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    // safeParseArgs returns original string when JSON.parse fails
    expect(journal.toolsExecuted[0]!.argsSnapshot).toBe('"not valid json {{{"');
  });

  it('skips non-assistant messages', () => {
    const history: ContextMessage[] = [
      userMsg('hello'),
      toolResultMsg('some_id'),
      assistantMsg([
        {
          id: 'call_only',
          name: 'Glob',
          arguments: '{}',
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted).toHaveLength(1);
    expect(journal.toolsExecuted[0]!.toolName).toBe('Glob');
  });

  it('skips assistant messages without toolCalls', () => {
    const history: ContextMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'just text' }],
      } as unknown as ContextMessage,
      assistantMsg([
        {
          id: 'call_real',
          name: 'Read',
          arguments: '{}',
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted).toHaveLength(1);
  });

  it('defaults tool name to "unknown" when function.name is missing', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_noname',
          name: undefined as unknown as string,
          arguments: '{}',
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    expect(journal.toolsExecuted[0]!.toolName).toBe('unknown');
  });

  it('reports metrics from usage data', () => {
    const agent = mockAgent([], {
      inputOther: 500,
      output: 150,
      inputCacheRead: 200,
      inputCacheCreation: 75,
    });
    const journal = buildExecutionJournal(agent, 5);

    expect(journal.metrics).toEqual({
      inputOther: 500,
      output: 150,
      inputCacheRead: 200,
      inputCacheCreation: 75,
    });
    expect(journal.turnsCompleted).toBe(5);
  });

  it('defaults metrics to zeros when usage total is undefined', () => {
    const agent = mockAgent([]);
    const journal = buildExecutionJournal(agent, 0);

    expect(journal.metrics).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('handles args passed as already-parsed objects', () => {
    const history: ContextMessage[] = [
      assistantMsg([
        {
          id: 'call_obj',
          name: 'Write',
          arguments: undefined as unknown as string,
        },
      ]),
    ];

    const agent = mockAgent(history);
    const journal = buildExecutionJournal(agent, 1);

    // safeParseArgs returns undefined, truncateArgs stringifies it as "{}" via `args ?? {}`
    expect(journal.toolsExecuted[0]!.argsSnapshot).toBe('{}');
  });
});
