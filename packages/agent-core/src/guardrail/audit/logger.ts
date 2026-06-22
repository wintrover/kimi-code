/**
 * Structured security audit logger for guardrail decisions.
 *
 * Records all guardrail blocks, warnings, passes, overrides, and false-positive
 * reports as JSONL for offline analysis and dashboard consumption.
 *
 * Writes are buffered and flushed periodically (every 10 events) or on explicit
 * `flush()` / `close()`. An in-memory ring buffer of recent events is kept for
 * the live dashboard.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

import { join } from 'pathe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AstViolationEntry {
  readonly node: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
}

export interface SecurityAuditViolation {
  readonly policy: string;
  readonly ruleId?: string;
  readonly riskLevel: string;
  readonly action: string;
  readonly description: string;
}

export interface SecurityAuditContext {
  readonly toolName?: string;
  readonly toolArgs?: Record<string, unknown>;
  readonly astViolations?: readonly AstViolationEntry[];
  readonly matchedPattern?: string;
  readonly normalizedCommand?: string;
}

export interface SecurityAuditDecision {
  readonly action: 'block' | 'warn' | 'allow';
  readonly overrideAvailable?: boolean;
  readonly overridePattern?: string;
  readonly falsePositiveReported?: boolean;
}

export interface SecurityAuditEvent {
  readonly event:
    | 'guardrail_block'
    | 'guardrail_warn'
    | 'guardrail_pass'
    | 'guardrail_override'
    | 'false_positive';
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly step?: number;
  readonly violation?: SecurityAuditViolation;
  readonly context?: SecurityAuditContext;
  readonly decision?: SecurityAuditDecision;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOG_DIR = join(homedir(), '.kimi-code', 'security-audit');
const FLUSH_THRESHOLD = 10;
const RING_BUFFER_CAPACITY = 100;

// ---------------------------------------------------------------------------
// SecurityAuditLogger
// ---------------------------------------------------------------------------

export class SecurityAuditLogger {
  private readonly sessionId?: string;
  private readonly logDir: string;
  private readonly enableTelemetry: boolean;
  private readonly filePath: string;

  /** Write buffer — accumulated until the next flush. */
  private buffer: SecurityAuditEvent[] = [];

  /** In-memory ring buffer of recent events for the dashboard. */
  private readonly recent: SecurityAuditEvent[] = [];

  /** Whether the logger has been closed. */
  private closed = false;

  /** Mutex: serialises concurrent `log()` callers so writes never interleave. */
  private flushLock: Promise<void> = Promise.resolve();

  constructor(
    options?: {
      readonly sessionId?: string;
      /** Default: `~/.kimi-code/security-audit/` */
      readonly logDir?: string;
      readonly enableTelemetry?: boolean;
    },
  ) {
    this.sessionId = options?.sessionId;
    this.logDir = options?.logDir ?? DEFAULT_LOG_DIR;
    this.enableTelemetry = options?.enableTelemetry ?? false;
    this.filePath = join(
      this.logDir,
      `${this.sessionId ?? 'default'}.jsonl`,
    );
  }

  // ---- Public API --------------------------------------------------------

  /** Log a guardrail decision event. */
  async log(event: SecurityAuditEvent): Promise<void> {
    if (this.closed) return;

    // Ensure the timestamp is always ISO 8601.
    const normalised: SecurityAuditEvent = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
      sessionId: event.sessionId ?? this.sessionId,
    };

    this.pushRecent(normalised);
    this.buffer.push(normalised);

    if (this.buffer.length >= FLUSH_THRESHOLD) {
      await this.flush();
    }
  }

  /** Convenience: log a block event. */
  async logBlock(params: {
    readonly policy: string;
    readonly ruleId?: string;
    readonly riskLevel: string;
    readonly description: string;
    readonly toolName?: string;
    readonly toolArgs?: Record<string, unknown>;
    readonly astViolations?: readonly AstViolationEntry[];
    readonly normalizedCommand?: string;
  }): Promise<void> {
    await this.log({
      event: 'guardrail_block',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      violation: {
        policy: params.policy,
        ruleId: params.ruleId,
        riskLevel: params.riskLevel,
        action: 'block',
        description: params.description,
      },
      context: {
        toolName: params.toolName,
        toolArgs: params.toolArgs,
        astViolations: params.astViolations,
        normalizedCommand: params.normalizedCommand,
      },
      decision: { action: 'block' },
    });
  }

  /** Convenience: log a warning event. */
  async logWarn(params: {
    readonly policy: string;
    readonly ruleId?: string;
    readonly riskLevel: string;
    readonly description: string;
    readonly toolName?: string;
    readonly toolArgs?: Record<string, unknown>;
    readonly astViolations?: readonly AstViolationEntry[];
    readonly normalizedCommand?: string;
  }): Promise<void> {
    await this.log({
      event: 'guardrail_warn',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      violation: {
        policy: params.policy,
        ruleId: params.ruleId,
        riskLevel: params.riskLevel,
        action: 'warn',
        description: params.description,
      },
      context: {
        toolName: params.toolName,
        toolArgs: params.toolArgs,
        astViolations: params.astViolations,
        normalizedCommand: params.normalizedCommand,
      },
      decision: { action: 'warn' },
    });
  }

  /** Convenience: log a pass event (for audit completeness). */
  async logPass(params: {
    readonly policy: string;
    readonly toolName?: string;
  }): Promise<void> {
    await this.log({
      event: 'guardrail_pass',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      context: { toolName: params.toolName },
      decision: { action: 'allow' },
    });
  }

  /** Get recent events for the current session. */
  getRecentEvents(limit?: number): readonly SecurityAuditEvent[] {
    if (limit === undefined) return this.recent;
    return this.recent.slice(-limit);
  }

  /** Flush pending writes to disk. */
  async flush(): Promise<void> {
    // Serialise via the lock so concurrent callers don't interleave.
    this.flushLock = this.flushLock.then(() => this.flushInternal());
    return this.flushLock;
  }

  /** Close the logger (flush + release resources). */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  // ---- Internals ---------------------------------------------------------

  /** Push event into the in-memory ring buffer. */
  private pushRecent(event: SecurityAuditEvent): void {
    this.recent.push(event);
    if (this.recent.length > RING_BUFFER_CAPACITY) {
      this.recent.shift();
    }
  }

  /** Perform the actual disk write (guarded by the flush lock). */
  private async flushInternal(): Promise<void> {
    if (this.buffer.length === 0) return;

    const pending = this.buffer;
    this.buffer = [];

    // Ensure the log directory exists.
    await mkdir(this.logDir, { recursive: true });

    const lines = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(this.filePath, lines, 'utf-8');
  }
}
