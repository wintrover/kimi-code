import Ajv, { type ValidateFunction } from 'ajv';

import type { GuardrailMiddleware } from '../context.js';
import { GuardrailViolationError } from '../error.js';

/**
 * Cached AJV instance and compiled validators keyed by schema JSON hash.
 *
 * A single Ajv instance is reused across calls to avoid re-parsing schemas.
 * Validators are cached by a deterministic JSON key derived from the tool's
 * `parameters` schema so repeated tool calls reuse the same compiled function.
 */
const ajv = new Ajv({ strict: false, allErrors: true });

const validatorCache = new Map<string, ValidateFunction>();

function schemaCacheKey(schema: Record<string, unknown>): string {
  return JSON.stringify(schema);
}

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = schemaCacheKey(schema);
  let validate = validatorCache.get(key);
  if (validate === undefined) {
    // Inject additionalProperties: false so the provider-level strict mode
    // rejects any unexpected properties the model may have included.
    validate = ajv.compile({ ...schema, additionalProperties: false });
    validatorCache.set(key, validate);
  }
  return validate;
}

/**
 * Strict schema guardrail middleware.
 *
 * Validates tool-call arguments against the tool's JSON Schema before
 * execution. Runs during the `beforeToolBatch` phase when `ctx.toolCalls`
 * is populated. Throws a {@link GuardrailViolationError} with policy
 * `'strict_schema'` on any validation failure.
 */
export function createStrictSchemaMiddleware(): GuardrailMiddleware {
  return async (ctx) => {
    if (!ctx.config.enabled) return ctx;
    if (ctx.toolCalls === undefined || ctx.toolCalls.length === 0) return ctx;

    // Build a name → tool lookup for this batch.
    const toolByName = new Map(ctx.tools.map((t) => [t.name, t]));

    for (const toolCall of ctx.toolCalls) {
      const tool = toolByName.get(toolCall.name);
      if (tool === undefined) continue;

      const schema = tool.parameters as Record<string, unknown>;
      if (schema === undefined || typeof schema !== 'object') continue;

      // Parse the arguments JSON string produced by the model.
      if (toolCall.arguments === null) {
        // Null arguments are only valid for zero-parameter tools — let the
        // schema validator decide.
        const validate = getValidator(schema);
        if (!validate({})) {
          throw new GuardrailViolationError(
            'strict_schema',
            `Tool '${toolCall.name}' received null arguments but the schema requires properties.`,
            {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              errors: ajv.errorsText(validate.errors, { dataVar: 'args' }),
            },
          );
        }
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(toolCall.arguments) as unknown;
      } catch {
        throw new GuardrailViolationError(
          'strict_schema',
          `Tool '${toolCall.name}' received invalid JSON in arguments.`,
          {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            rawArguments: toolCall.arguments,
          },
        );
      }

      const validate = getValidator(schema);
      if (!validate(parsed)) {
        throw new GuardrailViolationError(
          'strict_schema',
          `Tool '${toolCall.name}' arguments failed schema validation.`,
          {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            errors: ajv.errorsText(validate.errors, { dataVar: 'args' }),
          },
        );
      }
    }

    return ctx;
  };
}
