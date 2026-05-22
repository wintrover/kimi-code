import { readFile, stat } from 'node:fs/promises';

import { Hono } from 'hono';

import { pathConfig } from '../config';
import { buildAnnotatedMessages, buildProjectedStateSummary } from '../lib/context-builder';
import type { ContextResponse, SessionState } from '../lib/types';
import { loadWireRecords } from '../lib/wire-loader';

const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;

export function contextRoute(): Hono {
  const app = new Hono();

  app.get('/:id/context', async (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }
    const sessionDir = pathConfig.sessionDir(id);
    try {
      const dirStat = await stat(sessionDir);
      if (!dirStat.isDirectory()) {
        return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
      }
    } catch {
      return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
    }

    try {
      const load = await loadWireRecords(sessionDir);
      const state = await readSessionState(id);
      const annotated = buildAnnotatedMessages(load.records);
      const projected = buildProjectedStateSummary(load.records, load.session_initialized, state);
      const body: ContextResponse = {
        session_id: id,
        agent_id: null,
        annotated_messages: annotated,
        projected_state: projected,
      };
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to build context: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  return app;
}

async function readSessionState(sessionId: string): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(pathConfig.statePath(sessionId), 'utf8')) as SessionState;
  } catch {
    return null;
  }
}
