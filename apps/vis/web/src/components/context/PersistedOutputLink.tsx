import { useState } from 'react';
import { useToolResult } from '../../hooks/useContext';
import { formatBytes } from '../shared/SizePreview';

interface PersistedOutputLinkProps {
  sessionId: string;
  toolCallId: string;
  path: string;
}

export function PersistedOutputLink({
  sessionId,
  toolCallId,
  path,
}: PersistedOutputLinkProps) {
  const [load, setLoad] = useState(false);
  const { data, isLoading, error } = useToolResult(sessionId, toolCallId, load);
  const basename = path.split('/').pop() ?? path;

  return (
    <div className="my-1 border border-border bg-surface-0">
      <button
        onClick={() =>{  setLoad((v) => !v); }}
        className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-[11px] text-fg-2 hover:bg-surface-2 hover:text-fg-1"
      >
        <span className="text-fg-3">{load ? '▾' : '▸'}</span>
        <span className="pill" style={{
          backgroundColor: 'color-mix(in oklab, var(--color-compaction) 18%, transparent)',
          color: 'var(--color-compaction)',
        }}>
          persisted
        </span>
        <span className="truncate">{basename}</span>
        {data ? <span className="ml-auto text-fg-3 tabular">{formatBytes(data.size_bytes)}</span> : null}
      </button>
      {load ? (
        <div className="border-t border-border">
          {isLoading ? (
            <div className="px-2 py-1 font-mono text-[11px] text-fg-3">loading…</div>
          ) : error ? (
            <div className="px-2 py-1 font-mono text-[11px] text-[var(--color-sev-error)]">
              {(error).message}
            </div>
          ) : data ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[12px] text-fg-1">
              {data.content}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
