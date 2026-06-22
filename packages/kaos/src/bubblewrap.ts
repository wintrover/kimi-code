import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import { detectEnvironmentFromNode, type Environment } from './environment';
import { KaosFileExistsError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

const isWindows: boolean = process.platform === 'win32';

/**
 * Build the `(dev, ino)` cycle-detection key used by `_globWalk`'s
 * visited set. Returns `null` when `ino` is 0, which Node returns on
 * filesystems that don't carry inodes (Windows FAT/exFAT, some SMB/NFS
 * mounts). A null key signals "no reliable identity for this dir" so
 * the caller skips visited tracking for that descent — cycle safety
 * is weakened on those filesystems, but normal walking works instead
 * of every directory colliding on the shared key `"<dev>:0"`.
 */
function cycleKey(s: { dev: number; ino: number }): string | null {
  if (s.ino === 0) return null;
  return `${String(s.dev)}:${String(s.ino)}`;
}

// ── Process wrapper ───────────────────────────────────────────────────────

/**
 * Process wrapper for BubblewrapKaos — identical to LocalProcess since the
 * child process handle is the same regardless of how it was spawned.
 */
class BubblewrapProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = new BufferedReadable(child.stderr);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    if (this.pid <= 0) {
      return Promise.resolve();
    }

    // bwrap is spawned with `detached: true` and `--die-with-parent`, so
    // signaling the bwrap process group will tear down the entire sandbox tree.
    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return Promise.resolve();
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
          /* best effort */
        }
        return Promise.resolve();
      }
      throw error;
    }
    return Promise.resolve();
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

type BindMount = { host: string; guest: string; readonly?: boolean };

// ── Options ───────────────────────────────────────────────────────────────

export interface BubblewrapKaosOptions {
  /** Directory to bind as writable `/workspace` inside the sandbox. Defaults to `process.cwd()`. */
  workspaceBind?: string;
  /** Whether to unshare the network namespace (`--unshare-net`). Defaults to `true`. */
  networkIsolated?: boolean;
  /** Whether to bind-mount system directories as read-only. Defaults to `true`. */
  readOnlySystem?: boolean;
  /** Additional bind mounts for the sandbox. */
  extraBinds?: Array<{ host: string; guest: string; readonly?: boolean }>;
  /** Additional environment variables to overlay on every spawned process. */
  env?: Record<string, string>;
}

// ── Helper ────────────────────────────────────────────────────────────────

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

// ── BubblewrapKaos ────────────────────────────────────────────────────────

/**
 * A KAOS implementation that uses Bubblewrap (`bwrap`) for lightweight process
 * isolation via Linux namespaces.
 *
 * File operations are performed directly on the host filesystem (identical to
 * {@link LocalKaos}), while `exec()` wraps every command with `bwrap` to run
 * it inside a sandboxed PID/network namespace with a read-only view of the
 * system directories and a writable bind-mount of the workspace.
 */
export class BubblewrapKaos implements Kaos {
  readonly name: string = 'bubblewrap';
  readonly osEnv: Environment;
  private _cwd: string;
  private readonly _workspaceBind: string;
  private readonly _networkIsolated: boolean;
  private readonly _readOnlySystem: boolean;
  private readonly _extraBinds: readonly BindMount[];
  private readonly _envLayers: readonly Record<string, string>[];
  private readonly _bwrapPath: string;

  private constructor(
    osEnv: Environment,
    bwrapPath: string,
    workspaceBind: string,
    cwd: string | undefined,
    networkIsolated: boolean,
    readOnlySystem: boolean,
    extraBinds: readonly BindMount[],
    envLayers: readonly Record<string, string>[],
  ) {
    this.osEnv = osEnv;
    this._bwrapPath = bwrapPath;
    this._workspaceBind = workspaceBind;
    this._cwd = normalize(cwd ?? workspaceBind);
    this._networkIsolated = networkIsolated;
    this._readOnlySystem = readOnlySystem;
    this._extraBinds = extraBinds;
    this._envLayers = envLayers;
  }

