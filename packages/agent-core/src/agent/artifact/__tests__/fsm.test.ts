import { describe, expect, it } from 'vitest';

import { SubagentFSM } from '../fsm';

describe('SubagentFSM', () => {
  it('starts in idle', () => {
    const fsm = new SubagentFSM();
    expect(fsm.current).toBe('idle');
  });

  it('transitions idle -> exploring -> committing -> committed', () => {
    const fsm = new SubagentFSM();
    fsm.transition('exploring');
    expect(fsm.current).toBe('exploring');
    fsm.transition('committing');
    expect(fsm.current).toBe('committing');
    fsm.transition('committed');
    expect(fsm.current).toBe('committed');
  });

  it('rejects invalid transitions', () => {
    const fsm = new SubagentFSM();
    expect(() => fsm.transition('committed')).toThrow('Invalid FSM transition');
    fsm.transition('exploring');
    expect(() => fsm.transition('committed')).toThrow('Invalid FSM transition');
  });

  it('allows transitioning to failed from exploring or committing', () => {
    const exploring = new SubagentFSM();
    exploring.transition('exploring');
    exploring.transition('failed');
    expect(exploring.current).toBe('failed');

    const committing = new SubagentFSM();
    committing.transition('exploring');
    committing.transition('committing');
    committing.transition('failed');
    expect(committing.current).toBe('failed');
  });
});
