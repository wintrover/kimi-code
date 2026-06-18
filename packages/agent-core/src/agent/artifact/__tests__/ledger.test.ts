import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactCorruptionError,
  ArtifactValidationError,
  FileSystemAgentLedger,
} from '../ledger';

describe('FileSystemAgentLedger', () => {
  let tmpDir: string;
  let ledger: FileSystemAgentLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-artifact-'));
    ledger = new FileSystemAgentLedger({ agentId: 'agent-1', artifactsDir: join(tmpDir, 'artifacts') });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('commits an artifact atomically and reads it back', async () => {
    const record = await ledger.commit({
      profileName: 'test',
      schemaVersion: '1.0.0',
      payload: { hello: 'world' },
    });

    expect(record.artifactId).toBe('final');
    expect(record.checksum).toHaveLength(64);

    const read = await ledger.read();
    expect(read?.payload).toEqual({ hello: 'world' });
  });

  it('validates payload against Zod schema on commit', async () => {
    const schema = z.object({ value: z.number() });
    await expect(
      ledger.commit(
        {
          profileName: 'test',
          schemaVersion: '1.0.0',
          payload: { value: 'not a number' } as unknown as { value: number },
        },
        schema,
      ),
    ).rejects.toBeInstanceOf(ArtifactValidationError);
  });

  it('validates payload on read', async () => {
    const schema = z.object({ value: z.number() });
    await ledger.commit(
      {
        profileName: 'test',
        schemaVersion: '1.0.0',
        payload: { value: 42 },
      },
      schema,
    );

    const read = await ledger.read('final', schema);
    expect(read?.payload).toEqual({ value: 42 });
  });

  it('detects checksum corruption', async () => {
    await ledger.commit({
      profileName: 'test',
      schemaVersion: '1.0.0',
      payload: { hello: 'world' },
    });

    const filePath = join(tmpDir, 'artifacts', 'final.json');
    const content = JSON.parse(await readFile(filePath, 'utf8'));
    content.payload = { tampered: true };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, JSON.stringify(content), 'utf8');

    await expect(ledger.read()).rejects.toBeInstanceOf(ArtifactCorruptionError);
  });

  it('returns only recent artifacts via readRecent', async () => {
    const schema = z.object({ n: z.number() });
    for (let i = 1; i <= 5; i += 1) {
      await ledger.commit(
        {
          artifactId: `checkpoint-${i}`,
          profileName: 'test',
          schemaVersion: '1.0.0',
          payload: { n: i },
        },
        schema,
      );
    }

    const recent = await ledger.readRecent(2, schema);
    expect(recent.map((r) => r.payload.n)).toEqual([4, 5]);
  });

  it('excludes final artifacts when reading checkpoints', async () => {
    const schema = z.object({ n: z.number() });
    await ledger.commit(
      {
        artifactId: 'checkpoint-1',
        profileName: 'test',
        schemaVersion: '1.0.0',
        payload: { n: 1 },
      },
      schema,
    );
    await ledger.commit(
      {
        artifactId: 'checkpoint-2',
        profileName: 'test',
        schemaVersion: '1.0.0',
        payload: { n: 2 },
      },
      schema,
    );
    await ledger.commit(
      {
        artifactId: 'final',
        profileName: 'test',
        schemaVersion: '1.0.0',
        payload: { n: 99 },
      },
      schema,
    );

    const checkpoints = await ledger.readCheckpoints(10, schema);
    expect(checkpoints.map((r) => r.payload.n)).toEqual([1, 2]);
  });

  it('reads delta chain in sequence order', async () => {
    const schema = z.object({ n: z.number() });
    for (let i = 1; i <= 4; i += 1) {
      await ledger.commit(
        {
          artifactId: `cp-${i}`,
          profileName: 'test',
          schemaVersion: '1.0.0',
          payload: { n: i },
          parentSequence: i - 1,
        },
        schema,
      );
    }

    const chain = await ledger.readDeltaChain(2, schema);
    expect(chain.map((r) => r.payload.n)).toEqual([2, 3, 4]);
  });
});
