import { describe, it, expect } from 'vitest';

import { createCapabilityMiddleware } from '../middleware/capability.js';
import { ToolRegistryProxy } from '../tool-proxy.js';
import type { GuardrailConfig, GuardrailContext } from '../context.js';
import type { ToolManager } from '#/agent/tool';
import type { ExecutableTool } from '#/loop';

function makeCapabilities(toolUse: boolean) {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: toolUse,
    max_context_tokens: 0,
  };
}

function makeContext(
  config: Partial<GuardrailConfig>,
  declaredCapabilities: readonly string[],
): GuardrailContext {
  const fullConfig: GuardrailConfig = {
    enabled: true,
    maxRepeats: 3,
    windowSize: 5,
    requireReviewBetweenToolBatches: false,
    requireDeclaredToolUse: config.requireDeclaredToolUse ?? false,
  };
  return {
    agent: {
      config: {
        modelAlias: 'test-model',
      },
      kimiConfig: {
        models: {
          'test-model': {
            capabilities: [...declaredCapabilities],
          },
        },
      },
    } as unknown as GuardrailContext['agent'],
    modelCapabilities: makeCapabilities(false),
    tools: [{ name: 'Bash' } as ExecutableTool],
    state: 'PLANNING',
    telemetry: { records: [], record: () => {}, recordObservation: () => {}, recentMatches: () => 0 },
    config: fullConfig,
  };
}

describe('createCapabilityMiddleware', () => {
  it('keeps tools when tool_use is explicitly declared', async () => {
    const tools = [{ name: 'Bash' } as ExecutableTool];
    const proxy = new ToolRegistryProxy({ loopTools: tools } as unknown as ToolManager);
    const mw = createCapabilityMiddleware(proxy);
    const ctx = makeContext({}, ['tool_use']);
    await mw(ctx);
    expect(ctx.tools).toEqual(tools);
  });

  it('removes tools when capabilities are explicit and omit tool_use', async () => {
    const tools = [{ name: 'Bash' } as ExecutableTool];
    const proxy = new ToolRegistryProxy({ loopTools: tools } as unknown as ToolManager);
    const mw = createCapabilityMiddleware(proxy);
    const ctx = makeContext({}, ['thinking']);
    await mw(ctx);
    expect(ctx.tools).toEqual([]);
  });

  it('keeps tools when no capabilities are declared (auto-detection fallback)', async () => {
    const tools = [{ name: 'Bash' } as ExecutableTool];
    const proxy = new ToolRegistryProxy({ loopTools: tools } as unknown as ToolManager);
    const mw = createCapabilityMiddleware(proxy);
    const ctx = makeContext({}, []);
    await mw(ctx);
    expect(ctx.tools).toEqual(tools);
  });

  it('removes tools when requireDeclaredToolUse is true and tool_use is not declared', async () => {
    const tools = [{ name: 'Bash' } as ExecutableTool];
    const proxy = new ToolRegistryProxy({ loopTools: tools } as unknown as ToolManager);
    const mw = createCapabilityMiddleware(proxy);
    const ctx = makeContext({ requireDeclaredToolUse: true }, ['thinking']);
    await mw(ctx);
    expect(ctx.tools).toEqual([]);
  });

  it('keeps tools when requireDeclaredToolUse is true and tool_use is declared', async () => {
    const tools = [{ name: 'Bash' } as ExecutableTool];
    const proxy = new ToolRegistryProxy({ loopTools: tools } as unknown as ToolManager);
    const mw = createCapabilityMiddleware(proxy);
    const ctx = makeContext({ requireDeclaredToolUse: true }, ['tool_use']);
    await mw(ctx);
    expect(ctx.tools).toEqual(tools);
  });
});
