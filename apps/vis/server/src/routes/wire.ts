import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

import { pathConfig } from '../config';
import type { WireResponse } from '../lib/types';
import { loadWireRecords } from '../lib/wire-loader';
import { replayWire } from '../lib/wire-replay';

const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;
const ARCHIVE_FILE_RE = /^wire\.\d+\.jsonl$/;

export function wireRoute(): Hono {
  const app = new Hono();

  app.get('/:id/wire', async (c) => {
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
      const result = await loadWireRecords(sessionDir);
      const body: WireResponse = {
        session_id: id,
        agent_id: null,
        files_read: result.files_read,
        health: result.health,
        warnings: result.warnings,
        records: result.records,
      };
      if (result.broken_reason !== undefined) body.broken_reason = result.broken_reason;
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to load wire: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  app.get('/:id/archives/:filename', async (c) => {
    const id = c.req.param('id');
    const filename = c.req.param('filename');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }
    if (!ARCHIVE_FILE_RE.test(filename)) {
      return c.json({ error: `invalid archive filename: ${filename}`, code: 'BAD_REQUEST' }, 400);
    }
    const archivePath = join(pathConfig.mainAgentDir(id), filename);
    try {
      await stat(archivePath);
    } catch {
      return c.json({ error: `archive not found: ${filename}`, code: 'NOT_FOUND' }, 404);
    }
    try {
      const result = await replayWire(archivePath);
      const body: WireResponse = {
        session_id: id,
        agent_id: null,
        files_read: [archivePath],
        health: result.health,
        warnings: [...result.warnings],
        records: result.records,
      };
      if (result.brokenReason !== undefined) body.broken_reason = result.brokenReason;
      return c.json(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to replay archive: ${msg}`, code: 'READ_ERROR' }, 500);
    }
  });

  return app;
}
