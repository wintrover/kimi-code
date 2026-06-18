/**
 * YieldArtifact — deterministic subagent result commitment tool.
 *
 * Subagents in `output_mode='artifact'` call this tool to commit a structured
 * payload to the agent's ledger and terminate the turn. The tool validates the
 * payload against the profile's registered output schema, writes the artifact
 * atomically to the workspace ledger, and forces the turn to stop.
 */

import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './yield-artifact.md?raw';

export const YIELD_ARTIFACT_TOOL_NAME = 'YieldArtifact' as const;

export const YieldArtifactInputSchema = z.object({
  artifact_id: z
    .string()
    .optional()
    .describe('Optional stable id; defaults to "final".'),
  payload: z
    .record(z.string(), z.unknown())
    .describe('Structured payload to commit to the artifact ledger.'),
  finalize: z
    .boolean()
    .optional()
    .describe('When true, this artifact terminates the subagent successfully.'),
});

export type YieldArtifactInput = z.infer<typeof YieldArtifactInputSchema>;

export class YieldArtifactTool implements BuiltinTool<YieldArtifactInput> {
  readonly name = YIELD_ARTIFACT_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(YieldArtifactInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: YieldArtifactInput): ToolExecution {
    const schema = this.agent.artifacts?.schemaRegistry.get(this.agent.artifacts.profileName);
    const description = schema
      ? `Commit artifact "${args.artifact_id ?? 'final'}" for profile "${this.agent.artifacts!.profileName}"`
      : `Commit artifact "${args.artifact_id ?? 'final'}"`;

    return {
      description,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: YieldArtifactInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    signal.throwIfAborted();

    const artifacts = this.agent.artifacts;
    if (artifacts === undefined) {
      return {
        output: 'YieldArtifact is only available for subagents running in artifact output mode.',
        isError: true,
      };
    }

    const fsm = artifacts.fsm;
    if (fsm.current !== 'exploring' && fsm.current !== 'committing') {
      return {
        output: `Cannot yield artifact from FSM state "${fsm.current}".`,
        isError: true,
      };
    }

    fsm.transition('committing');

    const profileName = artifacts.profileName;
    const registered = artifacts.schemaRegistry.get(profileName);
    const validator = registered?.validator;
    const schemaVersion = registered?.version ?? '1.0.0';

    try {
      const record = await artifacts.ledger.commit(
        {
          artifactId: args.artifact_id ?? 'final',
          profileName,
          schemaVersion,
          payload: args.payload,
        },
        validator,
      );

      fsm.transition('committed');

      const output = JSON.stringify({
        committed: true,
        artifactId: record.artifactId,
        checksum: record.checksum,
      });

      return {
        output,
        stopTurn: args.finalize !== false,
      };
    } catch (error) {
      fsm.transition('failed');
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: `Failed to commit artifact: ${message}`,
        isError: true,
      };
    }
  }
}
