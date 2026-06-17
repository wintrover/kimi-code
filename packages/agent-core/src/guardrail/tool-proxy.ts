import type { ToolManager } from '#/agent/tool';
import type { ExecutableTool } from '#/loop';

/**
 * Capability-aware tool registry proxy.
 *
 * The agent never sees tools that its model cannot use. This prevents a
 * non-tool-use model from even being prompted with tool definitions.
 */
export class ToolRegistryProxy {
  constructor(private readonly tools: ToolManager) {}

  /** All tools currently registered with the agent. */
  get availableTools(): readonly ExecutableTool[] {
    return this.tools.loopTools;
  }
}
