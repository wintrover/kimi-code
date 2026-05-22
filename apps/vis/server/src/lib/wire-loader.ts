import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  MetadataRecord,
  SessionInitializedRecord,
  VisWireRecord,
  WireFileMetadata,
} from './types';
import { replayWire } from './wire-replay';

const ARCHIVE_RE = /^wire\.(\d+)\.jsonl$/;

export interface WireLoadResult {
  records: VisWireRecord[];
  /** session_initialized from the newest wire file's line 2.
   *  `null` when the session predates the line-2 header convention or
   *  the file lacks a `session_initialized` line. */
  session_initialized: SessionInitializedRecord | null;
  health: 'ok' | 'broken';
  broken_reason?: string;
  warnings: string[];
  files_read: string[];
}

/**
 * Enumerate all wire files in `agentDir` (archives first, ascending by N;
 * then current `wire.jsonl`). Re-implemented locally because the
 * corresponding helper inside `@moonshot-ai/agent-core` is not exported.
 */
export async function listWireFilesManually(agentDir: string): Promise<string[]> {
  const wireDir = await resolveWireDir(agentDir);
  let entries: string[];
  try {
    entries = await readdir(wireDir);
  } catch {
    return [];
  }

  const archives: { path: string; n: number }[] = [];
  let current: string | null = null;
  for (const entry of entries) {
    if (entry === 'wire.jsonl') {
      current = join(wireDir, entry);
      continue;
    }
    const m = ARCHIVE_RE.exec(entry);
    if (m?.[1] !== undefined) {
      archives.push({ path: join(wireDir, entry), n: Number.parseInt(m[1], 10) });
    }
  }
  archives.sort((a, b) => a.n - b.n);
  const out = archives.map((a) => a.path);
  if (current !== null) {
    out.push(current);
  }
  return out;
}

async function resolveWireDir(agentDir: string): Promise<string> {
  const mainDir = join(agentDir, 'agents', 'main');
  try {
    const entries = await readdir(mainDir);
    if (entries.includes('wire.jsonl')) return mainDir;
  } catch {
    // `agentDir` is already an agent dir or has no main agent.
  }
  return agentDir;
}

/**
 * Load all wire records for an agent (main or subagent) in age order.
 *
 * Calls `replayWire()` per file and concatenates — core only exports the
 * single-file replay primitive, so multi-file replay is composed here.
 *
 * The cast to `VisWireRecord[]` is the sole trust boundary in vis. Safe
 * because the vis mirror types are field-for-field identical to the core
 * `WireRecord` union and `replayWire()` only emits validated records.
 */
export async function loadWireRecords(agentDir: string): Promise<WireLoadResult> {
  const files = await listWireFilesManually(agentDir);

  if (files.length === 0) {
    return {
      records: [],
      session_initialized: null,
      health: 'broken',
      broken_reason: `no wire files found under ${agentDir}`,
      warnings: [],
      files_read: [],
    };
  }

  const records: VisWireRecord[] = [];
  const warnings: string[] = [];
  let overallHealth: 'ok' | 'broken' = 'ok';
  let brokenReason: string | undefined;
  const filesRead: string[] = [];
  // session_initialized is the line-2 truth source. Keep the most-recent
  // (current wire's) value, not archive values, so post-compaction the
  // live model/prompt is reflected.
  let sessionInitialized: SessionInitializedRecord | null = null;

  for (const filePath of files) {
    try {
      const result = await replayWire(filePath);
      filesRead.push(filePath);
      const fileMeta = await readMetadataLine(filePath);
      const init = result.sessionInitialized;
      // Splice the two wire.jsonl header lines back into the timeline so
      // the Wire tab shows EVERYTHING in the file (including system_prompt).
      if (fileMeta !== null) {
        const metaRecord: MetadataRecord = {
          type: 'metadata',
          seq: 0,
          time: fileMeta.created_at,
          protocol_version: fileMeta.protocol_version,
          created_at: fileMeta.created_at,
          file_name: basename(filePath),
        };
        if (fileMeta.kimi_version !== undefined) metaRecord.kimi_version = fileMeta.kimi_version;
        if (fileMeta.producer !== undefined) metaRecord.producer = fileMeta.producer;
        records.push(metaRecord);
      }
      if (init !== null) records.push(init);
      records.push(...(result.records));
      sessionInitialized = init;
      for (const w of result.warnings) warnings.push(`${filePath}: ${w}`);
      if (result.health === 'broken') {
        overallHealth = 'broken';
        brokenReason ??= result.brokenReason ?? `broken wire file: ${filePath}`;
      }
    } catch (error) {
      // Filesystem / unexpected errors surface as a soft broken state —
      // vis still lists the session and shows its raw records if we
      // have any.
      overallHealth = 'broken';
      const reason = error instanceof Error ? error.message : String(error);
      brokenReason ??= `${filePath}: ${reason}`;
      warnings.push(`${filePath}: ${reason}`);
    }
  }

  const out: WireLoadResult = {
    records,
    session_initialized: sessionInitialized,
    health: overallHealth,
    warnings,
    files_read: filesRead,
  };
  if (brokenReason !== undefined) out.broken_reason = brokenReason;
  return out;
}

/** Parse line 1 of a wire.jsonl as the file-header metadata record.
 *  Returns null on any read/parse failure — the caller already ran
 *  `replayWire()`, which validates the header independently, so this
 *  helper stays forgiving: missing metadata just means we can't splice
 *  it into the timeline, not that the session is broken. */
async function readMetadataLine(filePath: string): Promise<WireFileMetadata | null> {
  try {
    const text = await readFile(filePath, 'utf8');
    const nl = text.indexOf('\n');
    const first = nl === -1 ? text : text.slice(0, nl);
    if (first.length === 0) return null;
    const parsed = JSON.parse(first) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== 'metadata'
    ) {
      return null;
    }
    return parsed as WireFileMetadata;
  } catch {
    return null;
  }
}