  /**
   * Construct a fresh `BubblewrapKaos` after probing the host environment
   * and verifying that `bwrap` is installed.
   *
   * @throws {Error} if `bwrap` is not installed or not accessible.
   */
  static async create(options?: BubblewrapKaosOptions): Promise<BubblewrapKaos> {
    const bwrapPath = await BubblewrapKaos._findBwrap();
    if (bwrapPath === undefined) {
      throw new Error(
        'BubblewrapKaos requires bubblewrap (bwrap) to be installed. ' +
          'Install it via your package manager (e.g. apt install bubblewrap).',
      );
    }

    const osEnv = await detectEnvironmentFromNode();
    const workspaceBind = normalize(options?.workspaceBind ?? process.cwd());
    const envLayers: readonly Record<string, string>[] = options?.env
      ? [options.env]
      : [];

    return new BubblewrapKaos(
      osEnv,
      bwrapPath,
      workspaceBind,
      undefined,
      options?.networkIsolated ?? true,
      options?.readOnlySystem ?? true,
      options?.extraBinds ?? [],
      envLayers,
    );
  }

  /**
   * Check whether bubblewrap (`bwrap`) is available on this system.
   */
  static async isAvailable(): Promise<boolean> {
    return (await BubblewrapKaos._findBwrap()) !== undefined;
  }

