import type { MouseEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { SessionSummary } from '../../types';
import { formatRelativeTime } from '../../util/time';
import { Pill } from '../shared/Pill';

interface SessionCardProps {
  session: SessionSummary;
  onDelete: (session: SessionSummary) => void;
  deleting: boolean;
}

export function SessionCard({ session, onDelete, deleting }: SessionCardProps) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const selected = sessionId === session.session_id;
  const dirty = session.last_exit_code === 'dirty';
  const workspaceLabel = session.workspace_dir
    ? session.workspace_dir.split('/').slice(-2).join('/')
    : '(no workspace)';
  const shortId = session.session_id.replace(/^session_/, '').slice(0, 10);
  const title = session.title ?? session.custom_title;

  function handleDeleteClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    onDelete(session);
  }

  return (
    <div
      className={[
        'group relative border-b border-border transition-colors',
        selected
          ? 'bg-surface-2'
          : 'hover:bg-surface-1',
        session.archived ? 'opacity-60' : '',
      ].join(' ')}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-cat-conversation)]" />
      ) : null}
      <Link to={`/sessions/${session.session_id}`} className="block px-3 py-2 pr-10">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
              style={{
                backgroundColor: dirty ? 'var(--color-sev-warning)' : 'var(--color-fg-3)',
              }}
              title={dirty ? 'dirty exit' : 'clean or unknown exit'}
            />
            <span className="shrink-0 font-mono text-[12px] text-fg-0">{shortId}</span>
            {session.model ? (
              <Pill tone="config" variant="soft" className="!py-0">
                {session.model}
              </Pill>
            ) : null}
            {session.archived ? (
              <Pill tone="warning" variant="soft" className="!py-0">
                archived
              </Pill>
            ) : null}
          </div>
          <span className="shrink-0 font-mono text-[10.5px] text-fg-3 tabular">
            {formatRelativeTime(session.updated_at)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[10.5px] text-fg-2">
          <span className="truncate" title={session.workspace_dir ?? ''}>
            {workspaceLabel}
          </span>
          <span className="tabular text-fg-3">
            {session.wire_record_count}ev
          </span>
          {session.subagent_count > 0 ? (
            <span className="tabular text-[var(--color-cat-subagent)]">
              {session.subagent_count}sub
            </span>
          ) : null}
          {session.archive_count > 0 ? (
            <span className="tabular text-[var(--color-compaction)]">
              {session.archive_count}arch
            </span>
          ) : null}
          {session.health !== 'ok' ? (
            <span className="tabular text-[var(--color-sev-error)]">
              {session.health}
            </span>
          ) : null}
        </div>
        {title ? (
          <div className="mt-1 truncate font-mono text-[11px] text-fg-1" title={title}>
            {title}
          </div>
        ) : null}
        {session.last_prompt ? (
          <div className="mt-1 truncate font-mono text-[10.5px] text-fg-3" title={session.last_prompt}>
            prompt · {session.last_prompt}
          </div>
        ) : null}
      </Link>
      <button
        type="button"
        onClick={handleDeleteClick}
        disabled={deleting}
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center border border-transparent text-fg-3 transition-colors hover:border-[var(--color-sev-error)] hover:text-[var(--color-sev-error)] disabled:cursor-not-allowed disabled:opacity-40"
        title={`Delete session ${session.session_id}`}
        aria-label={`Delete session ${session.session_id}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 3 H10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
      <path d="M4 3 V2 H8 V3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M3 4 H9 L8.5 10 H3.5 Z" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}
