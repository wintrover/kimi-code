import { execFile } from 'node:child_process';

import { BubblewrapKaos, type BubblewrapKaosOptions } from './bubblewrap';
import { DockerKaos, type DockerKaosOptions } from './docker';
import type { Kaos } from './kaos';
import { LocalKaos } from './local';

// ── Types ──────────────────────────────────────────────────────────────

export type BackendType = 'docker' | 'bubblewrap' | 'ssh' | 'local';

export interface BackendDetectionResult {
  backend: BackendType;
  available: boolean;
  reason?: string;
}

export interface BackendDetectorOptions {
  /** Preferred order. Default: `['docker', 'bubblewrap', 'local']`. */
  preference?: BackendType[];
  /**
   * SSH target for the SSH backend (e.g. `"user@host"` or `"host"`).
   * When provided, the detector will check reachability of this target.
   */
  sshTarget?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_PREFERENCE: BackendType[] = ['docker', 'bubblewrap', 'local'];

/**
 * Check whether an SSH target is reachable by running a quick
 * `ssh -o ConnectTimeout=5 -O exit <target>` command.
 */
async function isSshReachable(target: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(
      'ssh',
      ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '-f', target, 'true'],
      { timeout: 10_000 },
      (error) => {
        resolve(error === null);
      },
    );
  });
}

// ── BackendDetector ────────────────────────────────────────────────────

/**
 * Auto-detects the best available execution backend based on the
 * configured preference order.
 *
 * Detection logic for each backend:
 * - **Docker**: `docker --version` succeeds (via `DockerKaos.isAvailable()`).
 * - **Bubblewrap**: `which bwrap` succeeds (via `BubblewrapKaos.isAvailable()`).
 * - **SSH**: the configured `sshTarget` is reachable via `ssh`.
 * - **Local**: always available (fallback).
 */
export class BackendDetector {
  private readonly _preference: BackendType[];
  private readonly _sshTarget: string | undefined;

  constructor(options?: BackendDetectorOptions) {
    this._preference = options?.preference ?? DEFAULT_PREFERENCE;
    this._sshTarget = options?.sshTarget;
  }

  /**
   * Detect the best available backend by walking the preference list
   * and returning the first one that is available.
   */
  async detect(): Promise<BackendDetectionResult> {
    for (const backend of this._preference) {
      const result = await this.checkBackend(backend);
      if (result.available) return result;
    }

    // Should never reach here because 'local' is always available, but
    // handle the edge case where someone configured a preference list
    // without 'local'.
    return { backend: 'local', available: true };
  }

  /**
   * Check availability of a specific backend type.
   */
  async checkBackend(type: BackendType): Promise<BackendDetectionResult> {
    switch (type) {
      case 'docker':
        return this._checkDocker();
      case 'bubblewrap':
        return this._checkBubblewrap();
      case 'ssh':
        return this._checkSsh();
      case 'local':
        return { backend: 'local', available: true };
    }
  }

  /**
   * List all backends and their availability status.
   */
  async listAvailable(): Promise<BackendDetectionResult[]> {
    const all: BackendType[] = ['docker', 'bubblewrap', 'ssh', 'local'];
    return Promise.all(all.map((b) => this.checkBackend(b)));
  }

  /**
   * Create a {@link Kaos} instance for the best detected backend.
   */
  async createKaos(options?: Record<string, unknown>): Promise<Kaos> {
    const result = await this.detect();
    return this._createForBackend(result.backend, options);
  }

  // ── Private: per-backend checks ────────────────────────────────────

  private async _checkDocker(): Promise<BackendDetectionResult> {
    try {
      const available = await DockerKaos.isAvailable();
      return {
        backend: 'docker',
        available,
        reason: available ? undefined : 'Docker daemon not reachable',
      };
    } catch {
      return { backend: 'docker', available: false, reason: 'Docker check failed' };
    }
  }

  private async _checkBubblewrap(): Promise<BackendDetectionResult> {
    try {
      const available = await BubblewrapKaos.isAvailable();
      return {
        backend: 'bubblewrap',
        available,
        reason: available ? undefined : 'bwrap not found on PATH',
      };
    } catch {
      return { backend: 'bubblewrap', available: false, reason: 'Bubblewrap check failed' };
    }
  }

  private async _checkSsh(): Promise<BackendDetectionResult> {
    if (this._sshTarget === undefined) {
      return { backend: 'ssh', available: false, reason: 'No SSH target configured' };
    }
    try {
      const reachable = await isSshReachable(this._sshTarget);
      return {
        backend: 'ssh',
        available: reachable,
        reason: reachable ? undefined : `SSH target "${this._sshTarget}" unreachable`,
      };
    } catch {
      return { backend: 'ssh', available: false, reason: 'SSH reachability check failed' };
    }
  }

  // ── Private: factory ───────────────────────────────────────────────

  private async _createForBackend(
    backend: BackendType,
    options?: Record<string, unknown>,
  ): Promise<Kaos> {
    switch (backend) {
      case 'docker':
        return new DockerKaos(options as DockerKaosOptions | undefined);
      case 'bubblewrap':
        return BubblewrapKaos.create(options as BubblewrapKaosOptions | undefined);
      case 'ssh': {
        // SSH requires explicit connection details — dynamic import to
        // avoid pulling the ssh2 dependency when SSH is not used.
        const { SSHKaos } = await import('./ssh');
        return SSHKaos.create(options as unknown as Parameters<typeof SSHKaos.create>[0]);
      }
      case 'local':
      default:
        return LocalKaos.create();
    }
  }
}
