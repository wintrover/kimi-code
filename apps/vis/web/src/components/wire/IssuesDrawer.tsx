import { useEffect } from 'react';

import type { Issue, IssueSeverity } from '../../lib/issues';

interface IssuesDrawerProps {
  issues: Issue[];
  onClose: () => void;
  onJumpTo?: (seq: number) => void;
  /** Optional predicate: "is this seq currently visible under the active
   *  filter?". When provided, jump buttons for filtered-out seqs are
   *  disabled and flagged. */
  isSeqVisible?: (seq: number) => boolean;
}

const SEV_COLOR: Record<IssueSeverity, string> = {
  error: 'var(--color-sev-error)',
  warning: 'var(--color-sev-warning)',
  info: 'var(--color-sev-info)',
};

const KIND_LABEL: Record<Issue['kind'], string> = {
  subagent_failed: 'subagent failed',
  tool_error: 'tool error',
  tool_denied: 'tool denied',
  turn_failed: 'turn failed',
  step_truncated: 'step truncated',
  wire_warning: 'wire warning',
};

export function IssuesDrawer({ issues, onClose, onJumpTo, isSeqVisible }: IssuesDrawerProps) {
  // ESC closes — standard drawer affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () =>{  window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <>
      {/* Backdrop — click outside drawer to dismiss. Subtle tint so the
          underlying Wire timeline is still readable. */}
      <button
        type="button"
        aria-label="close issues"
        onClick={onClose}
        className="absolute inset-0 z-10 bg-black/20"
      />
      {/* Drawer — slides from the right. 320px wide, full height. */}
      <aside
        className="absolute right-0 top-0 bottom-0 z-20 flex w-[360px] flex-col border-l border-border bg-surface-1 shadow-[-8px_0_32px_rgba(0,0,0,0.25)]"
        role="dialog"
        aria-label="issues"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 font-mono text-[12px] text-fg-0">
          <span>
            Issues <span className="text-fg-3">·</span>{' '}
            <span className="tabular text-fg-2">{issues.length}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[14px] text-fg-3 hover:text-fg-0"
            title="close (ESC)"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {issues.length === 0 ? (
            <div className="p-6 font-mono text-[12px] text-fg-3">no issues detected</div>
          ) : (
            <ul className="divide-y divide-border">
              {issues.map((iss, i) => (
                <IssueItem
                  key={`${iss.kind}-${iss.seq ?? 'w'}-${i}`}
                  issue={iss}
                  onJumpTo={onJumpTo}
                  onClose={onClose}
                  isSeqVisible={isSeqVisible}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function IssueItem({
  issue,
  onJumpTo,
  onClose,
  isSeqVisible,
}: {
  issue: Issue;
  onJumpTo?: (seq: number) => void;
  onClose: () => void;
  isSeqVisible?: (seq: number) => boolean;
}) {
  const color = SEV_COLOR[issue.severity];
  const seq = issue.seq;
  const hidden = seq !== null && isSeqVisible !== undefined && !isSeqVisible(seq);
  const canJump = seq !== null && onJumpTo !== undefined && !hidden;
  return (
    <li className="px-3 py-2 hover:bg-surface-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span
          className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="text-fg-1">{KIND_LABEL[issue.kind]}</span>
        {seq !== null ? (
          <>
            <span className="text-fg-3">·</span>
            <span className="tabular text-fg-3">seq {seq}</span>
          </>
        ) : null}
        {hidden ? <span className="text-fg-3">(filtered out)</span> : null}
        {seq !== null ? (
          <button
            type="button"
            disabled={!canJump}
            onClick={() => {
              if (canJump) onJumpTo?.(seq);
              onClose();
            }}
            className="ml-auto text-fg-3 hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-fg-3"
            title={hidden ? 'record is filtered out' : 'scroll to + expand'}
          >
            jump →
          </button>
        ) : null}
      </div>
      <div className="mt-1 break-words font-mono text-[12px] text-fg-0">{issue.summary}</div>
      {issue.detail !== undefined ? (
        <div className="mt-0.5 break-words font-mono text-[10.5px] text-fg-3">{issue.detail}</div>
      ) : null}
    </li>
  );
}
