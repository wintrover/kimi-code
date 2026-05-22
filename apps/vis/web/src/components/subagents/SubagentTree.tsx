import type { SubagentNode as SubagentNodeT } from '../../types';
import { SubagentNode } from './SubagentNode';

interface SubagentTreeProps {
  tree: SubagentNodeT[];
  sessionId: string;
}

export function SubagentTree({ tree, sessionId }: SubagentTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="p-6 font-mono text-[12px] text-fg-3">
        no subagents spawned in this session
      </div>
    );
  }
  return (
    <div className="p-3">
      {tree.map((node) => (
        <SubagentNode key={node.agent_id} node={node} sessionId={sessionId} />
      ))}
    </div>
  );
}
