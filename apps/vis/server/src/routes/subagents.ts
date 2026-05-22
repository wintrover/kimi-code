import { readFile, stat } from 'node:fs/promises';

import { Hono } from 'hono';

import { pathConfig } from '../config';
import { buildAnnotatedMessages, buildProjectedStateSummary } from '../lib/context-builder';
import { buildSubagentTree } from '../lib/subagent-loader';
import type {
  ContextResponse,
  SubagentMetaResponse,
  SubagentNode,
  SubagentTreeResponse,
  WireResponse
} from '../lib/types';
import { loadWireRecords } from '../lib/wire-loader';

const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;
// Subagent ids in the wild look like "sub_<uuid-ish>" — allow word chars and dashes.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

function findNode(tree: SubagentNode[], agentId: string): SubagentNode | null {
  for (const node of tree) {
    if (node.agent_id === agentId) return node;
    const found = findNode(node.children, agentId);
    if (found !== null) return found;
  }
  return null;
}

export function subagentsRoute(): Hono {
  const app = new Hono();

  app.get('/:id/subagents', async (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }
    const sessionDir = pathConfig.sessionDir(id);
    try {
      const s = await stat(sessionDir);
      if (!s.isDirectory())
        return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
    } catch {
      return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
    }

    try {
      const main = await loadWireRecords(sessionDir);
      const tree = await buildSubagentTree(sessionDir, main.records);
      const body: SubagentTreeResponse = { session_id: id, tree };
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to build subagent tree: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  app.get('/:id/subagents/:agentId/wire', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!SESSION_ID_RE.test(id) || !AGENT_ID_RE.test(agentId)) {
      return c.json({ error: 'invalid session or agent id', code: 'BAD_REQUEST' }, 400);
    }
    const subDir = pathConfig.subagentDir(id, agentId);
    try {
      const s = await stat(subDir);
      if (!s.isDirectory())
        return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    } catch {
      return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    }

    try {
      const result = await loadWireRecords(subDir);
      const body: WireResponse = {
        session_id: id,
        agent_id: agentId,
        files_read: result.files_read,
        health: result.health,
        warnings: result.warnings,
        records: result.records,
      };
      if (result.broken_reason !== undefined) body.broken_reason = result.broken_reason;
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to load subagent wire: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  app.get('/:id/subagents/:agentId/context', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!SESSION_ID_RE.test(id) || !AGENT_ID_RE.test(agentId)) {
      return c.json({ error: 'invalid session or agent id', code: 'BAD_REQUEST' }, 400);
    }
    const subDir = pathConfig.subagentDir(id, agentId);
    try {
      const s = await stat(subDir);
      if (!s.isDirectory())
        return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    } catch {
      return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    }

    try {
      const load = await loadWireRecords(subDir);
      const annotated = buildAnnotatedMessages(load.records);
      const projected = buildProjectedStateSummary(load.records, load.session_initialized);
      const body: ContextResponse = {
        session_id: id,
        agent_id: agentId,
        annotated_messages: annotated,
        projected_state: projected,
      };
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to build subagent context: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  app.get('/:id/subagents/:agentId/meta', async (c) => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!SESSION_ID_RE.test(id) || !AGENT_ID_RE.test(agentId)) {
      return c.json({ error: 'invalid session or agent id', code: 'BAD_REQUEST' }, 400);
    }
    const sessionDir = pathConfig.sessionDir(id);
    const subDir = pathConfig.subagentDir(id, agentId);
    try {
      const s = await stat(subDir);
      if (!s.isDirectory())
        return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    } catch {
      return c.json({ error: `subagent not found: ${agentId}`, code: 'NOT_FOUND' }, 404);
    }

    let meta_json: SubagentMetaResponse['meta_json'] = null;
    try {
      const raw = await readFile(`${subDir}/meta.json`, 'utf8');
      meta_json = JSON.parse(raw) as SubagentMetaResponse['meta_json'];
    } catch {
      meta_json = null;
    }

    // Find the agent in the tree, then scan its direct parent's wire for
    // lifecycle records. For nested subagents (depth >= 1), lifecycle records
    // live on the intermediate parent's wire, not the main session wire.
    let spawned_record: SubagentMetaResponse['spawned_record'] = null;
    let completed_record: SubagentMetaResponse['completed_record'] = null;
    let failed_record: SubagentMetaResponse['failed_record'] = null;
    let depth = 0;

    try {
      const main = await loadWireRecords(sessionDir);
      const tree = await buildSubagentTree(sessionDir, main.records);
      const node = findNode(tree, agentId);
      if (node !== null) depth = node.depth;

      // Pick the correct wire to scan: main wire for depth 0, else the parent
      // subagent's wire (which contains this child's spawn/complete records).
      const parentAgentId = node?.parent_agent_id ?? null;
      const scanRecords =
        parentAgentId === null
          ? main.records
          : (await loadWireRecords(pathConfig.subagentDir(id, parentAgentId))).records;

      for (const r of scanRecords) {
        if (r.type === 'subagent_spawned' && r.data.agent_id === agentId) {
          const entry: NonNullable<SubagentMetaResponse['spawned_record']> = {
            parent_tool_call_id: r.data.parent_tool_call_id,
            run_in_background: r.data.run_in_background,
            seq: r.seq,
            time: r.time,
          };
          if (r.data.agent_name !== undefined) entry.agent_name = r.data.agent_name;
          if (r.data.parent_agent_id !== undefined) entry.parent_agent_id = r.data.parent_agent_id;
          spawned_record = entry;
        } else if (r.type === 'subagent_completed' && r.data.agent_id === agentId) {
          const entry: NonNullable<SubagentMetaResponse['completed_record']> = {
            parent_tool_call_id: r.data.parent_tool_call_id,
            result_summary: r.data.result_summary,
            seq: r.seq,
            time: r.time,
          };
          if (r.data.usage !== undefined) {
            const u = r.data.usage;
            const usage: {
              input_tokens: number;
              output_tokens: number;
              cache_read_tokens?: number;
              cache_write_tokens?: number;
            } = { input_tokens: u.input, output_tokens: u.output };
            if (u.cache_read !== undefined) usage.cache_read_tokens = u.cache_read;
            if (u.cache_write !== undefined) usage.cache_write_tokens = u.cache_write;
            entry.usage = usage;
          }
          completed_record = entry;
        } else if (r.type === 'subagent_failed' && r.data.agent_id === agentId) {
          failed_record = {
            parent_tool_call_id: r.data.parent_tool_call_id,
            error: r.data.error,
            seq: r.seq,
            time: r.time,
          };
        }
      }
    } catch {
      // Fall through — partial response is still useful.
    }

    const body: SubagentMetaResponse = {
      agent_id: agentId,
      session_id: id,
      meta_json,
      spawned_record,
      completed_record,
      failed_record,
      depth,
    };
    return c.json(body);
  });

  return app;
}
