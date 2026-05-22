import { readFile, stat } from 'node:fs/promises';

import { Hono } from 'hono';

import { pathConfig } from '../config';
import type { ToolResultFileResponse } from '../lib/types';

const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;
// Tool call ids observed in the wild: simple identifiers, "call_..." or
// "Agent:7". Allow a conservative character set including colon.
const TOOL_CALL_ID_RE = /^[a-zA-Z0-9_:.-]+$/;

export function toolResultsRoute(): Hono {
  const app = new Hono();

  app.get('/:id/tool-results/:toolCallId', async (c) => {
    const id = c.req.param('id');
    const toolCallId = c.req.param('toolCallId');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }
    if (!TOOL_CALL_ID_RE.test(toolCallId)) {
      return c.json({ error: `invalid tool call id: ${toolCallId}`, code: 'BAD_REQUEST' }, 400);
    }
    const filePath = pathConfig.toolResultArchivePath(id, toolCallId);
    let s;
    try {
      s = await stat(filePath);
    } catch {
      return c.json({ error: `tool result not found: ${toolCallId}`, code: 'NOT_FOUND' }, 404);
    }
    try {
      const content = await readFile(filePath, 'utf8');
      const body: ToolResultFileResponse = {
        tool_call_id: toolCallId,
        session_id: id,
        size_bytes: s.size,
        content,
      };
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to read tool result: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  return app;
}
