/**
 * Docker image profiles for DockerKaos.
 *
 * Each profile describes a pre-configured container image with optional
 * package lists and Dockerfile content for custom image builds.
 */

import { spawn } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────

export interface DockerProfile {
  /** Unique profile name used for lookup. */
  name: string;
  /** Docker image reference (e.g. `'node:24-slim'`). */
  image: string;
  /** Human-readable description of what the profile provides. */
  description: string;
  /** Extra packages installed in the Docker image. */
  packages?: string[];
  /** Dockerfile content for custom image builds. */
  dockerfile?: string;
}

// ── Built-in profiles ─────────────────────────────────────────────────

export const DOCKER_PROFILES: Record<string, DockerProfile> = {
  minimal: {
    name: 'minimal',
    image: 'node:24-slim',
    description: 'Node.js only — suitable for JavaScript/TypeScript projects',
  },
  nim: {
    name: 'nim',
    image: 'kimi-code/nim:latest',
    description: 'Node.js + Nim + Nimble',
    packages: ['nim', 'nimble'],
    dockerfile: `FROM node:24-slim
RUN apt-get update && apt-get install -y nim nimble && rm -rf /var/lib/apt/lists/*
`,
  },
  full: {
    name: 'full',
    image: 'kimi-code/full:latest',
    description: 'Node.js + Nim + Python + GCC',
    packages: ['nim', 'nimble', 'python3', 'gcc'],
    dockerfile: `FROM node:24-slim
RUN apt-get update && apt-get install -y nim nimble python3 gcc && rm -rf /var/lib/apt/lists/*
`,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Retrieve a Docker profile by name.
 *
 * @throws {Error} If the profile name is not found in `DOCKER_PROFILES`.
 */
export function getProfile(name: string): DockerProfile {
  const profile = DOCKER_PROFILES[name];
  if (profile === undefined) {
    const available = Object.keys(DOCKER_PROFILES).join(', ');
    throw new Error(
      `Unknown Docker profile "${name}". Available profiles: ${available}`,
    );
  }
  return profile;
}

/**
 * Build a Docker image for the given profile.
 *
 * If the profile has a `dockerfile`, it is written to a temporary location
 * and used as the build context. Otherwise the profile's `image` field is
 * used as-is (pulled from the registry).
 *
 * @returns The image tag that can be passed to `DockerKaosOptions.image`.
 */
export async function buildDockerImage(profile: DockerProfile): Promise<string> {
  // If no dockerfile is provided, the image is a pre-built reference — just
  // pull it to make sure it is available locally.
  if (profile.dockerfile === undefined) {
    await dockerPull(profile.image);
    return profile.image;
  }

  // Build from the inline Dockerfile.
  const tag = `kimi-code/${profile.name}:local`;
  await dockerBuild(profile.dockerfile, tag);
  return tag;
}

// ── Docker CLI helpers ────────────────────────────────────────────────

function dockerPull(image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['pull', image], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err: Error) => reject(err));
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const msg = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(`docker pull failed (exit ${code}): ${msg}`));
        return;
      }
      resolve();
    });
  });
}

function dockerBuild(dockerfileContent: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '-t', tag, '-f', '-', '.'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (child.stdin === null) {
      reject(new Error('Failed to open stdin for docker build'));
      return;
    }
    child.stdin.write(dockerfileContent);
    child.stdin.end();

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err: Error) => reject(err));
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const msg = Buffer.concat(stderrChunks).toString('utf-8').trim();
        reject(new Error(`docker build failed (exit ${code}): ${msg}`));
        return;
      }
      resolve();
    });
  });
}
