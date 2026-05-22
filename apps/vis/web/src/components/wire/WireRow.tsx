import { memo } from 'react';

import { recordMatchesFocus, useFocus } from '../../lib/focus-context';
import type { VisWireRecord } from '../../types';
import { TYPE_CATEGORY, TYPE_CTX_EFFECT } from '../../types';
import { formatWallClock } from '../../util/time';
import { TypeBadge } from './TypeBadge';
import { renderHeadline } from './WireHeadline';
import { WireRowDetail } from './WireRowDetail';

const CAT_COLOR_VAR: Record<string, string> = {
  conversation: '--color-cat-conversation',
  config: '--color-cat-config',
  lifecycle: '--color-cat-lifecycle',
  subagent: '--color-cat-subagent',
  approval: '--color-cat-approval',
  ephemeral: '--color-cat-ephemeral',
  meta: '--color-cat-meta',
  tools: '--color-cat-tools',
};

interface WireRowProps {
  record: VisWireRecord;
  expanded: boolean;
  onToggle: () => void;
  /** For tool_call / tool_result — the counterpart record (if any). */
  paired?: VisWireRecord | undefined;
  /** null when `paired` is undefined; true/false when the counterpart exists. */
  pairedInFiltered?: boolean | null;
  /** Scroll to a seq and expand it — wired by the Wire tab via the virtualizer. */
  onJumpTo?: (seq: number) => void;
}

export const WireRow = memo(function WireRow({
  record,
  expanded,
  onToggle,
  paired,
  pairedInFiltered,
  onJumpTo,
}: WireRowProps) {
  const cat = TYPE_CATEGORY[record.type];
  const accentVar = CAT_COLOR_VAR[cat] ?? '--color-fg-3';
  const ctx = TYPE_CTX_EFFECT[record.type];
  const h = renderHeadline(record);
  const { focus } = useFocus();
  const related = focus === null ? true : recordMatchesFocus(record, focus);
  const timeTitle = formatTimeTitle(record.time);

  return (
    <div
      className={[
        'flex items-stretch border-b border-border transition-opacity',
        expanded ? 'bg-surface-1' : 'bg-surface-0 hover:bg-surface-1',
        focus !== null && !related ? 'opacity-30' : '',
        focus !== null && related ? 'ring-1 ring-inset ring-[var(--color-sev-info)]/40' : '',
      ].join(' ')}
    >
      <div className="accent-bar" style={{ backgroundColor: `var(${accentVar})` }} />
      <div className="min-w-0 flex-1">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-3 px-2 py-[5px] text-left min-h-[28px]"
        >
          <span className="font-mono text-[11px] text-fg-3 tabular w-[52px] shrink-0 text-right">
            {record.seq}
          </span>
          <span
            className="font-mono text-[11px] text-fg-3 tabular w-[68px] shrink-0"
            title={timeTitle}
          >
            {formatWallClock(record.time)}
          </span>
          <span className="shrink-0">
            <TypeBadge type={record.type} />
          </span>
          <span className="flex-1 min-w-0 flex items-center gap-2">{h.main}</span>
          <span className="flex items-center gap-2 shrink-0">
            {h.right}
            <CtxMarker effect={ctx} />
            <Chevron open={expanded} />
          </span>
        </button>
        {expanded ? (
          <div className="border-t border-border bg-surface-1 px-2 pb-2 pt-1">
            <WireRowDetail
              record={record}
              paired={paired}
              pairedInFiltered={pairedInFiltered ?? null}
              onJumpTo={onJumpTo}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});

function formatTimeTitle(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'missing time';
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return 'invalid time';
  return date.toISOString();
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`text-fg-3 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M3 2 L7 5 L3 8" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function CtxMarker({ effect }: { effect: boolean | 'conditional' }) {
  const title =
    effect === true
      ? 'affects LLM context'
      : effect === 'conditional'
        ? 'conditionally affects LLM context'
        : 'telemetry only — no context effect';
  const symbol = effect === true ? '●' : effect === 'conditional' ? '◑' : '○';
  const color = effect ? 'text-[var(--color-cat-conversation)]' : 'text-fg-3';
  return (
    <span className={`font-mono text-[11px] ${color}`} title={title}>
      {symbol}
    </span>
  );
}
