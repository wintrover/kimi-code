import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMigration, runMigration } from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const SOURCE_HOME = join(FIXTURES, 'multi-workdir', '.kimi');
const MARKER_PATH = join(SOURCE_HOME, '.migrated-to-kimi-code');
const FIXTURE_CONFIG = join(SOURCE_HOME, 'config.toml');

let tgt: string;
beforeEach(async () => {
  tgt = await mkdtemp(join(tmpdir(), 'integration-'));
  // Clean any leftover artifacts that previous failed runs might have left in
  // the committed fixture directory.
  await rm(MARKER_PATH, { recursive: true, force: true });
  await rm(FIXTURE_CONFIG, { force: true });
});
afterEach(async () => {
  await rm(tgt, { recursive: true, force: true });
  await rm(MARKER_PATH, { recursive: true, force: true });
  await rm(FIXTURE_CONFIG, { force: true });
});

describe('runMigration (end-to-end on multi-workdir fixture)', () => {
  it('migrates everything when scope is full and limit is null', async () => {
    const plan = await detectMigration({ sourcePath: SOURCE_HOME });
    const report = await runMigration({
      plan,
      scope: {
        config: true,
        mcp: true,
        userHistory: true,
        sessions: true,
      },
      source: SOURCE_HOME,
      target: tgt,
    });
    expect(report.summary.sessions.sessionsMigrated).toBeGreaterThan(0);

    const indexText = await readFile(join(tgt, 'session_index.jsonl'), 'utf-8');
    const indexLines = indexText.split('\n').filter((l) => l.length > 0);
    expect(indexLines.length).toBeGreaterThan(0);

    const markerText = await readFile(MARKER_PATH, 'utf-8');
    const marker: unknown = JSON.parse(markerText);
    expect((marker as { version: number }).version).toBe(1);
  });

  it('completes the migration even when the source marker cannot be written', async () => {
    // Block the marker path with a directory so writeMarker()'s writeFile fails.
    await mkdir(MARKER_PATH, { recursive: true });
    const plan = await detectMigration({ sourcePath: SOURCE_HOME });
    const report = await runMigration({
      plan,
      scope: { config: true, mcp: true, userHistory: true, sessions: true },
      source: SOURCE_HOME,
      target: tgt,
    });
    // All data migrated — a completed run must return a report, not reject.
    expect(report.summary.sessions.sessionsMigrated).toBeGreaterThan(0);
  });

  it('config-only scope writes config but skips sessions', async () => {
    // Materialize a config.toml in the fixture; afterEach cleans it up.
    await writeFile(FIXTURE_CONFIG, 'default_thinking = true\n');

    const plan = await detectMigration({ sourcePath: SOURCE_HOME });
    const report = await runMigration({
      plan,
      scope: {
        config: true,
        mcp: true,
        userHistory: true,
        sessions: false,
      },
      source: SOURCE_HOME,
      target: tgt,
    });
    expect(report.summary.sessions.scope).toBe('config-only');
    expect(report.summary.sessions.sessionsMigrated).toBe(0);
  });

  it('does not copy OAuth credentials into the target', async () => {
    // OAuth refresh tokens rotate server-side: they are single-use and
    // single-owner. Copying a credential to a second install breaks login
    // for whichever side refreshes second. The migration must NOT copy
    // credentials — it leaves the legacy login alone and asks the user to
    // run /login in kimi-code instead.
    const src = await mkdtemp(join(tmpdir(), 'oauth-src-'));
    try {
      await mkdir(join(src, 'credentials'), { recursive: true });
      await writeFile(
        join(src, 'credentials', 'kimi-code.json'),
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_at: 1,
          scope: 's',
          token_type: 'Bearer',
        }),
      );
      const plan = await detectMigration({ sourcePath: src });
      const report = await runMigration({
        plan,
        scope: { config: true, mcp: true, userHistory: true, sessions: false },
        source: src,
        target: tgt,
      });
      // The credential must not be copied into the target.
      await expect(
        readFile(join(tgt, 'credentials', 'kimi-code.json'), 'utf-8'),
      ).rejects.toThrow();
      // The report tells the user to sign in again in kimi-code.
      expect(report.notices.oauthLoginsRequiringRelogin).toContain('kimi-code.json');
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});
