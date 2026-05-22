import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useWire(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['session', sessionId, 'wire'] as const,
    queryFn: () => api.getWire(sessionId!),
    enabled: !!sessionId && enabled,
  });
}

export function useSubagentWire(
  sessionId: string | undefined,
  agentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'subagent', agentId, 'wire'] as const,
    queryFn: () => api.getSubagentWire(sessionId!, agentId!),
    enabled: !!sessionId && !!agentId && enabled,
  });
}

export function useArchive(
  sessionId: string | undefined,
  filename: string | undefined,
) {
  return useQuery({
    queryKey: ['session', sessionId, 'archive', filename] as const,
    queryFn: () => api.getArchive(sessionId!, filename!),
    enabled: !!sessionId && !!filename,
  });
}
