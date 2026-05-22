import { Link, useParams } from 'react-router-dom';
import type { SubagentNode as SubagentNodeT } from '../../types';
import { Pill, type PillTone } from '../shared/Pill';
import { formatRelativeTime } from '../../util/time';

const STATUS_TONE: Record<SubagentNodeT['status'], PillTone> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  killed: 'neutral',
  lost: 'warning',
  unknown: 'neutral',
};

interface Props {
  node: SubagentNodeT;
  sessionId: string;
}

export function SubagentNode({ node, sessionId }: Props) {
  const { agentId: activeAgentId } = useParams<{ agentId?: string }>();
  const selected = activeAgentId === node.agent_id;
  const shortId = node.agent_id.replace(/^sub_/, '').slice(0, 10);

  return (
    <div className="my-1">
      <Link
        to={`/sessions/${sessionId}/subagents/${node.agent_id}`}
        className={[
          'relative flex items-start gap-3 border border-border bg-surface-0 px-3 py-2 transition-colors hover:bg-surface-1',
          selected ? 'border-[var(--color-cat-subagent)]' : '',
        ].join(' ')}
      >
        <span
          className="mt-[3px] inline-block h-[7px] w-[7px] rounded-full shrink-0"
          style={{
            backgroundColor: `var(${STATUS_COLOR_VAR[node.status]})`,
          }}
          title={node.status}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Pill tone="subagent" variant="soft">
              {node.subagent_type ?? 'unknown'}
            </Pill>
            <span className="font-mono text-[12px] text-fg-0">{shortId}</span>
            <Pill tone={STATUS_TONE[node.status]} variant="outline">
              {node.status}
            </Pill>
            {node.run_in_background ? (
              <Pill tone="subagent" variant="outline">bg</Pill>
            ) : null}
            <span className="ml-auto font-mono text-[10.5px] text-fg-3 tabular">
              depth {node.depth} · {formatRelativeTime(node.spawn_time)}
            </span>
          </div>
          {node.agent_name ? (
            <div className="mt-0.5 font-mono text-[11px] text-fg-2">
              {node.agent_name}
            </div>
          ) : null}
          {node.result_summary ? (
            <div className="mt-1 font-mono text-[12px] text-fg-1 line-clamp-3">
              {node.result_summary}
            </div>
          ) : null}
          {node.error ? (
            <div className="mt-1 font-mono text-[12px] text-[var(--color-sev-error)] line-clamp-3">
              {node.error}
            </div>
          ) : null}
        </div>
      </Link>
      {node.children.length > 0 ? (
        <div className="mt-1 border-l border-border pl-3 ml-3">
          {node.children.map((c) => (
            <SubagentNode key={c.agent_id} node={c} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_COLOR_VAR: Record<SubagentNodeT['status'], string> = {
  running: '--color-sev-info',
  completed: '--color-sev-success',
  failed: '--color-sev-error',
  killed: '--color-fg-3',
  lost: '--color-sev-warning',
  unknown: '--color-fg-3',
};
