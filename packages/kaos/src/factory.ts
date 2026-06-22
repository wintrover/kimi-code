/**
 * Kaos factory — create a {@link Kaos} instance from a backend name.
 *
 * Used by the agent core to translate the `execution_backend` config value
 * into the correct execution environment.
 */

import { BubblewrapKaos } from './bubblewrap';
import { DockerKaos, type DockerKaosOptions } from './docker';
import type { Kaos } from './kaos';
import { LocalKaos } from './local';

/** Supported execution backend identifiers. */
export type ExecutionBackend = 'local' | 'docker' | 'bubblewrap';

/**
 * Options forwarded to the concrete Kaos constructor.
 */
export interface CreateKaosOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Docker-specific options (only used when backend is `'docker'`). */
  docker?: DockerKaosOptions;
}

/**
 * Create a {@link Kaos} instance for the given execution backend.
 *
 * @param backend - `'local'` (default), `'docker'`, or `'bubblewrap'`.
 * @param options - Optional overrides forwarded to the concrete implementation.
 * @returns A fresh {@link Kaos} instance.
 */
export async function createKaos(
  backend: ExecutionBackend | undefined,
  options?: CreateKaosOptions,
): Promise<Kaos> {
  switch (backend) {
    case 'docker': {
      const k = new DockerKaos(options?.docker, options?.cwd);
      return k;
    }
    case 'bubblewrap':
      return BubblewrapKaos.create(options?.cwd !== undefined ? { workspaceBind: options.cwd } : undefined);
    case 'local':
    case undefined: {
      const k = await LocalKaos.create();
      if (options?.cwd !== undefined) {
        await k.chdir(options.cwd);
      }
      return k;
    }
    default: {
      const _exhaustive: never = backend;
      throw new Error(`Unknown execution backend: ${String(_exhaustive)}`);
    }
  }
}
