import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FocusProvider, useFocus } from '../../lib/focus-context';
import { computeIssues, topSeverity } from '../../lib/issues';
import {
  buildMatchContext,
  matchesQuery,
  parseQuery,
  type ParsedQuery,
  type QueryToken,
} from '../../lib/query-parser';
import type { VisWireRecord, WireCategory } from '../../types';
import { TYPE_CATEGORY } from '../../types';
import { IssuesDrawer } from './IssuesDrawer';
import { WireRow } from './WireRow';

interface WireTabProps {
  records: VisWireRecord[];
  health?: 'ok' | 'broken';
  brokenReason?: string;
  warnings?: string[];
}

const CATEGORIES: WireCategory[] = [
  'conversation',
  'tools',
  'approval',
  'subagent',
  'ephemeral',
  'meta',
  'config',
  'lifecycle',
];

const CAT_COLOR_VAR: Record<WireCategory, string> = {
  conversation: '--color-cat-conversation',
  config: '--color-cat-config',
  lifecycle: '--color-cat-lifecycle',
  subagent: '--color-cat-subagent',
  approval: '--color-cat-approval',
  ephemeral: '--color-cat-ephemeral',
  meta: '--color-cat-meta',
  tools: '--color-cat-tools',
};

export function WireTab(props: WireTabProps) {
  // The FocusProvider wraps the entire tab so IdBadge clicks deep inside
  // the virtualized rows can update (and be read by) the toolbar status
  // indicator without prop-drilling.
  return (
    <FocusProvider>
      <WireTabInner {...props} />
    </FocusProvider>
  );
}

