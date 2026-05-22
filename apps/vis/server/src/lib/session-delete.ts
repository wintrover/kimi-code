import { rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { pathConfig } from '../config';
import { listSessions } from './session-lister';
import type { ClearSessionsResponse, DeleteSessionResponse } from './types';

export const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveSafeSessionDir(sessionId: string): string {
  const sessionsRoot = resolve(pathConfig.sessionsDir);
  const sessionDir = resolve(pathConfig.sessionDir(sessionId));
  if (!isInside(sessionsRoot, sessionDir) || basename(sessionDir) !== sessionId) {
    throw new Error(`refusing to delete unsafe session path: ${sessionDir}`);
  }
  return sessionDir;
}

export async function deleteSession(sessionId: string): Promise<DeleteSessionResponse | null> {
  const sessionDir = resolveSafeSessionDir(sessionId);
  const info = await stat(sessionDir).catch(() => null);
  if (info?.isDirectory() !== true) return null;
  await rm(sessionDir, { recursive: true, force: true });
  return { session_id: sessionId, deleted: true };
}

export async function clearSessions(): Promise<ClearSessionsResponse> {
  const sessions = await listSessions(pathConfig.sessionsDir);
  const failed: ClearSessionsResponse['failed'] = [];
  let deleted_count = 0;

  for (const session of sessions) {
    try {
      const result = await deleteSession(session.session_id);
      if (result?.deleted === true) deleted_count += 1;
    } catch (error) {
      failed.push({
        session_id: session.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deleted_count, failed };
}
