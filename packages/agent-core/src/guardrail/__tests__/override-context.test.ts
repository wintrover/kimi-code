import { describe, it, expect } from 'vitest';

import { computeOverrideContext } from '../override-context.js';
import type { GuardrailOverride } from '../context.js';

describe('computeOverrideContext', () => {
  it('returns undefined when overrides is undefined', () => {
    expect(computeOverrideContext(undefined, 'Bash', { command: 'ls' })).toBeUndefined();
  });

  it('returns undefined when overrides is empty', () => {
    expect(computeOverrideContext([], 'Bash', { command: 'ls' })).toBeUndefined();
  });

  it('returns undefined when no override matches', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'ax prove *', repeatPolicy: 'allow' },
    ];
    expect(computeOverrideContext(overrides, 'Bash', { command: 'ls -la' })).toBeUndefined();
  });

  it('matches a Bash command by glob pattern', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'ax prove *', repeatPolicy: 'allow' },
    ];
    const result = computeOverrideContext(overrides, 'Bash', { command: 'ax prove all' });
    expect(result).toEqual({
      override: 'allow',
      pattern: 'ax prove *',
      canonical_cmd: 'ax prove all',
    });
  });

  it('matches a non-Bash tool by name', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'Grep', repeatPolicy: 'warn' },
    ];
    const result = computeOverrideContext(overrides, 'Grep', null);
    expect(result).toEqual({
      override: 'warn',
      pattern: 'Grep',
      canonical_cmd: 'Grep',
    });
  });

  it('returns first matching override (first-match-wins)', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'ax *', repeatPolicy: 'warn' },
      { match: 'ax prove *', repeatPolicy: 'allow' },
    ];
    const result = computeOverrideContext(overrides, 'Bash', { command: 'ax prove all' });
    expect(result?.override).toBe('warn');
    expect(result?.pattern).toBe('ax *');
  });

  it('defaults to block when repeatPolicy is unset and behavior is not stateless_search', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'ax prove *' },
    ];
    const result = computeOverrideContext(overrides, 'Bash', { command: 'ax prove all' });
    expect(result?.override).toBe('block');
  });

  it('defaults to allow for stateless_search behavior', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'ax prove *', behavior: 'stateless_search' },
    ];
    const result = computeOverrideContext(overrides, 'Bash', { command: 'ax prove all' });
    expect(result?.override).toBe('allow');
  });

  it('canonicalizes Bash commands before matching', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'git status', repeatPolicy: 'allow' },
    ];
    // "sudo git status" should canonicalize to "git status"
    const result = computeOverrideContext(overrides, 'Bash', { command: 'sudo git status' });
    expect(result).toEqual({
      override: 'allow',
      pattern: 'git status',
      canonical_cmd: 'git status',
    });
  });

  it('uses tool name as subject when args is null for non-Bash tools', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'Read', repeatPolicy: 'allow' },
    ];
    const result = computeOverrideContext(overrides, 'Read', null);
    expect(result?.canonical_cmd).toBe('Read');
  });

  it('uses tool name when args lacks command field for Bash', () => {
    const overrides: GuardrailOverride[] = [
      { match: 'Bash', repeatPolicy: 'allow' },
    ];
    const result = computeOverrideContext(overrides, 'Bash', { other: 'value' });
    expect(result?.canonical_cmd).toBe('Bash');
  });
});
