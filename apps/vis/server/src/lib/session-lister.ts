import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { SessionState, SessionSummary, WireFileMetadata } from './types';
import { readSessionLastPrompt, readSessionTitle } from './session-title';

const ARCHIVE_RE = /^wire\.\d+\.jsonl$/;
const SESSION_ID_RE = /^session_[a-zA-Z0-9_-]+$/;

/** Count NDJSON body lines (excluding metadata header) without loading the
 * full file into memory. Returns `null` if the file is unreadable. */
async function countWireBodyLines(wirePath: string): Promise<{
  count: number;
  metadata: WireFileMetadata | null;
} | null> {
  try {
    const stream = createReadStream(wirePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headerConsumed = false;
    let count = 0;
    let metadata: WireFileMetadata | null = null;

    for await (const line of rl) {
      if (line.length === 0) continue;
      if (!headerConsumed) {
        headerConsumed = true;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { type?: unknown }).type === 'metadata'
          ) {
            metadata = parsed as WireFileMetadata;
          }
        } catch {
          // first line malformed — session is broken, not missing
        }
        continue;
      }
      count += 1;
    }
    return { count, metadata };
  } catch {
    return null;
  }
}

async function readStateJson(statePath: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

async function countSubagents(sessionDir: string): Promise<number> {
  const agentCount = await countAgentSubagents(sessionDir);
  if (agentCount > 0) return agentCount;
  try {
    const entries = await readdir(join(sessionDir, 'subagents'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function countAgentSubagents(sessionDir: string): Promise<number> {
  try {
    const entries = await readdir(join(sessionDir, 'agents'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== 'main').length;
  } catch {
    return 0;
  }
}

async function resolveMainAgentDir(sessionDir: string): Promise<string> {
  const mainDir = join(sessionDir, 'agents', 'main');
  const info = await stat(mainDir).catch(() => null);
  return info?.isDirectory() === true ? mainDir : sessionDir;
}

async function countArchives(sessionDir: string): Promise<number> {
  try {
    const entries = await readdir(sessionDir);
    return entries.filter((e) => ARCHIVE_RE.test(e)).length;
  } catch {
    return 0;
  }
}

/**
 * Build a `SessionSummary` from a single session directory. Malformed
 * state.json / missing wire.jsonl yield health markers rather than errors.
 */
export async function loadSessionSummary(sessionDir: string): Promise<SessionSummary> {
  const sessionId = sessionDir.split('/').pop() ?? sessionDir;
  const statePath = join(sessionDir, 'state.json');
  const mainAgentDir = await resolveMainAgentDir(sessionDir);
  const wirePath = join(mainAgentDir, 'wire.jsonl');

  const state = await readStateJson(statePath);
  const wireStat = await stat(wirePath).catch(() => null);
  const wireInfo = wireStat === null ? null : await countWireBodyLines(wirePath);
  const subagent_count = await countSubagents(sessionDir);
  const archive_count = await countArchives(mainAgentDir);

  let health: SessionSummary['health'];
  if (wireStat === null) {
    health = 'missing_wire';
  } else if (wireInfo === null) {
    health = 'broken';
  } else if (state === null) {
    // state.json missing / unreadable — still usable, flag as broken.
    health = 'broken';
  } else {
    health = 'ok';
  }

  return {
    session_id: state?.session_id ?? sessionId,
    title: readSessionTitle(state),
    last_prompt: readSessionLastPrompt(state),
    created_at: state?.created_at ?? 0,
    updated_at: state?.updated_at ?? 0,
    last_turn_time: state?.last_turn_time ?? null,
    model: state?.model ?? null,
    permission_mode: state?.permission_mode ?? null,
    last_exit_code: state?.last_exit_code ?? null,
    custom_title: state?.custom_title ?? null,
    tags: state?.tags ?? [],
    archived: state?.archived ?? false,
    workspace_dir: state?.workspace_dir ?? null,
    wire_protocol_version: wireInfo?.metadata?.protocol_version ?? null,
    wire_record_count: wireInfo?.count ?? 0,
    archive_count,
    subagent_count,
    health,
  };
}

/**
 * Enumerate sessions under `sessionsDir`. Current dev stores sessions under a
 * workdir bucket (`sessions/<workdir-key>/<sessionId>`), while older fixtures
 * may still be direct `sessions/<sessionId>` directories.
 */
export async function listSessions(sessionsDir: string): Promise<SessionSummary[]> {
  const candidates: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const sessionDir = join(sessionsDir, entry);
    const s = await stat(sessionDir).catch(() => null);
    if (s?.isDirectory() !== true) continue;
    if (SESSION_ID_RE.test(entry)) {
      candidates.push(sessionDir);
      continue;
    }
    let children: string[];
    try {
      children = await readdir(sessionDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (!SESSION_ID_RE.test(child)) continue;
      const childDir = join(sessionDir, child);
      const childStat = await stat(childDir).catch(() => null);
      if (childStat?.isDirectory() === true) candidates.push(childDir);
    }
  }

  // Cheap pre-filter on state.json producer before doing any wire I/O.
  const keep = await Promise.all(
    candidates.map(async (dir) => {
      const state = await readStateJson(join(dir, 'state.json'));
      if (state === null) return null;
      return state.producer?.kind === 'python' ? null : dir;
    }),
  );

  const summaries = await Promise.all(
    keep.filter((d): d is string => d !== null).map((dir) => loadSessionSummary(dir)),
  );

  summaries.sort((a, b) => b.updated_at - a.updated_at);
  return summaries;
}
