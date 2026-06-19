import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { AgentEnvStore } from './env-store';
import type { EnvSnapshot } from './types';
import GET_DESCRIPTION from './get-env.md?raw';
import LIST_DESCRIPTION from './list-env.md?raw';

export const GET_ENV_TOOL_NAME = 'GetEnv' as const;
export const LIST_ENV_TOOL_NAME = 'ListEnv' as const;

// ── GetEnv ──

const GetEnvInputSchema = z.object({
  key: z.string().min(1).describe('Environment variable name to look up.'),
});

export type GetEnvInput = z.infer<typeof GetEnvInputSchema>;

export class GetEnvTool implements BuiltinTool<GetEnvInput> {
  readonly name = GET_ENV_TOOL_NAME;
  readonly description: string = GET_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetEnvInputSchema);

  constructor(private readonly envStore: AgentEnvStore) {}

  resolveExecution(args: GetEnvInput): ToolExecution {
    return {
      description: `Get env: ${args.key}`,
      approvalRule: this.name,
      execute: async () => {
        const value = this.envStore.get(args.key);
        if (value === undefined) {
          return { isError: false, output: `${args.key} is not set.` };
        }
        return { isError: false, output: `${args.key}=${value}` };
      },
    };
  }
}

// ── ListEnv ──

const ListEnvInputSchema = z.object({
  include_history: z.boolean().default(false)
    .describe('If true, include the change history of environment variables.'),
  limit: z.number().int().positive().default(10)
    .describe('Maximum number of history entries to show when include_history is true.'),
});

export type ListEnvInput = z.infer<typeof ListEnvInputSchema>;

function renderSnapshot(snapshot: EnvSnapshot): string {
  const entries = Object.entries(snapshot.env);
  if (entries.length === 0) return '(empty)';
  return entries
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export class ListEnvTool implements BuiltinTool<ListEnvInput> {
  readonly name = LIST_ENV_TOOL_NAME;
  readonly description: string = LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListEnvInputSchema);

  constructor(private readonly envStore: AgentEnvStore) {}

  resolveExecution(args: ListEnvInput): ToolExecution {
    return {
      description: 'List environment',
      approvalRule: this.name,
      execute: async () => {
        const parts: string[] = [];
        parts.push(`Version: ${this.envStore.version}`);
        parts.push(`Current environment (${String(Object.keys(this.envStore.snapshot.env).length)} vars):`);
        parts.push(renderSnapshot(this.envStore.snapshot));

        if (args.include_history) {
          const history = this.envStore.history;
          const recent = history.slice(-args.limit);
          parts.push(`\n--- History (showing ${recent.length}/${history.length} entries) ---`);
          for (let i = history.length - recent.length; i < history.length; i++) {
            const entry = history[i]!;
            const ts = new Date(entry.timestamp).toISOString();
            parts.push(`  [${i}] ${ts} — ${entry.cause}`);
          }
        }

        return { isError: false, output: parts.join('\n') };
      },
    };
  }
}
