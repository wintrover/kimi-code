import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Hono } from 'hono';

import { pathConfig } from '../config';
import { deleteSession, SESSION_ID_RE } from '../lib/session-delete';
import { readSessionLastPrompt, readSessionTitle } from '../lib/session-title';
import type { SessionDetail, SessionState, WireFileMetadata } from '../lib/types';

const ARCHIVE_RE = /^wire\.\d+\.jsonl$/;

async function readFirstLine(path: string): Promise<string | null> {
  try {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      rl.close();
      stream.close();
      return line;
    }
  } catch {
    return null;
  }
  return null;
}

export function sessionDetailRoute(): Hono {
  const app = new Hono();

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }
    const sessionDir = pathConfig.sessionDir(id);

    let dirStat;
    try {
      dirStat = await stat(sessionDir);
    } catch {
      return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
    }
    if (!dirStat.isDirectory()) {
      return c.json({ error: `session not a directory: ${id}`, code: 'NOT_FOUND' }, 404);
    }

    // state.json (best-effort).
    let state: SessionState;
    try {
      const raw = await readFile(pathConfig.statePath(id), 'utf8');
      state = JSON.parse(raw) as SessionState;
    } catch {
      state = {
        session_id: id,
        created_at: 0,
        updated_at: 0,
      };
    }

    // Directory listings.
    const mainAgentDir = pathConfig.mainAgentDir(id);
    const mainEntries = await readdir(mainAgentDir).catch(() => [] as string[]);
    const archive_files = mainEntries.filter((e) => ARCHIVE_RE.test(e)).toSorted();

    const subagent_ids: string[] = [];
    try {
      const subs = await readdir(join(sessionDir, 'agents'));
      for (const s of subs) {
        if (s === 'main') continue;
        const ss = await stat(join(sessionDir, 'agents', s)).catch(() => null);
        if (ss?.isDirectory()) subagent_ids.push(s);
      }
    } catch {
      try {
        const subs = await readdir(join(sessionDir, 'subagents'));
        for (const s of subs) {
          const ss = await stat(join(sessionDir, 'subagents', s)).catch(() => null);
          if (ss?.isDirectory()) subagent_ids.push(s);
        }
      } catch {
        // subagents dir missing is fine
      }
    }

    const tool_result_ids: string[] = [];
    try {
      const files = await readdir(join(mainAgentDir, 'tool-results'));
      for (const f of files) {
        if (f.endsWith('.txt')) tool_result_ids.push(f.slice(0, -4));
      }
    } catch {
      try {
        const files = await readdir(join(sessionDir, 'tool-results'));
        for (const f of files) {
          if (f.endsWith('.txt')) tool_result_ids.push(f.slice(0, -4));
        }
      } catch {
        // tool-results dir missing is fine
      }
    }

    // wire metadata (first line of wire.jsonl)
    let wire_metadata: WireFileMetadata | null = null;
    const firstLine = await readFirstLine(pathConfig.wirePath(id));
    if (firstLine !== null) {
      try {
        const parsed = JSON.parse(firstLine) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { type?: unknown }).type === 'metadata'
        ) {
          wire_metadata = parsed as WireFileMetadata;
        }
      } catch {
        // ignore malformed header
      }
    }

    const detail: SessionDetail = {
      session_id: id,
      title: readSessionTitle(state),
      last_prompt: readSessionLastPrompt(state),
      state,
      subagent_ids,
      archive_files,
      tool_result_ids,
      wire_metadata,
    };
    return c.json(detail);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_RE.test(id)) {
      return c.json({ error: `invalid session id: ${id}`, code: 'BAD_REQUEST' }, 400);
    }

    try {
      const result = await deleteSession(id);
      if (result === null) {
        return c.json({ error: `session not found: ${id}`, code: 'NOT_FOUND' }, 404);
      }
      return c.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `failed to delete session: ${msg}`, code: 'DELETE_ERROR' }, 500);
    }
  });

  return app;
}
