import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testAgent } from '../../../../test/agent/harness/agent';
import { FileSystemAgentLedger } from '../ledger';
import { SubagentFSM } from '../fsm';
import { ArtifactSchemaRegistry } from '../schema-registry';
import { YieldArtifactTool } from '../../../tools/builtin/collaboration/yield-artifact';

describe('YieldArtifactTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yield-artifact-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('validates payload against a registered JSON output schema', async () => {
    const agent = testAgent({ type: 'sub' });
    agent.configure();

    const registry = new ArtifactSchemaRegistry();
    registry.registerJsonSchema('coder', {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    });

    agent.agent.artifacts = {
      ledger: new FileSystemAgentLedger({
        agentId: 'sub-1',
        artifactsDir: join(tmpDir, 'artifacts'),
      }),
      fsm: new SubagentFSM(),
      profileName: 'coder',
      schemaRegistry: registry,
    };
    agent.agent.artifacts.fsm.transition('exploring');

    const tool = new YieldArtifactTool(agent.agent);
    const execution = tool.resolveExecution({
      payload: { answer: 'not a number' },
      finalize: true,
    });

    if (!('execute' in execution)) {
      throw new Error('Expected executable tool result');
    }
    const result = await execution.execute({
      toolCallId: 'call_yield',
      signal: new AbortController().signal,
      turnId: '1',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('validation failed');
    expect(agent.agent.artifacts.fsm.current).toBe('failed');
  });

  it('commits a payload that satisfies the registered JSON output schema', async () => {
    const agent = testAgent({ type: 'sub' });
    agent.configure();

    const registry = new ArtifactSchemaRegistry();
    registry.registerJsonSchema('coder', {
      type: 'object',
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
      additionalProperties: false,
    });

    agent.agent.artifacts = {
      ledger: new FileSystemAgentLedger({
        agentId: 'sub-2',
        artifactsDir: join(tmpDir, 'artifacts'),
      }),
      fsm: new SubagentFSM(),
      profileName: 'coder',
      schemaRegistry: registry,
    };
    agent.agent.artifacts.fsm.transition('exploring');

    const tool = new YieldArtifactTool(agent.agent);
    const execution = tool.resolveExecution({
      payload: { answer: 42 },
      finalize: true,
    });

    if (!('execute' in execution)) {
      throw new Error('Expected executable tool result');
    }
    const result = await execution.execute({
      toolCallId: 'call_yield',
      signal: new AbortController().signal,
      turnId: '1',
    });

    expect(result.isError).toBeUndefined();
    expect(result.stopTurn).toBe(true);
    expect(agent.agent.artifacts.fsm.current).toBe('committed');

    const committed = await agent.agent.artifacts.ledger.read('final');
    expect(committed?.payload).toEqual({ answer: 42 });
  });
});
