import type { GuardrailContext, GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';
import type { PolicyDecision, PolicyEngine } from '../policy/engine.js';
import type { SecurityAuditLogger } from '../audit/logger.js';

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
 * Policy guardrail middleware.
 *
 * Evaluates every tool call in the current batch against the
 * {@link PolicyEngine}. The engine returns a {@link PolicyDecision} for the
 * first matching rule. Outcomes are:
 *
 * - `'block'` → throws {@link GuardrailViolationError} with `policy: 'policy_engine'`.
 * - `'warn'` → emits a `console.warn` and, when available, logs via
 *   {@link SecurityAuditLogger.logWarn}.
 * - `'allow'` / `null` → pass-through.
 */
export function createPolicyMiddleware(
  policyEngine: PolicyEngine,
  auditLogger?: SecurityAuditLogger,
): GuardrailMiddleware {
  return async (ctx: GuardrailContext): Promise<GuardrailContext> => {
    if (ctx.toolCalls === undefined || ctx.toolCalls.length === 0) {
      return ctx;
    }

    for (const toolCall of ctx.toolCalls) {
      const parsedArgs = parseArgs(toolCall.arguments);
      const context = buildEvalContext(toolCall.name, parsedArgs);
      const decision = policyEngine.evaluate(context);

      if (decision === null) continue;

      await handleDecision(ctx, toolCall.name, parsedArgs, decision, auditLogger);
    }

    return ctx;
  };
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

interface EvalContext {
  toolName: string;
  command?: string;
  codeBlock?: string;
  language?: string;
}

/** Extract the evaluation context fields from a parsed tool-call payload. */
function buildEvalContext(toolName: string, args: Record<string, unknown>): EvalContext {
  const ctx: EvalContext = { toolName };

  if (toolName === 'Bash') {
    const cmd = args['command'];
    if (typeof cmd === 'string') {
      ctx.command = cmd;
    }
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const content = args['content'] ?? args['new_string'];
    if (typeof content === 'string') {
      ctx.codeBlock = content;
    }
  }

  return ctx;
}

async function handleDecision(
  _ctx: GuardrailContext,
  toolName: string,
  parsedArgs: Record<string, unknown>,
  decision: PolicyDecision,
  auditLogger: SecurityAuditLogger | undefined,
): Promise<void> {
  if (decision.action === 'block') {
    if (auditLogger !== undefined) {
      await auditLogger.logBlock({
        policy: 'policy_engine',
        ruleId: decision.ruleId,
        riskLevel: decision.riskLevel,
        description: decision.description,
        toolName,
        toolArgs: parsedArgs,
      });
    }
    throw new GuardrailViolationError(
      'policy_engine',
      `${decision.description} [rule: ${decision.ruleId}, risk: ${decision.riskLevel}]`,
      {
        toolName,
        ruleId: decision.ruleId,
        riskLevel: decision.riskLevel,
      },
    );
  }

  if (decision.action === 'warn') {
    console.warn(
      `[guardrail] Policy rule "${decision.ruleId}" (${decision.riskLevel}): ${decision.description}`,
    );
    if (auditLogger !== undefined) {
      await auditLogger.logWarn({
        policy: 'policy_engine',
        ruleId: decision.ruleId,
        riskLevel: decision.riskLevel,
        description: decision.description,
        toolName,
        toolArgs: parsedArgs,
      });
    }
  }
}
