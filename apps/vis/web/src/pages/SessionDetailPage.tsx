import { useParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useWire } from '../hooks/useWire';
import { useSessionContext } from '../hooks/useContext';
import { useSubagents } from '../hooks/useSubagents';
import { TabBar, useActiveTab } from '../components/layout/TabBar';
import { WireTab } from '../components/wire/WireTab';
import { ContextTab } from '../components/context/ContextTab';
import { SubagentsTab } from '../components/subagents/SubagentsTab';
import { StateTab } from '../components/state/StateTab';
import { FilesTab } from '../components/files/FilesTab';
import { CopyButton } from '../components/shared/CopyButton';
import { Pill } from '../components/shared/Pill';
import { formatAbsoluteTime, formatRelativeTime } from '../util/time';

type TabId = 'wire' | 'context' | 'subagents' | 'state' | 'files';

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const active = useActiveTab('wire') as TabId;

  const { data: session, isLoading: sessionLoading, error: sessionError } = useSession(sessionId);

  // Eagerly count subagents from the session detail; fetch wire/context/subagents
  // only when their tab is open.
  const wireQ = useWire(sessionId, active === 'wire');
  const contextQ = useSessionContext(sessionId, active === 'context');
  const subQ = useSubagents(sessionId, active === 'subagents');

  if (!sessionId) return <div className="p-6 text-fg-3">(no session id)</div>;
  if (sessionLoading) return <div className="p-6 font-mono text-[12px] text-fg-3">loading session…</div>;
  if (sessionError)
    return (
      <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
        {(sessionError).message}
      </div>
    );
  if (!session) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Detail header */}
      <div className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[14px] text-fg-0">{session.session_id}</span>
          <CopyButton value={session.session_id} />
          {session.state.model ? (
            <Pill tone="config" variant="soft">{session.state.model}</Pill>
          ) : null}
          {session.state.archived ? (
            <Pill tone="warning" variant="outline">archived</Pill>
          ) : null}
          {session.state.permission_mode === 'bypassPermissions' ? (
            <Pill tone="error" variant="outline">yolo</Pill>
          ) : null}
          {session.title ? (
            <span className="font-mono text-[12px] text-fg-1">
              "{session.title}"
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-fg-2">
          {session.state.workspace_dir ? (
            <span className="truncate" title={session.state.workspace_dir}>
              {session.state.workspace_dir}
            </span>
          ) : null}
          {session.state.updated_at ? (
            <span className="text-fg-3 tabular">
              updated {formatRelativeTime(session.state.updated_at)} ·{' '}
              {formatAbsoluteTime(session.state.updated_at)}
            </span>
          ) : null}
        </div>
        {session.last_prompt ? (
          <div className="mt-1 truncate font-mono text-[11px] text-fg-3" title={session.last_prompt}>
            prompt · {session.last_prompt}
          </div>
        ) : null}
      </div>

      <TabBar
        defaultTab="wire"
        tabs={[
          { id: 'wire', label: 'Wire', count: wireQ.data?.records.length ?? null },
          { id: 'context', label: 'Context', count: contextQ.data?.annotated_messages.length ?? null },
          { id: 'subagents', label: 'Subagents', count: session.subagent_ids.length },
          { id: 'state', label: 'State', count: null },
          { id: 'files', label: 'Files', count: session.archive_files.length + session.tool_result_ids.length },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {active === 'wire' ? (
          wireQ.isLoading ? (
            <Centered>loading wire…</Centered>
          ) : wireQ.error ? (
            <ErrorView msg={(wireQ.error).message} />
          ) : wireQ.data ? (
            <WireTab
              records={wireQ.data.records}
              health={wireQ.data.health}
              brokenReason={wireQ.data.broken_reason}
              warnings={wireQ.data.warnings}
            />
          ) : null
        ) : null}

        {active === 'context' ? (
          contextQ.isLoading ? (
            <Centered>loading context…</Centered>
          ) : contextQ.error ? (
            <ErrorView msg={(contextQ.error).message} />
          ) : contextQ.data ? (
            <ContextTab
              sessionId={sessionId}
              messages={contextQ.data.annotated_messages}
              projectedState={contextQ.data.projected_state}
            />
          ) : null
        ) : null}

        {active === 'subagents' ? (
          subQ.isLoading ? (
            <Centered>loading subagents…</Centered>
          ) : (
            <SubagentsTab sessionId={sessionId} />
          )
        ) : null}

        {active === 'state' ? (
          <StateTab
            state={session.state}
            protocolVersion={session.wire_metadata?.protocol_version ?? null}
          />
        ) : null}

        {active === 'files' ? (
          <FilesTab sessionId={sessionId} detail={session} />
        ) : null}
      </div>
    </div>
  );
}

function Centered({ children }: { children: import('react').ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 font-mono text-[12px] text-fg-3">
      {children}
    </div>
  );
}

function ErrorView({ msg }: { msg: string }) {
  return (
    <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">{msg}</div>
  );
}
