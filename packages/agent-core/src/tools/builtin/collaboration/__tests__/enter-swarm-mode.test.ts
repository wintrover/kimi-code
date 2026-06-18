import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../../../../../test/agent/harness/agent';
import { EnterSwarmModeTool } from '../enter-swarm-mode';

function createMockSubagentHost() {
  return {
    spawn: vi.fn(),
    cancelAll: vi.fn(),
    startBtw: vi.fn(),
    runQueued: vi.fn(),
    getSwarmItem: vi.fn(),
  } as unknown as import('#/session/subagent-host').SessionSubagentHost;
}

describe('Agent.swarmToolEnabled', () => {
  it('defaults to false', () => {
    const ctx = testAgent();
    expect(ctx.agent.swarmToolEnabled).toBe(false);
  });

  it('setSwarmToolEnabled toggles the flag', () => {
    const ctx = testAgent();
    ctx.agent.setSwarmToolEnabled(true);
    expect(ctx.agent.swarmToolEnabled).toBe(true);

    ctx.agent.setSwarmToolEnabled(false);
    expect(ctx.agent.swarmToolEnabled).toBe(false);
  });
});

describe('loopTools AgentSwarm filtering', () => {
  it('excludes AgentSwarm when swarmToolEnabled is false', () => {
    const subagentHost = createMockSubagentHost();
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Read', 'Write', 'AgentSwarm'] });

    const toolNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    expect(toolNames).not.toContain('AgentSwarm');
  });

  it('includes AgentSwarm when swarmToolEnabled is true', () => {
    const subagentHost = createMockSubagentHost();
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Read', 'Write', 'AgentSwarm'] });
    ctx.agent.setSwarmToolEnabled(true);

    const toolNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(toolNames).toContain('AgentSwarm');
  });
});

describe('EnterSwarmModeTool', () => {
  it('sets swarmToolEnabled to true on execution', async () => {
    const ctx = testAgent();
    ctx.configure();

    const tool = new EnterSwarmModeTool(ctx.agent);
    const execution = tool.resolveExecution({});

    if (!('execute' in execution)) {
      throw new Error('Expected executable tool result');
    }
    const result = await execution.execute({
      toolCallId: 'call_enter_swarm',
      signal: new AbortController().signal,
      turnId: '1',
    });

    expect(ctx.agent.swarmToolEnabled).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Swarm mode activated');
  });

  it('returns error when swarm mode is already active', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.setSwarmToolEnabled(true);

    const tool = new EnterSwarmModeTool(ctx.agent);
    const execution = tool.resolveExecution({});

    if (!('execute' in execution)) {
      throw new Error('Expected executable tool result');
    }
    const result = await execution.execute({
      toolCallId: 'call_enter_swarm_dup',
      signal: new AbortController().signal,
      turnId: '1',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already active');
    expect(ctx.agent.swarmToolEnabled).toBe(true);
  });

  it('has correct tool metadata', () => {
    const ctx = testAgent();
    const tool = new EnterSwarmModeTool(ctx.agent);
    expect(tool.name).toBe('EnterSwarmMode');
    expect(tool.description).toContain('Activate swarm mode');
    expect(tool.parameters).toBeDefined();
  });
});
