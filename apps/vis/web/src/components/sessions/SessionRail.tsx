import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useClearSessions, useDeleteSession, useSessions } from '../../hooks/useSession';
import type { SessionSummary } from '../../types';
import { SessionCard } from './SessionCard';
import { SessionFilter } from './SessionFilter';

export type SessionSortKey = 'recent' | 'oldest' | 'most_records' | 'most_subagents';
export type HealthFilter = 'all' | 'ok' | 'broken' | 'missing_wire';

function workspaceKey(s: SessionSummary): string {
  if (!s.workspace_dir) return '(no workspace)';
  return s.workspace_dir.split('/').slice(-2).join('/');
}

function sortSessions(sessions: readonly SessionSummary[], key: SessionSortKey): SessionSummary[] {
  switch (key) {
    case 'recent':
      return sessions.toSorted((a, b) => b.updated_at - a.updated_at);
    case 'oldest':
      return sessions.toSorted((a, b) => a.created_at - b.created_at);
    case 'most_records':
      return sessions.toSorted((a, b) => b.wire_record_count - a.wire_record_count);
    case 'most_subagents':
      return sessions.toSorted((a, b) => b.subagent_count - a.subagent_count);
  }
}

export function SessionRail() {
  const { data, isLoading, error } = useSessions();
  const deleteSession = useDeleteSession();
  const clearSessions = useClearSessions();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SessionSortKey>('recent');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.filter((s) => {
      if (!showArchived && s.archived) return false;
      if (healthFilter !== 'all' && s.health !== healthFilter) return false;
      if (!q) return true;
      const hay = [
        s.session_id,
        s.title ?? '',
        s.last_prompt ?? '',
        s.custom_title ?? '',
        s.workspace_dir ?? '',
        s.model ?? '',
        ...s.tags,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, search, showArchived, healthFilter]);

  // Grouping-by-workspace only makes sense when sorted by time — for any
  // other sort the user asked for a particular total ordering across
  // sessions, so we honour it and display a flat list.
  const grouped = useMemo(() => {
    if (sortKey !== 'recent') return null;
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const k = workspaceKey(s);
      const existing = map.get(k);
      if (existing === undefined) {
        map.set(k, [s]);
      } else {
        existing.push(s);
      }
    }
    return [...map.entries()]
      .map(([group, items]) => {
        const sorted = items.toSorted((a, b) => b.updated_at - a.updated_at);
        return [group, sorted] as const;
      })
      .toSorted(([, a], [, b]) => {
        const ua = a[0]?.updated_at ?? 0;
        const ub = b[0]?.updated_at ?? 0;
        return ub - ua;
      });
  }, [filtered, sortKey]);

  const flat = useMemo(
    () => (grouped === null ? sortSessions(filtered, sortKey) : null),
    [filtered, sortKey, grouped],
  );

  async function handleDeleteSession(session: SessionSummary) {
    const label = session.title ?? session.last_prompt ?? session.session_id;
    if (!window.confirm(`Delete session "${label}"?\n\nThis removes its files from KIMI_CODE_HOME.`)) {
      return;
    }
    try {
      await deleteSession.mutateAsync(session.session_id);
      if (sessionId === session.session_id) {
        void navigate('/');
      }
    } catch (deleteError) {
      window.alert(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function handleClearSessions() {
    const total = data?.length ?? 0;
    if (total === 0) return;
    if (!window.confirm(`Clear all ${total} sessions shown by vis?\n\nThis removes their files from KIMI_CODE_HOME.`)) {
      return;
    }
    try {
      const result = await clearSessions.mutateAsync();
      void navigate('/');
      if (result.failed.length > 0) {
        window.alert(`Deleted ${result.deleted_count} sessions; ${result.failed.length} failed.`);
      }
    } catch (clearError) {
      window.alert(clearError instanceof Error ? clearError.message : String(clearError));
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-border bg-surface-1">
      <SessionFilter
        search={search}
        onSearchChange={setSearch}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        sortKey={sortKey}
        onSortChange={setSortKey}
        healthFilter={healthFilter}
        onHealthChange={setHealthFilter}
        totalCount={data?.length ?? 0}
        filteredCount={filtered.length}
        onClearSessions={() => {
          void handleClearSessions();
        }}
        clearDisabled={(data?.length ?? 0) === 0 || clearSessions.isPending}
        clearBusy={clearSessions.isPending}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-3 font-mono text-[11px] text-fg-3">loading…</div>
        ) : error ? (
          <div className="p-3 font-mono text-[11px] text-[var(--color-sev-error)]">
            {(error).message}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-3 font-mono text-[11px] text-fg-3">no sessions match</div>
        ) : grouped !== null ? (
          grouped.map(([group, items]) => (
            <div key={group}>
              <div className="sticky top-0 z-10 border-b border-border bg-surface-1 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
                {group} <span className="text-fg-3 tabular">· {items.length}</span>
              </div>
              {items.map((s) => (
                <SessionCard
                  key={s.session_id}
                  session={s}
                  onDelete={(target) => {
                    void handleDeleteSession(target);
                  }}
                  deleting={deleteSession.isPending && deleteSession.variables === s.session_id}
                />
              ))}
            </div>
          ))
        ) : (
          flat?.map((s) => (
            <SessionCard
              key={s.session_id}
              session={s}
              onDelete={(target) => {
                void handleDeleteSession(target);
              }}
              deleting={deleteSession.isPending && deleteSession.variables === s.session_id}
            />
          ))
        )}
      </div>
    </aside>
  );
}
