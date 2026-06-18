import { describe, expect, it } from 'vitest';

import { compileToolArgsValidator, validateToolArgs } from '../../src/tools/args-validator';

describe('anyOf validation', () => {
  it('validates anyOf with integer and null', () => {
    const schema = {
      type: 'object',
      properties: {
        max_results: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
        },
      },
    };
    const validator = compileToolArgsValidator(schema);

    // integer should pass
    expect(validateToolArgs(validator, { max_results: 5 })).toBeNull();
    // null should pass
    expect(validateToolArgs(validator, { max_results: null })).toBeNull();
    // string should fail
    expect(validateToolArgs(validator, { max_results: 'abc' })).not.toBeNull();
  });

  it('validates nullable: true schema', () => {
    const schema = {
      type: 'object',
      properties: {
        max_results: {
          type: 'integer',
          nullable: true,
        },
      },
    };
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { max_results: 5 })).toBeNull();
    expect(validateToolArgs(validator, { max_results: null })).toBeNull();
    expect(validateToolArgs(validator, { max_results: 'abc' })).not.toBeNull();
  });

  it('includes sub-error details for anyOf failures', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
        },
      },
    };
    const validator = compileToolArgsValidator(schema);
    const result = validateToolArgs(validator, { value: 'hello' });

    expect(result).not.toBeNull();
    // Should contain the anyOf parent error
    expect(result).toContain('must match a schema in anyOf');
    // Should contain branch sub-errors with instance paths
    expect(result).toContain('/value');
  });

  it('validates anyOf with multiple type branches', () => {
    const schema = {
      type: 'object',
      properties: {
        data: {
          anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
        },
      },
    };
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { data: 'text' })).toBeNull();
    expect(validateToolArgs(validator, { data: 42 })).toBeNull();
    expect(validateToolArgs(validator, { data: true })).toBeNull();
    expect(validateToolArgs(validator, { data: [1, 2] })).not.toBeNull();
  });

  it('validates nested anyOf inside object schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            timeout: {
              anyOf: [{ type: 'integer' }, { type: 'null' }],
            },
          },
        },
      },
    };
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { config: { timeout: 30 } })).toBeNull();
    expect(validateToolArgs(validator, { config: { timeout: null } })).toBeNull();
    expect(validateToolArgs(validator, { config: { timeout: 'fast' } })).not.toBeNull();
  });

  it('reports errors without instancePath for root-level anyOf', () => {
    const schema = {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
    };
    const validator = compileToolArgsValidator(schema);
    const result = validateToolArgs(validator, 'hello');

    expect(result).not.toBeNull();
    expect(result).toContain('must match a schema in anyOf');
  });
});
