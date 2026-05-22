import { Link, useParams } from 'react-router-dom';
import { useSubagentWire } from '../hooks/useWire';
import { useSubagentContext } from '../hooks/useContext';
import { useSubagentMeta } from '../hooks/useSubagents';
import { TabBar, useActiveTab } from '../components/layout/TabBar';
import { WireTab } from '../components/wire/WireTab';
import { ContextTab } from '../components/context/ContextTab';
import { JsonViewer } from '../components/shared/JsonViewer';
import { Pill } from '../components/shared/Pill';
import { formatAbsoluteTime, formatRelativeTime } from '../util/time';

type TabId = 'wire' | 'context' | 'meta';

export function SubagentDetailPage() {
  const { sessionId, agentId } = useParams<{ sessionId: string; agentId: string }>();
  const active = useActiveTab('wire') as TabId;

  const wireQ = useSubagentWire(sessionId, agentId, active === 'wire');
  const contextQ = useSubagentContext(sessionId, agentId, active === 'context');
  const metaQ = useSubagentMeta(sessionId, agentId);

  if (!sessionId || !agentId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb + header */}
      <div className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
          <Link to={`/sessions/${sessionId}?tab=subagents`} className="hover:text-fg-0">
            ‹ back to subagents
          </Link>
          <span className="text-fg-3">·</span>
          <Link to={`/sessions/${sessionId}`} className="hover:text-fg-0">main</Link>
          <span className="text-fg-3">›</span>
          <span className="text-fg-0">
            {agentId.replace(/^sub_/, '').slice(0, 12)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="font-mono text-[14px] text-fg-0">{agentId}</span>
          {metaQ.data?.meta_json?.subagent_type ? (
            <Pill tone="subagent" variant="soft">
              {metaQ.data.meta_json.subagent_type}
            </Pill>
          ) : null}
          {metaQ.data?.meta_json?.status ? (
            <Pill tone="neutral" variant="outline">
              {metaQ.data.meta_json.status}
            </Pill>
          ) : null}
          {metaQ.data?.depth !== undefined ? (
            <span className="font-mono text-[11px] text-fg-3 tabular">
              depth {metaQ.data.depth}
            </span>
          ) : null}
        </div>
        {metaQ.data?.meta_json?.description ? (
          <div className="mt-1 font-mono text-[12px] text-fg-1">
            {metaQ.data.meta_json.description}
          </div>
        ) : null}
      </div>

      <TabBar
        defaultTab="wire"
        tabs={[
          { id: 'wire', label: 'Wire', count: wireQ.data?.records.length ?? null },
          { id: 'context', label: 'Context', count: contextQ.data?.annotated_messages.length ?? null },
          { id: 'meta', label: 'Meta', count: null },
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

        {active === 'meta' ? <MetaView meta={metaQ.data} error={metaQ.error} /> : null}
      </div>
    </div>
  );
}

function MetaView({ meta, error }: { meta: unknown; error: unknown }) {
  if (error) {
    return <ErrorView msg={(error as Error).message} />;
  }
  if (!meta) return <Centered>loading meta…</Centered>;
  const m = meta as {
    meta_json: unknown;
    spawned_record: unknown;
    completed_record: unknown;
    failed_record: unknown;
  };
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <MetaSection title="meta.json" value={m.meta_json} />
      <MetaSection title="spawn record" subtitle="from parent wire" value={m.spawned_record} />
      <MetaSection title="completion record" subtitle="from parent wire" value={m.completed_record} />
      <MetaSection title="failure record" subtitle="from parent wire" value={m.failed_record} />
      <TimestampsSection spawned={m.spawned_record} completed={m.completed_record} failed={m.failed_record} />
    </div>
  );
}

function MetaSection({
  title,
  subtitle,
  value,
}: {
  title: string;
  subtitle?: string;
  value: unknown;
}) {
  return (
    <section>
      <h2 className="flex items-baseline gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
        {title}
        {subtitle ? <span className="text-fg-3/70">{subtitle}</span> : null}
      </h2>
      <div className="mt-2 border border-border bg-surface-0 p-3">
        {value === null || value === undefined ? (
          <span className="font-mono text-[11px] text-fg-3">(not present)</span>
        ) : (
          <JsonViewer value={value} defaultOpenDepth={2} />
        )}
      </div>
    </section>
  );
}

function TimestampsSection({ spawned, completed, failed }: { spawned: unknown; completed: unknown; failed: unknown }) {
  const rows = [
    spawned ? ['spawn', (spawned as { time?: number }).time] : null,
    completed ? ['complete', (completed as { time?: number }).time] : null,
    failed ? ['failure', (failed as { time?: number }).time] : null,
  ].filter(Boolean) as [string, number | undefined][];
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">timeline</h2>
      <div className="mt-2 border border-border bg-surface-0">
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {rows.map(([label, t]) => (
              <tr key={label} className="border-b border-border last:border-b-0">
                <td className="w-[120px] border-r border-border bg-surface-1 px-3 py-1.5 text-right text-fg-2">
                  {label}
                </td>
                <td className="px-3 py-1.5 text-fg-0 tabular">
                  {t !== undefined ? (
                    <>
                      {formatAbsoluteTime(t)}{' '}
                      <span className="text-fg-3">({formatRelativeTime(t)})</span>
                    </>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
