import { describe, it, expect } from 'vitest';

import { canonicalizeArgs, stableStringify, TurnTelemetryBuffer } from '../telemetry.js';

describe('stableStringify', () => {
  it('produces same string regardless of key order', () => {
    const a = { cmd: 'ls', args: ['-a', '-l'] };
    const b = { args: ['-a', '-l'], cmd: 'ls' };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles nested objects', () => {
    const a = { x: { z: 1, y: 2 } };
    const b = { x: { y: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe('canonicalizeArgs', () => {
  it('normalizes Bash command whitespace', () => {
    expect(canonicalizeArgs('Bash', { command: '  echo   hello  ' })).toEqual({
      command: 'echo hello',
    });
  });

  it('sorts keys for non-Bash tools', () => {
    const a = canonicalizeArgs('Read', { path: 'a', line_offset: 1 });
    const b = canonicalizeArgs('Read', { line_offset: 1, path: 'a' });
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

describe('TurnTelemetryBuffer', () => {
  it('counts recent matches within window', () => {
    const buffer = new TurnTelemetryBuffer(10);
    buffer.record('Bash', { command: 'echo hi' });
    buffer.record('Bash', { command: 'echo hi' });
    buffer.record('Read', { path: 'x' });
    expect(buffer.recentMatches('Bash', { command: 'echo hi' }, 5)).toBe(2);
    expect(buffer.recentMatches('Bash', { command: 'echo bye' }, 5)).toBe(0);
  });

  it('evicts oldest records over capacity', () => {
    const buffer = new TurnTelemetryBuffer(2);
    buffer.record('Bash', { command: 'a' });
    buffer.record('Bash', { command: 'b' });
    buffer.record('Bash', { command: 'c' });
    expect(buffer.records).toHaveLength(2);
    expect(buffer.recentMatches('Bash', { command: 'a' }, 5)).toBe(0);
  });
});
