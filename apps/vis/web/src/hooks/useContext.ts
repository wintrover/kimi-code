import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useSessionContext(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['session', sessionId, 'context'] as const,
    queryFn: () => api.getContext(sessionId!),
    enabled: !!sessionId && enabled,
  });
}

export function useSubagentContext(
  sessionId: string | undefined,
  agentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'subagent', agentId, 'context'] as const,
    queryFn: () => api.getSubagentContext(sessionId!, agentId!),
    enabled: !!sessionId && !!agentId && enabled,
  });
}

export function useToolResult(
  sessionId: string | undefined,
  toolCallId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'tool-result', toolCallId] as const,
    queryFn: () => api.getToolResult(sessionId!, toolCallId!),
    enabled: !!sessionId && !!toolCallId && enabled,
  });
}
