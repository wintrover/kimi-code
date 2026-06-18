import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupArtifactTmpFiles } from '../subagent-host';

describe('cleanupArtifactTmpFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synthesis-cleanup-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes only artifact tmp files with UUID suffix', async () => {
    const tmpFile = join(tmpDir, 'final.json.tmp-12345678-1234-1234-1234-123456789abc');
    const artifactFile = join(tmpDir, 'checkpoint.json');
    const otherFile = join(tmpDir, 'random.txt');
    const malformedTmp = join(tmpDir, 'final.json.tmp-nouuid');

    await writeFile(tmpFile, 'incomplete');
    await writeFile(artifactFile, '{}');
    await writeFile(otherFile, 'text');
    await writeFile(malformedTmp, 'incomplete');

    const deleted = await cleanupArtifactTmpFiles(tmpDir);

    expect(deleted).toContain(tmpFile);
    expect(deleted).not.toContain(artifactFile);
    expect(deleted).not.toContain(otherFile);
    expect(deleted).not.toContain(malformedTmp);
  });

  it('returns an empty array when the directory does not exist', async () => {
    const deleted = await cleanupArtifactTmpFiles(join(tmpDir, 'missing'));
    expect(deleted).toEqual([]);
  });
});
