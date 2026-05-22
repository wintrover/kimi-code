import { useState, type ReactNode } from 'react';

import type { VisWireRecord } from '../../types';
import { CopyButton } from '../shared/CopyButton';
import { JsonViewer } from '../shared/JsonViewer';
import { SizePreview } from '../shared/SizePreview';

interface WireRowDetailProps {
  record: VisWireRecord;
  /** Counterpart in a tool_call ↔ tool_result pair (if applicable). */
  paired?: VisWireRecord | undefined;
  /** Whether the counterpart is visible in the current filter. null when
   *  there is no counterpart at all. */
  pairedInFiltered?: boolean | null;
  /** Scroll to + expand a given seq. */
  onJumpTo?: (seq: number) => void;
}

/** Fields that are best rendered as collapsible large-payload blocks rather than
 *  as key-value pairs. Keyed by the path (dot-separated) from record root. */
const LARGE_FIELDS: Record<string, true> = {
  new_prompt: true,
  system_prompt: true,
  summary: true,
  think: true,
  text: true,
  content: true,
  output: true,
  user_input: true,
  'data.body': true,
  'data.args': true,
  'data.payload': true,
  'data.tail_output': true,
  'data.result_summary': true,
  'data.error': true,
  'data.reason': true,
  'data.content': true,
  'data.summary': true,
  result_summary: true,
  new_content: true,
};

const TOP_LEVEL_META = new Set(['type', 'seq', 'time']);

