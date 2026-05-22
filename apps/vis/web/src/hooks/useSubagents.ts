import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useSubagents(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['session', sessionId, 'subagents'] as const,
    queryFn: () => api.getSubagents(sessionId!),
    enabled: !!sessionId && enabled,
  });
}

export function useSubagentMeta(
  sessionId: string | undefined,
  agentId: string | undefined,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'subagent', agentId, 'meta'] as const,
    queryFn: () => api.getSubagentMeta(sessionId!, agentId!),
    enabled: !!sessionId && !!agentId,
  });
}
