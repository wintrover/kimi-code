import { GuardrailPipeline } from './pipeline.js';
import { SecurityAuditLogger } from './audit/logger.js';
import { PolicyEngine } from './policy/engine.js';
import { createToolAllowlistMiddleware } from './middleware/tool-allowlist.js';
import { createStrictSchemaMiddleware } from './middleware/strict-schema.js';
import { createSystemLockMiddleware } from './middleware/system-lock.js';
import { createShellAstMiddleware } from './middleware/shell-ast.js';
import { createCodeBlockAstMiddleware } from './middleware/code-block-ast.js';
import { createPolicyMiddleware } from './middleware/policy.js';
import { createCircuitBreakerMiddleware } from './middleware/circuit-breaker.js';
import { createFsmMiddleware } from './middleware/fsm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityPipelineOptions {
  /** Enable/disable all guardrails. Default: true */
  readonly enabled?: boolean;
  /** Path to policy TOML file. Default: ~/.kimi-code/security-policy.toml */
  readonly policyPath?: string;
  /** Session ID for audit logging */
  readonly sessionId?: string;
  /** Enable intent classifier. Default: false */
  readonly enableIntentClassifier?: boolean;
  /** Custom audit log directory */
  readonly auditLogDir?: string;
}

export interface SecurityPipelineResult {
  pipeline: GuardrailPipeline;
  auditLogger: SecurityAuditLogger;
  policyEngine: PolicyEngine;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the full security pipeline with audit logging and policy engine.
 *
 * Middleware are registered in the canonical guardrail order:
 *
 * 1. Tool allowlist (Layer A)
 * 2. Strict schema (Layer A)
 * 3. System lock (Layer A)
 * 4. Shell AST (Layer B)
 * 5. Code-block AST (Layer B)
 * 6. Policy engine (Layer D)
 * 7. Circuit breaker (existing)
 * 8. FSM (existing)
 *
 * Note: `createCapabilityMiddleware` requires a `ToolRegistryProxy` which is
 * an external dependency. The caller must register it separately after
 * obtaining a reference to the tool registry:
 *
 * ```ts
 * const { pipeline } = await createSecurityPipeline({ sessionId });
 * pipeline.use(createCapabilityMiddleware(toolRegistry));
 * ```
 */
export async function createSecurityPipeline(
  options?: SecurityPipelineOptions,
): Promise<SecurityPipelineResult> {
  const _enabled = options?.enabled ?? true;

  // 1. Create infrastructure
  const auditLogger = new SecurityAuditLogger({
    sessionId: options?.sessionId,
    logDir: options?.auditLogDir,
  });

  const policyEngine = new PolicyEngine(options?.policyPath);
  await policyEngine.load();

  // 2. Build the pipeline
  const pipeline = new GuardrailPipeline();
  pipeline.setAuditLogger(auditLogger);

  // 3. Register middleware in canonical order
  // Layer A: Input validation
  pipeline.use(createToolAllowlistMiddleware());
  pipeline.use(createStrictSchemaMiddleware());
  pipeline.use(createSystemLockMiddleware());

  // Layer B: AST analysis
  pipeline.use(createShellAstMiddleware());
  pipeline.use(createCodeBlockAstMiddleware());

  // Layer D: Policy engine
  pipeline.use(createPolicyMiddleware(policyEngine, auditLogger));

  // Existing: Loop protection
  pipeline.use(createCircuitBreakerMiddleware());
  pipeline.use(createFsmMiddleware());

  // 4. Start the policy file watcher for hot-reload
  policyEngine.startWatcher();

  return { pipeline, auditLogger, policyEngine };
}

/**
 * Create a minimal default pipeline with only loop-protection middleware.
 *
 * Suitable for quick setup where the full security stack is not needed.
 */
export function createDefaultPipeline(): GuardrailPipeline {
  const pipeline = new GuardrailPipeline();
  pipeline.use(createCircuitBreakerMiddleware());
  pipeline.use(createFsmMiddleware());
  return pipeline;
}
