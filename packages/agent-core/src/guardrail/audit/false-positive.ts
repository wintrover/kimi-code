/**
 * False-positive tracker for guardrail decisions.
 *
 * Records user-reported false-positive blocks as JSONL under
 * `~/.kimi-code/security-audit/false-positives.jsonl` and provides
 * in-memory + historical lookup.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';

import { join } from 'pathe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FalsePositiveRecord {
  readonly id: string;
  readonly originalBlockId: string;
  readonly ruleId: string;
  readonly policy: string;
  readonly userReason: string;
  readonly contextSnapshot: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), '.kimi-code', 'security-audit');
const FP_FILE_NAME = 'false-positives.jsonl';

// ---------------------------------------------------------------------------
// FalsePositiveTracker
// ---------------------------------------------------------------------------

export class FalsePositiveTracker {
  private readonly sessionId?: string;
  private readonly logDir: string;
  private readonly filePath: string;

  /** In-memory records for the current session. */
  private readonly records: FalsePositiveRecord[] = [];

  constructor(
    options?: {
      /** Default: `~/.kimi-code/security-audit/` */
      readonly logDir?: string;
      readonly sessionId?: string;
    },
  ) {
    this.sessionId = options?.sessionId;
    this.logDir = options?.logDir ?? DEFAULT_LOG_DIR;
    this.filePath = join(this.logDir, FP_FILE_NAME);
  }

  // ---- Public API --------------------------------------------------------

  /** Record a false-positive report and persist it to disk. */
  async report(params: {
    readonly originalBlockId: string;
    readonly ruleId: string;
    readonly policy: string;
    readonly userReason: string;
    readonly context: Record<string, unknown>;
  }): Promise<FalsePositiveRecord> {
    const record: FalsePositiveRecord = {
      id: randomUUID(),
      originalBlockId: params.originalBlockId,
      ruleId: params.ruleId,
      policy: params.policy,
      userReason: params.userReason,
      contextSnapshot: Object.freeze({ ...params.context }),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    // Persist to disk.
    await mkdir(this.logDir, { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8');

    // Keep in-memory copy.
    this.records.push(record);

    return record;
  }

  /** Get all false-positive records for the current session (in-memory). */
  getRecords(): readonly FalsePositiveRecord[] {
    return this.records;
  }

  /** Load historical false-positives from disk (all sessions). */
  async loadHistory(): Promise<FalsePositiveRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.logDir);
    } catch {
      return [];
    }

    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) return [];

    const results: FalsePositiveRecord[] = [];

    for (const file of jsonlFiles) {
      let content: string;
      try {
        content = await readFile(join(this.logDir, file), 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isFalsePositiveRecord(parsed)) {
            results.push(parsed);
          }
        } catch {
          // Skip malformed lines.
        }
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFalsePositiveRecord(value: unknown): value is FalsePositiveRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['originalBlockId'] === 'string' &&
    typeof obj['ruleId'] === 'string' &&
    typeof obj['policy'] === 'string' &&
    typeof obj['userReason'] === 'string' &&
    typeof obj['contextSnapshot'] === 'object' &&
    obj['contextSnapshot'] !== null &&
    typeof obj['timestamp'] === 'string'
  );
}