  private static async _findBwrap(): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile('which', ['bwrap'], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const p = stdout.trim();
        resolve(p.length > 0 ? p : undefined);
      });
    });
  }

  // ── Kaos fluent builders ──────────────────────────────────────────────

  withCwd(cwd: string): BubblewrapKaos {
    return new BubblewrapKaos(
      this.osEnv,
      this._bwrapPath,
      this._workspaceBind,
      cwd,
      this._networkIsolated,
      this._readOnlySystem,
      this._extraBinds,
      this._envLayers,
    );
  }

  withEnv(env: Record<string, string>): BubblewrapKaos {
    return new BubblewrapKaos(
      this.osEnv,
      this._bwrapPath,
      this._workspaceBind,
      this._cwd,
      this._networkIsolated,
      this._readOnlySystem,
      this._extraBinds,
      [...this._envLayers, env],
    );
  }

  // ── Path operations (sync) ──────────────────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return isWindows ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return normalize(homedir());
  }

  getcwd(): string {
    return this._cwd;
  }

  // ── Directory operations (async) ────────────────────────────────────

  async chdir(path: string): Promise<void> {
    const resolved = this._resolvePath(path);
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    const s = followSymlinks ? await stat(resolved) : await lstat(resolved);
    return {
      stMode: s.mode,
      stIno: s.ino,
      stDev: s.dev,
      stNlink: s.nlink,
      stUid: s.uid,
      stGid: s.gid,
      stSize: s.size,
      stAtime: s.atimeMs / 1000,
      stMtime: s.mtimeMs / 1000,
      stCtime: isWindows ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await readdir(resolved);
    for (const entry of entries) {
      yield join(resolved, entry);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    const patternParts = pattern.split('/');
    const initVisited = new Set<string>();
    try {
      const rootStat = await stat(resolved);
      const rootKey = cycleKey(rootStat);
      if (rootKey !== null) initVisited.add(rootKey);
    } catch {
      // base does not exist / not accessible
    }
    yield* this._globWalk(resolved, patternParts, caseSensitive, initVisited);
  }

  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
    visited: Set<string>,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) {
      return;
    }

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive, visited);
      } else {
        yield basePath;
      }

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(basePath, entry);
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          yield* this._globWalk(
            fullPath,
            patternParts,
            caseSensitive,
            key !== null ? new Set([...visited, key]) : visited,
          );
        } else if (remainingParts.length === 0) {
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!regex.test(entry)) {
          continue;
        }

        const fullPath = join(basePath, entry);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else {
          let entryStat;
          try {
            entryStat = await stat(fullPath);
          } catch {
            continue;
          }
          if (entryStat.isDirectory()) {
            const key = cycleKey(entryStat);
            if (key !== null && visited.has(key)) continue;
            yield* this._globWalk(
              fullPath,
              remainingParts,
              caseSensitive,
              key !== null ? new Set([...visited, key]) : visited,
            );
          }
        }
      }
    }
  }

  // ── File operations (async) ─────────────────────────────────────────

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    if (n === undefined) {
      return Buffer.from(await readFile(resolved));
    }
    const fh = await open(resolved, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await readFile(resolved);
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const buf = await readFile(resolved);
    const content = decodeTextWithErrors(buf, encoding, errors);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (i < lines.length - 1) {
        yield line + '\n';
      } else if (line !== '') {
        yield line;
      }
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    const resolved = this._resolvePath(path);
    await writeFile(resolved, data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const mode = options?.mode ?? 'w';
    if (mode === 'a') {
      await appendFile(resolved, data, encoding);
    } else {
      await writeFile(resolved, data, encoding);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      if (!existOk) {
        try {
          const s = await stat(resolved);
          if (s.isDirectory()) {
            throw new KaosFileExistsError(`${resolved} already exists`);
          }
        } catch (error: unknown) {
          if (error instanceof KaosFileExistsError) throw error;
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') throw error;
        }
      }
      await mkdir(resolved, { recursive: true });
      return;
    }

    try {
      await mkdir(resolved);
    } catch (error: unknown) {
      if (
        existOk &&
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      throw error;
    }
  }

  // ── Process execution ───────────────────────────────────────────────

  async exec(...args: string[]): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'BubblewrapKaos.exec(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);
    const bwrapArgs = this._buildBwrapArgs(command, restArgs);
    const child = spawn(this._bwrapPath, bwrapArgs, {
      cwd: this._workspaceBind,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: this._buildExecEnv(),
    });
    await waitForSpawn(child);
    return new BubblewrapProcess(child);
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'BubblewrapKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);
    const bwrapArgs = this._buildBwrapArgs(command, restArgs);
    const child = spawn(this._bwrapPath, bwrapArgs, {
      cwd: this._workspaceBind,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: this._buildExecEnv(env),
    });
    await waitForSpawn(child);
    return new BubblewrapProcess(child);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    return join(this._cwd, path);
  }

  /**
   * Build the bwrap argument list that wraps the user command in a sandbox.
   *
   * The resulting invocation is:
   * ```
   * bwrap --unshare-pid [--unshare-net] --die-with-parent \
   *       [--ro-bind|--bind /usr /usr] ... --ro-bind /proc /proc --dev /dev \
   *       --bind <workspace> /workspace --chdir /workspace \
   *       [--ro-bind|--bind extraBinds...] \
   *       -- <command> <args...>
   * ```
   */
  private _buildBwrapArgs(command: string, commandArgs: string[]): string[] {
    const args: string[] = [];

    // Unshare PID namespace so the sandboxed process tree is isolated.
    args.push('--unshare-pid');

    // Network isolation
    if (this._networkIsolated) {
      args.push('--unshare-net');
    }

    // Ensure sandboxed processes are killed when the parent exits.
    args.push('--die-with-parent');

    // Bind-mount system directories. When `readOnlySystem` is true, use
    // `--ro-bind` so the sandbox cannot modify the host filesystem.
    const bindFlag = this._readOnlySystem ? '--ro-bind' : '--bind';
    const systemDirs = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc'];
    for (const dir of systemDirs) {
      args.push(bindFlag, dir, dir);
    }

    // Virtual /proc and /dev
    args.push('--proc', '/proc');
    args.push('--dev', '/dev');

    // Bind the workspace directory as writable at /workspace inside the sandbox.
    args.push('--bind', this._workspaceBind, '/workspace');
    args.push('--chdir', '/workspace');

    // Extra bind mounts from the caller.
    for (const extra of this._extraBinds) {
      const flag = extra.readonly ? '--ro-bind' : '--bind';
      args.push(flag, extra.host, extra.guest);
    }

    // Separator: everything after `--` is the command inside the sandbox.
    args.push('--');
    args.push(command, ...commandArgs);

    return args;
  }

  private _buildExecEnv(invocationEnv?: Record<string, string>): Record<string, string> | undefined {
    if (this._envLayers.length === 0) return invocationEnv;
    const merged: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...invocationEnv,
    };
    for (const layer of this._envLayers) {
      Object.assign(merged, layer);
    }
    return merged;
  }
}
