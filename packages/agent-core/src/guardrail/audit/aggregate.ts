import type { SecurityAuditEvent } from './logger.js';

export interface SecurityRuleSummary {
  readonly ruleId: string;
  readonly count: number;
  readonly riskLevel: string;
  readonly lastSeen: string;
}

export interface SecuritySummary {
  readonly totalEvents: number;
  readonly blocks: number;
  readonly warns: number;
  readonly passes: number;
  readonly rules: readonly SecurityRuleSummary[];
}

/**
 * Aggregates security audit events into summary statistics.
 */
export class SecurityAggregator {
  private readonly events: SecurityAuditEvent[] = [];

  addEvent(event: SecurityAuditEvent): void {
    this.events.push(event);
  }

  getSummary(): SecuritySummary {
    let blocks = 0;
    let warns = 0;
    let passes = 0;
    const ruleCounts = new Map<string, { count: number; riskLevel: string; lastSeen: string }>();

    for (const event of this.events) {
      switch (event.event) {
        case 'guardrail_block':
          blocks++;
          break;
        case 'guardrail_warn':
          warns++;
          break;
        case 'guardrail_pass':
          passes++;
          break;
      }

      if (event.violation?.ruleId !== undefined) {
        const existing = ruleCounts.get(event.violation.ruleId);
        if (existing !== undefined) {
          ruleCounts.set(event.violation.ruleId, {
            count: existing.count + 1,
            riskLevel: event.violation.riskLevel,
            lastSeen: event.timestamp,
          });
        } else {
          ruleCounts.set(event.violation.ruleId, {
            count: 1,
            riskLevel: event.violation.riskLevel,
            lastSeen: event.timestamp,
          });
        }
      }
    }

    const rules: SecurityRuleSummary[] = [];
    for (const [ruleId, data] of ruleCounts) {
      rules.push({ ruleId, count: data.count, riskLevel: data.riskLevel, lastSeen: data.lastSeen });
    }

    return { totalEvents: this.events.length, blocks, warns, passes, rules };
  }
}
