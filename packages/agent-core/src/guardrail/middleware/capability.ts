import type { GuardrailContext, GuardrailMiddleware } from '../context.js';
import { ToolRegistryProxy } from '../tool-proxy.js';

function declaredCapabilities(ctx: GuardrailContext): readonly string[] {
  const alias = ctx.agent.config.modelAlias;
  if (alias === undefined) return [];
  return ctx.agent.kimiConfig?.models?.[alias]?.capabilities ?? [];
}

function hasDeclaredToolUse(ctx: GuardrailContext): boolean {
  return declaredCapabilities(ctx).some((c) => c.trim().toLowerCase() === 'tool_use');
}

function hasExplicitCapabilities(ctx: GuardrailContext): boolean {
  return declaredCapabilities(ctx).length > 0;
}

/**
 * Capability middleware.
 *
 * Filters the tool list exposed to the model based on declared capabilities.
 * When the model alias explicitly lists capabilities and omits `tool_use`, the
 * tools are stripped. This catches misconfigured aliases (e.g. a thinking-only
 * model) without blocking models whose capabilities are left to provider
 * auto-detection.
 */
export function createCapabilityMiddleware(
  toolRegistry: ToolRegistryProxy,
): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled) return ctx;

    const explicit = hasExplicitCapabilities(ctx);
    const declaredToolUse = hasDeclaredToolUse(ctx);

    const allowed = ctx.config.requireDeclaredToolUse
      ? declaredToolUse
      : explicit
        ? declaredToolUse
        : true;

    ctx.tools = allowed ? toolRegistry.availableTools : [];
    return ctx;
  };
}
