import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal synthetic session dir using the current atomic wire protocol.
 *  Real on-disk sessions under `~/.kimi-code/sessions/` use a legacy layout
 *  that can no longer be replayed, so tests use synthetic fixtures. */
export interface SyntheticOptions {
  withReminder?: boolean;
  withTools?: boolean;
  withSubagent?: boolean;
}

export interface SyntheticResult {
  dir: string;
  sessionId: string;
  cleanup(): void;
}

export function createSyntheticSession(opts: SyntheticOptions = {}): SyntheticResult {
  const sessionId = `session_${randomBytes(6).toString('hex')}`;
  const dir = join(tmpdir(), `vis-test-${sessionId}`);
  mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  let seq = 1;
  const push = (rec: Record<string, unknown>): void => {
    lines.push(JSON.stringify(rec));
  };

  push({
    type: 'metadata',
    protocol_version: '1.0',
    created_at: Date.now(),
    producer: {
      kind: 'typescript',
      name: '@moonshot-ai/agent-core',
      version: '0.0.1',
    },
  });

  push({
    type: 'session_initialized',
    seq: seq++,
    time: Date.now(),
    agent_type: 'main',
    session_id: sessionId,
    system_prompt: 'You are a test assistant.',
    model: 'test-model',
    active_tools: opts.withTools ? ['Bash'] : [],
    permission_mode: 'default',
    plan_mode: false,
    workspace_dir: '/tmp',
  });

  push({
    type: 'turn_begin',
    seq: seq++,
    time: Date.now(),
    turn_id: 'turn_1',
    agent_type: 'main',
    input_kind: 'user',
    user_input: 'hi',
  });

  push({
    type: 'user_message',
    seq: seq++,
    time: Date.now(),
    turn_id: 'turn_1',
    content: 'hi',
  });

  if (opts.withReminder) {
    push({
      type: 'system_reminder',
      seq: seq++,
      time: Date.now(),
      content: 'test reminder',
      consumed_at_turn: 1,
    });
  }

  const stepUuid = 'step-1';
  push({
    type: 'step_begin',
    seq: seq++,
    time: Date.now(),
    uuid: stepUuid,
    turn_id: 'turn_1',
    step: 0,
  });
  push({
    type: 'content_part',
    seq: seq++,
    time: Date.now(),
    uuid: 'cp-1',
    turn_id: 'turn_1',
    step: 0,
    step_uuid: stepUuid,
    role: 'assistant',
    part: { kind: 'text', text: 'hello!' },
  });

  if (opts.withTools) {
    push({
      type: 'tool_call',
      seq: seq++,
      time: Date.now(),
      uuid: 'tc-wire-1',
      turn_id: 'turn_1',
      step: 0,
      step_uuid: stepUuid,
      data: {
        tool_call_id: 'tc_abc',
        tool_name: 'Bash',
        args: { cmd: 'echo hi' },
      },
    });
  }

  push({
    type: 'step_end',
    seq: seq++,
    time: Date.now(),
    uuid: stepUuid,
    turn_id: 'turn_1',
    step: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  if (opts.withTools) {
    push({
      type: 'tool_result',
      seq: seq++,
      time: Date.now(),
      turn_id: 'turn_1',
      tool_call_id: 'tc_abc',
      output: 'hi\n',
    });
  }

  if (opts.withSubagent) {
    push({
      type: 'subagent_spawned',
      seq: seq++,
      time: Date.now(),
      data: {
        agent_id: 'sub_test-1',
        agent_name: 'coder',
        parent_tool_call_id: 'tc_sub',
        run_in_background: false,
      },
    });
    // Write the subagent's own wire.jsonl
    const subDir = join(dir, 'subagents', 'sub_test-1');
    mkdirSync(subDir, { recursive: true });
    const subLines: string[] = [
      JSON.stringify({
        type: 'metadata',
        protocol_version: '1.0',
        created_at: Date.now(),
        producer: {
          kind: 'typescript',
          name: '@moonshot-ai/agent-core',
          version: '0.0.1',
        },
      }),
      JSON.stringify({
        type: 'session_initialized',
        seq: 1,
        time: Date.now(),
        agent_type: 'sub',
        agent_id: 'sub_test-1',
        agent_name: 'coder',
        parent_session_id: sessionId,
        parent_tool_call_id: 'tc_sub',
        run_in_background: false,
        system_prompt: 'You are a subagent.',
        model: 'test-model',
        active_tools: [],
        permission_mode: 'default',
        plan_mode: false,
        workspace_dir: '/tmp',
      }),
    ];
    writeFileSync(join(subDir, 'wire.jsonl'), subLines.join('\n') + '\n');
    writeFileSync(
      join(subDir, 'meta.json'),
      JSON.stringify({
        agent_id: 'sub_test-1',
        subagent_type: 'coder',
        status: 'completed',
        description: 'test subagent',
        parent_tool_call_id: 'tc_sub',
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
      }),
    );

    push({
      type: 'subagent_completed',
      seq: seq++,
      time: Date.now(),
      data: {
        agent_id: 'sub_test-1',
        parent_tool_call_id: 'tc_sub',
        result_summary: 'all done',
        usage: { input: 100, output: 50 },
      },
    });
  }

  push({
    type: 'turn_end',
    seq: seq++,
    time: Date.now(),
    turn_id: 'turn_1',
    agent_type: 'main',
    success: true,
    reason: 'done',
  });

  writeFileSync(join(dir, 'wire.jsonl'), lines.join('\n') + '\n');
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      session_id: sessionId,
      model: 'test-model',
      status: 'idle',
      created_at: Date.now(),
      updated_at: Date.now(),
      workspace_dir: '/tmp',
      // Required for listSessions() producer filter.
      producer: { kind: 'typescript', name: '@moonshot-ai/agent-core', version: '0.0.1' },
    }),
  );

  return {
    dir,
    sessionId,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
