/**
 * Telemetry buffer and canonical fingerprinting for the guardrail pipeline.
 *
 * Fingerprints are stable across object key order and Bash command formatting
 * so that semantically identical tool calls are reliably de-duplicated.
 */

import type { ToolCallFingerprint, ToolTelemetryBuffer } from './context.js';

/**
 * Recursively sort object keys so that two objects with the same key/value
 * pairs but different insertion orders produce identical strings.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON stringify with sorted keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Normalize tool arguments for fingerprinting.
 *
 * - Bash: trim whitespace and collapse repeated whitespace.
 * - Other tools: stable JSON stringify.
 */
export function canonicalizeArgs(name: string, args: unknown): unknown {
  if (name === 'Bash' && args !== null && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>)['command'];
    if (typeof cmd === 'string') {
      return { command: cmd.trim().replace(/\s+/g, ' ') };
    }
  }
  // Parse stable stringify and re-parse to get a normalized object.
  return JSON.parse(stableStringify(args)) as unknown;
}

export function makeFingerprint(name: string, args: unknown): ToolCallFingerprint {
  return {
    name,
    normalizedArgs: canonicalizeArgs(name, args),
    timestamp: Date.now(),
  };
}

/** Default turn-scoped telemetry buffer with a fixed-size ring. */
export class TurnTelemetryBuffer implements ToolTelemetryBuffer {
  private readonly buffer: ToolCallFingerprint[] = [];

  constructor(private readonly capacity: number) {}

  get records(): readonly ToolCallFingerprint[] {
    return this.buffer;
  }

  record(name: string, args: unknown): void {
    this.buffer.push(makeFingerprint(name, args));
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  recentMatches(name: string, args: unknown, window: number): number {
    const target = canonicalizeArgs(name, args);
    const targetKey = stableStringify({ name, args: target });
    const start = Math.max(0, this.buffer.length - window);
    let count = 0;
    for (let i = this.buffer.length - 1; i >= start; i -= 1) {
      const record = this.buffer[i]!;
      const recordKey = stableStringify({ name: record.name, args: record.normalizedArgs });
      if (recordKey === targetKey) {
        count += 1;
      }
    }
    return count;
  }
}
