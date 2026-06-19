#!/usr/bin/env node
import { execSync } from 'node:child_process';

const PACKAGES_RE = /^packages\/[^/]+\/(src|package\.json|tsconfig\.json)/;

try {
  const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' });
  const needsBuild = staged.split('\n').some((f) => PACKAGES_RE.test(f));

  if (needsBuild) {
    console.log('Package source changed — rebuilding CLI bundle…');
    execSync('pnpm -C apps/kimi-code build', { stdio: 'inherit' });
    console.log('CLI bundle rebuilt successfully.');
  } else {
    console.log('No package source changes — skipping CLI build.');
  }
} catch (error) {
  console.error('\n❌ CLI bundle rebuild failed.');
  console.error('   This is likely a build system issue, not a code problem.');
  console.error('   To bypass: git commit --no-verify');
  console.error(`   Error: ${error.message}\n`);
  process.exit(1);
}
