import { z } from 'zod';
import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const DESCRIPTION = `# Workload Partitioner
AST + Z3 SMT-based optimal workload partitioning for subagent swarms.
Analyzes source files, computes cost metrics, and splits work into balanced agent groups.`;

const WorkloadPartitionerInputSchema = z.object({
  files: z.array(z.object({
    path: z.string().describe('File path'),
    content: z.string().describe('File source content'),
  })).min(1).describe('Source files to partition'),
  num_agents: z.number().int().min(2).max(16).describe('Number of agent groups'),
  timeout_ms: z.number().int().min(1000).max(60000).optional().describe('Z3 solver timeout (default 30s)'),
}).strict();

type WorkloadPartitionerInput = z.infer<typeof WorkloadPartitionerInputSchema>;

export class WorkloadPartitionerTool implements BuiltinTool<WorkloadPartitionerInput> {
  readonly name = 'WorkloadPartitioner' as const;
  readonly description = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WorkloadPartitionerInputSchema);

  constructor(_subagentHost: SessionSubagentHost) {}

  resolveExecution(args: WorkloadPartitionerInput): ToolExecution {
    return {
      accesses: ToolAccesses.all(),
      description: 'Analyzing and partitioning source files for swarm distribution',
      approvalRule: this.name,
      execute: (ctx) => this.execution()(args, ctx),
    };
  }

  execution() {
    return async (args: WorkloadPartitionerInput, _ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
      try {
        const { analyzeSourceFiles } = await import('../../../partitioner/ast-analyzer.js');
        const { computeWeights } = await import('../../../partitioner/cost-model.js');
        const { buildUndirectedEdges } = await import('../../../partitioner/dependency-graph.js');
        const { solveSwarmPartition } = await import('../../../partitioner/z3-solver.js');

        // 1. AST analysis
        const analyses = await analyzeSourceFiles(
          args.files.map(f => ({ path: f.path, content: f.content }))
        );

        // 2. Dependency graph
        const filePaths = analyses.map(a => a.filePath);
        const imports = new Map(analyses.map(a => [a.filePath, new Set(a.imports)]));
        const edges = buildUndirectedEdges(imports, filePaths);

        // 3. Weights
        const W = computeWeights(analyses);

        // 4. Z3 optimal partition
        const result = await solveSwarmPartition(W, edges, args.num_agents, args.timeout_ms);

        // 5. Build response with file groupings
        const groups: Record<string, string[]> = {};
        for (let i = 0; i < args.num_agents; i++) {
          groups[`agent_${i}`] = [];
        }
        for (let j = 0; j < result.assignment.length; j++) {
          const agentIdx = result.assignment[j]!;
          groups[`agent_${agentIdx}`]!.push(filePaths[j]!);
        }

        return {
          output: JSON.stringify({
            groups,
            agent_loads: result.agentLoads,
            T_max: result.T_max,
            solver: result.solver,
            reason: result.reason,
            cost_metrics: analyses.map(a => ({
              file: a.filePath,
              weight: W[analyses.indexOf(a)],
              nodeCount: a.metrics.nodeCount,
              CC: a.metrics.cyclomaticComplexity,
              ioDegree: a.metrics.ioDegree,
              fallback: a.metrics.fallback,
            })),
          }, null, 2),
        };
      } catch (error) {
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    };
  }
}
