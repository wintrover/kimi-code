import { useState } from 'react';

import type { AnnotatedMessage, ProjectedStateSummary } from '../../types';
import { Pill } from '../shared/Pill';
import { formatBytes } from '../shared/SizePreview';
import { EphemeralBubble } from './EphemeralBubble';
import { MessageBubble } from './MessageBubble';

interface ContextTabProps {
  sessionId: string;
  messages: AnnotatedMessage[];
  projectedState: ProjectedStateSummary;
}

export function ContextTab({ sessionId, messages, projectedState }: ContextTabProps) {
  const [hideOutOfContext, setHideOutOfContext] = useState(false);

  const visible = hideOutOfContext ? messages.filter((m) => !m.out_of_context) : messages;

  const stats = countKinds(messages);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header strip */}
      <div className="flex shrink-0 items-center gap-3 bg-surface-1 px-3 py-2 font-mono text-[11px] text-fg-2">
        <span className="tabular text-fg-0">{messages.length}</span>
        <span>messages</span>
        <span className="text-fg-3">·</span>
        <span>model</span>
        <span className="text-fg-0">{projectedState.model ?? 'unknown'}</span>
        <span className="text-fg-3">·</span>
        <TokenDots breakdown={projectedState} />
        <span className="ml-auto flex items-center gap-3">
          <LegendDot color="var(--color-user)" label="user" count={stats.user} />
          <LegendDot color="var(--color-assistant)" label="asst" count={stats.assistant} />
          <LegendDot color="var(--color-tool)" label="tool" count={stats.tool} />
          <LegendDot color="var(--color-cat-ephemeral)" label="reminder" count={stats.reminder} />
          <LegendDot color="var(--color-cat-meta)" label="notif" count={stats.notif} />
          <label className="flex items-center gap-1 text-fg-2 hover:text-fg-1">
            <input
              type="checkbox"
              checked={hideOutOfContext}
              onChange={(e) =>{  setHideOutOfContext(e.target.checked); }}
              className="accent-[var(--color-cat-conversation)]"
            />
            hide out-of-context
          </label>
        </span>
      </div>
      {/* Token stacked bar — 2px hairline under the header. Replaces the
       *  border-b so the bar itself is the separator. */}
      <TokenBar breakdown={projectedState} />

      {/* Message stream */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 px-3 py-4">
          <SystemPromptBubble text={projectedState.system_prompt} />
          {visible.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[12px] text-fg-3">
              no messages — session has only lifecycle/config records so far.
            </div>
          ) : (
            visible.map((m) => {
              if (m.is_ephemeral) {
                return <EphemeralBubble key={m.seq} message={m} />;
              }
              return <MessageBubble key={m.seq} message={m} sessionId={sessionId} />;
            })
          )}
        </div>
      </div>
    </div>
  );
}

