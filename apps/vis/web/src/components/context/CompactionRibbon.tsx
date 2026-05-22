interface CompactionRibbonProps {
  summary: string;
  seq: number;
}

/**
 * Horizontal ribbon marker where a compaction occurred in the message stream.
 * Derivation is best-effort from the annotated message stream; if a compaction
 * was applied, buildAnnotatedMessages emits a summary assistant message. We
 * detect the prior "break" via seq discontinuity, but for now we render a
 * stand-alone banner wherever the caller places it.
 */
export function CompactionRibbon({ summary, seq }: CompactionRibbonProps) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--color-compaction)] opacity-50" />
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-compaction)]">
        ⏪ compacted · seq {seq}
      </span>
      <span className="h-px flex-1 bg-[var(--color-compaction)] opacity-50" />
      {summary ? (
        <div className="mt-2 text-fg-2">
          <pre className="whitespace-pre-wrap font-mono text-[12px]">{summary}</pre>
        </div>
      ) : null}
    </div>
  );
}
