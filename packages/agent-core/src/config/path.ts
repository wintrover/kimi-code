import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'pathe';

export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

/**
 * Walk up from `cwd` looking for a `.git` directory to identify the project root.
 * Returns `undefined` when no `.git` is found (e.g. outside a repo).
 */
export function findProjectRoot(cwd: string): string | undefined {
  let current = normalize(cwd);
  while (true) {
    try {
      if (statSync(join(current, '.git')).isDirectory()) return current;
    } catch {
      // .git does not exist at this level — keep walking
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolve the project-level config.toml path.
 * Returns the path only when the file actually exists on disk.
 */
export function resolveProjectConfigPath(cwd: string): string | undefined {
  const root = findProjectRoot(cwd);
  if (root === undefined) return undefined;
  const candidate = join(root, '.kimi-code', 'config.toml');
  return existsSync(candidate) ? candidate : undefined;
}

export function ensureKimiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
