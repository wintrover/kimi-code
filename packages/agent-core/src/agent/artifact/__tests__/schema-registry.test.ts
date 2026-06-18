import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { ArtifactSchemaRegistry } from '../schema-registry';

describe('ArtifactSchemaRegistry', () => {
  const schema = z.object({ value: z.number() });

  it('registers and retrieves a schema', () => {
    const registry = new ArtifactSchemaRegistry();
    registry.register('test', schema, '1.0.0');
    expect(registry.has('test')).toBe(true);
    expect(registry.get('test')?.version).toBe('1.0.0');
  });

  it('validates payload when versions match', () => {
    const registry = new ArtifactSchemaRegistry();
    registry.register('test', schema, '1.0.0');
    const result = registry.migrate<{ value: number }>('test', { value: 42 }, '1.0.0');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payload).toEqual({ value: 42 });
    }
  });

  it('returns failure for invalid payload', () => {
    const registry = new ArtifactSchemaRegistry();
    registry.register('test', schema, '1.0.0');
    const result = registry.migrate('test', { value: 'not a number' }, '1.0.0');
    expect(result.success).toBe(false);
  });

  it('upcasts via registered migration transformer', () => {
    const registry = new ArtifactSchemaRegistry();
    const v1 = z.object({ count: z.number() });
    const v2 = z.object({ count: z.number(), doubled: z.number() });
    registry.register('test', v2, '2.0.0');
    registry.registerMigration<{ count: number }, { count: number; doubled: number }>(
      'test',
      '1.0.0',
      '2.0.0',
      (payload) => ({ count: payload.count, doubled: payload.count * 2 }),
    );

    const result = registry.migrate<{ count: number; doubled: number }>('test', { count: 3 }, '1.0.0');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payload).toEqual({ count: 3, doubled: 6 });
    }
  });

  it('returns failure when migration is missing', () => {
    const registry = new ArtifactSchemaRegistry();
    registry.register('test', schema, '2.0.0');
    const result = registry.migrate('test', { value: 1 }, '1.0.0');
    expect(result.success).toBe(false);
  });

  it('registers and validates a JSON Schema', () => {
    const registry = new ArtifactSchemaRegistry();
    registry.registerJsonSchema(
      'test',
      {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        additionalProperties: false,
      },
      '1.0.0',
    );
    expect(registry.has('test')).toBe(true);

    const valid = registry.migrate<{ value: number }>('test', { value: 42 }, '1.0.0');
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.payload).toEqual({ value: 42 });
    }

    const invalid = registry.migrate('test', { value: 'not a number' }, '1.0.0');
    expect(invalid.success).toBe(false);
  });
});
