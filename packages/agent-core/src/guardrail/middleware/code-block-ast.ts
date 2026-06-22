import type { GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';
import {
  analyzeCodeBlocks,
  type CodeBlockViolation,
} from '../ast/code-block-analyzer.js';

function parseArgs(raw: string | null): Record<string, unknown> {
  if (raw === null || raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Code-block AST guardrail middleware.
 *
 * Analyzes the code content of `Write` and `Edit` tool calls using the
 * multi-language tree-sitter WASM analyzer. Critical violations block
 * execution; high violations emit a warning.
 *
 * When the WASM parser is unavailable the middleware silently passes through
 * — the downstream policy engine and circuit breaker still apply.
 */
export function createCodeBlockAstMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled) return ctx;
    if (ctx.toolCalls === undefined || ctx.toolCalls.length === 0) return ctx;

    for (const toolCall of ctx.toolCalls) {
      if (toolCall.name !== 'Write' && toolCall.name !== 'Edit') continue;

      const parsedArgs = parseArgs(toolCall.arguments);
      const content =
        toolCall.name === 'Write'
          ? (parsedArgs['content'] as string | undefined)
          : (parsedArgs['new_string'] as string | undefined);

      if (content === undefined || content.length === 0) continue;

      const result = await analyzeCodeBlocks(content);

      if (result.violations.length === 0) continue;

      const criticalViolations = result.violations.filter(
        (v) => v.riskLevel === 'critical',
      );
      const highViolations = result.violations.filter(
        (v) => v.riskLevel === 'high',
      );

      if (criticalViolations.length > 0) {
        throw new GuardrailViolationError(
          'code_block_ast',
          `Dangerous code block blocked: ${criticalViolations.map((v) => v.description).join('; ')}`,
          {
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            violations: criticalViolations.map(describeViolation),
            totalViolationCount: result.violations.length,
          },
        );
      }

      if (highViolations.length > 0) {
        for (const v of highViolations) {
          console.warn(
            `[guardrail:code_block_ast] ${v.riskLevel.toUpperCase()}: ${v.description} (rule: ${v.rule}, language: ${v.language ?? 'unknown'})`,
          );
        }
      }
    }

    return ctx;
  };
}

function describeViolation(v: CodeBlockViolation): Record<string, unknown> {
  return {
    rule: v.rule,
    riskLevel: v.riskLevel,
    description: v.description,
    language: v.language,
    line: v.line,
    column: v.column,
    blockStartLine: v.blockStartLine,
    blockEndLine: v.blockEndLine,
  };
}
