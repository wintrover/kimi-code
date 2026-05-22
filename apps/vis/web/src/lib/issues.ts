// Aggregate every "something went wrong" signal from a wire timeline
// into a flat list consumable by the Issues drawer. Pure — no React.

import type { VisWireRecord } from '../types';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  /** Human-readable kind — shown as the row's title. */
  kind:
    | 'subagent_failed'
    | 'tool_error'
    | 'tool_denied'
    | 'turn_failed'
    | 'step_truncated'
    | 'wire_warning';
  /** Seq of the offending record. `null` for file-level warnings. */
  seq: number | null;
  /** Short summary shown on a single line. */
  summary: string;
  /** Optional second line / tooltip detail. */
  detail?: string;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Scan `records` + `warnings` and produce an ordered issue list.
 *  Sorted by severity first, then seq ascending. Warnings (no seq) go last. */
export function computeIssues(
  records: readonly VisWireRecord[],
  warnings: readonly string[],
): Issue[] {
  const out: Issue[] = [];

  for (const r of records) {
    switch (r.type) {
      case 'subagent_failed': {
        const d = (r as { data?: { error?: string; agent_id?: string } }).data ?? {};
        out.push({
          severity: 'error',
          kind: 'subagent_failed',
          seq: r.seq,
          summary: firstLine(d.error ?? '(no error message)'),
          detail: d.agent_id ? `agent ${d.agent_id}` : undefined,
        });
        break;
      }
      case 'tool_result': {
        const rec = r as { is_error?: boolean; output?: unknown; tool_call_id?: string };
        if (rec.is_error === true) {
          const text =
            typeof rec.output === 'string'
              ? rec.output
              : rec.output !== undefined
                ? (() => {
                    try {
                      return JSON.stringify(rec.output);
                    } catch {
                      return '(unserializable output)';
                    }
                  })()
                : '';
          out.push({
            severity: 'error',
            kind: 'tool_error',
            seq: r.seq,
            summary: firstLine(text) || '(no output)',
            detail: rec.tool_call_id ? `call ${rec.tool_call_id}` : undefined,
          });
        }
        break;
      }
      case 'tool_denied': {
        const d =
          (r as { data?: { tool_name?: string; reason?: string; rule_id?: string } }).data ?? {};
        out.push({
          severity: 'warning',
          kind: 'tool_denied',
          seq: r.seq,
          summary: `${d.tool_name ?? 'tool'} — ${firstLine(d.reason ?? '(no reason)')}`,
          detail: d.rule_id ? `rule ${d.rule_id}` : undefined,
        });
        break;
      }
      case 'turn_end': {
        const rec = r as {
          success?: boolean;
          reason?: string;
          turn_id?: string;
          synthetic?: boolean;
        };
        if (rec.success === false || rec.reason === 'error' || rec.reason === 'interrupted') {
          out.push({
            severity: 'warning',
            kind: 'turn_failed',
            seq: r.seq,
            summary: `turn ${rec.turn_id ?? ''} — ${rec.reason ?? 'unknown'}`,
            detail: rec.synthetic === true ? 'synthetic' : undefined,
          });
        }
        break;
      }
      case 'step_end': {
        const rec = r as { finish_reason?: string; turn_id?: string };
        if (rec.finish_reason === 'length' || rec.finish_reason === 'error') {
          out.push({
            severity: 'info',
            kind: 'step_truncated',
            seq: r.seq,
            summary: `step finished with "${rec.finish_reason}"`,
            detail: rec.turn_id ? `turn ${rec.turn_id}` : undefined,
          });
        }
        break;
      }
      case 'approval_request':
      case 'approval_response':
      case 'compaction':
      case 'content_part':
      case 'context_cleared':
      case 'context_edit':
      case 'metadata':
      case 'notification':
      case 'ownership_changed':
      case 'session_initialized':
      case 'skill_completed':
      case 'skill_invoked':
      case 'step_begin':
      case 'subagent_completed':
      case 'subagent_spawned':
      case 'system_prompt_changed':
      case 'system_reminder':
      case 'team_mail':
      case 'tool_call':
      case 'tools_changed':
      case 'turn_begin':
      case 'user_message':
        break;
      default:
        break;
    }
  }

  for (const w of warnings) {
    out.push({
      severity: 'warning',
      kind: 'wire_warning',
      seq: null,
      summary: firstLine(w),
    });
  }

  out.sort((a, b) => {
    const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (d !== 0) return d;
    const sa = a.seq ?? Number.POSITIVE_INFINITY;
    const sb = b.seq ?? Number.POSITIVE_INFINITY;
    return sa - sb;
  });

  return out;
}

/** Top-level summary tone used for the toolbar pill — "worst wins". */
export function topSeverity(issues: readonly Issue[]): IssueSeverity | null {
  if (issues.length === 0) return null;
  for (const i of issues) if (i.severity === 'error') return 'error';
  for (const i of issues) if (i.severity === 'warning') return 'warning';
  return 'info';
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  const nl = trimmed.indexOf('\n');
  const one = nl === -1 ? trimmed : trimmed.slice(0, nl);
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}
