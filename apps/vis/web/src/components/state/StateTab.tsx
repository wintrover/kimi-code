import { useState, type ReactNode } from 'react';

import type { SessionState } from '../../types';
import { formatAbsoluteTime, formatRelativeTime } from '../../util/time';
import { CopyButton } from '../shared/CopyButton';
import { JsonViewer } from '../shared/JsonViewer';

interface StateTabProps {
  state: SessionState;
  protocolVersion: string | null;
}

/** Keys whose values should be interpreted as epoch milliseconds and
 *  decorated with both an absolute time and "2h ago" style relative label.
 *  Matches the shape of state.json written by `@moonshot-ai/agent-core`. */
const EPOCH_MS_KEYS = new Set(['created_at', 'updated_at', 'last_turn_time']);

/** Keys whose values tend to be long paths worth copying with one click. */
const COPY_KEYS = new Set(['workspace_dir', 'plan_slug', 'session_id']);

export function StateTab({ state, protocolVersion }: StateTabProps) {
  const [showRaw, setShowRaw] = useState(false);
  const entries = Object.entries(state);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">
          state.json
          {protocolVersion ? ` · wire protocol ${protocolVersion}` : ''}
        </div>
        <div className="flex items-center gap-3">
          <CopyButton value={JSON.stringify(state, null, 2)} label="copy json" />
          <button
            onClick={() =>{  setShowRaw((v) => !v); }}
            className="font-mono text-[10px] text-fg-3 hover:text-fg-1"
          >
            {showRaw ? '[ hide raw ]' : '[ {…} raw json ]'}
          </button>
        </div>
      </div>

      <DurationRow state={state} />

      <div className="mt-4 border border-border bg-surface-0">
        <table className="w-full font-mono text-[12px]">
          <tbody>
            {entries.map(([k, v]) => (
              <StateRow key={k} keyName={k} value={v} />
            ))}
          </tbody>
        </table>
      </div>

      {showRaw ? (
        <div className="mt-4 border border-border bg-surface-0 p-3">
          <JsonViewer value={state} defaultOpenDepth={3} />
        </div>
      ) : null}
    </div>
  );
}

/** Derive a human duration from created_at + updated_at when both are
 *  valid epoch-ms numbers. Rendered just under the header as a single dim
 *  line — omitted silently when data is missing. */
function DurationRow({ state }: { state: SessionState }) {
  const created = state.created_at;
  const updated = state.updated_at;
  if (typeof created !== 'number' || typeof updated !== 'number') return null;
  if (updated < created) return null;
  const ms = updated - created;
  return (
    <div className="mt-2 font-mono text-[11px] text-fg-3">
      duration <span className="text-fg-1">{formatDuration(ms)}</span>
      {' · '}
      from <span className="text-fg-1">{formatAbsoluteTime(created)}</span>
      {' → '}
      <span className="text-fg-1">{formatAbsoluteTime(updated)}</span>
    </div>
  );
}

function StateRow({ keyName, value }: { keyName: string; value: unknown }) {
  return (
    <tr className="border-b border-border last:border-b-0 align-top">
      <td className="w-[200px] border-r border-border bg-surface-1 px-3 py-1.5 text-right text-fg-2">
        {keyName}
      </td>
      <td className="px-3 py-1.5 text-fg-0 break-words">
        <ValueCell keyName={keyName} value={value} />
      </td>
    </tr>
  );
}

function ValueCell({ keyName, value }: { keyName: string; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-fg-3">null</span>;

  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-[var(--color-sev-success)]' : 'text-fg-3'}>
        {String(value)}
      </span>
    );
  }

  if (typeof value === 'number') {
    if (EPOCH_MS_KEYS.has(keyName) && value > 1_000_000_000_000) {
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[var(--color-sev-info)] tabular">{formatAbsoluteTime(value)}</span>
          <span className="text-fg-3">·</span>
          <span className="text-fg-2">{formatRelativeTime(value)}</span>
          <span className="text-fg-3">·</span>
          <span className="text-fg-3 tabular">{value}</span>
        </span>
      );
    }
    return <span className="text-[var(--color-sev-info)] tabular">{value}</span>;
  }

  if (typeof value === 'string') {
    const withCopy = COPY_KEYS.has(keyName);
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[var(--color-cat-ephemeral)] break-all">"{value}"</span>
        {withCopy ? <CopyButton value={value} /> : null}
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-fg-3">[]</span>;
    // Arrays of primitives render inline; arrays of objects use JsonViewer.
    const allPrim = value.every((v) => typeof v !== 'object' || v === null);
    if (allPrim) {
      return (
        <span className="flex flex-wrap items-center gap-1">
          {(value as unknown[]).map((v, i) => (
            <span
              key={i}
              className="border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] text-fg-1"
            >
              {typeof v === 'string' ? v : String(v)}
            </span>
          ))}
        </span>
      );
    }
    return <JsonViewer value={value} defaultOpenDepth={2} />;
  }

  // Nested object: render as a compact sub-table so fields like `producer`
  // read as structured data instead of a JSON.stringify blob.
  return <NestedObject value={value as Record<string, unknown>} />;
}

function NestedObject({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-fg-3">{'{}'}</span>;
  return (
    <div className="inline-block border border-border bg-surface-1">
      <table className="font-mono text-[11.5px]">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-border last:border-b-0 align-top">
              <td className="border-r border-border px-2 py-0.5 text-right text-fg-3">{k}</td>
              <td className="px-2 py-0.5 text-fg-0 break-all">
                <NestedValue value={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NestedValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="text-fg-3">null</span>;
  if (typeof value === 'boolean') {
    return (
      <span className={value ? 'text-[var(--color-sev-success)]' : 'text-fg-3'}>
        {String(value)}
      </span>
    );
  }
  if (typeof value === 'number')
    return <span className="text-[var(--color-sev-info)] tabular">{value}</span>;
  if (typeof value === 'string')
    return <span className="text-[var(--color-cat-ephemeral)]">"{value}"</span>;
  if (Array.isArray(value)) {
    return (
      <span className="text-fg-1">
        [{value.length} item{value.length === 1 ? '' : 's'}]
      </span>
    );
  }
  return <NestedObject value={value as Record<string, unknown>} />;
}

/** Format a duration in ms as "3h 14m" / "12m 30s" / "45s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
