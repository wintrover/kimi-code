import { describe, it, expect } from 'vitest';

import {
  createCommandKaos,
  testAgent,
} from '../agent/harness/agent';
import type { TelemetryRecord } from '../fixtures/telemetry';
import { recordingTelemetry } from '../fixtures/telemetry';
import type { ToolCall } from '#/loop';

function bashCallWithId(id: string, command: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

describe('guardrail integration', () => {
  it('stops a repeated no-op Bash loop after maxRepeats identical calls', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('noop'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    // Simulate a model stuck calling the no-op shell command `:`.
    for (let i = 0; i < 5; i += 1) {
      ctx.mockNextResponse(bashCallWithId(`call_loop_${i}`, ':'));
    }

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Keep running' }] });
    await ctx.untilTurnEnd();

    const bashCalls = records.filter(
      (r) => r.event === 'tool_call' && r.properties?.['tool_name'] === 'Bash',
    );
    const successes = bashCalls.filter((r) => r.properties?.['outcome'] === 'success');
    expect(successes.length).toBeLessThanOrEqual(3);

    const endedWithError = records.some(
      (r) =>
        r.event === 'turn_interrupted' ||
        (r.event === 'api_error' && r.properties?.['model'] === 'mock-model'),
    );
    expect(endedWithError).toBe(true);
  });

  it('keeps tools when the mock model has no explicit capabilities', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('hello'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(bashCallWithId('call_hello', 'echo hello'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Say hello' }] });
    await ctx.untilTurnEnd();

    const bashCalls = records.filter(
      (r) => r.event === 'tool_call' && r.properties?.['tool_name'] === 'Bash',
    );
    expect(bashCalls.length).toBe(1);
    expect(bashCalls[0]?.properties?.['outcome']).toBe('success');
  });
});
