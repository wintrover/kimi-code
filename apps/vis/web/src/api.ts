import type {
  SessionSummary,
  SessionDetail,
  WireResponse,
  ContextResponse,
  SubagentTreeResponse,
  SubagentMetaResponse,
  ToolResultFileResponse,
  DeleteSessionResponse,
  ClearSessionsResponse,
  ApiError,
} from './types';

const TOKEN_STORAGE_KEY = 'kimi-vis-auth-token';

function readTokenParam(raw: string): string | null {
  const trimmed = raw.replace(/^[#?]/, '');
  if (trimmed.length === 0) return null;
  const params = new URLSearchParams(trimmed);
  return params.get('token') ?? params.get('vis_token');
}

function deleteTokenParams(params: URLSearchParams): boolean {
  const hadToken = params.has('token') || params.has('vis_token');
  params.delete('token');
  params.delete('vis_token');
  return hadToken;
}

function scrubTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const changedSearch = deleteTokenParams(url.searchParams);
  const hash = url.hash.replace(/^#/, '');
  let changedHash = false;
  if (hash.length > 0) {
    const hashParams = new URLSearchParams(hash);
    changedHash = deleteTokenParams(hashParams);
    if (changedHash) {
      const nextHash = hashParams.toString();
      url.hash = nextHash.length > 0 ? nextHash : '';
    }
  }
  if (changedSearch || changedHash) {
    window.history.replaceState(null, '', url.toString());
  }
}

function authToken(): string | null {
  if (typeof window === 'undefined') return null;
  const fromHash = readTokenParam(window.location.hash);
  const fromSearch = readTokenParam(window.location.search);
  const token = fromHash ?? fromSearch;
  if (token !== null && token.length > 0) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    scrubTokenFromUrl();
    return token;
  }
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, method: 'GET' | 'DELETE'): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = authToken();
  if (token !== null && token.length > 0) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(path, { method, headers });
  if (!res.ok) {
    let err: ApiError | null = null;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* ignore */
    }
    throw new Error(err?.error ?? `HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, 'GET');
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, 'DELETE');
}

const enc = encodeURIComponent;

export const api = {
  listSessions: () => get<SessionSummary[]>('/api/sessions'),

  getSession: (id: string) => get<SessionDetail>(`/api/sessions/${enc(id)}`),

  deleteSession: (id: string) => del<DeleteSessionResponse>(`/api/sessions/${enc(id)}`),

  clearSessions: () => del<ClearSessionsResponse>('/api/sessions'),

  getWire: (id: string) => get<WireResponse>(`/api/sessions/${enc(id)}/wire`),

  getContext: (id: string) => get<ContextResponse>(`/api/sessions/${enc(id)}/context`),

  getSubagents: (id: string) => get<SubagentTreeResponse>(`/api/sessions/${enc(id)}/subagents`),

  getSubagentWire: (id: string, agentId: string) =>
    get<WireResponse>(`/api/sessions/${enc(id)}/subagents/${enc(agentId)}/wire`),

  getSubagentContext: (id: string, agentId: string) =>
    get<ContextResponse>(`/api/sessions/${enc(id)}/subagents/${enc(agentId)}/context`),

  getSubagentMeta: (id: string, agentId: string) =>
    get<SubagentMetaResponse>(`/api/sessions/${enc(id)}/subagents/${enc(agentId)}/meta`),

  getToolResult: (id: string, toolCallId: string) =>
    get<ToolResultFileResponse>(`/api/sessions/${enc(id)}/tool-results/${enc(toolCallId)}`),

  getArchive: (id: string, filename: string) =>
    get<WireResponse>(`/api/sessions/${enc(id)}/archives/${enc(filename)}`),
};
