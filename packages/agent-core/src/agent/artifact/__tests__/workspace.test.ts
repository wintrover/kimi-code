import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { beforeEach, describe, expect, it } from 'vitest';

import { allocateSubagentWorkspace } from '../workspace';

describe('SubagentWorkspace', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-workspace-'));
  });

  it('allocates nested directories', async () => {
    const workspace = await allocateSubagentWorkspace({ sessionHome: tmpDir, agentId: 'agent-1' });
    expect(workspace.paths.root).toBe(join(tmpDir, 'subagents', 'agent-1'));
    expect(workspace.paths.workspace).toBe(join(tmpDir, 'subagents', 'agent-1', 'workspace'));
    expect(workspace.paths.artifacts).toBe(join(tmpDir, 'subagents', 'agent-1', 'artifacts'));
    expect(workspace.paths.checkpoints).toBe(join(tmpDir, 'subagents', 'agent-1', 'checkpoints'));
  });
});
