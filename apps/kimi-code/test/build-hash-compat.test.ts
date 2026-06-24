import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { computeSourceHash, loadConfig } from '../../../scripts/source-hash.mjs';

describe('computeSourceHash', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(process.cwd(), '.tmp-hash-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces deterministic hash for the same file set', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');
    writeFileSync(join(tmpDir, 'b.json'), '{"key":"value"}\n');
    mkdirSync(join(tmpDir, 'sub'), { recursive: true });
    writeFileSync(join(tmpDir, 'sub', 'c.md'), '# Hello\n');

    const config = {
      sourceExts: ['.ts', '.md', '.json'],
      excludedDirs: ['node_modules', '.git'],
    };

    const hash1 = computeSourceHash(tmpDir, config);
    const hash2 = computeSourceHash(tmpDir, config);
    expect(hash1).toBe(hash2);
  });

  it('changes hash when file content changes', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');

    const config = {
      sourceExts: ['.ts'],
      excludedDirs: [],
    };

    const hashBefore = computeSourceHash(tmpDir, config);
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 2;\n');
    const hashAfter = computeSourceHash(tmpDir, config);

    expect(hashBefore).not.toBe(hashAfter);
  });

  it('changes hash when a new file is added', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');

    const config = {
      sourceExts: ['.ts'],
      excludedDirs: [],
    };

    const hashBefore = computeSourceHash(tmpDir, config);
    writeFileSync(join(tmpDir, 'b.ts'), 'const y = 2;\n');
    const hashAfter = computeSourceHash(tmpDir, config);

    expect(hashBefore).not.toBe(hashAfter);
  });

  it('ignores files with non-matching extensions', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');

    const config = {
      sourceExts: ['.ts'],
      excludedDirs: [],
    };

    const hashBefore = computeSourceHash(tmpDir, config);
    writeFileSync(join(tmpDir, 'b.py'), 'print("hello")\n');
    const hashAfter = computeSourceHash(tmpDir, config);

    expect(hashBefore).toBe(hashAfter);
  });

  it('excludes directories in excludedDirs', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');

    const config = {
      sourceExts: ['.ts'],
      excludedDirs: ['node_modules'],
    };

    const hashBefore = computeSourceHash(tmpDir, config);
    mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'dep.ts'), 'export const dep = 1;\n');
    const hashAfter = computeSourceHash(tmpDir, config);

    expect(hashBefore).toBe(hashAfter);
  });

  it('uses SHA1 algorithm producing 40-char hex string', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'test\n');

    const hash = computeSourceHash(tmpDir, { sourceExts: ['.ts'], excludedDirs: [] });

    expect(hash).toHaveLength(40);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('matches the SHA1 hash computed by Node.js crypto directly', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const x = 1;\n');
    writeFileSync(join(tmpDir, 'b.md'), '# Hello\n');

    const config = {
      sourceExts: ['.ts', '.md'],
      excludedDirs: [],
    };

    const result = computeSourceHash(tmpDir, config);

    // Manually compute expected hash: sort files, hash binary content
    const files = [join(tmpDir, 'a.ts'), join(tmpDir, 'b.md')].toSorted();
    const expected = createHash('sha1');
    for (const f of files) {
      expected.update(readFileSync(f));
    }

    expect(result).toBe(expected.digest('hex'));
  });

  it('uses lexicographic sort order for files (matching Nim seq.sort)', () => {
    // Create files in reverse alphabetical order
    writeFileSync(join(tmpDir, 'z.ts'), 'z\n');
    writeFileSync(join(tmpDir, 'a.ts'), 'a\n');
    writeFileSync(join(tmpDir, 'm.ts'), 'm\n');

    const config = {
      sourceExts: ['.ts'],
      excludedDirs: [],
    };

    const result = computeSourceHash(tmpDir, config);

    // Manually compute with sorted paths
    const files = [
      join(tmpDir, 'a.ts'),
      join(tmpDir, 'm.ts'),
      join(tmpDir, 'z.ts'),
    ];
    const expected = createHash('sha1');
    for (const f of files) {
      expected.update(readFileSync(f));
    }

    expect(result).toBe(expected.digest('hex'));
  });
});

describe('loadConfig', () => {
  it('returns defaults when config file does not exist', () => {
    const tmpDir = join(process.cwd(), '.tmp-config-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    try {
      const config = loadConfig(tmpDir);
      expect(config.sourceExts).toEqual(['.ts', '.md', '.json']);
      expect(config.excludedDirs).toContain('node_modules');
      expect(config.hashAlgorithm).toBe('sha1');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads config from .build-hash-config.json when present', () => {
    const tmpDir = join(process.cwd(), '.tmp-config-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    try {
      const customConfig = {
        sourceExts: ['.ts', '.tsx'],
        excludedDirs: ['node_modules', '.git'],
        hashAlgorithm: 'sha1',
        hashFile: '.custom-hash',
        lockFile: '.custom-lock',
      };
      writeFileSync(join(tmpDir, '.build-hash-config.json'), JSON.stringify(customConfig));

      const config = loadConfig(tmpDir);
      expect(config.sourceExts).toEqual(['.ts', '.tsx']);
      expect(config.hashFile).toBe('.custom-hash');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
