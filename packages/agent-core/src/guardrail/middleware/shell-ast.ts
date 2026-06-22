import type { GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';
import { analyzeBashCommand, type AstViolation } from '../ast/bash-analyzer.js';
import { getPatternsByLanguage } from '../ast/dangerous-patterns.js';
import { canonicalizeCommand } from '../normalize-command.js';

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

function extractCommand(parsedArgs: Record<string, unknown>): string | undefined {
  const cmd = parsedArgs['command'];
  return typeof cmd === 'string' ? cmd : undefined;
}

/**
 * Regex-based fallback check using `DangerousPattern` textPatterns.
 *
 * Used when the WASM tree-sitter parser is unavailable. Applies each
 * bash-language pattern's text regexes against the raw command string.
 * Returns violations with risk levels mapped from the pattern definitions.
 */
function regexFallbackCheck(command: string): AstViolation[] {
  const bashPatterns = getPatternsByLanguage('bash');
  const violations: AstViolation[] = [];

  for (const pattern of bashPatterns) {
    if (pattern.textPatterns === undefined || pattern.textPatterns.length === 0) continue;

    for (const regexStr of pattern.textPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(regexStr, 'i');
      } catch {
        continue;
      }

      if (regex.test(command)) {
        violations.push({
          nodeType: 'regex_fallback',
          text: command,
          line: 0,
          column: 0,
          rule: pattern.id,
          riskLevel: pattern.riskLevel,
          description: pattern.description,
        });
        // One violation per pattern is enough
        break;
      }
    }
  }

  return violations;
}

/**
 * Shell AST guardrail middleware.
 *
 * Uses the web-tree-sitter Bash AST analyzer to detect dangerous shell
 * commands before execution. Only activates during the `beforeToolBatch`
 * phase when `ctx.toolCalls` is present.
 *
 * Detection results are handled by risk level:
 * - `critical`: throws `GuardrailViolationError` to block execution
 * - `high`: logs a warning but allows the command through
 * - `medium`: logged but allowed (same as high in this middleware)
 *
 * When the WASM parser is unavailable (`fallback === true`), the middleware
 * falls back to regex-based pattern matching using `DangerousPattern`
 * textPatterns from the pattern database. If neither approach triggers,
 * the command passes through — the existing regex-based
 * `normalize-command.ts` and circuit breaker still apply downstream.
 */
export function createShellAstMiddleware(): GuardrailMiddleware {
  const _bashPatterns = getPatternsByLanguage('bash');

  return async (ctx) => {
    if (!ctx.config.enabled) return ctx;
    if (ctx.toolCalls === undefined || ctx.toolCalls.length === 0) return ctx;

    for (const toolCall of ctx.toolCalls) {
      if (toolCall.name !== 'Bash') continue;

      const parsedArgs = parseArgs(toolCall.arguments);
      const command = extractCommand(parsedArgs);
      if (command === undefined || command.length === 0) continue;

      const result = await analyzeBashCommand(command);

      let violations: AstViolation[];

      if (result.fallback) {
        // WASM unavailable — fall through to regex-based check
        violations = regexFallbackCheck(command);
      } else {
        violations = result.violations;
      }

      if (violations.length === 0) continue;

      // Separate by risk level
      const criticalViolations = violations.filter((v) => v.riskLevel === 'critical');
      const highViolations = violations.filter((v) => v.riskLevel === 'high');

      // Critical violations block execution
      if (criticalViolations.length > 0) {
        throw new GuardrailViolationError(
          'shell_ast',
          `Dangerous shell command blocked: ${criticalViolations.map((v) => v.description).join('; ')}`,
          {
            command,
            canonicalizedCommand: canonicalizeCommand(command),
            violations: criticalViolations,
            totalViolationCount: violations.length,
          },
        );
      }

      // High violations warn but allow through
      if (highViolations.length > 0) {
        for (const v of highViolations) {
          console.warn(
            `[guardrail:shell_ast] ${v.riskLevel.toUpperCase()}: ${v.description} (rule: ${v.rule}, command: ${command})`,
          );
        }
      }
    }

    return ctx;
  };
}