function WireTabInner({ records, health, brokenReason, warnings = [] }: WireTabProps) {
  const [search, setSearch] = useState('');
  const [excluded, setExcluded] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const query = useMemo<ParsedQuery>(() => parseQuery(search), [search]);

  const matchCtx = useMemo(() => buildMatchContext(records, query), [records, query]);

  const filtered = useMemo(() => {
    return records.filter((r) => {
      const cat = TYPE_CATEGORY[r.type];
      if (excluded.has(cat)) return false;
      return matchesQuery(r, query, matchCtx);
    });
  }, [records, excluded, query, matchCtx]);

  // Pair map: tool_call_id → the two sides. Built from the full records[]
  // (not `filtered`) so jumping from a filtered view still works when the
  // counterpart has been filtered out — the detail panel will just mark it
  // "(hidden by current filter)".
  const pairMap = useMemo(() => {
    const m = new Map<string, { call?: VisWireRecord; result?: VisWireRecord }>();
    for (const r of records) {
      if (r.type === 'tool_call') {
        const id = (r as { data?: { tool_call_id?: string } }).data?.tool_call_id;
        if (id !== undefined) {
          const slot = m.get(id) ?? {};
          slot.call = r;
          m.set(id, slot);
        }
      } else if (r.type === 'tool_result') {
        const id = (r as { tool_call_id?: string }).tool_call_id;
        if (id !== undefined) {
          const slot = m.get(id) ?? {};
          slot.result = r;
          m.set(id, slot);
        }
      }
    }
    return m;
  }, [records]);

  /** Find the counterpart for a tool_call / tool_result row (undefined otherwise). */
  const pairedFor = useCallback(
    (r: VisWireRecord): VisWireRecord | undefined => {
      if (r.type === 'tool_call') {
        const id = (r as { data?: { tool_call_id?: string } }).data?.tool_call_id;
        return id === undefined ? undefined : pairMap.get(id)?.result;
      }
      if (r.type === 'tool_result') {
        const id = (r as { tool_call_id?: string }).tool_call_id;
        return id === undefined ? undefined : pairMap.get(id)?.call;
      }
      return undefined;
    },
    [pairMap],
  );

  // Compute per-category counts over the unfiltered set
  const catCounts = useMemo(() => {
    const m = new Map<WireCategory, number>();
    for (const r of records) {
      const c = TYPE_CATEGORY[r.type];
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [records]);

  const turnCount = useMemo(() => records.filter((r) => r.type === 'turn_begin').length, [records]);

  // Issues are computed over the full records[] + file warnings (not the
  // filter result) so the pill keeps showing real problems even when the
  // user has narrowed their query. Jumping to an issue scrolls the Wire
  // list — if the issue's seq is currently filtered out, `jumpToSeq` is
  // a no-op and the drawer just closes.
  const issues = useMemo(() => computeIssues(records, warnings), [records, warnings]);
  const issuesSeverity = topSeverity(issues);

  // Stable estimate — ResizeObserver (wired via `virt.measureElement` ref
  // on each item) refines to the actual rendered height. Do NOT vary the
  // estimate based on `expanded`: that fights the library's measurement
  // cache and produces layout gaps when the two race.
  const virt = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (i) => filtered[i]?.seq ?? i,
  });

  const toggle = useCallback((seq: number) => {
    // Trust the library's ResizeObserver to catch the new content size —
    // calling `virt.measure()` manually here races with the observer and
    // can clear freshly-written cache entries, stranding items at their
    // `estimateSize` value and producing visible gaps.
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  /** Seq → index lookup built from the filtered list. Doubles as the
   *  "is this seq currently visible?" test used by pairing + issues jumps. */
  const filteredSeqIdx = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < filtered.length; i += 1) {
      const r = filtered[i];
      if (r !== undefined) m.set(r.seq, i);
    }
    return m;
  }, [filtered]);

  /** Jump to a specific seq: scroll the row into view and expand it.
   *  No-op if the seq isn't in the current filtered set — callers can
   *  check `filteredSeqIdx.has(seq)` ahead of time and disable the link. */
  const jumpToSeq = useCallback(
    (seq: number) => {
      const idx = filteredSeqIdx.get(seq);
      if (idx === undefined) return;
      virt.scrollToIndex(idx, { align: 'center' });
      setExpanded((prev) => (prev.has(seq) ? prev : new Set(prev).add(seq)));
    },
    [filteredSeqIdx, virt],
  );

  const toggleCat = (c: WireCategory) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const expandAll = () =>{  setExpanded(new Set(filtered.map((r) => r.seq))); };
  const collapseAll = () =>{  setExpanded(new Set()); };

  const hasStructuredTokens = query.tokens.some((t) => t.key !== null) || query.errors.length > 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <div className="relative flex items-center">
          <input
            type="text"
            placeholder="type:tool_call tool:Bash error:true …"
            value={search}
            onChange={(e) =>{  setSearch(e.target.value); }}
            className="w-80 border border-border bg-surface-0 px-2 py-1 pr-7 font-mono text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
          />
          <button
            type="button"
            onClick={() =>{  setShowHelp((v) => !v); }}
            title="query syntax cheatsheet"
            className="absolute right-1 top-1/2 -translate-y-1/2 font-mono text-[11px] text-fg-3 hover:text-fg-0"
          >
            ?
          </button>
          {showHelp ? <QueryHelp onClose={() =>{  setShowHelp(false); }} /> : null}
        </div>
        <div className="flex items-center gap-1">
          {CATEGORIES.map((c) => {
            const count = catCounts.get(c) ?? 0;
            if (count === 0) return null;
            const on = !excluded.has(c);
            const color = `var(${CAT_COLOR_VAR[c]})`;
            return (
              <button
                key={c}
                onClick={() =>{  toggleCat(c); }}
                title={`Toggle ${c} (${count})`}
                className="pill"
                style={
                  on
                    ? {
                        backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
                        color,
                      }
                    : {
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-fg-3)',
                      }
                }
              >
                <span>{c}</span>
                <span className="tabular">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-fg-2">
          <span className="tabular">
            {filtered.length} / {records.length} ev
          </span>
          <span className="tabular text-fg-3">{turnCount} turns</span>
          {issues.length > 0 && issuesSeverity !== null ? (
            <button
              onClick={() =>{  setDrawerOpen(true); }}
              title={`${issues.length} issue${issues.length > 1 ? 's' : ''} — click to inspect`}
              className="flex items-center gap-1 border px-2 py-0.5"
              style={{
                borderColor: `var(--color-sev-${issuesSeverity})`,
                color: `var(--color-sev-${issuesSeverity})`,
                backgroundColor: `color-mix(in oklab, var(--color-sev-${issuesSeverity}) 10%, transparent)`,
              }}
            >
              <span>
                {issuesSeverity === 'error' ? '⚠' : issuesSeverity === 'warning' ? '⚠' : 'ℹ'}
              </span>
              <span className="tabular">{issues.length}</span>
            </button>
          ) : null}
          <button
            onClick={expandAll}
            className="border border-border px-2 py-0.5 text-fg-2 hover:border-border-strong hover:text-fg-0"
          >
            expand all
          </button>
          <button
            onClick={collapseAll}
            className="border border-border px-2 py-0.5 text-fg-2 hover:border-border-strong hover:text-fg-0"
          >
            collapse
          </button>
        </div>
      </div>

      {/* Query chips — one-line summary of parsed filters, each removable */}
      {hasStructuredTokens ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-surface-1 px-3 py-1">
          {query.tokens
            .filter((t) => t.key !== null)
            .map((t, i) => {
              const invalid = query.errors.some((e) => e.token === t.raw);
              return (
                <QueryChip
                  key={`${t.raw}-${i}`}
                  token={t}
                  invalid={invalid}
                  onRemove={() =>{  setSearch((s) => removeToken(s, t.raw)); }}
                />
              );
            })}
          {query.errors.length > 0 ? (
            <span
              className="font-mono text-[10px] text-[var(--color-sev-warning)]"
              title={query.errors.map((e) => `${e.token}: ${e.reason}`).join('\n')}
            >
              · {query.errors.length} unknown
            </span>
          ) : null}
        </div>
      ) : null}

      <FocusStatus />

      {/* Health warning */}
      {health === 'broken' ? (
        <div className="shrink-0 border-b border-[var(--color-sev-error)] bg-[color-mix(in_oklab,var(--color-sev-error)_12%,transparent)] px-3 py-1 font-mono text-[11px] text-[var(--color-sev-error)]">
          broken: {brokenReason ?? 'unknown reason'}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="shrink-0 border-b border-[var(--color-sev-warning)] bg-[color-mix(in_oklab,var(--color-sev-warning)_8%,transparent)] px-3 py-1 font-mono text-[11px] text-[var(--color-sev-warning)]">
          {warnings.length} warning{warnings.length > 1 ? 's' : ''} · first: {warnings[0]}
        </div>
      ) : null}

      {/* Virtualized list */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 font-mono text-[12px] text-fg-3">
            no records match the current filter
          </div>
        ) : (
          <div
            style={{
              height: virt.getTotalSize(),
              position: 'relative',
            }}
          >
            {virt.getVirtualItems().map((vi) => {
              const r = filtered[vi.index];
              if (!r) return null;
              // Compute the counterpart once per row — paired lookup runs
              // inside a virtualized render loop, so duplicating the call
              // meant ~40 redundant ops per scroll tick on deep sessions.
              const paired = pairedFor(r);
              const pairedInFiltered = paired === undefined ? null : filteredSeqIdx.has(paired.seq);
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <WireRow
                    record={r}
                    expanded={expanded.has(r.seq)}
                    onToggle={() =>{  toggle(r.seq); }}
                    paired={paired}
                    pairedInFiltered={pairedInFiltered}
                    onJumpTo={jumpToSeq}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {drawerOpen ? (
        <IssuesDrawer
          issues={issues}
          onClose={() =>{  setDrawerOpen(false); }}
          onJumpTo={jumpToSeq}
          isSeqVisible={(seq) => filteredSeqIdx.has(seq)}
        />
      ) : null}
    </div>
  );
}

// ──────── helper subcomponents ────────

function QueryChip({
  token,
  invalid,
  onRemove,
}: {
  token: QueryToken;
  invalid: boolean;
  onRemove: () => void;
}) {
  const label = `${token.key}${token.op === '=' ? ':' : token.op}${token.values.join(',')}`;
  return (
    <span
      className={[
        'inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px]',
        invalid
          ? 'border-[var(--color-sev-error)] text-[var(--color-sev-error)]'
          : 'border-border bg-surface-0 text-fg-1',
      ].join(' ')}
    >
      <span>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-fg-3 hover:text-fg-0"
        title="remove filter"
      >
        ×
      </button>
    </span>
  );
}

function QueryHelp({ onClose }: { onClose: () => void }) {
  // Dismiss on: ESC, or outside click. `onMouseLeave` was too twitchy —
  // the panel would flash shut on mouse tremor near its edge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-query-help-root]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // defer doc listener one tick so the opening click doesn't immediately close us
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
    }, 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);
  return (
    <div
      data-query-help-root="true"
      className="absolute left-0 top-full z-20 mt-1 w-[420px] border border-border bg-surface-0 p-3 font-mono text-[11px] text-fg-1 shadow-lg"
    >
      <div className="mb-1 text-fg-0">query syntax</div>
      <ul className="space-y-0.5 text-fg-2">
        <li>
          <span className="text-fg-0">type:</span>tool_call · type:user_message,tool_result ·
          type:!compaction
        </li>
        <li>
          <span className="text-fg-0">tool:</span>Bash · tool:Read,Write
        </li>
        <li>
          <span className="text-fg-0">turn:</span>3 · turn:turn_5
        </li>
        <li>
          <span className="text-fg-0">seq:</span>
          {'>'}100 · seq:&lt;50 · seq:&gt;=200
        </li>
        <li>
          <span className="text-fg-0">error:</span>true · error:false
        </li>
        <li>
          <span className="text-fg-0">agent:</span>sub_abc123 (substring)
        </li>
        <li>
          <span className="text-fg-0">id:</span>abc123 (matches any id field)
        </li>
        <li>
          <span className="text-fg-3">bare words → JSON substring (AND)</span>
        </li>
      </ul>
      <div className="mt-2 text-fg-3">
        tip: click an underlined id in any row to focus all related records · ESC to clear
      </div>
    </div>
  );
}

function FocusStatus() {
  const { focus, clear } = useFocus();
  if (focus === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-sev-info)]/40 bg-[color-mix(in_oklab,var(--color-sev-info)_8%,transparent)] px-3 py-1 font-mono text-[11px] text-fg-1">
      <span className="text-[var(--color-sev-info)]">◎ focus</span>
      <span className="text-fg-2">{focus.kind}</span>
      <span className="text-fg-3">=</span>
      <span className="text-fg-0">
        {focus.value.length > 24 ? focus.value.slice(0, 24) + '…' : focus.value}
      </span>
      <button
        type="button"
        onClick={clear}
        className="ml-auto text-fg-3 hover:text-fg-0"
        title="clear focus (ESC)"
      >
        clear
      </button>
    </div>
  );
}

/** Remove a single structured token from the raw search string. Used when
 *  the user clicks the × on a chip. Matches the token's `raw` text exactly,
 *  trimming adjacent whitespace. */
function removeToken(input: string, raw: string): string {
  const re = new RegExp(`(^|\\s)${escapeRegExp(raw)}(?=\\s|$)`);
  return input.replace(re, '').replaceAll(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
