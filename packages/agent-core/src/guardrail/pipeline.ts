import type { GuardrailContext, GuardrailMiddleware } from './context.js';

/**
 * Guardrail middleware pipeline.
 *
 * Higher-level orchestration wraps the core agent loop with this pipeline.
 * Each middleware receives the shared {@link GuardrailContext}, may mutate it,
 * and must throw {@link GuardrailViolationError} on policy violation.
 */
export class GuardrailPipeline {
  private readonly middlewares: GuardrailMiddleware[] = [];

  use(middleware: GuardrailMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  async execute(ctx: GuardrailContext): Promise<GuardrailContext> {
    let current = ctx;
    for (const middleware of this.middlewares) {
      current = await middleware(current);
    }
    return current;
  }
}
