import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { listWireFilesManually, loadWireRecords } from '../src/lib/wire-loader';
import { createSyntheticSession, type SyntheticResult } from './_fixture';

describe('wire-loader', () => {
  let fixture: SyntheticResult | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it('lists wire.jsonl after any archives, current file last', async () => {
    fixture = createSyntheticSession();
    const files = await listWireFilesManually(fixture.dir);
    expect(files.length).toBeGreaterThan(0);
    expect((files.at(-1) ?? '').endsWith('wire.jsonl')).toBe(true);
  });

  it('loads records from a synthetic session', async () => {
    fixture = createSyntheticSession({ withTools: true });
    const result = await loadWireRecords(fixture.dir);
    expect(result.health).toBe('ok');
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.files_read.length).toBe(1);
    expect(result.session_initialized).not.toBeNull();
    expect(result.session_initialized?.agent_type).toBe('main');
  });

  it('yields seq-ordered records', async () => {
    fixture = createSyntheticSession({ withTools: true });
    const result = await loadWireRecords(fixture.dir);
    for (let i = 1; i < result.records.length; i += 1) {
      const prev = result.records[i - 1];
      const cur = result.records[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.seq).toBeGreaterThanOrEqual(prev.seq);
    }
  });

  it('splices metadata + session_initialized into records so the Wire tab can show them', async () => {
    fixture = createSyntheticSession();
    const result = await loadWireRecords(fixture.dir);
    expect(result.health).toBe('ok');
    // metadata comes first, session_initialized second.
    expect(result.records[0]?.type).toBe('metadata');
    expect(result.records[1]?.type).toBe('session_initialized');
    const meta = result.records[0] as {
      protocol_version?: string;
      producer?: { kind?: string };
    };
    expect(meta.protocol_version).toBe('1.0');
    expect(meta.producer?.kind).toBe('typescript');
    const init = result.records[1] as { system_prompt?: string };
    expect(init.system_prompt).toBe('You are a test assistant.');
  });

  it('returns health=broken with a message for a non-existent dir', async () => {
    const result = await loadWireRecords('/tmp/vis-test-does-not-exist-xxxxx');
    expect(result.health).toBe('broken');
    expect(result.records.length).toBe(0);
    expect(result.broken_reason).toBeTruthy();
    expect(result.session_initialized).toBeNull();
  });

  it('treats idle turn.steer as a turn start without splitting active steer', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: {
          kind: 'typescript',
          name: '@moonshot-ai/agent-core',
          version: '0.0.1',
        },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        model: 'test-model',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'first' }],
      },
      {
        type: 'context.user_message',
        seq: 3,
        time: 3,
        content: [{ type: 'text', text: 'first' }],
      },
      {
        type: 'context.delta',
        seq: 4,
        time: 4,
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'turn.steer',
        seq: 5,
        time: 5,
        input: [{ type: 'text', text: 'active steer' }],
      },
      {
        type: 'context.delta',
        seq: 6,
        time: 6,
        event: { type: 'step.end', uuid: 'step-1', turnId: '0', step: 1, finishReason: 'tool_use' },
      },
      {
        type: 'context.user_message',
        seq: 7,
        time: 7,
        content: [{ type: 'text', text: 'active steer' }],
      },
      {
        type: 'context.delta',
        seq: 8,
        time: 8,
        event: { type: 'step.begin', uuid: 'step-2', turnId: '0', step: 2 },
      },
      {
        type: 'context.delta',
        seq: 9,
        time: 9,
        event: { type: 'step.end', uuid: 'step-2', turnId: '0', step: 2, finishReason: 'end_turn' },
      },
      {
        type: 'turn.steer',
        seq: 10,
        time: 10,
        input: [{ type: 'text', text: 'terminal gap steer' }],
      },
      {
        type: 'context.user_message',
        seq: 11,
        time: 11,
        content: [{ type: 'text', text: 'terminal gap steer' }],
      },
      {
        type: 'context.delta',
        seq: 12,
        time: 12,
        event: { type: 'step.begin', uuid: 'step-3', turnId: '0', step: 3 },
      },
      {
        type: 'context.delta',
        seq: 13,
        time: 13,
        event: { type: 'step.end', uuid: 'step-3', turnId: '0', step: 3, finishReason: 'end_turn' },
      },
      {
        type: 'turn.steer',
        seq: 14,
        time: 14,
        input: [{ type: 'text', text: 'idle steer' }],
      },
      {
        type: 'context.user_message',
        seq: 15,
        time: 15,
        content: [{ type: 'text', text: 'idle steer' }],
      },
      {
        type: 'context.delta',
        seq: 16,
        time: 16,
        event: { type: 'step.begin', uuid: 'step-4', turnId: '1', step: 1 },
      },
      {
        type: 'context.delta',
        seq: 17,
        time: 17,
        event: {
          type: 'tool.result',
          parentUuid: 'tool-1',
          toolCallId: 'tool-1',
          result: { output: 'idle result' },
        },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    const turnBegins = result.records.filter((record) => record.type === 'turn_begin');
    const userMessages = result.records.filter((record) => record.type === 'user_message');
    const toolResult = result.records.find((record) => record.type === 'tool_result');

    expect(turnBegins.map((record) => [record.turn_id, record.user_input])).toEqual([
      ['0', 'first'],
      ['1', 'idle steer'],
    ]);
    expect(userMessages.map((record) => record.turn_id)).toEqual(['0', '0', '0', '1']);
    expect(toolResult).toMatchObject({ turn_id: '1' });
  });

  it('treats idle turn.steer after a failed pre-step turn as a new turn', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: {
          kind: 'typescript',
          name: '@moonshot-ai/agent-core',
          version: '0.0.1',
        },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'missing model' }],
      },
      {
        type: 'context.user_message',
        seq: 3,
        time: 3,
        content: [{ type: 'text', text: 'missing model' }],
      },
      {
        type: 'turn.steer',
        seq: 4,
        time: 4,
        input: [{ type: 'text', text: 'after failure' }],
      },
      {
        type: 'context.user_message',
        seq: 5,
        time: 5,
        content: [{ type: 'text', text: 'after failure' }],
      },
      {
        type: 'context.delta',
        seq: 6,
        time: 6,
        event: { type: 'step.begin', uuid: 'step-1', turnId: '1', step: 1 },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    const turnBegins = result.records.filter((record) => record.type === 'turn_begin');
    const userMessages = result.records.filter((record) => record.type === 'user_message');

    expect(turnBegins.map((record) => [record.turn_id, record.user_input])).toEqual([
      ['0', 'missing model'],
      ['1', 'after failure'],
    ]);
    expect(userMessages.map((record) => record.turn_id)).toEqual(['0', '1']);
  });
  it('unwraps the newer dot-namespaced record names (append_loop_event, append_message, set_active_tools)', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.0.1' },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'hi' }],
      },
      {
        type: 'context.append_message',
        seq: 3,
        time: 3,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'tools.set_active_tools',
        seq: 4,
        time: 4,
        names: ['Read', 'Write', 'Bash'],
      },
      {
        type: 'context.append_loop_event',
        seq: 5,
        time: 5,
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        seq: 6,
        time: 6,
        event: {
          type: 'tool.call',
          uuid: 'tc-1',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          toolCallId: 'call-1',
          name: 'Write',
          args: { path: '/tmp/x', content: 'hello' },
        },
      },
      {
        type: 'context.append_loop_event',
        seq: 7,
        time: 7,
        event: { type: 'step.end', uuid: 'step-1', turnId: '0', step: 1, finishReason: 'tool_use' },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    expect(result.health).toBe('ok');
    const types = result.records.map((r) => r.type);
    expect(types).toContain('turn_begin');
    expect(types).toContain('user_message');
    expect(types).toContain('tools_changed');
    expect(types).toContain('step_begin');
    expect(types).toContain('tool_call');
    expect(types).toContain('step_end');
    expect(types).not.toContain('notification');

    const toolCall = result.records.find((r) => r.type === 'tool_call');
    expect(toolCall).toMatchObject({ turn_id: '0', data: { tool_name: 'Write' } });
    const toolsChanged = result.records.find((r) => r.type === 'tools_changed');
    expect(toolsChanged).toMatchObject({ operation: 'set_active', tools: ['Read', 'Write', 'Bash'] });
  });

  // The newer `context.append_message` producer carries assistant /
  // system roles too. Without a role filter, inferSteerStartedTurnId
  // would see any append_message in the lookahead window and conclude
  // that the steer launched a fresh turn, fabricating a turn id.
  it('ignores non-user append_message when inferring whether a turn.steer launched a fresh turn', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.0.1' },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'first' }],
      },
      {
        type: 'context.append_message',
        seq: 3,
        time: 3,
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      },
      {
        type: 'context.append_loop_event',
        seq: 4,
        time: 4,
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      // Steer arrives during an active turn (no later loop event reveals
      // a new turnId, no later user message follows). Only an assistant
      // append_message lands in the lookahead window.
      {
        type: 'turn.steer',
        seq: 5,
        time: 5,
        input: [{ type: 'text', text: 'buffered steer' }],
      },
      {
        type: 'context.append_message',
        seq: 6,
        time: 6,
        message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    const turnBegins = result.records.filter((record) => record.type === 'turn_begin');
    // Only the original turn.prompt should produce a turn_begin. The
    // steer must stay buffered because the lookahead contains no user
    // message — assistant append_messages don't count.
    expect(turnBegins.map((record) => record.turn_id)).toEqual(['0']);
  });

  // ContextMemory.appendSystemReminder() persists injected reminders /
  // skill activations / system triggers as role: 'user' messages for the
  // LLM, but their origin.kind is not 'user'. Replay must not surface
  // these as user_message records or count them when inferring whether
  // a turn.steer launched a fresh turn.
  it('does not surface non-user-origin append_message as user_message', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.0.1' },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'hi' }],
      },
      {
        type: 'context.append_message',
        seq: 3,
        time: 3,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          origin: { kind: 'user' },
        },
      },
      // System reminder: role: 'user' for the LLM, but origin.kind says
      // it's an injection, not a real user message.
      {
        type: 'context.append_message',
        seq: 4,
        time: 4,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>be careful</system-reminder>' }],
          origin: { kind: 'injection', variant: 'safety' },
        },
      },
      // Skill activation payload: also role: 'user' under the hood.
      {
        type: 'context.append_message',
        seq: 5,
        time: 5,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'skill bootstrap' }],
          origin: { kind: 'skill_activation', activationId: 'a1', skillName: 'plan', trigger: 'user-slash' },
        },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    const userMessages = result.records.filter((record) => record.type === 'user_message');
    // Only the real user message at seq 3 should surface — the injection
    // and skill_activation entries must not show as user_message.
    expect(userMessages.map((record) => record.seq)).toEqual([3]);
  });

  it('ignores non-user-origin append_message when inferring whether a turn.steer launched a fresh turn', async () => {
    fixture = createSyntheticSession();
    writeWire(fixture.dir, [
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
        producer: { kind: 'typescript', name: '@moonshot-ai/core', version: '0.0.1' },
      },
      {
        type: 'session_initialized',
        seq: 1,
        time: 1,
        agent_type: 'main',
        session_id: fixture.sessionId,
        system_prompt: 'You are a test assistant.',
        active_tools: [],
      },
      {
        type: 'turn.prompt',
        seq: 2,
        time: 2,
        input: [{ type: 'text', text: 'first' }],
      },
      {
        type: 'context.append_message',
        seq: 3,
        time: 3,
        message: { role: 'user', content: [{ type: 'text', text: 'first' }], origin: { kind: 'user' } },
      },
      {
        type: 'context.append_loop_event',
        seq: 4,
        time: 4,
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'turn.steer',
        seq: 5,
        time: 5,
        input: [{ type: 'text', text: 'buffered steer' }],
      },
      // Injected system reminder lands in the lookahead window. It has
      // role: 'user' but origin.kind: 'system_trigger', so it must NOT
      // count as evidence of a user-launched fresh turn.
      {
        type: 'context.append_message',
        seq: 6,
        time: 6,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>focus</system-reminder>' }],
          origin: { kind: 'system_trigger', name: 'focus-reminder' },
        },
      },
    ]);

    const result = await loadWireRecords(fixture.dir);
    const turnBegins = result.records.filter((record) => record.type === 'turn_begin');
    expect(turnBegins.map((record) => record.turn_id)).toEqual(['0']);
  });
});

function writeWire(dir: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(
    join(dir, 'wire.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}
