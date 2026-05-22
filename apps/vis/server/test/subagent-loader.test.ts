import { afterEach, describe, expect, it } from 'vitest';

import { buildSubagentTree, listSubagents } from '../src/lib/subagent-loader';
import { loadWireRecords } from '../src/lib/wire-loader';
import { createSyntheticSession, type SyntheticResult } from './_fixture';

describe('subagent-loader', () => {
  let fixture: SyntheticResult | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it('lists subagent ids for a session with subagents', async () => {
    fixture = createSyntheticSession({ withSubagent: true });
    const ids = await listSubagents(fixture.dir);
    expect(ids.length).toBe(1);
    expect(ids[0]?.startsWith('sub_')).toBe(true);
  });

  it('builds a tree rooted at main', async () => {
    fixture = createSyntheticSession({ withSubagent: true });
    const main = await loadWireRecords(fixture.dir);
    const tree = await buildSubagentTree(fixture.dir, main.records);
    expect(tree.length).toBe(1);
    const node = tree[0];
    expect(node?.depth).toBe(0);
    expect(node?.agent_id.startsWith('sub_')).toBe(true);
    expect(node?.parent_agent_id).toBeNull();
  });

  it('pairs spawn with completed lifecycle records', async () => {
    fixture = createSyntheticSession({ withSubagent: true });
    const main = await loadWireRecords(fixture.dir);
    const tree = await buildSubagentTree(fixture.dir, main.records);
    const node = tree[0];
    expect(node?.status).toBe('completed');
    expect(node?.result_summary).toBe('all done');
  });

  it('returns empty tree for sessions without subagents', async () => {
    fixture = createSyntheticSession();
    const main = await loadWireRecords(fixture.dir);
    const tree = await buildSubagentTree(fixture.dir, main.records);
    expect(tree).toHaveLength(0);
  });
});
