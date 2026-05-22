import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  SubagentCompletedRecord,
  SubagentFailedRecord,
  SubagentNode,
  SubagentSpawnedRecord,
  VisWireRecord,
} from './types';
import { loadWireRecords } from './wire-loader';

interface LifecyclePair {
  spawned: SubagentSpawnedRecord;
  completed: SubagentCompletedRecord | null;
  failed: SubagentFailedRecord | null;
}

/** Directly list subagent ids for a session (only names, no tree build). */
export async function listSubagents(sessionDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(sessionDir, 'agents'));
    const out: string[] = [];
    for (const e of entries) {
      if (e === 'main') continue;
      const s = await stat(join(sessionDir, 'agents', e)).catch(() => null);
      if (s?.isDirectory()) out.push(e);
    }
    if (out.length > 0) return out;
  } catch {
    // Fall back to legacy subagents/ below.
  }
  try {
    const entries = await readdir(join(sessionDir, 'subagents'));
    const out: string[] = [];
    for (const e of entries) {
      const s = await stat(join(sessionDir, 'subagents', e)).catch(() => null);
      if (s?.isDirectory()) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

function extractLifecycleRecords(records: readonly VisWireRecord[]): Map<string, LifecyclePair> {
  const map = new Map<string, LifecyclePair>();
  for (const r of records) {
    if (r.type === 'subagent_spawned') {
      const existing = map.get(r.data.agent_id);
      if (existing === undefined) {
        map.set(r.data.agent_id, { spawned: r, completed: null, failed: null });
      } else {
        existing.spawned = r;
      }
    } else if (r.type === 'subagent_completed') {
      const existing = map.get(r.data.agent_id);
      if (existing === undefined) {
        // Rare: completion without spawn in this wire — create skeleton.
        const fakeSpawn: SubagentSpawnedRecord = {
          type: 'subagent_spawned',
          seq: 0,
          time: 0,
          data: {
            agent_id: r.data.agent_id,
            parent_tool_call_id: r.data.parent_tool_call_id,
            run_in_background: false,
          },
        };
        map.set(r.data.agent_id, { spawned: fakeSpawn, completed: r, failed: null });
      } else {
        existing.completed = r;
      }
    } else if (r.type === 'subagent_failed') {
      const existing = map.get(r.data.agent_id);
      if (existing === undefined) {
        const fakeSpawn: SubagentSpawnedRecord = {
          type: 'subagent_spawned',
          seq: 0,
          time: 0,
          data: {
            agent_id: r.data.agent_id,
            parent_tool_call_id: r.data.parent_tool_call_id,
            run_in_background: false,
          },
        };
        map.set(r.data.agent_id, { spawned: fakeSpawn, completed: null, failed: r });
      } else {
        existing.failed = r;
      }
    }
  }
  return map;
}

async function readSubagentMeta(
  sessionDir: string,
  agentId: string,
): Promise<{ subagent_type: string | null; status: string | null }> {
  try {
    const raw = await readFile(join(await resolveSubagentDir(sessionDir, agentId), 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as { subagent_type?: unknown; status?: unknown };
    return {
      subagent_type: typeof parsed.subagent_type === 'string' ? parsed.subagent_type : null,
      status: typeof parsed.status === 'string' ? parsed.status : null,
    };
  } catch {
    return { subagent_type: null, status: null };
  }
}

async function resolveSubagentDir(sessionDir: string, agentId: string): Promise<string> {
  const agentDir = join(sessionDir, 'agents', agentId);
  const agentStat = await stat(agentDir).catch(() => null);
  return agentStat?.isDirectory() === true ? agentDir : join(sessionDir, 'subagents', agentId);
}

function deriveStatus(pair: LifecyclePair, metaStatus: string | null): SubagentNode['status'] {
  if (pair.failed !== null) return 'failed';
  if (pair.completed !== null) return 'completed';
  if (metaStatus !== null) {
    const allowed: ReadonlyArray<SubagentNode['status']> = [
      'running',
      'completed',
      'failed',
      'killed',
      'lost',
    ];
    if ((allowed as string[]).includes(metaStatus)) {
      return metaStatus as SubagentNode['status'];
    }
  }
  return 'unknown';
}

/**
 * Build the subagent tree for a session, recursing into each subagent's
 * wire.jsonl to discover nested spawns. Depth-capped at `maxDepth`
 * (default 5) to prevent runaway recursion on corrupt fixtures.
 */
export async function buildSubagentTree(
  sessionDir: string,
  mainWireRecords: readonly VisWireRecord[],
  maxDepth = 5,
): Promise<SubagentNode[]> {
  const visited = new Set<string>();

  async function buildLevel(
    records: readonly VisWireRecord[],
    depth: number,
    parentAgentId: string | null,
  ): Promise<SubagentNode[]> {
    if (depth > maxDepth) return [];
    const pairs = extractLifecycleRecords(records);

    // Reserve all agentIds at this level synchronously so parallel recursion
    // cannot re-visit a cousin branch's already-claimed agent.
    const toProcess: Array<[string, LifecyclePair]> = [];
    for (const [agentId, pair] of pairs) {
      if (visited.has(agentId)) continue;
      visited.add(agentId);
      toProcess.push([agentId, pair]);
    }

    const nodes = await Promise.all(
      toProcess.map(async ([agentId, pair]): Promise<SubagentNode> => {
        const meta = await readSubagentMeta(sessionDir, agentId);
        let children: SubagentNode[] = [];
        const subDir = await resolveSubagentDir(sessionDir, agentId);
        const dirStat = await stat(subDir).catch(() => null);
        if (dirStat?.isDirectory() && depth < maxDepth) {
          try {
            const sub = await loadWireRecords(subDir);
            children = await buildLevel(sub.records, depth + 1, agentId);
          } catch {
            // ignore — leave children empty
          }
        }

        const status = deriveStatus(pair, meta.status);
        let success: boolean | null;
        if (pair.completed !== null) success = true;
        else if (pair.failed !== null) success = false;
        else success = null;

        const resolvedParent =
          pair.spawned.data.parent_agent_id ?? parentAgentId;

        return {
          agent_id: agentId,
          agent_name: pair.spawned.data.agent_name ?? null,
          subagent_type: meta.subagent_type,
          run_in_background: pair.spawned.data.run_in_background,
          parent_agent_id: resolvedParent,
          depth,
          status,
          success,
          result_summary: pair.completed?.data.result_summary ?? null,
          error: pair.failed?.data.error ?? null,
          spawn_seq: pair.spawned.seq,
          spawn_time: pair.spawned.time,
          children,
        };
      }),
    );

    // Sort deterministically — earliest spawn first.
    nodes.sort((a, b) => a.spawn_seq - b.spawn_seq);
    return nodes;
  }

  return buildLevel(mainWireRecords, 0, null);
}
