import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
} from '../../src/agent/records';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeWirePath(): Promise<string> {
  const dir = join(tmpdir(), `wire-jsonl-test-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return join(dir, 'wire.jsonl');
}

async function readLines(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('FileSystemAgentRecordPersistence', () => {
  it('writes a metadata header on the first append', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    await persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(2);
    const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(meta).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(typeof meta['created_at']).toBe('number');
  });

  it('does not re-emit a metadata header when the file already has content', async () => {
    const wirePath = await makeWirePath();

    const first = new FileSystemAgentRecordPersistence(wirePath);
    await first.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await first.close();

    const second = new FileSystemAgentRecordPersistence(wirePath);
    await second.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'two' }],
      origin: { kind: 'user' },
    });
    await second.close();

    const lines = await readLines(wirePath);
    // 1 metadata + 2 turn.prompt records.
    expect(lines).toHaveLength(3);
    const metaLines = lines.filter((l) => l.includes('"type":"metadata"'));
    expect(metaLines).toHaveLength(1);
  });

  it('filters the metadata header out of read() output', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);
    await persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hi' }],
      origin: { kind: 'user' },
    });
    await persistence.close();

    const reader = new FileSystemAgentRecordPersistence(wirePath);
    const records: AgentRecord[] = [];
    for await (const r of reader.read()) records.push(r);
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe('turn.prompt');
  });

  it('rejects an append that resumes after close starts', async () => {
    const wirePath = await makeWirePath();
    const persistence = new FileSystemAgentRecordPersistence(wirePath);

    const appendPromise = persistence.append({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'late' }],
      origin: { kind: 'user' },
    });
    const closePromise = persistence.close();

    await expect(appendPromise).rejects.toThrow(
      'FileSystemAgentRecordPersistence: append on closed persistence',
    );
    await closePromise;

    const lines = await readLines(wirePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('metadata');
  });
});
