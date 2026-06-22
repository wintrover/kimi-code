import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalKaos } from '@moonshot-ai/kaos';

import { FileCheckpointer, MemoryCheckpointer } from '#/session/checkpoint';
import type { TurnContextSnapshot } from '#/session/checkpoint';
import type { TurnStateSnapshot } from '#/session/turn-state';

function makeSnapshot(overrides: Partial<TurnContextSnapshot> = {}): TurnContextSnapshot {
  const turnState: TurnStateSnapshot = {
    phase: 'executing',
    turnId: 1,
    history: [{ phase: 'receiving', at: Date.now() }, { phase: 'executing', at: Date.now() }],
  };
  return {
    turnState,
    agentId: 'agent-0',
    turnId: 1,
    pendingSteps: ['Write src/foo.ts', 'Run tests'],
    goal: 'Implement feature X',
    sideEffectState: 'none',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MemoryCheckpointer', () => {
  it('saves and loads a snapshot by agentId', async () => {
    const cp = new MemoryCheckpointer();
    const snap = makeSnapshot();
    await cp.save(snap);

    const loaded = await cp.load('agent-0');
    expect(loaded).toBeDefined();
    expect(loaded!.agentId).toBe('agent-0');
    expect(loaded!.goal).toBe('Implement feature X');
    expect(loaded!.pendingSteps).toEqual(['Write src/foo.ts', 'Run tests']);
  });

  it('returns undefined for unknown agentId', async () => {
    const cp = new MemoryCheckpointer();
    const loaded = await cp.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('overwrites previous snapshot on save', async () => {
    const cp = new MemoryCheckpointer();
    await cp.save(makeSnapshot({ goal: 'v1' }));
    await cp.save(makeSnapshot({ goal: 'v2' }));

    const loaded = await cp.load('agent-0');
    expect(loaded!.goal).toBe('v2');
  });

  it('clears a snapshot', async () => {
    const cp = new MemoryCheckpointer();
    await cp.save(makeSnapshot());
    await cp.clear('agent-0');

    const loaded = await cp.load('agent-0');
    expect(loaded).toBeUndefined();
  });

  it('clear is idempotent', async () => {
    const cp = new MemoryCheckpointer();
    await cp.clear('agent-0');
    const loaded = await cp.load('agent-0');
    expect(loaded).toBeUndefined();
  });

  it('returns a deep copy (mutation-safe)', async () => {
    const cp = new MemoryCheckpointer();
    const snap = makeSnapshot();
    await cp.save(snap);

    const loaded1 = await cp.load('agent-0');
    const loaded2 = await cp.load('agent-0');
    expect(loaded1).not.toBe(loaded2);
    expect(loaded1).toEqual(loaded2);
  });
});

// ── FileCheckpointer tests ───────────────────────────────────────────

let tmpDir: string;
let kaos: LocalKaos;

// Create a shared temp directory for all FileCheckpointer tests.
const setupPromise = (async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'checkpoint-test-'));
  kaos = await LocalKaos.create();
  kaos = kaos.withCwd(tmpDir);
})();

afterAll(async () => {
  await setupPromise;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('FileCheckpointer', () => {
  it('saves and loads a snapshot by agentId', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    const snap = makeSnapshot();
    await cp.save(snap);

    const loaded = await cp.load('agent-0');
    expect(loaded).toBeDefined();
    expect(loaded!.agentId).toBe('agent-0');
    expect(loaded!.goal).toBe('Implement feature X');
    expect(loaded!.pendingSteps).toEqual(['Write src/foo.ts', 'Run tests']);
  });

  it('returns undefined for unknown agentId', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    const loaded = await cp.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('overwrites previous snapshot on save', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    await cp.save(makeSnapshot({ goal: 'v1' }));
    await cp.save(makeSnapshot({ goal: 'v2' }));

    const loaded = await cp.load('agent-0');
    expect(loaded!.goal).toBe('v2');
  });

  it('clears a snapshot', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    await cp.save(makeSnapshot());
    await cp.clear('agent-0');

    const loaded = await cp.load('agent-0');
    expect(loaded).toBeUndefined();
  });

  it('clear is idempotent', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    await cp.clear('nonexistent');
    const loaded = await cp.load('nonexistent');
    expect(loaded).toBeUndefined();
  });

  it('persists across separate FileCheckpointer instances', async () => {
    await setupPromise;
    const cp1 = new FileCheckpointer(tmpDir, kaos);
    const snap = makeSnapshot({ goal: 'persist-test' });
    await cp1.save(snap);

    // A different instance pointing at the same directory sees the file.
    const cp2 = new FileCheckpointer(tmpDir, kaos);
    const loaded = await cp2.load('agent-0');
    expect(loaded).toBeDefined();
    expect(loaded!.goal).toBe('persist-test');
  });

  it('creates the checkpoints directory on first save', async () => {
    await setupPromise;
    const baseDir = join(tmpDir, 'nested', 'dir');
    const cp = new FileCheckpointer(baseDir, kaos);
    await cp.save(makeSnapshot());

    const loaded = await cp.load('agent-0');
    expect(loaded).toBeDefined();
  });

  it('stores human-readable JSON', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    const snap = makeSnapshot({ goal: 'readable' });
    await cp.save(snap);

    const raw = await kaos.readText(join(tmpDir, 'checkpoints', 'agent-0.json'));
    // Pretty-printed JSON contains newlines and indentation.
    expect(raw).toContain('\n');
    expect(raw).toContain('"goal": "readable"');
  });

  it('isolates checkpoints by agentId', async () => {
    await setupPromise;
    const cp = new FileCheckpointer(tmpDir, kaos);
    await cp.save(makeSnapshot({ agentId: 'alpha', goal: 'alpha-goal' }));
    await cp.save(makeSnapshot({ agentId: 'beta', goal: 'beta-goal' }));

    const a = await cp.load('alpha');
    const b = await cp.load('beta');
    expect(a!.goal).toBe('alpha-goal');
    expect(b!.goal).toBe('beta-goal');

    await cp.clear('alpha');
    expect(await cp.load('alpha')).toBeUndefined();
    expect(await cp.load('beta')).toBeDefined();
  });
});
