import { describe, expect, it } from 'vitest';
import { TurnBoundary } from '#/session/turn-boundary';

describe('TurnBoundary', () => {
  it('starts and ends a turn cleanly', async () => {
    const b = new TurnBoundary();
    expect(b.isActive).toBe(false);

    expect(b.start()).toBe(true);
    expect(b.isActive).toBe(true);

    await b.end();
    expect(b.isActive).toBe(false);
  });

  it('rejects start when already active', () => {
    const b = new TurnBoundary();
    expect(b.start()).toBe(true);
    expect(b.start()).toBe(false);
  });

  it('transitions through state machine on start', () => {
    const b = new TurnBoundary();
    b.start();
    expect(b.state.getPhase()).toBe('receiving');
  });

  it('transitions to completed on end', async () => {
    const b = new TurnBoundary();
    b.start();
    await b.end();
    expect(b.state.getPhase()).toBe('idle');
  });

  it('transitions to failed on cancel', () => {
    const b = new TurnBoundary();
    b.start();
    b.cancel(new Error('test'));
    expect(b.state.getPhase()).toBe('failed');
    expect(b.isActive).toBe(false);
  });

  it('requestCompaction returns immediate when not active', () => {
    const b = new TurnBoundary();
    const result = b.requestCompaction();
    expect(result.shouldCompactNow).toBe(true);
    expect(result.waitForTurnComplete).toBeUndefined();
  });

  it('requestCompaction returns deferred when active', () => {
    const b = new TurnBoundary();
    b.start();
    const result = b.requestCompaction();
    expect(result.shouldCompactNow).toBe(false);
    expect(result.waitForTurnComplete).toBeInstanceOf(Promise);
    expect(b.compactionRequested).toBe(true);
  });

  it('deduplicates compaction requests', () => {
    const b = new TurnBoundary();
    b.start();
    const r1 = b.requestCompaction();
    const r2 = b.requestCompaction();
    expect(r1.waitForTurnComplete).toBe(r2.waitForTurnComplete);
  });

  it('end resolves deferred compaction', async () => {
    const b = new TurnBoundary();
    b.start();
    const { waitForTurnComplete } = b.requestCompaction();

    let resolved = false;
    void waitForTurnComplete!.then(() => { resolved = true; });

    await b.end();
    // After end, compaction promise should have been resolved
    expect(b.isActive).toBe(false);
  });

  it('cleave transitions to emergency_cleaving', () => {
    const b = new TurnBoundary();
    b.start();
    b.state.transition('planning');
    b.state.transition('executing');

    const { snapshot, signal } = b.cleave();
    expect(b.state.getPhase()).toBe('emergency_cleaving');
    expect(snapshot.phase).toBe('emergency_cleaving');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('recover transitions from emergency_cleaving to recovering', () => {
    const b = new TurnBoundary();
    b.start();
    b.state.transition('planning');
    b.state.transition('executing');
    b.cleave();
    b.recover();
    expect(b.state.getPhase()).toBe('recovering');
  });

  it('recover transitions from compacting to recovering', () => {
    const b = new TurnBoundary();
    b.start();
    b.state.transition('planning');
    b.state.transition('executing');
    b.state.transition('compacting');
    b.recover();
    expect(b.state.getPhase()).toBe('recovering');
  });

  it('cancel with error calls rejecter on deferred compaction', async () => {
    const b = new TurnBoundary();
    b.start();
    const { waitForTurnComplete } = b.requestCompaction();

    let caught: Error | undefined;
    void waitForTurnComplete!.catch((error) => { caught = error; });

    b.cancel(new Error('forced'));
    // Promise rejection fires as microtask — await it
    await new Promise((r) => setTimeout(r, 0));
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toBe('forced');
  });
});
