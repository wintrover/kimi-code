import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import type { Environment } from './environment';
import { KaosError, KaosFileExistsError, KaosValueError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

// ── Docker options ────────────────────────────────────────────────────

export interface DockerKaosOptions {
  /** Docker image to use. Default: `'node:24-slim'`. */
  image?: string;
  /** Docker network mode. Default: `'none'`. */
  networkMode?: 'bridge' | 'none' | 'host';
  /** Container memory limit. Default: `'512m'`. */
  memoryLimit?: string;
  /** Container CPU limit (number of CPUs). Default: `1`. */
  cpuLimit?: number;
  /** Host directory to mount into the container. Default: `process.cwd()`. */
  workspaceMount?: string;
  /** Working directory inside the container. Default: `'/workspace'`. */
  containerWorkdir?: string;
  /** Extra environment variables passed to every `docker exec`. */
  env?: Record<string, string>;
}

// ── stat mode constants ────────────────────────────────────────────────
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

function isDirectoryStat(s: StatResult): boolean {
  return (s.stMode & S_IFMT) === S_IFDIR;
}

// ── Shell quoting ──────────────────────────────────────────────────────

/**
 * Shell-escape a single argument (POSIX sh compatible).
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Run a docker command and return stdout. Throws on non-zero exit.
 */
function dockerRun(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs,
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err: Error) => reject(err));
    child.on('close', (code: number | null) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Run a simple docker exec command and return trimmed stdout.
 */
async function dockerExecText(
  containerId: string,
  command: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const result = await dockerRun(
    ['exec', containerId, 'sh', '-c', command],
    opts,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `docker exec failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

// ── DockerProcess ──────────────────────────────────────────────────────

class DockerProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('DockerProcess must be created with stdin/stdout/stderr pipes.');
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

// ── DockerKaos ─────────────────────────────────────────────────────────

/**
 * A KAOS implementation that runs commands and file operations inside
 * a Docker container.
 *
 * The container is created lazily on the first `exec()` or `execWithEnv()`
 * call. All filesystem operations are delegated to the container via
 * `docker exec`.
 */
export class DockerKaos implements Kaos {
  readonly name: string = 'docker';

  private readonly _image: string;
  private readonly _networkMode: 'bridge' | 'none' | 'host';
  private readonly _memoryLimit: string;
  private readonly _cpuLimit: number;
  private readonly _hostMount: string;
  private readonly _containerWorkdir: string;
  private readonly _envOverlay: Record<string, string>;
  private readonly _envLayers: readonly Record<string, string>[];

  private _containerId: string | undefined;
  private _cwd: string;
  private _osEnv: Environment | undefined;

  constructor(options?: DockerKaosOptions, cwd?: string, envLayers?: readonly Record<string, string>[]) {
    this._image = options?.image ?? 'node:24-slim';
    this._networkMode = options?.networkMode ?? 'none';
    this._memoryLimit = options?.memoryLimit ?? '512m';
    this._cpuLimit = options?.cpuLimit ?? 1;
    this._hostMount = options?.workspaceMount ?? process.cwd();
    this._containerWorkdir = options?.containerWorkdir ?? '/workspace';
    this._envOverlay = options?.env ?? {};
    this._cwd = cwd ?? this._containerWorkdir;
    this._envLayers = envLayers ?? [];
  }

  get osEnv(): Environment {
    if (this._osEnv === undefined) {
      throw new KaosError(
        'DockerKaos.osEnv is not available until the container has been created. Call exec() first.',
      );
    }
    return this._osEnv;
  }

  /**
   * Check whether Docker is available on this host.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const result = await dockerRun(['--version'], { timeoutMs: 5_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Create and start the Docker container. Idempotent — returns the
   * existing container ID if already created.
   */
  private async _ensureContainer(): Promise<string> {
    if (this._containerId !== undefined) return this._containerId;

    // Generate a unique container name to avoid collisions
    const containerName = `kimi-kaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const runArgs: string[] = [
      'run',
      '--rm',
      '-d',
      '--name', containerName,
      `--network=${this._networkMode}`,
      `--memory=${this._memoryLimit}`,
      `--cpus=${String(this._cpuLimit)}`,
      '-v', `${this._hostMount}:${this._containerWorkdir}`,
      '-w', this._containerWorkdir,
      this._image,
      'sleep', 'infinity',
    ];

    // Add env overlay as env vars
    for (const [key, value] of Object.entries(this._envOverlay)) {
      runArgs.push('-e', `${key}=${value}`);
    }

    const result = await dockerRun(runArgs, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new KaosError(`Failed to create Docker container: ${result.stderr.trim()}`);
    }

    // The container ID is the full stdout from `docker run -d`
    this._containerId = result.stdout.trim();

    // Probe the container environment
    this._osEnv = await this._probeEnvironment();

    return this._containerId;
  }

  /**
   * Probe the container's OS environment by running commands inside it.
   */
  private async _probeEnvironment(): Promise<Environment> {
    const id = await this._ensureContainer();

    const platformText = await dockerExecText(id, "uname -s");
    const osKind = platformText.trim() === 'Darwin' ? 'macOS' : platformText.trim() === 'Linux' ? 'Linux' : platformText.trim();

    const archText = await dockerExecText(id, "uname -m");
    const osArch = archText.trim();

    const versionText = await dockerExecText(id, "uname -r");
    const osVersion = versionText.trim();

    // Detect shell
    let shellName: 'bash' | 'sh' = 'sh';
    let shellPath = '/bin/sh';
    try {
      const bashCheck = await dockerExecText(id, "test -f /bin/bash && echo yes || echo no");
      if (bashCheck.trim() === 'yes') {
        shellName = 'bash';
        shellPath = '/bin/bash';
      }
    } catch {
      // Default to sh
    }

    return { osKind, osArch, osVersion, shellName, shellPath };
  }

  /**
   * Destroy the Docker container, removing it and all its state.
   */
  async destroy(): Promise<void> {
    if (this._containerId === undefined) return;

    try {
      await dockerRun(['rm', '-f', this._containerId], { timeoutMs: 10_000 });
    } catch {
      // Best effort cleanup — container may already be gone.
    }
    this._containerId = undefined;
    this._osEnv = undefined;
  }

  // ── Clone helpers ──────────────────────────────────────────────────

  private _clone(opts: { cwd?: string; envLayers?: readonly Record<string, string>[] }): DockerKaos {
    const cloned = new DockerKaos(
      {
        image: this._image,
        networkMode: this._networkMode,
        memoryLimit: this._memoryLimit,
        cpuLimit: this._cpuLimit,
        workspaceMount: this._hostMount,
        containerWorkdir: this._containerWorkdir,
        env: this._envOverlay,
      },
      opts.cwd ?? this._cwd,
      opts.envLayers ?? this._envLayers,
    );
    // Share the same container — clone reuses the running container.
    cloned._containerId = this._containerId;
    cloned._osEnv = this._osEnv;
    return cloned;
  }

  // ── Path operations (sync) ─────────────────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return '/root';
  }

  getcwd(): string {
    return this._cwd;
  }

  // ── Directory operations (async) ───────────────────────────────────

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    return join(this._cwd, path);
  }

  async chdir(path: string): Promise<void> {
    const resolved = this._resolvePath(path);
    const s = await this.stat(resolved);
    if (!isDirectoryStat(s)) {
      throw new KaosValueError(`Not a directory: ${resolved}`);
    }
    this._cwd = resolved;
  }

  withCwd(cwd: string): DockerKaos {
    return this._clone({ cwd });
  }

  withEnv(env: Record<string, string>): DockerKaos {
    return this._clone({ envLayers: [...this._envLayers, env] });
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const id = await this._ensureContainer();
    const followSymlinks = options?.followSymlinks ?? true;

    // Use stat inside the container and parse the output.
    // Use Python-compatible format: mode,ino,dev,nlink,uid,gid,size,atime,mtime,ctime
    const fmt = followSymlinks
      ? 'stat -c %a,%i,%d,%h,%u,%g,%s,%X,%Y,%Z'
      : 'stat -L -c %a,%i,%d,%h,%u,%g,%s,%X,%Y,%Z';

    let output: string;
    try {
      output = await dockerExecText(id, `${fmt} ${shellQuote(resolved)}`);
    } catch {
      throw new Error(`No such file or directory: ${resolved}`);
    }

    const parts = output.trim().split(',');
    if (parts.length < 10) {
      throw new Error(`Unexpected stat output for ${resolved}: ${output.trim()}`);
    }

    const mode = parseInt(parts[0] ?? '0', 8); // octal mode
    const ino = parseInt(parts[1] ?? '0', 10);
    const dev = parseInt(parts[2] ?? '0', 10);
    const nlink = parseInt(parts[3] ?? '0', 10);
    const uid = parseInt(parts[4] ?? '0', 10);
    const gid = parseInt(parts[5] ?? '0', 10);
    const size = parseInt(parts[6] ?? '0', 10);
    const atime = parseInt(parts[7] ?? '0', 10);
    const mtime = parseInt(parts[8] ?? '0', 10);
    const ctime = parseInt(parts[9] ?? '0', 10);

    // Reconstruct POSIX st_mode (file type bits + permission bits).
    // `stat -c %a` only returns permission bits (e.g. 755). We need
    // file type bits too. Fall back to testing the path.
    const typeTest = await dockerExecText(id, `[ -d ${shellQuote(resolved)} ] && d || [ -L ${shellQuote(resolved)} ] && l || f`);
    let stMode = mode;
    const typeChar = typeTest.trim().charAt(0);
    const S_IFMT = 0o170000;
    const S_IFREG = 0o100000;
    const S_IFDIR = 0o040000;
    const S_IFLNK = 0o120000;
    if (typeChar === 'd') stMode = (stMode & ~S_IFMT) | S_IFDIR;
    else if (typeChar === 'l') stMode = (stMode & ~S_IFMT) | S_IFLNK;
    else stMode = (stMode & ~S_IFMT) | S_IFREG;

    return {
      stMode,
      stIno: ino,
      stDev: dev,
      stNlink: nlink,
      stUid: uid,
      stGid: gid,
      stSize: size,
      stAtime: atime,
      stMtime: mtime,
      stCtime: ctime,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const id = await this._ensureContainer();

    const output = await dockerExecText(id, `ls -1 ${shellQuote(resolved)}`);
    const entries = output.split('\n').filter((e) => e.length > 0);
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
    yield* this._globWalk(resolved, patternParts, caseSensitive);
  }

  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) return;

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive);
      } else {
        yield basePath;
      }

      let entries: string[];
      try {
        entries = await this._listDir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(basePath, entry);
        let isDir: boolean;
        try {
          const s = await this.stat(fullPath);
          isDir = isDirectoryStat(s);
        } catch {
          continue;
        }
        if (isDir) {
          yield* this._globWalk(fullPath, patternParts, caseSensitive);
        } else if (remainingParts.length === 0) {
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: string[];
      try {
        entries = await this._listDir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!regex.test(entry)) continue;

        const fullPath = join(basePath, entry);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else {
          let isDir: boolean;
          try {
            const s = await this.stat(fullPath);
            isDir = isDirectoryStat(s);
          } catch {
            continue;
          }
          if (isDir) {
            yield* this._globWalk(fullPath, remainingParts, caseSensitive);
          }
        }
      }
    }
  }

  /** List directory entry names via docker exec. */
  private async _listDir(path: string): Promise<string[]> {
    const id = await this._ensureContainer();
    const output = await dockerExecText(id, `ls -1 ${shellQuote(path)}`);
    return output.split('\n').filter((e) => e.length > 0);
  }

  // ── File operations (async) ────────────────────────────────────────

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    const id = await this._ensureContainer();

    if (n === undefined) {
      // Read entire file as base64 to avoid encoding issues
      const base64 = await dockerExecText(id, `base64 ${shellQuote(resolved)}`);
      return Buffer.from(base64, 'base64');
    }

    // Read first n bytes via dd + base64
    const base64 = await dockerExecText(id, `dd if=${shellQuote(resolved)} bs=1 count=${String(n)} 2>/dev/null | base64`);
    return Buffer.from(base64, 'base64');
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await this.readBytes(path);
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    if (text === '') return;

    const lines = text.split('\n');
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
    const id = await this._ensureContainer();

    // Write via base64 decode inside the container
    const b64 = data.toString('base64');
    await dockerExecText(id, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(resolved)}`);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const mode = options?.mode ?? 'w';
    const encoding = options?.encoding ?? 'utf-8';
    const id = await this._ensureContainer();

    const buf = Buffer.from(data, encoding);
    // Use base64 to safely transfer arbitrary text without shell escaping issues
    const b64 = buf.toString('base64');

    if (mode === 'a') {
      await dockerExecText(id, `echo ${shellQuote(b64)} | base64 -d >> ${shellQuote(resolved)}`);
    } else {
      await dockerExecText(id, `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(resolved)}`);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;
    const id = await this._ensureContainer();

    const flag = parents ? '-p' : '';

    if (!existOk) {
      // Check existence first
      try {
        const s = await this.stat(resolved);
        if (isDirectoryStat(s)) {
          throw new KaosFileExistsError(`${resolved} already exists`);
        }
      } catch (error: unknown) {
        if (error instanceof KaosFileExistsError) throw error;
        // ENOENT — proceed to create
      }
    }

    try {
      await dockerExecText(id, `mkdir ${flag} ${shellQuote(resolved)}`);
    } catch (error: unknown) {
      if (existOk) {
        // Verify it's a directory if it already exists
        try {
          const s = await this.stat(resolved);
          if (isDirectoryStat(s)) return;
        } catch {
          // falls through
        }
      }
      throw error;
    }
  }

  // ── Process execution ──────────────────────────────────────────────

  async exec(...args: string[]): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'DockerKaos.exec(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv());
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'DockerKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv(env));
  }

  private _buildExecEnv(invocationEnv?: Record<string, string>): Record<string, string> | undefined {
    if (this._envLayers.length === 0) return invocationEnv;
    const merged: Record<string, string> = { ...invocationEnv };
    for (const layer of this._envLayers) {
      Object.assign(merged, layer);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private async _execInternal(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const containerId = await this._ensureContainer();

    // Build the docker exec command.
    // `docker exec -i -w <cwd> <containerId> <cmd> <args...>`
    const dockerArgs: string[] = ['exec', '-i', '-w', this._cwd];

    // Inject environment variables inline (like SSHKaos)
    if (env !== undefined) {
      for (const [key, value] of Object.entries(env)) {
        dockerArgs.push('-e', `${key}=${value}`);
      }
    }

    dockerArgs.push(containerId);
    dockerArgs.push(...args);

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    await waitForSpawn(child);
    return new DockerProcess(child);
  }
}

// ── Spawn helper ───────────────────────────────────────────────────────

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
