/**
 * EnterSwarmModeTool — swarm mode entry tool.
 *
 * The LLM calls this tool to enable swarm mode, which makes the AgentSwarm
 * tool available on the next turn. This two-step process ensures the LLM
 * cannot mix AgentSwarm with other tools in a single batch.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './enter-swarm-mode.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const EnterSwarmModeInputSchema = z.object({}).strict();
export type EnterSwarmModeInput = z.infer<typeof EnterSwarmModeInputSchema>;

export class EnterSwarmModeTool implements BuiltinTool<EnterSwarmModeInput> {
  readonly name = 'EnterSwarmMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterSwarmModeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: EnterSwarmModeInput): ToolExecution {
    return {
      description: 'Activating swarm mode',
      approvalRule: this.name,
      execute: async () => {
        if (this.agent.swarmToolEnabled) {
          return {
            isError: true,
            output: 'Swarm mode is already active. AgentSwarm is available — call it directly.',
          };
        }

        this.agent.setSwarmToolEnabled(true);
        return {
          output:
            'Swarm mode activated. AgentSwarm tool is now available on the next turn.\n' +
            'Call AgentSwarm with your decomposed tasks in the next response.',
        };
      },
    };
  }
}
