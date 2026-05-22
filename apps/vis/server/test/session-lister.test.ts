import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listSessions, loadSessionSummary } from '../src/lib/session-lister';
import { createSyntheticSession, type SyntheticResult } from './_fixture';

describe('session-lister', () => {
  let fixture: SyntheticResult | null = null;
  const fixtureRoots: string[] = [];

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
    // Cleanup enumeration roots from the second test
    for (const root of fixtureRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    fixtureRoots.length = 0;
  });

  it('loads a single SessionSummary from a synthetic session dir', async () => {
    fixture = createSyntheticSession({ withSubagent: true });
    const summary = await loadSessionSummary(fixture.dir);
    expect(summary.session_id).toBe(fixture.sessionId);
    expect(summary.model).toBe('test-model');
    expect(summary.workspace_dir).toBe('/tmp');
    expect(summary.subagent_count).toBe(1);
    expect(summary.wire_protocol_version).toBe('1.0');
    expect(summary.wire_record_count).toBeGreaterThan(0);
    expect(summary.health).toBe('ok');
  });

  it('enumerates session_* subdirs and sorts by updated_at desc', async () => {
    const root = join(tmpdir(), `vis-list-${randomBytes(4).toString('hex')}`);
    mkdirSync(root, { recursive: true });
    fixtureRoots.push(root);

    // Seed three synthetic sessions with staggered updated_at
    for (let i = 0; i < 3; i += 1) {
      const sessionId = `session_${randomBytes(6).toString('hex')}`;
      const dir = join(root, sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'wire.jsonl'),
        JSON.stringify({
          type: 'metadata',
          protocol_version: '1.0',
          created_at: Date.now(),
          producer: { kind: 'typescript', name: '@moonshot-ai/agent-core', version: '0.0.1' },
        }) + '\n',
      );
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          session_id: sessionId,
          model: 'test-model',
          status: 'idle',
          created_at: Date.now() - i * 1000,
          updated_at: Date.now() - i * 1000,
          workspace_dir: '/tmp',
          producer: { kind: 'typescript', name: '@moonshot-ai/agent-core', version: '0.0.1' },
        }),
      );
    }

    // Drop a non-session_* entry to verify it is ignored
    writeFileSync(join(root, 'random-file.txt'), 'x');

    // Drop a session_* dir with a non-TS producer — must be filtered out
    const pySessionId = `session_${randomBytes(6).toString('hex')}`;
    const pyDir = join(root, pySessionId);
    mkdirSync(pyDir, { recursive: true });
    writeFileSync(join(pyDir, 'wire.jsonl'), '{}\n');
    writeFileSync(
      join(pyDir, 'state.json'),
      JSON.stringify({
        session_id: pySessionId,
        created_at: Date.now(),
        updated_at: Date.now(),
        producer: { kind: 'python', name: 'kimi-cli', version: '0.9.0' },
      }),
    );

    // Drop a session_* dir with no state.json — must be filtered out
    const oldSessionId = `session_${randomBytes(6).toString('hex')}`;
    const oldDir = join(root, oldSessionId);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'wire.jsonl'), '{}\n');

    const summaries = await listSessions(root);
    expect(summaries.length).toBe(3);
    // None of the filtered sessions should have leaked through.
    expect(summaries.some((s) => s.session_id === pySessionId)).toBe(false);
    expect(summaries.some((s) => s.session_id === oldSessionId)).toBe(false);
    for (const s of summaries) {
      expect(s.session_id.startsWith('session_')).toBe(true);
    }
    for (let i = 1; i < summaries.length; i += 1) {
      const prev = summaries[i - 1];
      const cur = summaries[i];
      if (prev === undefined || cur === undefined) continue;
      expect(prev.updated_at).toBeGreaterThanOrEqual(cur.updated_at);
    }
    for (const s of summaries) {
      expect(['ok', 'broken', 'missing_wire']).toContain(s.health);
    }
  });
});
