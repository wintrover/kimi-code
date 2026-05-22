import type { ReactNode } from 'react';

import { useFocus, type FocusKind } from '../../lib/focus-context';
import type { VisWireRecord } from '../../types';
import { Pill } from '../shared/Pill';
import { formatBytes } from '../shared/SizePreview';

export interface HeadlineRender {
  /** Main headline content — rendered in the flex-grow slot of the row */
  main: ReactNode;
  /** Right-side badges / pair refs */
  right?: ReactNode;
}

function truncate(s: unknown, n: number): string {
  let str: string;
  if (s === null || s === undefined) str = '';
  else if (typeof s === 'string') str = s;
  else if (typeof s === 'number' || typeof s === 'boolean' || typeof s === 'bigint')
    str = String(s);
  else {
    try {
      str = JSON.stringify(s);
    } catch {
      return '[unserializable]';
    }
  }
  if (str.length <= n) return str;
  return str.slice(0, n) + '…';
}

/** Narrow an `unknown` to a string — used for wire-record field values that
 *  are typed `unknown` but practically always string/null in the field we read. */
function asStr(v: unknown, fallback = '—'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function byteLength(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (v === undefined || v === null) return 0;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

/** Render the collapsed-headline for a wire record. */
export function renderHeadline(r: VisWireRecord): HeadlineRender {
  switch (r.type) {
    // ─── FILE HEADER / STARTUP BASELINE ───
    case 'metadata': {
      const pv = r['protocol_version'] as string | undefined;
      const producer = r['producer'] as
        | { kind?: string; name?: string; version?: string }
        | undefined;
      const kimiVer = r['kimi_version'] as string | undefined;
      const fileName = r['file_name'] as string | undefined;
      const prodStr = producer ? `${producer.name ?? '?'}@${producer.version ?? '?'}` : 'legacy';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>protocol v{pv ?? '?'}</Mono>
            <Dim>·</Dim>
            <Mono className="truncate">{prodStr}</Mono>
            {kimiVer ? <Dim className="truncate">· kimi {kimiVer}</Dim> : null}
          </span>
        ),
        right: fileName ? <Dim>{fileName}</Dim> : null,
      };
    }

    case 'session_initialized': {
      const agentType = r['agent_type'] as string | undefined;
      const model = r['model'] as string | undefined;
      const sysPrompt = r['system_prompt'] as string | undefined;
      const tools = (r['active_tools'] as string[] | undefined) ?? [];
      const permMode = r['permission_mode'] as string | undefined;
      const planMode = r['plan_mode'] as boolean | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>{model ?? '—'}</Mono>
            <Dim>·</Dim>
            <Mono>{tools.length} tools</Mono>
            <Dim>·</Dim>
            <Mono>{permMode ?? '—'}</Mono>
            {planMode ? (
              <Pill tone="config" variant="soft">
                plan
              </Pill>
            ) : null}
            <Dim>·</Dim>
            <span className="truncate text-fg-1">
              sp: {truncate(sysPrompt ?? '', 70) || <Dim>(empty)</Dim>}
            </span>
          </span>
        ),
        right: (
          <Pill
            tone={
              agentType === 'sub'
                ? 'subagent'
                : agentType === 'independent'
                  ? 'lifecycle'
                  : 'config'
            }
            variant="outline"
          >
            {agentType ?? 'main'}
          </Pill>
        ),
      };
    }

    // ─── CONVERSATION ───
    case 'turn_begin': {
      const agentType = r['agent_type'] as string | undefined;
      const kind = r['input_kind'] as string | undefined;
      const input = r['user_input'] as string | undefined;
      const turnId = r['turn_id'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>turn #</Mono>
            <IdBadge kind="turn_id" value={turnId} />
            <Dim>kind={kind ?? '—'}</Dim>
            {input ? <span className="truncate text-fg-1">· {truncate(input, 80)}</span> : null}
          </span>
        ),
        right: (
          <Pill
            tone={
              agentType === 'sub' ? 'subagent' : agentType === 'independent' ? 'lifecycle' : 'turn'
            }
            variant="outline"
          >
            {agentType ?? 'main'}
          </Pill>
        ),
      };
    }

    case 'turn_end': {
      const reason = r['reason'] as string | undefined;
      const success = r['success'] as boolean | undefined;
      const usage = r['usage'] as Record<string, unknown> | undefined;
      const synthetic = r['synthetic'] as boolean | undefined;
      const outputTokens = usage?.['output_tokens'] as number | undefined;
      const cost = usage?.['cost_usd'] as number | undefined;
      const turnId = r['turn_id'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>turn #</Mono>
            <IdBadge kind="turn_id" value={turnId} />
            <span
              className={
                success ? 'text-[var(--color-sev-success)]' : 'text-[var(--color-sev-error)]'
              }
            >
              {reason}
            </span>
          </span>
        ),
        right: (
          <span className="flex items-center gap-2">
            {synthetic ? (
              <Pill tone="warning" variant="outline">
                synthetic
              </Pill>
            ) : null}
            {outputTokens !== undefined ? <Dim>{outputTokens}tok</Dim> : null}
            {cost !== undefined ? <Dim>${cost.toFixed(4)}</Dim> : null}
          </span>
        ),
      };
    }

    case 'user_message': {
      const content = r['content'];
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as { type: string; text?: string }[])
                .map((p) => (p.type === 'text' ? (p.text ?? '') : `<${p.type}>`))
                .join('')
            : '';
      const parts = Array.isArray(content) ? content.length : 1;
      return {
        main: (
          <span className="truncate text-fg-0">{truncate(text, 120) || <Dim>(empty)</Dim>}</span>
        ),
        right: parts > 1 ? <Dim>{parts} parts</Dim> : undefined,
      };
    }

    // An "assistant message" is now a sequence of atoms: step_begin →
    // (content_part | tool_call)* → step_end. Render each atom distinctly so
    // the wire timeline stays a 1:1 view of the underlying records.
    case 'step_begin': {
      const uuid = r['uuid'] as string | undefined;
      const step = r['step'] as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>step #{step ?? '—'}</Mono>
            <IdBadge kind="step_uuid" value={uuid} shortenTo={10} />
          </span>
        ),
      };
    }

    case 'step_end': {
      const step = r['step'] as number | undefined;
      const finish = r['finish_reason'] as string | undefined;
      const usage = r['usage'] as Record<string, unknown> | undefined;
      const outputTokens = usage?.['output_tokens'] as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>step #{step ?? '—'}</Mono>
            {finish ? <Dim>{finish}</Dim> : null}
          </span>
        ),
        right: outputTokens !== undefined ? <Dim>{outputTokens}tok</Dim> : undefined,
      };
    }

    case 'content_part': {
      const part = r['part'] as
        | { kind: 'text' | 'think'; text?: string; think?: string }
        | undefined;
      if (part === undefined) {
        return { main: <Dim>(empty part)</Dim> };
      }
      const body = part.kind === 'text' ? (part.text ?? '') : (part.think ?? '');
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={part.kind === 'think' ? 'config' : 'assistant'} variant="soft">
              {part.kind}
            </Pill>
            <span className="truncate text-fg-0">{truncate(body, 100) || <Dim>(empty)</Dim>}</span>
          </span>
        ),
        right: <Dim>{formatBytes(body.length)}</Dim>,
      };
    }

    case 'tool_call': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const name = d['tool_name'] as string | undefined;
      const args = d['args'];
      const preview =
        typeof args === 'string' ? args : args !== undefined ? JSON.stringify(args) : '';
      const activity = d['description'] as string | undefined;
      const callId = d['tool_call_id'] as string | undefined;
      const step = r['step'] as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono className="text-[var(--color-cat-tools)]">{name ?? '—'}</Mono>
            {activity ? (
              <span className="truncate text-fg-1">— {truncate(activity, 60)}</span>
            ) : (
              <span className="truncate font-mono text-[12px] text-fg-1">
                ({truncate(preview, 60)})
              </span>
            )}
          </span>
        ),
        right: (
          <span className="flex items-center gap-2">
            {callId ? (
              <span className="flex items-center gap-1">
                <Dim>call=</Dim>
                <IdBadge kind="tool_call_id" value={callId} shortenTo={10} />
              </span>
            ) : null}
            {step !== undefined ? <Dim>step={step}</Dim> : null}
          </span>
        ),
      };
    }

    case 'tool_result': {
      const output = r['output'];
      const isError = r['is_error'] as boolean | undefined;
      const synthetic = r['synthetic'] as boolean | undefined;
      const callId = r['tool_call_id'] as string | undefined;
      const outputBytes = byteLength(output);
      const isPersisted =
        typeof output === 'string' && output.trimStart().startsWith('<persisted-output');
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>call=</Mono>
            <IdBadge kind="tool_call_id" value={callId} shortenTo={10} />
            <Dim>
              {typeof output === 'string'
                ? 'string'
                : Array.isArray(output)
                  ? 'array'
                  : typeof output}
            </Dim>
            <Dim>{formatBytes(outputBytes)}</Dim>
            {isPersisted ? (
              <Pill tone="compaction" variant="outline">
                persisted
              </Pill>
            ) : null}
          </span>
        ),
        right: (
          <span className="flex items-center gap-2">
            {synthetic ? (
              <Pill tone="warning" variant="outline">
                synthetic
              </Pill>
            ) : null}
            {isError ? (
              <Pill tone="error" variant="solid">
                error
              </Pill>
            ) : null}
          </span>
        ),
      };
    }

    case 'compaction': {
      const summary = r['summary'] as string | undefined;
      const pre = r['pre_compact_tokens'] as number | undefined;
      const post = r['post_compact_tokens'] as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="compaction" variant="solid">
              summary
            </Pill>
            {summary ? <span className="truncate text-fg-1">{truncate(summary, 80)}</span> : null}
            {pre !== undefined && post !== undefined ? (
              <Dim>
                · {pre}→{post} tok
              </Dim>
            ) : null}
          </span>
        ),
      };
    }

    // ─── CONFIG ───
    case 'system_prompt_changed': {
      const prompt = r['new_prompt'] as string | undefined;
      return {
        main: (
          <span className="truncate text-fg-0">
            {truncate(prompt ?? '', 60) || <Dim>(empty)</Dim>}
          </span>
        ),
        right: <Dim>{formatBytes(byteLength(prompt))}</Dim>,
      };
    }

    case 'tools_changed': {
      const op = r['operation'] as string | undefined;
      const tools = (r['tools'] as string[] | undefined) ?? [];
      const head = tools.slice(0, 3).join(', ');
      const rest = tools.length > 3 ? ` +${tools.length - 3} more` : '';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="config" variant="soft">
              {op ?? '—'}
            </Pill>
            <Mono className="truncate">
              {head}
              {rest}
            </Mono>
          </span>
        ),
      };
    }

    // ─── EPHEMERAL ───
    case 'system_reminder': {
      const content = r['content'] as string | undefined;
      const consumed = r['consumed_at_turn'] as number | undefined;
      return {
        main: <span className="truncate text-fg-0">{truncate(content ?? '', 80)}</span>,
        right:
          consumed !== undefined ? (
            <Dim>consumed@turn{consumed}</Dim>
          ) : (
            <Pill tone="ephemeral" variant="outline">
              pending
            </Pill>
          ),
      };
    }

    // ─── META ───
    case 'notification': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const severity = d['severity'] as string | undefined;
      const title = d['title'] as string | undefined;
      const category = d['category'] as string | undefined;
      const targets = (d['targets'] as string[] | undefined) ?? [];
      const sevTone =
        severity === 'error'
          ? 'error'
          : severity === 'warning'
            ? 'warning'
            : severity === 'success'
              ? 'success'
              : 'info';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={sevTone} variant="soft">
              {severity ?? '—'}
            </Pill>
            <span className="truncate text-fg-0">{truncate(title ?? '', 80)}</span>
            {category ? <Dim>({category})</Dim> : null}
          </span>
        ),
        right:
          targets.length > 0 ? (
            <span className="flex items-center gap-1">
              {targets.map((t) => (
                <Pill key={t} tone="meta" variant="outline">
                  {t}
                </Pill>
              ))}
            </span>
          ) : undefined,
      };
    }

    case 'team_mail': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono>
              {asStr(d['from_agent'])} → {asStr(d['to_agent'])}
            </Mono>
            <span className="truncate text-fg-1">{truncate(d['content'], 60)}</span>
          </span>
        ),
      };
    }

    // ─── TOOLS ───
    // Note: the `tool_call` case is handled in the conversation section
    // above (alongside step_begin / step_end / content_part).

    case 'tool_denied': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const name = d['tool_name'] as string | undefined;
      const reason = d['reason'] as string | undefined;
      const rule = d['rule_id'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono className="text-[var(--color-sev-error)]">{name ?? '—'}</Mono>
            <Dim className="truncate">— {truncate(reason ?? '', 80)}</Dim>
          </span>
        ),
        right: rule ? (
          <Pill tone="error" variant="outline">
            rule={rule}
          </Pill>
        ) : undefined,
      };
    }

    case 'skill_invoked': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const name = d['skill_name'] as string | undefined;
      const mode = d['execution_mode'] as string | undefined;
      const trigger = d['invocation_trigger'] as string | undefined;
      const depth = d['query_depth'] as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono className="text-[var(--color-cat-tools)]">{name ?? '—'}</Mono>
            <Pill tone="tools" variant="outline">
              {mode ?? 'inline'}
            </Pill>
            {trigger ? <Dim>{trigger}</Dim> : null}
          </span>
        ),
        right: depth !== undefined && depth > 0 ? <Dim>depth={depth}</Dim> : undefined,
      };
    }

    case 'skill_completed': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const name = d['skill_name'] as string | undefined;
      const success = d['success'] as boolean | undefined;
      const error = d['error'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Mono className="text-[var(--color-cat-tools)]">{name ?? '—'}</Mono>
            <span
              className={
                success ? 'text-[var(--color-sev-success)]' : 'text-[var(--color-sev-error)]'
              }
            >
              {success ? 'ok' : error ? truncate(error, 60) : 'failed'}
            </span>
          </span>
        ),
      };
    }

    // ─── APPROVAL ───
    case 'approval_request': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const tool = d['tool_name'] as string | undefined;
      const action = d['action'] as string | undefined;
      const source = d['source'] as Record<string, unknown> | undefined;
      const display = d['display'] as Record<string, unknown> | undefined;
      return {
        main: (
          <span className="flex items-center gap-2">
            <Mono>{tool ?? '—'}</Mono>
            <Dim>· {action ?? '—'}</Dim>
            {source ? (
              <Pill tone="approval" variant="outline">
                {asStr(source['kind'], '?')}
              </Pill>
            ) : null}
          </span>
        ),
        right: display ? <Dim>display={asStr(display['kind'], '?')}</Dim> : undefined,
      };
    }

    case 'approval_response': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const response = d['response'] as string | undefined;
      const feedback = d['feedback'] as string | undefined;
      const selectedLabel = d['selected_label'] as string | undefined;
      const synthetic = d['synthetic'] as boolean | undefined;
      const tone =
        response === 'approved' ? 'success' : response === 'rejected' ? 'error' : 'neutral';
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone={tone} variant="soft">
              {response ?? '—'}
            </Pill>
            {selectedLabel ? <Dim>· {selectedLabel}</Dim> : null}
            {feedback ? <Dim className="truncate">· {truncate(feedback, 40)}</Dim> : null}
          </span>
        ),
        right: synthetic ? (
          <Pill tone="warning" variant="outline">
            synthetic
          </Pill>
        ) : undefined,
      };
    }

    // ─── SUBAGENT ───
    case 'subagent_spawned': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const id = d['agent_id'] as string | undefined;
      const name = d['agent_name'] as string | undefined;
      const bg = d['run_in_background'] as boolean | undefined;
      const parent = d['parent_agent_id'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <Pill tone="subagent" variant="soft">
              {name ?? 'subagent'}
            </Pill>
            <IdBadge kind="agent_id" value={id} shortenTo={10} />
          </span>
        ),
        right: (
          <span className="flex items-center gap-2">
            {bg ? (
              <Pill tone="subagent" variant="outline">
                bg
              </Pill>
            ) : null}
            {parent ? (
              <span className="flex items-center gap-1">
                <Dim>parent=</Dim>
                <IdBadge kind="agent_id" value={parent} shortenTo={8} />
              </span>
            ) : null}
          </span>
        ),
      };
    }

    case 'subagent_completed': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const id = d['agent_id'] as string | undefined;
      const summary = d['result_summary'] as string | undefined;
      const usage = d['usage'] as Record<string, unknown> | undefined;
      const out = (usage?.['output'] ?? usage?.['output_tokens']) as number | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <IdBadge kind="agent_id" value={id} shortenTo={10} />
            <span className="truncate text-fg-1">{truncate(summary ?? '', 80)}</span>
          </span>
        ),
        right: out !== undefined ? <Dim>{out}tok</Dim> : undefined,
      };
    }

    case 'subagent_failed': {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const id = d['agent_id'] as string | undefined;
      const error = d['error'] as string | undefined;
      return {
        main: (
          <span className="flex items-center gap-2 min-w-0">
            <IdBadge kind="agent_id" value={id} shortenTo={10} />
            <span className="truncate text-[var(--color-sev-error)]">
              {truncate(error ?? '', 80)}
            </span>
          </span>
        ),
      };
    }

    // ─── LIFECYCLE ───
    case 'ownership_changed': {
      const oldO = r['old_owner'] as string | null | undefined;
      const newO = r['new_owner'] as string | undefined;
      return {
        main: (
          <Mono>
            {oldO ?? '(none)'} → {newO ?? '—'}
          </Mono>
        ),
      };
    }

    case 'context_cleared': {
      return { main: <Dim>context history cleared</Dim> };
    }

    case 'context_edit': {
      const op = r['operation'] as string | undefined;
      const target = r['target_seq'] as number | undefined;
      const toTurn = r['to_turn'] as number | undefined;
      const cascade = r['cascade'] as boolean | undefined;
      const ref =
        target !== undefined
          ? `target=${target}`
          : toTurn !== undefined
            ? `to_turn=${toTurn}`
            : '—';
      return {
        main: (
          <span className="flex items-center gap-2">
            <Pill tone="lifecycle" variant="soft">
              {op ?? '—'}
            </Pill>
            <Mono>{ref}</Mono>
          </span>
        ),
        right: cascade ? (
          <Pill tone="warning" variant="outline">
            cascade
          </Pill>
        ) : undefined,
      };
    }

    default: {
      const t = (r as Record<string, unknown>)['type'];
      return { main: <Dim>unknown type: {String(t)}</Dim> };
    }
  }
}

// ─── tiny presentational helpers ───
function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] text-fg-0 ${className}`}>{children}</span>;
}

function Dim({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] text-fg-3 ${className}`}>{children}</span>;
}

/** A click-to-focus id badge. Clicking toggles a global focus that dims
 *  non-related rows. Re-clicking the same id (or pressing ESC) clears. */
function IdBadge({
  kind,
  value,
  shortenTo = 8,
}: {
  kind: FocusKind;
  value: string | undefined;
  shortenTo?: number;
}) {
  const { focus, toggle } = useFocus();
  if (!value) return <Mono>—</Mono>;
  const isFocused = focus?.kind === kind && focus.value === value;
  const display = value.length > shortenTo ? value.slice(0, shortenTo) : value;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle({ kind, value });
      }}
      title={`${kind}=${value} · click to focus related`}
      className={[
        'font-mono text-[12px] underline decoration-dotted underline-offset-2',
        isFocused
          ? 'text-[var(--color-sev-info)] decoration-[var(--color-sev-info)]'
          : 'text-fg-1 decoration-fg-3 hover:text-fg-0 hover:decoration-fg-1',
      ].join(' ')}
    >
      {display}
    </button>
  );
}
