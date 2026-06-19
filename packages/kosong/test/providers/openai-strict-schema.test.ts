import { deepMergeObjects, transformToStrictSchema } from '#/providers/openai-strict-schema';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// transformToStrictSchema
// ---------------------------------------------------------------------------

describe('transformToStrictSchema', () => {
  it('makes all properties required and optional properties nullable', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };

    const result = transformToStrictSchema(schema);

    // 'age' was optional → now required + nullable
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: ['number', 'null'] },
      },
      required: ['name', 'age'],
      additionalProperties: false,
    });
  });

  it('injects null into enum and adds "null" to type for optional enum properties', () => {
    const schema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['A', 'B'],
        },
      },
    };

    const result = transformToStrictSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        status: {
          type: ['string', 'null'],
          enum: ['A', 'B', null],
        },
      },
      required: ['status'],
      additionalProperties: false,
    });
  });

  it('appends { type: "null" } to anyOf for optional anyOf properties', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'integer' }],
        },
      },
    };

    const result = transformToStrictSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }],
        },
      },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('flattens allOf by deep-merging into the parent node', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
          },
          required: ['a'],
        },
        {
          type: 'object',
          properties: {
            b: { type: 'number' },
          },
          required: ['b'],
        },
      ],
    };

    const result = transformToStrictSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
    expect(result).not.toHaveProperty('allOf');
  });

  it('recursively transforms nested object properties', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    };

    const result = transformToStrictSchema(schema);
    const user = (result['properties'] as Record<string, Record<string, unknown>>)[
      'user'
    ] as Record<string, unknown>;

    // Inner object gets additionalProperties: false
    expect(user['additionalProperties']).toBe(false);
    // Inner optional property 'email' becomes nullable + required
    expect(user['required']).toEqual(['name', 'email']);
    expect(
      (user['properties'] as Record<string, Record<string, unknown>>)['email']!['type'],
    ).toEqual(['string', 'null']);
  });

  it('transforms inner objects inside array items', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'string' },
          y: { type: 'number' },
        },
        required: ['x'],
      },
    };

    const result = transformToStrictSchema(schema);

    expect(result).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'string' },
          y: { type: ['number', 'null'] },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    });
  });

  it('is idempotent when input is already strict-compatible', () => {
    const input = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: ['number', 'null'] },
      },
      required: ['name', 'age'],
      additionalProperties: false,
    };

    const first = transformToStrictSchema(input);
    const second = transformToStrictSchema(first);

    expect(second).toEqual(first);
  });

  it('handles properties with no type field gracefully', () => {
    const schema = {
      type: 'object',
      properties: {
        freeform: { description: 'untyped field' },
        empty: {},
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    // No type → ensureNullType is a no-op; property is added to required but type is not changed
    expect(result['required']).toEqual(['freeform', 'empty']);
    expect(props['freeform']!['type']).toBeUndefined();
    expect(props['empty']!['type']).toBeUndefined();
  });

  it('sets additionalProperties: false on every type: "object" node', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            deep: {
              type: 'object',
              properties: {
                leaf: { type: 'string' },
              },
              required: ['leaf'],
            },
          },
          required: ['deep'],
        },
      },
      required: ['nested'],
    };

    const result = transformToStrictSchema(schema);
    const nested = (result['properties'] as Record<string, Record<string, unknown>>)[
      'nested'
    ] as Record<string, unknown>;
    const deep = (nested['properties'] as Record<string, Record<string, unknown>>)[
      'deep'
    ] as Record<string, unknown>;

    expect(result['additionalProperties']).toBe(false);
    expect(nested['additionalProperties']).toBe(false);
    expect(deep['additionalProperties']).toBe(false);
  });

  it('preserves additionalProperties: true when explicitly set', () => {
    const schema = {
      type: 'object',
      properties: {
        data: { type: 'string' },
      },
      required: ['data'],
      additionalProperties: true,
    };

    const result = transformToStrictSchema(schema);

    // explicit true should not be overwritten
    expect(result['additionalProperties']).toBe(true);
  });

  it('does not mutate the original schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    };
    const original = JSON.stringify(schema);

    transformToStrictSchema(schema);

    expect(JSON.stringify(schema)).toBe(original);
  });

  it('converts string type to nullable array for optional properties', () => {
    const schema = {
      type: 'object',
      properties: {
        label: { type: 'string' },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['label']!['type']).toEqual(['string', 'null']);
  });

  it('pushes "null" into existing type array without duplication', () => {
    const schema = {
      type: 'object',
      properties: {
        mixed: { type: ['string', 'integer'] },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['mixed']!['type']).toEqual(['string', 'integer', 'null']);
  });

  it('skips nullable transformation for already-nullable type array', () => {
    const schema = {
      type: 'object',
      properties: {
        nullableStr: { type: ['string', 'null'] },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['nullableStr']!['type']).toEqual(['string', 'null']);
  });

  it('skips nullable transformation for already-nullable anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['value']!['anyOf']).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('skips nullable transformation for already-nullable enum', () => {
    const schema = {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: ['A', 'B', null],
        },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['choice']!['enum']).toEqual(['A', 'B', null]);
  });

  it('handles oneOf by recursing into branches', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            {
              type: 'object',
              properties: {
                a: { type: 'string' },
              },
              required: ['a'],
            },
            { type: 'number' },
          ],
        },
      },
    };

    const result = transformToStrictSchema(schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    const oneOf = props['value']!['oneOf'] as Record<string, unknown>[];
    const branch = oneOf[0] as Record<string, unknown>;

    // The inner object branch should get additionalProperties: false
    expect(branch['additionalProperties']).toBe(false);
    // The value property itself becomes required + nullable
    expect(result['required']).toContain('value');
  });

  it('deduplicates required entries from merged allOf', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'string' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
      allOf: [
        {
          properties: { x: { type: 'string' } },
          required: ['x'],
        },
      ],
    };

    const result = transformToStrictSchema(schema);

    // 'x' should appear only once in required
    const required = result['required'] as string[];
    expect(required.filter((r) => r === 'x')).toHaveLength(1);
    expect(required).toContain('x');
    expect(required).toContain('y');
  });

  it('handles allOf where parent has no existing properties', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
          },
          required: ['a'],
        },
      ],
    };

    const result = transformToStrictSchema(schema);

    expect(result).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
      },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('handles allOf where parent has no existing required', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
          },
          required: ['a'],
        },
        {
          type: 'object',
          properties: {
            b: { type: 'number' },
          },
          required: ['b'],
        },
      ],
    };

    const result = transformToStrictSchema(schema);

    // When parent has no required array, first sub-schema's required is just
    // assigned via the scalar fallthrough.
    expect(result['required']).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });

  it('handles tuple-style array items', () => {
    const schema = {
      type: 'array',
      items: [
        {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
          required: ['key'],
        },
        { type: 'number' },
      ],
    };

    const result = transformToStrictSchema(schema);
    const items = result['items'] as Record<string, unknown>[];
    const firstItem = items[0] as Record<string, unknown>;

    expect(firstItem['additionalProperties']).toBe(false);
  });

  it('preserves non-combinator schema keys during allOf flattening', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      description: 'root description',
      allOf: [
        {
          properties: {
            age: { type: 'number' },
          },
          required: ['age'],
          title: 'from allOf',
        },
      ],
    };

    const result = transformToStrictSchema(schema);

    expect(result['description']).toBe('root description');
    // Source wins for scalar keys from allOf entries
    expect(result['title']).toBe('from allOf');
  });
});

