import { describe, it, expect } from 'vitest';

import { reduceTurnState } from '../state.js';
import { GuardrailViolationError } from '../error.js';
import type { TurnState } from '../context.js';
import type { ToolCall } from '#/loop';

const toolCalls = [
  { id: '1', type: 'tool', name: 'Bash', arguments: '{}' },
] as unknown as readonly ToolCall[];

describe('reduceTurnState', () => {
  it('PLANNING -> tool_batch -> EXECUTION', () => {
    expect(reduceTurnState('PLANNING', { kind: 'tool_batch', toolCalls })).toBe('EXECUTION');
  });

  it('EXECUTION -> step_end(tool_use) -> REVIEW', () => {
    expect(reduceTurnState('EXECUTION', { kind: 'step_end', stopReason: 'tool_use' })).toBe('REVIEW');
  });

  it('EXECUTION -> step_end(text) -> PLANNING', () => {
    expect(reduceTurnState('EXECUTION', { kind: 'step_end', stopReason: 'text' })).toBe('PLANNING');
  });

  it('REVIEW -> step_end(text) -> PLANNING', () => {
    expect(reduceTurnState('REVIEW', { kind: 'step_end', stopReason: 'text' })).toBe('PLANNING');
  });

  it('REVIEW -> tool_batch throws', () => {
    expect(() => reduceTurnState('REVIEW', { kind: 'tool_batch', toolCalls })).toThrow(
      GuardrailViolationError,
    );
  });
});
