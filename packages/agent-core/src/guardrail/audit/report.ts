/**
 * Security report generator for guardrail audit data.
 *
 * Reads JSONL audit logs and false-positive records from disk, computes
 * per-rule false-positive rates, and emits a structured report.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { join } from 'pathe';

import type { FalsePositiveRecord } from './false-positive.js';
import type { SecurityAuditEvent } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleReport {
  ruleId: string;
  totalBlocks: number;
  falsePositives: number;
  fpRate: number;
  exceedsThreshold: boolean;
  recommendedAction?: string;
}

export interface SecurityReport {
  generatedAt: string;
  period: string;
  totalBlocks: number;
  totalWarnings: number;
  totalFalsePositives: number;
  rules: RuleReport[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), '.kimi-code', 'security-audit');
const DEFAULT_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Report Generator
// ---------------------------------------------------------------------------

export async function generateSecurityReport(options?: {
  /** ISO date string or relative like `'7d'`, `'30d'`. */
  readonly since?: string;
  /** Filter to a single rule. */
  readonly ruleId?: string;
  /** FP rate threshold — default 0.3. */
  readonly threshold?: number;
  /** Override log directory (useful for testing). */
  readonly logDir?: string;
}): Promise<SecurityReport> {
  const logDir = options?.logDir ?? DEFAULT_LOG_DIR;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const sinceMs = options?.since ? parseSince(options.since) : 0;

  // --- Load audit events ---------------------------------------------------
  const events = await loadAuditEvents(logDir);
  const fpRecords = await loadFalsePositives(logDir);

  // --- Filter by time window ------------------------------------------------
  const filteredEvents = events.filter(
    (e) => new Date(e.timestamp).getTime() >= sinceMs,
  );
  const filteredFPs = fpRecords.filter(
    (r) => new Date(r.timestamp).getTime() >= sinceMs,
  );

  // --- Aggregate stats ------------------------------------------------------
  const blockEvents = filteredEvents.filter(
    (e) => e.event === 'guardrail_block',
  );
  const warnEvents = filteredEvents.filter(
    (e) => e.event === 'guardrail_warn',
  );

  // Group blocks by ruleId.
  const blocksByRule = new Map<string, SecurityAuditEvent[]>();
  for (const evt of blockEvents) {
    const ruleId = evt.violation?.ruleId ?? '__unknown__';
    const list = blocksByRule.get(ruleId) ?? [];
    list.push(evt);
    blocksByRule.set(ruleId, list);
  }

  // Group false-positives by ruleId.
  const fpByRule = new Map<string, FalsePositiveRecord[]>();
  for (const fp of filteredFPs) {
    const list = fpByRule.get(fp.ruleId) ?? [];
    list.push(fp);
    fpByRule.set(fp.ruleId, list);
  }

  // --- Build per-rule reports -----------------------------------------------
  const ruleIds = new Set<string>([
    ...blocksByRule.keys(),
    ...fpByRule.keys(),
  ]);

  const rules: RuleReport[] = [];

  for (const ruleId of ruleIds) {
    if (options?.ruleId && ruleId !== options.ruleId) continue;

    const blocks = blocksByRule.get(ruleId) ?? [];
    const fps = fpByRule.get(ruleId) ?? [];
    const totalBlocks = blocks.length;
    const falsePositives = fps.length;
    const fpRate = totalBlocks > 0 ? falsePositives / totalBlocks : 0;
    const exceedsThreshold = fpRate >= threshold;

    let recommendedAction: string | undefined;
    if (exceedsThreshold) {
      if (fpRate >= 0.6) {
        recommendedAction = 'Consider demoting to warn or allow';
      } else {
        recommendedAction = 'Review rule pattern for tightening';
      }
    }

    rules.push({
      ruleId,
      totalBlocks,
      falsePositives,
      fpRate,
      exceedsThreshold,
      recommendedAction,
    });
  }

  // Sort by FP rate descending so the worst offenders come first.
  rules.sort((a, b) => b.fpRate - a.fpRate);

  return {
    generatedAt: new Date().toISOString(),
    period: options?.since ?? 'all',
    totalBlocks: blockEvents.length,
    totalWarnings: warnEvents.length,
    totalFalsePositives: filteredFPs.length,
    rules,
  };
}

// ---------------------------------------------------------------------------
// Helpers — file I/O
// ---------------------------------------------------------------------------

async function loadAuditEvents(logDir: string): Promise<SecurityAuditEvent[]> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter(
    (f) => f.endsWith('.jsonl') && !f.startsWith('false-positives'),
  );
  if (jsonlFiles.length === 0) return [];

  const results: SecurityAuditEvent[] = [];

  for (const file of jsonlFiles) {
    let content: string;
    try {
      content = await readFile(join(logDir, file), 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isSecurityAuditEvent(parsed)) {
          results.push(parsed);
        }
      } catch {
        // Skip malformed lines.
      }
    }
  }

  return results;
}

async function loadFalsePositives(
  logDir: string,
): Promise<FalsePositiveRecord[]> {
  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return [];

  const results: FalsePositiveRecord[] = [];

  for (const file of jsonlFiles) {
    let content: string;
    try {
      content = await readFile(join(logDir, file), 'utf-8');
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

// ---------------------------------------------------------------------------
// Helpers — type guards
// ---------------------------------------------------------------------------

function isSecurityAuditEvent(value: unknown): value is SecurityAuditEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['event'] === 'string' &&
    typeof obj['timestamp'] === 'string' &&
    [
      'guardrail_block',
      'guardrail_warn',
      'guardrail_pass',
      'guardrail_override',
      'false_positive',
    ].includes(obj['event'] as string)
  );
}

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

// ---------------------------------------------------------------------------
// Helpers — time parsing
// ---------------------------------------------------------------------------

/** Parse `'7d'`, `'30d'` or an ISO date string into epoch ms. */
function parseSince(since: string): number {
  // Relative: `Nd`
  const relativeMatch = /^(\d+)d$/.exec(since);
  if (relativeMatch) {
    const days = Number(relativeMatch[1]);
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }

  // Absolute ISO date.
  const parsed = Date.parse(since);
  if (!Number.isNaN(parsed)) return parsed;

  // Fallback: treat as zero (no filtering).
  return 0;
}
