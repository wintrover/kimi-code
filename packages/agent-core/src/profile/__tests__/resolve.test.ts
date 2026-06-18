import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../default';

describe('DEFAULT_AGENT_PROFILES', () => {
  it('exposes the synthesis profile with only YieldArtifact', () => {
    const synthesis = DEFAULT_AGENT_PROFILES['synthesis'];
    expect(synthesis).toBeDefined();
    expect(synthesis?.tools).toEqual(['YieldArtifact']);
  });

  it('keeps synthesis profile hidden from agent subagent listings', () => {
    const agentSubagents = DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {};
    expect(agentSubagents['synthesis']).toBeUndefined();
  });
});
