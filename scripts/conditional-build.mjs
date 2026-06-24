#!/usr/bin/env node
/**
 * conditional-build.mjs — Content-hash-based pre-commit build gate.
 *
 * Replaces the old path-pattern heuristic with deterministic SHA1 content hashing.
 * Shares the same hash file (`.build-hash`) and config (`.build-hash-config.json`)
 * as the Nim runtime gatekeeper (`scripts/bin/kimi.nim`).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeSourceHash, loadConfig } from './source-hash.mjs';

// ── Locking ─────────────────────────────────────────────────────────────────
// Uses atomic mkdirSync — independent of Nim's fcntl-based file lock.
// Nim locks `.build-hash.lock` (file), we lock `.build-hash.lock.d` (dir).

function withLock(lockDirPath, action) {
  let acquired = false;
  const start = Date.now();
  const timeout = 30_000;

  while (!acquired) {
    try {
      mkdirSync(lockDirPath);
      acquired = true;
    } catch {
      if (Date.now() - start > timeout) {
        throw new Error(`Lock timeout after ${timeout}ms`);
      }
      // Busy-wait 100ms — minimal CPU, no external deps
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 100);
    }
  }

  try {
    action();
  } finally {
    try {
      rmdirSync(lockDirPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

try {
  const rootDir = process.cwd();
  const config = loadConfig(rootDir);
  const lockDir = join(rootDir, `${config.lockFile}.d`);
  const hashPath = join(rootDir, config.hashFile);

  withLock(lockDir, () => {
    const currentHash = computeSourceHash(rootDir, config);
    const storedHash = existsSync(hashPath) ? readFileSync(hashPath, 'utf8').trim() : '';

    if (currentHash === storedHash) {
      console.log('[pre-commit] Source unchanged — skipping build.');
      return;
    }

    console.log('[pre-commit] Source changed — rebuilding CLI…');
    execSync('pnpm -C apps/kimi-code build', { stdio: 'inherit' });
    writeFileSync(hashPath, currentHash);
    console.log('[pre-commit] CLI rebuilt. Hash updated.');
  });
} catch (error) {
  console.error('\n❌ CLI bundle rebuild failed.');
  console.error('   This is likely a build system issue, not a code problem.');
  console.error('   To bypass: git commit --no-verify');
  console.error(`   Error: ${error.message}\n`);
  process.exit(1);
}
