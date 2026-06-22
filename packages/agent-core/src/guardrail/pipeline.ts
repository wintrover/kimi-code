import type { AgentRecord } from '../agent/records/types.js';
import type { GuardrailContext, GuardrailMiddleware } from './context.js';
import { GuardrailViolationError } from './error.js';
import type { SecurityAuditLogger } from './audit/logger.js';

/**
 * Guardrail middleware pipeline.
 *
 * Higher-level orchestration wraps the core agent loop with this pipeline.
 * Each middleware receives the shared {@link GuardrailContext}, may mutate it,
 * and must throw {@link GuardrailViolationError} on policy violation.
 */
export class GuardrailPipeline {
  private readonly middlewares: GuardrailMiddleware[] = [];
  private auditLogger?: SecurityAuditLogger;
  private recordWriter?: (record: AgentRecord) => void;

  use(middleware: GuardrailMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /** Attach a security audit logger. When set, the pipeline logs blocks and passes. */
  setAuditLogger(logger: SecurityAuditLogger): this {
    this.auditLogger = logger;
    return this;
  }

  /** Attach a wire.jsonl record writer. Guardrail records are written fire-and-forget. */
  setRecordWriter(writer: (record: AgentRecord) => void): void {
    this.recordWriter = writer;
  }

  async execute(ctx: GuardrailContext): Promise<GuardrailContext> {
    let current = ctx;
    for (const middleware of this.middlewares) {
      try {
        current = await middleware(current);
      } catch (error) {
        if (error instanceof GuardrailViolationError) {
          this.logViolation(error);
          throw error;
        }
        throw error;
      }
    }
    this.logPass(ctx);
    return current;
  }

  // ---- Internal audit helpers -------------------------------------------

  private logViolation(error: GuardrailViolationError): void {
    const { policy, reason, context } = error;

    // Fire-and-forget audit logger write.
    if (this.auditLogger) {
      void this.auditLogger.logBlock({
        policy,
        riskLevel: typeof context['riskLevel'] === 'string' ? context['riskLevel'] : 'unknown',
        description: reason,
        toolName: typeof context['toolName'] === 'string' ? context['toolName'] : undefined,
        normalizedCommand:
          typeof context['normalizedCommand'] === 'string' ? context['normalizedCommand'] : undefined,
        ruleId: typeof context['ruleId'] === 'string' ? context['ruleId'] : undefined,
      });
    }

    // Fire-and-forget wire.jsonl record.
    if (this.recordWriter) {
      this.recordWriter({
        type: 'guardrail.block',
        time: Date.now(),
        policy,
        riskLevel: typeof context['riskLevel'] === 'string' ? context['riskLevel'] : 'unknown',
        reason,
        toolName: typeof context['toolName'] === 'string' ? context['toolName'] : undefined,
        normalizedCommand:
          typeof context['normalizedCommand'] === 'string' ? context['normalizedCommand'] : undefined,
        ruleId: typeof context['ruleId'] === 'string' ? context['ruleId'] : undefined,
      });
    }
  }

  private logPass(_ctx: GuardrailContext): void {
    if (this.auditLogger) {
      void this.auditLogger.logPass({ policy: 'pipeline' });
    }
  }
}
