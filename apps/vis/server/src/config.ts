import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve KIMI_CODE_HOME (env > ~/.kimi-code). */
function resolveKimiCodeHome(): string {
  const envHome = process.env['KIMI_CODE_HOME'];
  if (envHome !== undefined && envHome.length > 0) {
    return envHome;
  }
  return join(homedir(), '.kimi-code');
}

/** HTTP port for the vis API server. */
export function resolvePort(): number {
  const raw = process.env['PORT'];
  if (raw !== undefined && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) {
      return n;
    }
  }
  return 3001;
}

/** HTTP host for the vis API server. Defaults to loopback. */
export function resolveHost(): string {
  const raw = process.env['VIS_HOST'] ?? process.env['HOST'];
  const host = raw?.trim();
  return host !== undefined && host.length > 0 ? host : '127.0.0.1';
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replaceAll('[', '').replaceAll(']', '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

export function resolveVisAuthToken(host: string = resolveHost()): string | undefined {
  const raw = process.env['VIS_AUTH_TOKEN'];
  const token = raw?.trim();
  if (token !== undefined && token.length > 0) return token;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `VIS_AUTH_TOKEN is required when binding vis-server outside loopback (host=${host})`,
    );
  }
  return undefined;
}

export const KIMI_CODE_HOME: string = resolveKimiCodeHome();

export class VisPathConfig {
  readonly sessionsDir: string;

  constructor(readonly home: string) {
    this.sessionsDir = join(home, 'sessions');
  }

  sessionDir(sessionId: string): string {
    return (
      this.findIndexedSessionDir(sessionId) ??
      this.findNestedSessionDir(sessionId) ??
      join(this.sessionsDir, sessionId)
    );
  }

  statePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'state.json');
  }

  mainAgentDir(sessionId: string): string {
    const sessionDir = this.sessionDir(sessionId);
    const mainDir = join(sessionDir, 'agents', 'main');
    return isDirectory(mainDir) ? mainDir : sessionDir;
  }

  wirePath(sessionId: string): string {
    return join(this.mainAgentDir(sessionId), 'wire.jsonl');
  }

  subagentDir(sessionId: string, agentId: string): string {
    const sessionDir = this.sessionDir(sessionId);
    const agentDir = join(sessionDir, 'agents', agentId);
    return isDirectory(agentDir) ? agentDir : join(sessionDir, 'subagents', agentId);
  }

  toolResultArchivePath(sessionId: string, toolCallId: string): string {
    const sessionDir = this.sessionDir(sessionId);
    const mainPath = join(sessionDir, 'agents', 'main', 'tool-results', `${toolCallId}.txt`);
    return existsSync(mainPath) ? mainPath : join(sessionDir, 'tool-results', `${toolCallId}.txt`);
  }

  private findIndexedSessionDir(sessionId: string): string | null {
    const indexPath = join(this.home, 'session_index.jsonl');
    let raw: string;
    try {
      raw = readFileSync(indexPath, 'utf8');
    } catch {
      return null;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as {
          sessionId?: unknown;
          session_id?: unknown;
          sessionDir?: unknown;
          session_dir?: unknown;
        };
        const id = stringValue(parsed.sessionId) ?? stringValue(parsed.session_id);
        if (id !== sessionId) continue;
        const dir = stringValue(parsed.sessionDir) ?? stringValue(parsed.session_dir);
        if (dir !== null && isDirectory(dir)) return dir;
      } catch {
        // Ignore malformed index lines.
      }
    }
    return null;
  }

  private findNestedSessionDir(sessionId: string): string | null {
    const direct = join(this.sessionsDir, sessionId);
    if (isDirectory(direct)) return direct;
    let entries: string[];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const candidate = join(this.sessionsDir, entry, sessionId);
      if (isDirectory(candidate)) return candidate;
    }
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Singleton path config pinned to the resolved KIMI_CODE_HOME. */
export const pathConfig = new VisPathConfig(KIMI_CODE_HOME);