function SystemPromptBubble({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const hasText = text !== null && text.length > 0;

  if (!hasText) {
    return (
      <article
        className="relative flex max-w-full min-w-0 flex-col border-l-[3px] bg-surface-1 px-3 py-2"
        style={{ borderLeftColor: 'var(--color-cat-config)' }}
      >
        <header className="flex items-center gap-2">
          <Pill tone="config" variant="solid">
            system
          </Pill>
          <span className="font-mono text-[12px] text-fg-3">(no system prompt)</span>
        </header>
      </article>
    );
  }

  return (
    <article
      className="relative flex max-w-full min-w-0 flex-col border-l-[3px] bg-surface-1"
      style={{ borderLeftColor: 'var(--color-cat-config)' }}
    >
      <button
        type="button"
        onClick={() =>{  setOpen((v) => !v); }}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2"
      >
        <span className="flex items-center gap-2">
          <Pill tone="config" variant="solid">
            system
          </Pill>
          <span className="font-mono text-[10px] text-fg-3 tabular">
            {formatBytes(text.length)} · {text.length.toLocaleString()} chars
          </span>
        </span>
        <span className="font-mono text-[11px] text-fg-1">
          {open ? '▾ collapse' : '▸ show full'}
        </span>
      </button>
      <div className="relative px-3 pb-2">
        <pre
          className={[
            'whitespace-pre-wrap break-words font-mono text-[12.5px] text-fg-0',
            open ? '' : 'max-h-[9em] overflow-hidden',
          ].join(' ')}
        >
          {text}
        </pre>
        {!open ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14"
            style={{
              background: 'linear-gradient(to bottom, transparent 0%, var(--color-surface-1) 85%)',
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

function LegendDot({ color, label, count }: { color: string; label: string; count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1 text-fg-3">
      <span
        className="inline-block h-[6px] w-[6px] rounded-full"
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
      <span className="tabular text-fg-2">{count}</span>
    </span>
  );
}

// ─── token breakdown (input / output / cache_read / cache_write) ───
// Colors are chosen from the existing semantic palette so the bar reads
// coherently with the rest of the app:
//   cache_read   = success   (saved / cached — the "good" share)
//   input        = info      (billed input)
//   output       = assistant (what the model produced)
//   cache_write  = warning   (billed once, amortised next call)

const TOK_COLORS = {
  cache_read: 'var(--color-sev-success)',
  input: 'var(--color-sev-info)',
  output: 'var(--color-assistant)',
  cache_write: 'var(--color-sev-warning)',
} as const;

interface TokenBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  return (n / 1_000_000).toFixed(1) + 'M';
}

function TokenDots({ breakdown }: { breakdown: TokenBreakdown }) {
  const { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } = breakdown;
  const billedIn = input_tokens + cache_read_tokens;
  const hitPct = billedIn > 0 ? Math.round((cache_read_tokens / billedIn) * 100) : 0;
  const hasAny =
    input_tokens > 0 || output_tokens > 0 || cache_read_tokens > 0 || cache_write_tokens > 0;
  if (!hasAny) {
    return <span className="text-fg-3">(no tokens yet)</span>;
  }
  return (
    <span className="flex items-center gap-2">
      <TokenDot color={TOK_COLORS.input} label="in" value={input_tokens} />
      <TokenDot color={TOK_COLORS.output} label="out" value={output_tokens} />
      <TokenDot color={TOK_COLORS.cache_read} label="cache" value={cache_read_tokens} />
      {cache_write_tokens > 0 ? (
        <TokenDot color={TOK_COLORS.cache_write} label="cw" value={cache_write_tokens} />
      ) : null}
      {cache_read_tokens > 0 ? <span className="text-fg-3 tabular">({hitPct}% hit)</span> : null}
    </span>
  );
}

function TokenDot({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1" title={`${label}: ${value.toLocaleString()}`}>
      <span
        className="inline-block h-[6px] w-[6px] rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="tabular text-fg-0">{formatTokens(value)}</span>
      <span className="text-fg-3">{label}</span>
    </span>
  );
}

/** 2px stacked bar that visually shows the 4-way token composition.
 *  Proportions use (input + output + cache_read + cache_write) as the
 *  total so cache_read's share is honest (it's not in the "billed"
 *  tokenCount but it's real work done on the request). */
function TokenBar({ breakdown }: { breakdown: TokenBreakdown }) {
  const { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } = breakdown;
  const total = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens;
  if (total === 0) {
    return <div className="h-[2px] shrink-0 bg-border" />;
  }
  const seg = (n: number) => (n / total) * 100;
  return (
    <div
      className="flex h-[2px] w-full shrink-0"
      title={`cache_read ${cache_read_tokens.toLocaleString()} · input ${input_tokens.toLocaleString()} · output ${output_tokens.toLocaleString()} · cache_write ${cache_write_tokens.toLocaleString()}`}
    >
      {cache_read_tokens > 0 ? (
        <div
          style={{ width: `${seg(cache_read_tokens)}%`, backgroundColor: TOK_COLORS.cache_read }}
        />
      ) : null}
      {input_tokens > 0 ? (
        <div style={{ width: `${seg(input_tokens)}%`, backgroundColor: TOK_COLORS.input }} />
      ) : null}
      {output_tokens > 0 ? (
        <div style={{ width: `${seg(output_tokens)}%`, backgroundColor: TOK_COLORS.output }} />
      ) : null}
      {cache_write_tokens > 0 ? (
        <div
          style={{ width: `${seg(cache_write_tokens)}%`, backgroundColor: TOK_COLORS.cache_write }}
        />
      ) : null}
    </div>
  );
}

function countKinds(messages: AnnotatedMessage[]) {
  let user = 0,
    assistant = 0,
    tool = 0,
    reminder = 0,
    notif = 0;
  for (const m of messages) {
    switch (m.origin.kind) {
      case 'user':
        user++;
        break;
      case 'assistant':
        assistant++;
        break;
      case 'tool':
        tool++;
        break;
      case 'system_reminder':
        reminder++;
        break;
      case 'notification':
        notif++;
        break;
    }
  }
  return { user, assistant, tool, reminder, notif };
}
