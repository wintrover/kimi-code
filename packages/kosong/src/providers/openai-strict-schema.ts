/**
 * Transform any JSON Schema into an OpenAI Strict Mode compatible schema.
 *
 * OpenAI strict mode requires:
 * - All object properties listed in `properties` must be in `required`.
 * - Optional properties must be made nullable (union with `null` type).
 * - `allOf` must be flattened (merged into the parent node).
 * - Every `type: "object"` node must have `additionalProperties: false`.
 *
 * The transformer is **pure** (no mutation of the input) and **idempotent**
 * (applying it twice produces the same result as applying it once).
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert any JSON Schema into an OpenAI Strict Mode compatible schema.
 *
 * @param schema - The input JSON Schema (draft-07 or compatible).
 * @returns A new schema object that satisfies OpenAI strict-mode constraints.
 */
export function transformToStrictSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = structuredClone(schema) as Record<string, unknown>;
  transformNode(cloned);
  return cloned;
}

// ---------------------------------------------------------------------------
// Deep merge helper (hand-rolled, no lodash)
// ---------------------------------------------------------------------------

/**
 * Deep-merge two plain objects. Arrays are **replaced** (not concatenated).
 * Nested plain objects are recursively merged. All other values from `source`
 * override `target`.
 */
export function deepMergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) continue;
    const targetValue = result[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMergeObjects(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recursive transform engine
// ---------------------------------------------------------------------------

/**
 * Recursively transform a single schema node in-place (on a deep clone).
 */
function transformNode(node: Record<string, unknown>): void {
  // 1. Flatten allOf first so downstream logic sees a single merged object.
  flattenAllOf(node);

  // 2. Close open object nodes (additionalProperties: false safety net).
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }

  // 3. Make every property that is not in `required` nullable + required.
  makeOptionalPropertiesNullable(node);

  // 4. Recurse into sub-schemas.
  recurseChildren(node);
}

// ---------------------------------------------------------------------------
// allOf flattening
// ---------------------------------------------------------------------------

/**
 * Deep-merge every element of an `allOf` array into the parent node.
 * After merging, the `allOf` key is deleted.
 */
function flattenAllOf(node: Record<string, unknown>): void {
  const allOf = node['allOf'];
  if (!Array.isArray(allOf) || allOf.length === 0) return;

  for (const subSchema of allOf) {
    if (!isPlainObject(subSchema)) continue;

    // Recurse into the sub-schema so its own allOf is flattened first.
    transformNode(subSchema);

    // Deep-merge structural keys.
    for (const [key, value] of Object.entries(subSchema)) {
      if (key === 'allOf') continue; // already processed
      if (key === 'properties' && isPlainObject(value) && isPlainObject(node['properties'])) {
        node['properties'] = deepMergeObjects(
          node['properties'] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (key === 'required' && Array.isArray(value) && Array.isArray(node['required'])) {
        // Deduplicate required arrays via Set.
        const merged = new Set<string>([
          ...(node['required'] as string[]),
          ...(value as string[]),
        ]);
        node['required'] = [...merged];
      } else {
        // Source wins for scalar / other keys.
        node[key] = value;
      }
    }
  }

  delete node['allOf'];
}

// ---------------------------------------------------------------------------
// Optional → required + nullable
// ---------------------------------------------------------------------------

/**
 * For every property present in `properties` but absent from `required`,
 * add it to `required` and make the property schema nullable.
 */
function makeOptionalPropertiesNullable(node: Record<string, unknown>): void {
  const properties = node['properties'];
  if (!isPlainObject(properties)) return;

  const required = Array.isArray(node['required'])
    ? new Set<string>(node['required'] as string[])
    : new Set<string>();

  for (const [propName, propSchema] of Object.entries(properties)) {
    if (!isPlainObject(propSchema)) continue;

    if (!required.has(propName)) {
      // Property is optional → make it required + nullable.
      required.add(propName);
      makeNullable(propSchema as Record<string, unknown>);
    }
  }

  node['required'] = [...required];
}

/**
 * Ensure a property schema accepts `null` in addition to its original type.
 *
 * Strategy depends on the shape of the property:
 * - `anyOf` array  → append `{ "type": "null" }`
 * - `enum` array   → append `null` literal **and** ensure `"null"` is in type
 * - `type` as array → push `"null"` into the array (deduped)
 * - `type` as string → convert to `[originalType, "null"]`
 * - no type ($ref / nested only) → skip (nullability already structurally
 *   handled by allOf/$ref resolution)
 */
function makeNullable(propSchema: Record<string, unknown>): void {
  // Already nullable? Check for "null" in any of the type representations.
  if (isAlreadyNullable(propSchema)) return;

  const anyOf = propSchema['anyOf'];
  if (Array.isArray(anyOf)) {
    anyOf.push({ type: 'null' });
    return;
  }

  const enumValues = propSchema['enum'];
  if (Array.isArray(enumValues)) {
    // Add the literal `null` value to the enum.
    enumValues.push(null);

    // Also ensure `"null"` appears in the `type` field if present.
    ensureNullType(propSchema);
    return;
  }

  ensureNullType(propSchema);
}

/**
 * Ensure the `type` field of a schema includes `"null"`.
 *
 * - If `type` is missing → add `type: "null"`.
 * - If `type` is a string → convert to `[type, "null"]`.
 * - If `type` is an array → push `"null"` (deduped).
 */
function ensureNullType(propSchema: Record<string, unknown>): void {
  const type = propSchema['type'];

  if (type === undefined) {
    // No explicit type — nothing to add "null" to. The schema likely uses
    // $ref or nested combinator keywords; nullability is structural.
    return;
  }

  if (typeof type === 'string') {
    propSchema['type'] = [type, 'null'];
    return;
  }

  if (Array.isArray(type)) {
    if (!type.includes('null')) {
      type.push('null');
    }
    return;
  }
}

/**
 * Heuristic check: does this schema already accept `null`?
 */
function isAlreadyNullable(schema: Record<string, unknown>): boolean {
  // Check anyOf for a { type: "null" } element.
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    for (const entry of anyOf) {
      if (isPlainObject(entry) && entry['type'] === 'null') return true;
    }
  }

  // Check enum for a null literal.
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.includes(null)) {
    return true;
  }

  // Check type for "null".
  const type = schema['type'];
  if (type === 'null') return true;
  if (Array.isArray(type) && type.includes('null')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Recursive traversal
// ---------------------------------------------------------------------------

/**
 * Recurse into every child schema position that the transformer needs to
 * visit: properties values, array items, and combinator sub-schemas.
 */
function recurseChildren(node: Record<string, unknown>): void {
  // properties (map of property-name → sub-schema)
  const properties = node['properties'];
  if (isPlainObject(properties)) {
    for (const propSchema of Object.values(properties)) {
      if (isPlainObject(propSchema)) {
        transformNode(propSchema);
      }
    }
  }

  // items (single schema or array of schemas for tuple validation)
  visitSchemaOrArray(node, 'items');

  // combinators
  visitSchemaArray(node, 'anyOf');
  visitSchemaArray(node, 'oneOf');
  // allOf is already consumed by flattenAllOf; recurse any leftover just in case.
  visitSchemaArray(node, 'allOf');

  // additionalProperties when it is itself a schema (not just boolean)
  const additionalProperties = node['additionalProperties'];
  if (isPlainObject(additionalProperties)) {
    transformNode(additionalProperties);
  }
}

function visitSchemaArray(
  node: Record<string, unknown>,
  key: string,
): void {
  const value = node[key];
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (isPlainObject(entry)) {
      transformNode(entry);
    }
  }
}

function visitSchemaOrArray(
  node: Record<string, unknown>,
  key: string,
): void {
  const value = node[key];
  if (isPlainObject(value)) {
    transformNode(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (isPlainObject(entry)) {
        transformNode(entry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
