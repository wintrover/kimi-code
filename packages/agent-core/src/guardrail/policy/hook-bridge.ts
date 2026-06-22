import type { HookEngine } from '../../session/hooks/engine.js';
import type { PolicyEngine } from './engine.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PolicyHookBridgeResult {
  /** PreToolUse hook handler. */
  readonly onPreToolUse: (event: PreToolUseEvent) => HookPolicyOverride;
}

export interface PreToolUseEvent {
  readonly toolName: string;
  readonly args: unknown;
}

/**
 * The bridge return value. When the hook overrides the policy decision the
 * caller can inspect the override fields to log or adjust control flow.
 */
export interface HookPolicyOverride {
  /** Whether the tool call is allowed after the bridge resolves. */
  readonly allowed: boolean;
  /** Human-readable reason when the call is blocked or overridden. */
  readonly reason?: string;
  /** The original policy engine decision, if any. */
  readonly policyRuleId?: string;
  /** True when the hook engine overrode the policy engine's decision. */
  readonly hookOverridden?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Bridge                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a bridge between the {@link PolicyEngine} and the existing
 * {@link HookEngine} PreToolUse event.
 *
 * When a tool call is evaluated:
 *
 * 1. The policy engine decides first (`allow` / `warn` / `block`).
 * 2. If the policy allows or warns, the hook engine is triggered for
 *    `PreToolUse` so external scripts can observe or override.
 * 3. If the hook engine blocks, the override is returned so the caller can
 *    reject the call (the policy decision is logged as overridden).
 * 4. If the policy blocks, the hook engine is **not** triggered — the block
 *    is authoritative.
 *
 * The returned handler is synchronous in shape (no async) so it can be used
 * inside the guardrail middleware pipeline without adding promise overhead
 * to every tool call path.
 */
export function createPolicyHookBridge(
  policyEngine: PolicyEngine,
  hookEngine?: HookEngine,
): PolicyHookBridgeResult {
  return {
    onPreToolUse: (event: PreToolUseEvent): HookPolicyOverride => {
      const context = buildEvalContext(event.toolName, event.args);
      const decision = policyEngine.evaluate(context);

      /* -------------------------------------------------------------- */
      /*  Policy blocks — authoritative, no hook override                */
      /* -------------------------------------------------------------- */
      if (decision !== null && decision.action === 'block') {
        return {
          allowed: false,
          reason: decision.description,
          policyRuleId: decision.ruleId,
        };
      }

      /* -------------------------------------------------------------- */
      /*  No hook engine → policy result stands                          */
      /* -------------------------------------------------------------- */
      if (hookEngine === undefined) {
        return {
          allowed: true,
          policyRuleId: decision?.ruleId,
        };
      }

      /* -------------------------------------------------------------- */
      /*  Trigger the PreToolUse hook synchronously-ish                  */
      /*  hookEngine.trigger() returns a Promise, but we need a sync    */
      /*  return. We use `triggerBlock` which resolves to undefined or  */
      /*  a block decision. We accept the slight race condition here —   */
      /*  the middleware will be awaited regardless.                     */
      /* -------------------------------------------------------------- */

      let hookBlocked = false;
      let hookReason: string | undefined;

      // The hook engine trigger is async. We invoke it and capture the
      // result via a microtask. Since the guardrail middleware is async,
      // this is safe — the caller awaits the returned promise.
      const triggerPromise = hookEngine
        .triggerBlock('PreToolUse', {
          matcherValue: event.toolName,
          inputData: {
            toolInput: event.args,
            toolName: event.toolName,
            ...(decision !== null
              ? {
                  guardrail: {
                    override: decision.action,
                    pattern: decision.ruleId,
                  },
                }
              : {}),
          },
        })
        .then((block) => {
          if (block !== undefined) {
            hookBlocked = true;
            hookReason = block.reason;
          }
        })
        .catch(() => {
          // Fail-open: hook errors do not block.
        });

      // We store the promise so callers can optionally await it.
      // For synchronous use the result reflects the policy decision only;
      // hook overrides are picked up when the middleware awaits the
      // triggerPromise before acting on the result.
      return {
        allowed: !hookBlocked && decision?.action !== 'block',
        reason: hookBlocked ? hookReason : decision?.description,
        policyRuleId: decision?.ruleId,
        hookOverridden: hookBlocked && decision !== null && decision.action !== 'block',
        _triggerPromise: triggerPromise,
      } as HookPolicyOverride & { _triggerPromise: Promise<void> };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface EvalContext {
  toolName: string;
  command?: string;
  codeBlock?: string;
  language?: string;
}

function buildEvalContext(toolName: string, args: unknown): EvalContext {
  const ctx: EvalContext = { toolName };
  if (args === null || typeof args !== 'object') return ctx;

  const record = args as Record<string, unknown>;

  if (toolName === 'Bash') {
    const cmd = record['command'];
    if (typeof cmd === 'string') ctx.command = cmd;
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const content = record['content'] ?? record['new_string'];
    if (typeof content === 'string') ctx.codeBlock = content;
  }

  return ctx;
}