export function WireRowDetail({ record, paired, pairedInFiltered, onJumpTo }: WireRowDetailProps) {
  const [showRaw, setShowRaw] = useState(false);
  const entries = Object.entries(record as Record<string, unknown>).filter(
    ([k]) => !TOP_LEVEL_META.has(k),
  );

  return (
    <div className="pl-[120px] pr-2 py-1 font-mono text-[12px]">
      <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-[2px]">
        {entries.map(([key, value]) => renderField(key, value, key))}
      </div>
      {paired !== undefined ? (
        <PairedSection
          self={record}
          paired={paired}
          pairedInFiltered={pairedInFiltered ?? null}
          onJumpTo={onJumpTo}
        />
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-3">
        <CopyButton value={JSON.stringify(record, null, 2)} label="copy record json" />
        <button
          onClick={() =>{  setShowRaw((v) => !v); }}
          className="font-mono text-[10px] text-fg-3 hover:text-fg-1"
        >
          {showRaw ? '[ hide raw json ]' : '[ {…} raw json ]'}
        </button>
      </div>
      {showRaw ? (
        <div className="mt-2 border border-border bg-surface-0 p-2">
          <JsonViewer value={record} defaultOpenDepth={2} />
        </div>
      ) : null}
    </div>
  );
}

/** Renders the "↳ paired with tool_result (seq N)" section below a
 *  tool_call row (or the reverse). Shows a compact preview of the
 *  counterpart and a jump button that scrolls-to + expands that row. */
function PairedSection({
  self,
  paired,
  pairedInFiltered,
  onJumpTo,
}: {
  self: VisWireRecord;
  paired: VisWireRecord;
  pairedInFiltered: boolean | null;
  onJumpTo?: (seq: number) => void;
}) {
  const selfIsCall = self.type === 'tool_call';
  const preview = selfIsCall ? previewToolResult(paired) : previewToolCallArgs(paired);
  const isError =
    paired.type === 'tool_result' && (paired as { is_error?: boolean }).is_error === true;
  const hidden = pairedInFiltered === false;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="text-fg-3">↳ paired</span>
        <span className="text-fg-1">{paired.type}</span>
        <span className="text-fg-3">seq</span>
        <span className="tabular text-fg-0">{paired.seq}</span>
        {isError ? (
          <span className="border border-[var(--color-sev-error)] px-1 text-[10px] text-[var(--color-sev-error)]">
            error
          </span>
        ) : null}
        {hidden ? <span className="text-fg-3">(hidden by filter)</span> : null}
        <button
          type="button"
          onClick={() => onJumpTo?.(paired.seq)}
          disabled={hidden || onJumpTo === undefined}
          className="ml-auto border border-border px-2 py-0.5 text-fg-2 hover:border-border-strong hover:text-fg-0 disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg-2"
          title={
            hidden ? 'counterpart is currently filtered out' : 'scroll to + expand counterpart'
          }
        >
          jump →
        </button>
      </div>
      {preview.length > 0 ? (
        <pre className="mt-1 max-h-[5.5em] overflow-hidden whitespace-pre-wrap break-words font-mono text-[11.5px] text-fg-1">
          {preview.length > 400 ? preview.slice(0, 400) + '…' : preview}
        </pre>
      ) : (
        <div className="mt-1 font-mono text-[11px] text-fg-3">(empty)</div>
      )}
    </div>
  );
}

function previewToolCallArgs(call: VisWireRecord): string {
  const args = (call as { data?: { args?: unknown } }).data?.args;
  if (args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    // Circular refs / BigInt / etc. — don't fall through to String(unknown)
    // which produces "[object Object]" and hides the actual problem.
    return '(unserialisable args)';
  }
}

function previewToolResult(result: VisWireRecord): string {
  const out = (result as { output?: unknown }).output;
  if (out === undefined || out === null) return '';
  if (typeof out === 'string') return out;
  try {
    return JSON.stringify(out, null, 2);
  } catch {
    return '(unserialisable output)';
  }
}

function renderField(key: string, value: unknown, path: string) {
  // Null / undefined
  if (value === null || value === undefined) {
    return (
      <FieldRow key={path} label={key}>
        <span className="text-fg-3">null</span>
      </FieldRow>
    );
  }

  // Large-payload fields: render via SizePreview with JsonViewer inside
  if (LARGE_FIELDS[path] || LARGE_FIELDS[key]) {
    if (typeof value === 'string') {
      return (
        <FieldRow key={path} label={key} wide>
          <SizePreview label={key} sizeBytes={value.length} preview={value}>
            <pre className="whitespace-pre-wrap break-words text-fg-1">{value}</pre>
          </SizePreview>
        </FieldRow>
      );
    }
    // non-string large fields: JSON tree
    return (
      <FieldRow key={path} label={key} wide>
        <SizePreview label={key} sizeBytes={JSON.stringify(value).length}>
          <JsonViewer value={value} defaultOpenDepth={1} />
        </SizePreview>
      </FieldRow>
    );
  }

  // Primitive
  if (typeof value !== 'object') {
    const repr =
      typeof value === 'string'
        ? `"${truncate(value, 160)}"`
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : typeof value;
    return (
      <FieldRow key={path} label={key}>
        <span className={typeColor(value)}>{repr}</span>
      </FieldRow>
    );
  }

  // Nested object: inline JsonViewer
  return (
    <FieldRow key={path} label={key} wide>
      <JsonViewer value={value} defaultOpenDepth={1} />
    </FieldRow>
  );
}

function FieldRow({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (wide) {
    return (
      <>
        <div className="col-span-2 flex items-baseline gap-3">
          <span className="w-[140px] shrink-0 font-mono text-[11px] text-fg-2 text-right">
            {label}
          </span>
          <div className="flex-1 min-w-0">{children}</div>
        </div>
      </>
    );
  }
  return (
    <>
      <span className="font-mono text-[11px] text-fg-2 text-right">{label}</span>
      <div className="font-mono text-[12px] text-fg-0 min-w-0 break-words">{children}</div>
    </>
  );
}

function typeColor(v: unknown): string {
  if (typeof v === 'boolean') return 'text-[var(--color-cat-config)]';
  if (typeof v === 'number') return 'text-[var(--color-sev-info)]';
  if (typeof v === 'string') return 'text-[var(--color-cat-ephemeral)]';
  return 'text-fg-0';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
