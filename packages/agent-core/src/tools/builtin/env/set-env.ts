import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { AgentEnvStore } from './env-store';
import DESCRIPTION from './set-env.md?raw';

export const SET_ENV_TOOL_NAME = 'SetEnv' as const;

const SetEnvInputSchema = z.object({
  key: z.string().min(1).describe('Environment variable name (e.g. PATH, HOME, NODE_ENV).'),
  value: z.string().describe('Value to set.'),
  action: z.enum(['set', 'append', 'delete']).default('set')
    .describe('set: overwrite. append: add to existing value with ":" separator. delete: remove the variable.'),
});

export type SetEnvInput = z.infer<typeof SetEnvInputSchema>;

export class SetEnvTool implements BuiltinTool<SetEnvInput> {
  readonly name = SET_ENV_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SetEnvInputSchema);

  constructor(private readonly envStore: AgentEnvStore) {}

  resolveExecution(args: SetEnvInput): ToolExecution {
    const { key, value, action } = args;
    const preview = `${action} ${key}`;
    return {
      description: `Env: ${preview}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          let snapshot;
          if (action === 'delete') {
            snapshot = this.envStore.delete(key);
          } else if (action === 'append') {
            snapshot = this.envStore.append(key, value);
          } else {
            snapshot = this.envStore.set(key, value);
          }
          const currentValue = snapshot.env[key];
          return {
            isError: false,
            output: `Environment updated (v${this.envStore.version}).\n` +
              `${key}=${currentValue ?? '(deleted)'}`,
          };
        } catch (error) {
          return {
            isError: true,
            output: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}
