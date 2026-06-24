#!/usr/bin/env node
/**
 * source-hash.mjs — Shared content-hash computation for build gates.
 *
 * Used by both `conditional-build.mjs` (pre-commit) and tests.
 * Must produce bit-for-bit identical output to `scripts/bin/kimi.nim`'s
 * `computeSourceHash` proc when given the same file set.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * @param {string} rootDir
 * @param {object} [config]
 * @param {string[]} [config.sourceExts]
 * @param {string[]} [config.excludedDirs]
 * @param {string} [config.hashAlgorithm]
 * @returns {string} hex-encoded SHA1 hash
 */
export function computeSourceHash(rootDir, config) {
  const sourceExts = config?.sourceExts ?? ['.ts', '.md', '.json'];
  const excludedDirs = config?.excludedDirs ?? [
    'node_modules', '.git', 'dist', 'dist-native', '.turbo', '.changeset', 'node',
  ];
  const algorithm = config?.hashAlgorithm ?? 'sha1';
  const excludedSet = new Set(excludedDirs);
  const files = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (excludedSet.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (sourceExts.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // Lexicographic sort by full path — must match Nim's seq.sort()

  const hash = createHash(algorithm);
  for (const f of files) {
    hash.update(readFileSync(f)); // Buffer (binary) — must match Nim's readFile()
  }
  return hash.digest('hex');
}

/**
 * Load config from `.build-hash-config.json`.
 * @param {string} rootDir
 * @returns {object}
 */
export function loadConfig(rootDir) {
  const configPath = join(rootDir, '.build-hash-config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }
  return {
    sourceExts: ['.ts', '.md', '.json'],
    excludedDirs: ['node_modules', '.git', 'dist', 'dist-native', '.turbo', '.changeset', 'node'],
    hashAlgorithm: 'sha1',
    hashFile: '.build-hash',
    lockFile: '.build-hash.lock',
  };
}