// ---------------------------------------------------------------------------
// deepMergeObjects
// ---------------------------------------------------------------------------

describe('deepMergeObjects', () => {
  it('shallow-merges flat objects', () => {
    const result = deepMergeObjects(
      { a: 1, b: 2 },
      { b: 3, c: 4 },
    );

    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deep-merges nested objects', () => {
    const result = deepMergeObjects(
      { outer: { a: 1, b: 2 } },
      { outer: { b: 3, c: 4 } },
    );

    expect(result).toEqual({ outer: { a: 1, b: 3, c: 4 } });
  });

  it('replaces arrays instead of concatenating', () => {
    const result = deepMergeObjects(
      { tags: ['x', 'y'] },
      { tags: ['z'] },
    );

    expect(result).toEqual({ tags: ['z'] });
  });

  it('does not mutate the inputs', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    const origTarget = JSON.stringify(target);
    const origSource = JSON.stringify(source);

    deepMergeObjects(target, source);

    expect(JSON.stringify(target)).toBe(origTarget);
    expect(JSON.stringify(source)).toBe(origSource);
  });

  it('skips undefined source values', () => {
    const result = deepMergeObjects(
      { a: 1 },
      { a: undefined, b: 2 },
    );

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('source scalars override target scalars', () => {
    const result = deepMergeObjects(
      { x: 'old' },
      { x: 'new' },
    );

    expect(result).toEqual({ x: 'new' });
  });

  it('handles deeply nested structures', () => {
    const result = deepMergeObjects(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { d: 3, e: 4 } } },
    );

    expect(result).toEqual({ a: { b: { c: 1, d: 3, e: 4 } } });
  });

  it('merges where one side has no matching keys', () => {
    const result = deepMergeObjects(
      { a: 1 },
      { b: 2 },
    );

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('handles empty objects', () => {
    expect(deepMergeObjects({}, {})).toEqual({});
    expect(deepMergeObjects({ a: 1 }, {})).toEqual({ a: 1 });
    expect(deepMergeObjects({}, { a: 1 })).toEqual({ a: 1 });
  });

  it('handles mixed nesting with arrays and objects', () => {
    const result = deepMergeObjects(
      {
        items: [
          { type: 'object', properties: { a: { type: 'string' } } },
        ],
        meta: { version: 1 },
      },
      {
        items: [
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
        meta: { version: 2, extra: true },
      },
    );

    expect(result).toEqual({
      items: [
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
      meta: { version: 2, extra: true },
    });
  });
});
