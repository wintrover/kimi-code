/**
 * SecurityDashboardComponent — renders the security audit summary in a
 * bordered panel, following the same layout pattern as UsagePanelComponent.
 *
 * Triggered by the `/security-log` slash command.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type {
  SecurityAuditEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const MIN_INTERIOR_WIDTH = 20;

type Colorize = (text: string) => string;

// ---------------------------------------------------------------------------
// Local types (avoids cross-package type resolution edge cases)
// ---------------------------------------------------------------------------

export interface SecurityLogArgs {
  readonly ruleId?: string;
  readonly since?: string;
}

/** Minimal summary interface matching the SDK's SecuritySummary shape. */
export interface SecuritySummaryData {
  readonly totalBlocks: number;
  readonly totalWarnings: number;
  readonly totalOverrides: number;
  readonly totalFalsePositives: number;
  readonly fpRate: number;
  readonly byRule: readonly {
    readonly ruleId: string;
    readonly policy: string;
    readonly blocks: number;
    readonly warnings: number;
    readonly falsePositives: number;
    readonly fpRate: number;
  }[];
  readonly recentEvents: readonly SecurityAuditEvent[];
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parse `--rule-id` and `--since` flags from the raw args string. */
export function parseSecurityLogArgs(raw: string): SecurityLogArgs {
  const parts = raw.trim().split(/\s+/);
  let ruleId: string | undefined;
  let since: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--rule-id' && i + 1 < parts.length) {
      ruleId = parts[i + 1];
      i++;
    } else if (part === '--since' && i + 1 < parts.length) {
      since = parts[i + 1];
      i++;
    }
  }

  return { ruleId, since };
}

/** Filter events by ruleId and/or since timestamp. */
function filterEvents(
  events: readonly SecurityAuditEvent[],
  args: SecurityLogArgs,
): readonly SecurityAuditEvent[] {
  let result = events;

  if (args.ruleId !== undefined) {
    const needle = args.ruleId.toLowerCase();
    result = result.filter(
      (e) =>
        (e.violation?.ruleId?.toLowerCase().includes(needle) ?? false) ||
        (e.violation?.policy?.toLowerCase().includes(needle) ?? false),
    );
  }

  if (args.since !== undefined) {
    const sinceDate = new Date(args.since);
    if (Number.isFinite(sinceDate.getTime())) {
      result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceDate.getTime());
    }
  }

  return result;
}

/** Build a summary from raw events. */
export function buildSummaryFromEvents(events: readonly SecurityAuditEvent[]): SecuritySummaryData {
  let totalBlocks = 0;
  let totalWarnings = 0;
  let totalOverrides = 0;
  let totalFalsePositives = 0;

  const ruleMap = new Map<
    string,
    { policy: string; blocks: number; warnings: number; falsePositives: number }
  >();

  for (const event of events) {
    if (event.event === 'guardrail_block') totalBlocks++;
    else if (event.event === 'guardrail_warn') totalWarnings++;
    else if (event.event === 'guardrail_override') totalOverrides++;
    else if (event.event === 'false_positive') totalFalsePositives++;

    const ruleId = event.violation?.ruleId ?? event.violation?.policy ?? 'unknown';
    const policy = event.violation?.policy ?? 'unknown';

    let entry = ruleMap.get(ruleId);
    if (entry === undefined) {
      entry = { policy, blocks: 0, warnings: 0, falsePositives: 0 };
      ruleMap.set(ruleId, entry);
    }

    if (event.event === 'guardrail_block') entry.blocks++;
    else if (event.event === 'guardrail_warn') entry.warnings++;
    else if (event.event === 'false_positive') entry.falsePositives++;
  }

  const totalActions = totalBlocks + totalWarnings;
  const fpRate = totalActions > 0 ? totalFalsePositives / totalActions : 0;

  const byRule = [...ruleMap.entries()]
    .map(([ruleId, data]) => ({
      ruleId,
      policy: data.policy,
      blocks: data.blocks,
      warnings: data.warnings,
      falsePositives: data.falsePositives,
      fpRate:
        data.blocks + data.warnings > 0
          ? data.falsePositives / (data.blocks + data.warnings)
          : 0,
    }))
    .toSorted((a, b) => b.blocks - a.blocks || a.ruleId.localeCompare(b.ruleId));

  return {
    totalBlocks,
    totalWarnings,
    totalOverrides,
    totalFalsePositives,
    fpRate,
    byRule,
    recentEvents: events,
  };
}

