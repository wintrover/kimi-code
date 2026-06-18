import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'pathe';

export interface SubagentWorkspacePaths {
  readonly root: string;
  readonly workspace: string;
  readonly artifacts: string;
  readonly checkpoints: string;
}

export interface SubagentWorkspaceOptions {
  readonly sessionHome: string;
  readonly agentId: string;
}

export class SubagentWorkspace {
  readonly paths: SubagentWorkspacePaths;

  constructor(options: SubagentWorkspaceOptions) {
    const root = join(options.sessionHome, 'subagents', options.agentId);
    this.paths = {
      root,
      workspace: join(root, 'workspace'),
      artifacts: join(root, 'artifacts'),
      checkpoints: join(root, 'checkpoints'),
    };
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.paths.workspace, { recursive: true });
    await mkdir(this.paths.artifacts, { recursive: true });
    await mkdir(this.paths.checkpoints, { recursive: true });
  }

  async validateVolumeConsistency(): Promise<void> {
    const resolvedRoot = await realpath(this.paths.root);
    const resolvedArtifacts = await realpath(this.paths.artifacts);
    const resolvedCheckpoints = await realpath(this.paths.checkpoints);
    if (!resolvedArtifacts.startsWith(resolvedRoot)) {
      throw new Error(
        `SubagentWorkspace volume inconsistency detected: artifacts (${resolvedArtifacts}) must reside under root (${resolvedRoot})`,
      );
    }
    if (!resolvedCheckpoints.startsWith(resolvedRoot)) {
      throw new Error(
        `SubagentWorkspace volume inconsistency detected: checkpoints (${resolvedCheckpoints}) must reside under root (${resolvedRoot})`,
      );
    }
  }
}

export async function allocateSubagentWorkspace(
  options: SubagentWorkspaceOptions,
): Promise<SubagentWorkspace> {
  const workspace = new SubagentWorkspace(options);
  await workspace.ensureDirectories();
  await workspace.validateVolumeConsistency();
  return workspace;
}
