#!/usr/bin/env node
/**
 * verify-patches.mjs — Parser-free patch integrity verifier.
 *
 * Hashes the raw bytes of pnpm-workspace.yaml + all .patch files in patches/.
 * Any byte-level change triggers pnpm install from the workspace root.
 *
 * No YAML parsing — eliminates heuristic failure modes entirely.
 * CWD isolation — always runs pnpm install from workspace root.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
const workspaceRoot = path.resolve(import.meta.dirname, '..');
const hashFilePath = path.join(workspaceRoot, '.patches-applied');
const patchesDir = path.join(workspaceRoot, 'patches');

try {
  const hash = crypto.createHash('sha1');

  // 1. Hash pnpm-workspace.yaml raw bytes (no parsing — tracks topology + patches config)
  const yamlPath = path.join(workspaceRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(yamlPath)) {
    hash.update(fs.readFileSync(yamlPath));
  }

  // 2. Hash patches/ directory: sorted .patch filenames + file contents
  if (fs.existsSync(patchesDir)) {
    const patchFiles = fs.readdirSync(patchesDir)
      .filter(file => file.endsWith('.patch'))
      .toSorted();
    for (const file of patchFiles) {
      const filePath = path.join(patchesDir, file);
      hash.update(file);
      hash.update(fs.readFileSync(filePath));
    }
  }

  const currentPatchesHash = hash.digest('hex');

  // 3. Safe load with ENOENT guard (fresh clone → .patches-applied doesn't exist)
  const storedHash = fs.existsSync(hashFilePath)
    ? fs.readFileSync(hashFilePath, 'utf8').trim()
    : '';

  // 4. node_modules corruption/absence guard
  const isNodeModulesCorrupted = !fs.existsSync(path.join(workspaceRoot, 'node_modules'));

  // 5. Deterministic self-healing
  if (currentPatchesHash !== storedHash || isNodeModulesCorrupted) {
    console.log('🚨 [Architecture Guard] Patch drift detected — running pnpm install...');
    execSync('pnpm install', { cwd: workspaceRoot, stdio: 'inherit' });
    fs.writeFileSync(hashFilePath, currentPatchesHash, 'utf8');
    console.log('✅ Environment integrity restored.');
  }
} catch (error) {
  console.error('❌ Patch verification failed:', error.message);
  process.exit(1);
}
