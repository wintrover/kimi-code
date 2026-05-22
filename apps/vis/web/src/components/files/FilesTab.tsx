import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useToolResult } from '../../hooks/useContext';
import { useArchive } from '../../hooks/useWire';
import type { SessionDetail } from '../../types';
import { Drawer } from '../shared/Drawer';
import { Pill } from '../shared/Pill';
import { formatBytes } from '../shared/SizePreview';
import { WireTab } from '../wire/WireTab';

interface FilesTabProps {
  sessionId: string;
  detail: SessionDetail;
}

export function FilesTab({ sessionId, detail }: FilesTabProps) {
  const [openArchive, setOpenArchive] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {/* Archives */}
      <section>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          wire archives · {detail.archive_files.length}
        </h2>
        {detail.archive_files.length === 0 ? (
          <p className="mt-2 font-mono text-[12px] text-fg-3">no compaction archives</p>
        ) : (
          <ul className="mt-2 border border-border bg-surface-0">
            {detail.archive_files.map((f) => (
              <li
                key={f}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Pill tone="compaction" variant="soft">
                  archive
                </Pill>
                <span className="font-mono text-[12px] text-fg-0">{f}</span>
                <button
                  onClick={() =>{  setOpenArchive(f); }}
                  className="ml-auto border border-border px-2 py-0.5 font-mono text-[11px] text-fg-2 hover:border-border-strong hover:text-fg-0"
                >
                  view records
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* External tool results */}
      <section className="mt-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          external tool results · {detail.tool_result_ids.length}
        </h2>
        {detail.tool_result_ids.length === 0 ? (
          <p className="mt-2 font-mono text-[12px] text-fg-3">none</p>
        ) : (
          <ul className="mt-2 border border-border bg-surface-0">
            {detail.tool_result_ids.map((id) => (
              <li
                key={id}
                className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Pill tone="tool" variant="soft">
                  file
                </Pill>
                <span className="truncate font-mono text-[12px] text-fg-0">{id}.txt</span>
                <button
                  onClick={() =>{  setOpenResult(id); }}
                  className="ml-auto border border-border px-2 py-0.5 font-mono text-[11px] text-fg-2 hover:border-border-strong hover:text-fg-0"
                >
                  view
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Subagent directories — click a tile to drill into that subagent's
          own wire + context + meta. Mirrors the Subagents tab tree but in
          a flat, filesystem-ish view. */}
      <section className="mt-6">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          subagent directories · {detail.subagent_ids.length}
        </h2>
        {detail.subagent_ids.length === 0 ? (
          <p className="mt-2 font-mono text-[12px] text-fg-3">none</p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
            {detail.subagent_ids.map((id) => (
              <li key={id}>
                <Link
                  to={`/sessions/${sessionId}/subagents/${id}`}
                  className="group block border border-border bg-surface-0 px-3 py-2 transition-colors hover:border-border-strong hover:bg-surface-1"
                >
                  <div className="flex items-center gap-2">
                    <Pill tone="subagent" variant="soft">
                      subagent
                    </Pill>
                    <span className="truncate font-mono text-[12px] text-fg-0">
                      {id.replace(/^sub_/, '').slice(0, 12)}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-fg-3 group-hover:text-fg-1">
                      open →
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10.5px] text-fg-3">{id}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openArchive ? (
        <ArchiveDrawer
          sessionId={sessionId}
          filename={openArchive}
          onClose={() =>{  setOpenArchive(null); }}
        />
      ) : null}
      {openResult ? (
        <ToolResultDrawer
          sessionId={sessionId}
          toolCallId={openResult}
          onClose={() =>{  setOpenResult(null); }}
        />
      ) : null}
    </div>
  );
}

function ArchiveDrawer({
  sessionId,
  filename,
  onClose,
}: {
  sessionId: string;
  filename: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useArchive(sessionId, filename);
  return (
    <Drawer open onClose={onClose} title={<span>archive · {filename}</span>} width={900}>
      {isLoading ? (
        <div className="p-4 font-mono text-[11px] text-fg-3">loading…</div>
      ) : error ? (
        <div className="p-4 font-mono text-[11px] text-[var(--color-sev-error)]">
          {(error).message}
        </div>
      ) : data ? (
        <WireTab
          records={data.records}
          health={data.health}
          brokenReason={data.broken_reason}
          warnings={data.warnings}
        />
      ) : null}
    </Drawer>
  );
}

function ToolResultDrawer({
  sessionId,
  toolCallId,
  onClose,
}: {
  sessionId: string;
  toolCallId: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useToolResult(sessionId, toolCallId, true);
  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span>
          tool-result · {toolCallId}.txt
          {data ? <span className="ml-2 text-fg-3">{formatBytes(data.size_bytes)}</span> : null}
        </span>
      }
      width={780}
    >
      {isLoading ? (
        <div className="p-4 font-mono text-[11px] text-fg-3">loading…</div>
      ) : error ? (
        <div className="p-4 font-mono text-[11px] text-[var(--color-sev-error)]">
          {(error).message}
        </div>
      ) : data ? (
        <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] text-fg-0">
          {data.content}
        </pre>
      ) : null}
    </Drawer>
  );
}
