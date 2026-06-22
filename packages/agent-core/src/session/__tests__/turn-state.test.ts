import { describe, expect, it } from 'vitest';
import { TurnStateMachine, TurnPhase } from '#/session/turn-state';

describe('TurnStateMachine', () => {
  it('starts in idle phase', () => {
    const sm = new TurnStateMachine();
    expect(sm.getPhase()).toBe('idle');
    expect(sm.isMidTurn()).toBe(false);
  });

  it('transitions through a normal turn lifecycle', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    expect(sm.getPhase()).toBe('receiving');
    expect(sm.isMidTurn()).toBe(true);
    expect(sm.getTurnId()).toBe(1);

    sm.transition('planning');
    expect(sm.getPhase()).toBe('planning');

    sm.transition('executing');
    expect(sm.getPhase()).toBe('executing');
    expect(sm.canCompact()).toBe(true);

    sm.transition('tool_calling');
    expect(sm.getPhase()).toBe('tool_calling');
    expect(sm.canCompact()).toBe(false);

    sm.transition('executing');
    sm.transition('completed');
    expect(sm.getPhase()).toBe('completed');
    expect(sm.isMidTurn()).toBe(false);
  });

  it('allows compaction from executing and idle', () => {
    const sm = new TurnStateMachine();
    expect(sm.canCompact()).toBe(true); // idle

    sm.startTurn();
    sm.transition('planning');
    sm.transition('executing');
    expect(sm.canCompact()).toBe(true);

    sm.transition('tool_calling');
    expect(sm.canCompact()).toBe(false);
  });

  it('rejects invalid transitions', () => {
    const sm = new TurnStateMachine();
    expect(() => sm.transition('executing')).toThrow('Invalid turn state transition: idle → executing');
  });

  it('supports emergency cleaving from executing', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('planning');
    sm.transition('executing');
    sm.transition('emergency_cleaving');
    expect(sm.getPhase()).toBe('emergency_cleaving');
    expect(sm.isMidTurn()).toBe(true);
  });

  it('supports recovery from compacting and emergency_cleaving', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('planning');
    sm.transition('executing');
    sm.transition('compacting');
    sm.transition('recovering');
    expect(sm.getPhase()).toBe('recovering');

    sm.transition('completed');
    expect(sm.getPhase()).toBe('completed');
  });

  it('supports recovery from emergency_cleaving', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('executing');
    sm.transition('emergency_cleaving');
    sm.transition('recovering');
    sm.transition('executing');
    expect(sm.getPhase()).toBe('executing');
  });

  it('captures phase history in snapshot', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('planning');
    sm.transition('executing');

    const snapshot = sm.getSnapshot();
    expect(snapshot.phase).toBe('executing');
    expect(snapshot.turnId).toBe(1);
    expect(snapshot.history.length).toBe(3); // receiving, planning, executing
    expect(snapshot.history.map((h) => h.phase)).toEqual(['receiving', 'planning', 'executing']);
  });

  it('resets to idle from completed or failed', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('executing');
    sm.transition('failed');
    expect(sm.getPhase()).toBe('failed');

    sm.transition('idle');
    expect(sm.getPhase()).toBe('idle');
    expect(sm.isMidTurn()).toBe(false);
  });

  it('increments turn ID on each startTurn', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    expect(sm.getTurnId()).toBe(1);
    sm.transition('completed');
    sm.transition('idle');
    sm.startTurn();
    expect(sm.getTurnId()).toBe(2);
  });

  it('resets state completely', () => {
    const sm = new TurnStateMachine();
    sm.startTurn();
    sm.transition('executing');
    sm.reset();
    expect(sm.getPhase()).toBe('idle');
    expect(sm.getTurnId()).toBe(0);
    expect(sm.getSnapshot().history.length).toBe(0);
  });
});
