/**
 * Auto-tune suggestion engine for guardrail rules.
 *
 * Analyses historical false-positive rates and produces actionable
 * suggestions — including a TOML patch snippet — for adjusting rules
 * whose false-positive rate exceeds the configurable threshold.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { join } from 'pathe';

import type { FalsePositiveRecord } from './false-positive.js';
import type { SecurityAuditEvent } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TuneSuggestion {
  ruleId: string;
  currentAction: 'block' | 'warn' | 'allow';
  suggestedAction: 'block' | 'warn' | 'allow';
  currentRiskLevel: string;
  suggestedRiskLevel: string;
  reason: string;
  falsePositiveRate: number;
  /** TOML patch to apply. */
  tomlPatch: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), '.kimi-code', 'security-audit');
const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_MIN_SAMPLE_SIZE = 5;

// ---------------------------------------------------------------------------
// Auto-Tune Suggestions
// ---------------------------------------------------------------------------

export async function generateTuneSuggestions(options?: {
  /** FP rate threshold — default 0.3. */
  readonly threshold?: number;
  /** Minimum block count before suggesting — default 5. */
  readonly minSampleSize?: number;
  /** Override log directory (useful for testing). */
  readonly logDir?: string;
}): Promise<TuneSuggestion[]> {
  const logDir = options?.logDir ?? DEFAULT_LOG_DIR;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const minSampleSize = options?.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;

  // --- Load data -----------------------------------------------------------
  const events = await loadAuditEvents(logDir);
  const fpRecords = await loadFalsePositives(logDir);

  // --- Per-rule aggregation ------------------------------------------------
  const blocksByRule = new Map<
    string,
    { total: number; fps: number; riskLevel: string; action: string }
  >();

  for (const evt of events) {
    if (evt.event !== 'guardrail_block') continue;
    const ruleId = evt.violation?.ruleId;
    if (!ruleId) continue;

    const entry = blocksByRule.get(ruleId) ?? {
      total: 0,
      fps: 0,
      riskLevel: evt.violation?.riskLevel ?? 'unknown',
      action: (evt.decision?.action as string) ?? 'block',
    };
    entry.total++;
    blocksByRule.set(ruleId, entry);
  }

  for (const fp of fpRecords) {
    const entry = blocksByRule.get(fp.ruleId);
    if (!entry) continue;
    entry.fps++;
  }

  // --- Produce suggestions --------------------------------------------------
  const suggestions: TuneSuggestion[] = [];

  for (const [ruleId, data] of blocksByRule) {
    if (data.total < minSampleSize) continue;

    const fpRate = data.fps / data.total;
    if (fpRate < threshold) continue;

    const currentAction = (data.action as 'block' | 'warn' | 'allow') ?? 'block';
    const currentRiskLevel = data.riskLevel;

    const { suggestedAction, suggestedRiskLevel } = deriveSuggestion(
      currentAction,
      fpRate,
    );

    const reason = buildReason(ruleId, data.total, data.fps, fpRate);

    const tomlPatch = buildTomlPatch(ruleId, suggestedAction, suggestedRiskLevel);

    suggestions.push({
      ruleId,
      currentAction,
      suggestedAction,
      currentRiskLevel,
      suggestedRiskLevel,
      reason,
      falsePositiveRate: fpRate,
      tomlPatch,
    });
  }

  // Highest FP rate first.
  suggestions.sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);

  return suggestions;
}

// ---------------------------------------------------------------------------
// Helpers — suggestion logic
// ---------------------------------------------------------------------------

function deriveSuggestion(
  currentAction: 'block' | 'warn' | 'allow',
  fpRate: number,
): { suggestedAction: 'block' | 'warn' | 'allow'; suggestedRiskLevel: string } {
  if (fpRate >= 0.6) {
    // Very high FP rate — demote by two levels.
    if (currentAction === 'block')
      return { suggestedAction: 'warn', suggestedRiskLevel: 'medium' };
    if (currentAction === 'warn')
      return { suggestedAction: 'allow', suggestedRiskLevel: 'low' };
    return { suggestedAction: 'allow', suggestedRiskLevel: 'low' };
  }

  // Moderate FP rate — demote by one level.
  if (currentAction === 'block')
    return { suggestedAction: 'warn', suggestedRiskLevel: 'medium' };
  if (currentAction === 'warn')
    return { suggestedAction: 'allow', suggestedRiskLevel: 'low' };
  return { suggestedAction: 'allow', suggestedRiskLevel: 'low' };
}

function buildReason(
  ruleId: string,
  totalBlocks: number,
  fps: number,
  fpRate: number,
): string {
  const pct = (fpRate * 100).toFixed(1);
  return `Rule "${ruleId}" has a ${pct}% false-positive rate (${fps}/${totalBlocks} blocks). Consider demoting the action or tightening the pattern.`;
}

function buildTomlPatch(
  ruleId: string,
  suggestedAction: 'block' | 'warn' | 'allow',
  suggestedRiskLevel: string,
): string {
  // Produce a minimal TOML snippet the user can paste into their config.
  return [
    `[guardrail.rules.${ruleId}]`,
    `action = "${suggestedAction}"`,
    `risk_level = "${suggestedRiskLevel}"`,
  ].join('\n');
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