// ---------------------------------------------------------------------------
// Line builder
// ---------------------------------------------------------------------------

function buildSecurityLines(
  summary: SecuritySummaryData,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
  warningStyle: Colorize,
): string[] {
  const lines: string[] = [];

  if (summary.recentEvents.length === 0) {
    lines.push(muted('  No security events recorded yet.'));
    return lines;
  }

  const fpPercent =
    summary.totalBlocks + summary.totalWarnings > 0
      ? (
          (summary.totalFalsePositives /
            (summary.totalBlocks + summary.totalWarnings)) *
          100
        ).toFixed(1)
      : '0.0';

  lines.push(
    `  Blocks: ${value(String(summary.totalBlocks))}  |  Warnings: ${value(String(summary.totalWarnings))}  |  Overrides: ${value(String(summary.totalOverrides))}`,
  );
  lines.push(
    `  False-positive reports: ${errorStyle(String(summary.totalFalsePositives))} (${muted(`${fpPercent}%`)})`,
  );

  if (summary.byRule.length > 0) {
    lines.push('');
    lines.push(accent('By rule:'));

    const maxLabelLen = Math.max(...summary.byRule.map((r) => r.ruleId.length));

    for (const rule of summary.byRule) {
      const barLen = Math.max(rule.blocks, 1);
      const bar = '\u2588'.repeat(Math.min(barLen, 20));
      const label = rule.ruleId.padEnd(maxLabelLen);
      const total = rule.blocks + rule.warnings;
      const actionLabel = total === 1 ? 'block' : 'blocks';

      let ruleLine = `    ${muted(label)} ${warningStyle(bar)} ${value(String(rule.blocks))} ${actionLabel} (${muted(`${rule.falsePositives} FP`)})`;
      if (rule.fpRate >= 0.5 && rule.blocks > 0) {
        ruleLine += ` ${errorStyle('\u2192 recommend: warn')}`;
      }
      lines.push(ruleLine);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// SecurityDashboardComponent
// ---------------------------------------------------------------------------

export class SecurityDashboardComponent implements Component {
  private lines: readonly string[];

  constructor(
    private readonly buildLines: () => readonly string[],
    private readonly borderToken: ColorToken = 'warning',
    private readonly title: string = ' Security Log ',
  ) {
    this.lines = buildLines();
  }

  invalidate(): void {
    this.lines = this.buildLines();
  }

  render(width: number): string[] {
    const paint = (s: string): string => currentTheme.fg(this.borderToken, s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const availableInterior = Math.max(
      MIN_INTERIOR_WIDTH,
      width - LEFT_MARGIN - 2 - 2 * SIDE_PADDING,
    );
    const longestLine = this.lines.reduce(
      (max, line) => Math.max(max, visibleWidth(line)),
      0,
    );
    const contentWidth = Math.max(
      MIN_INTERIOR_WIDTH,
      Math.min(
        availableInterior,
        longestLine,
        Math.max(longestLine, this.title.length),
      ),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;

    const trailingDashLen = Math.max(0, horzLen - this.title.length);
    const top =
      indent +
      paint('\u256D') +
      paint(this.title) +
      paint('\u2500'.repeat(trailingDashLen)) +
      paint('\u256E');
    const bottom = indent + paint('\u2570' + '\u2500'.repeat(horzLen) + '\u256F');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped =
        visibleWidth(line) > contentWidth
          ? truncateToWidth(line, contentWidth)
          : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(
        indent +
          paint('\u2502') +
          ' ' +
          clipped +
          ' '.repeat(pad) +
          ' ' +
          paint('\u2502'),
      );
    }
    out.push(bottom);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the coloured summary lines for the security dashboard.
 * Exported for testing.
 */
export function buildSecuritySummaryLines(
  events: readonly SecurityAuditEvent[],
  args: SecurityLogArgs,
): readonly string[] {
  const filtered = filterEvents(events, args);
  const summary = buildSummaryFromEvents(filtered);

  const accent = (text: string): string => currentTheme.boldFg('primary', text);
  const value = (text: string): string => currentTheme.fg('text', text);
  const muted = (text: string): string => currentTheme.fg('textDim', text);
  const errorStyle = (text: string): string => currentTheme.fg('error', text);
  const warningStyle = (text: string): string => currentTheme.fg('warning', text);

  return buildSecurityLines(
    summary,
    accent,
    value,
    muted,
    errorStyle,
    warningStyle,
  );
}
