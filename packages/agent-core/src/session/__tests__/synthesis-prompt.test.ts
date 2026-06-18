import { describe, expect, it } from 'vitest';

import { compactPayload } from '../subagent-host';

describe('compactPayload', () => {
  it('returns valid JSON for primitives', () => {
    expect(JSON.parse(compactPayload(42, 100))).toBe(42);
    expect(JSON.parse(compactPayload('hello', 100))).toBe('hello');
    expect(JSON.parse(compactPayload(null, 100))).toBeNull();
  });

  it('keeps full object when it fits the budget', () => {
    const payload = { a: 1, b: { c: 'two' } };
    const compacted = compactPayload(payload, 200);
    expect(JSON.parse(compacted)).toEqual(payload);
  });

  it('replaces oversized subtrees with a valid placeholder', () => {
    const payload = { small: 'x', huge: 'A'.repeat(500) };
    const compacted = compactPayload(payload, 80);
    const parsed = JSON.parse(compacted);
    expect(parsed.small).toBe('x');
    expect(parsed.huge).toBe('[TRUNCATED_BY_SYSTEM]');
  });

  it('truncates arrays while preserving valid JSON', () => {
    const payload = [1, 2, { nested: 'B'.repeat(500) }, 4];
    const compacted = compactPayload(payload, 60);
    const parsed = JSON.parse(compacted);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain(1);
    expect(parsed).toContain('[TRUNCATED_BY_SYSTEM]');
  });

  it('always returns JSON.parse-able output regardless of budget', () => {
    const payload = { a: { b: { c: { d: { e: 'deep' } } } } };
    for (const budget of [10, 50, 100, 1000]) {
      expect(() => JSON.parse(compactPayload(payload, budget))).not.toThrow();
    }
  });
});
