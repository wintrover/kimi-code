# TUI Footer Duplication Bug — Root Cause & Fix

> **Status**: Resolved  
> **Date**: 2026-06-25  
> **Severity**: Visual corruption — footer rendered multiple times, terminal auto-scroll  
> **Scope**: `apps/kimi-code/src/tui/` (kimi-code TUI layer only, no pi-tui changes)

## Symptoms

1. Footer bar duplicated 2-3 times during long streaming sessions
2. Terminal auto-scrolling past the viewport
3. `[DUP: N]` counter in footer increasing (misleading — see below)
4. Worse with long conversations, tool-heavy sessions, or small terminal windows

## Key Misconception: What `[DUP]` Actually Measures

The `[DUP: N]` counter in the footer **does NOT measure duplicate rendering**. It counts `requestRender()` calls that occur outside an active `RenderTransaction` during streaming — i.e., "transaction leak" violations. A high DUP count is a code quality signal (unwrapped handlers), not a visual corruption indicator.

The actual duplicate rendering was caused by a completely different mechanism (see Root Cause).

## Root Cause

### The Overflow Mechanism

```
transcriptContainer.render() returns N lines
  + chrome lines (footer, editor, activity, etc.)
  = total rendered lines
  > terminal.rows
  → terminal auto-scroll
  → footer painted at bottom, then scrolled up, then painted again
  → visual duplication
```

The `transcriptContainer` (a `GutterContainer`) accumulated lines without any height limit. As conversations grew, `render()` could return 1000+ lines. When total output exceeded `terminal.rows`, the terminal emulator's auto-wrap/auto-scroll caused the footer to be painted multiple times at different Y coordinates.

### Why pi-tui Doesn't Prevent This

pi-tui's `fullRender()` writes ALL lines from the root container's `render()` output with `\r\n` separators. It does **not** clamp output to `terminal.rows` — this is **by design**. pi-tui uses a viewport state machine that tracks `viewportTop` to control which slice of the buffer is visible. The scrollback is intentional.

Hard-clamping in pi-tui would break:
- Viewport scroll tracking
- Scrollback navigation
- Differential render line diffing

### The Resize Gap

pi-tui's resize handler calls `requestRender({ force: true })`, which bypasses kimi-code's `RenderTransaction` monkey-patch for the actual render. Before the fix, `updateTranscriptBounds()` was NOT called during resize, leaving `maxHeight` stale for one render cycle.

## Solution: Layout Virtualization

### Architecture

```
terminal.rows
├── transcriptContainer (GutterContainer with maxHeight)  ← CLAMPED
│   └── [chat messages, tool outputs, streaming text]
├── activityContainer                                      ← dynamic
├── todoPanelContainer                                     ← dynamic
├── queueContainer                                         ← dynamic
├── btwPanelContainer                                      ← dynamic
├── editorContainer                                        ← fixed 3 lines
└── footerContainer                                        ← fixed 2 lines (FOOTER_HEIGHT)
```

**Constraint**: `transcriptHeight + chromeHeight ≤ terminal.rows`

### Implementation

#### 1. `GutterContainer.maxHeight` (gutter-container.ts)

Added `maxHeight` property with setter/getter. When set, `render()` clamps output:

```typescript
override render(width: number): string[] {
  // ... render children into `out` ...
  if (this.maxHeight !== undefined && out.length > this.maxHeight) {
    // Drop oldest (top) lines, keep most recent content
    return out.slice(out.length - this.maxHeight);
  }
  return out;
}
```

**Safety**: All 19 transcript child component types have NO internal viewport/cursor state — pure data accumulation. Slicing is safe.

#### 2. Chrome Height Measurement (kimi-tui.ts)

```typescript
private measureChromeHeight(): number {
  let chrome = FOOTER_HEIGHT + 3; // footer(2) + editor(3 minimum)
  if (this.currentActivityPane !== null) chrome += 2;
  if (!this.state.todoPanel.isEmpty()) chrome += 8;
  chrome += this.state.queuedMessages.length;
  return chrome;
}
```

Uses **previous frame's** chrome height (1-frame lag, imperceptible). This avoids the chicken-and-egg problem of measuring chrome that includes the transcript container itself.

#### 3. Bounds Update (kimi-tui.ts)

```typescript
private updateTranscriptBounds(): void {
  const rows = this.state.terminal.rows;
  const chromeHeight = this.cachedChromeHeight;
  const maxHeight = Math.max(1, rows - chromeHeight);
  this.state.transcriptContainer.setMaxHeight(maxHeight);
}
```

Called from:
- `setAppState()` — when app state changes
- `commitRenderBatch()` — after every render batch (primary path)
- Monkey-patch `requestRender` — on force render (resize fix)

#### 4. Resize Gap Fix (kimi-tui.ts constructor)

```typescript
this.state.ui.requestRender = (force?: boolean) => {
  // ... existing diagnostics ...
  if (depth > 0) return; // inside transaction — suppress
  
  // Force render (resize): recalculate bounds before passing through
  if (force) {
    this.updateTranscriptBounds();
  }
  originalRequestRender(force);
};
```

## Key Files

| File | Role |
|---|---|
| `apps/kimi-code/src/tui/components/chrome/gutter-container.ts` | `maxHeight` + slice logic + `clamp` diagnostic |
| `apps/kimi-code/src/tui/kimi-tui.ts` | `measureChromeHeight()`, `updateTranscriptBounds()`, resize fix |
| `apps/kimi-code/src/tui/tui-state.ts` | `transcriptContainer: GutterContainer` type, diagnostics wiring |
| `apps/kimi-code/src/tui/components/chrome/footer.ts` | `FOOTER_HEIGHT = 2` constant |
| `apps/kimi-code/src/tui/render-diagnostics.ts` | `'bounds'` and `'clamp'` event types |
| `apps/kimi-code/src/tui/render-transaction.ts` | `RenderTransaction` with `_isCommitting` flag |

## Diagnostic Tools

### `/render-log` Command

Dumps the `RenderDiagnostics` ring buffer to `/tmp/kimi-code/render-log-{timestamp}.jsonl`.

Enable with `KIMI_CODE_RENDER_DEBUG=1` (auto-set in `~/.kimi-code/bin/kimi`).

### Event Types

| Type | Meaning |
|---|---|
| `request` | `requestRender()` called |
| `suppress` | `requestRender()` suppressed inside transaction |
| `commit` | Transaction committed, render flushed |
| `flush` | Streaming buffer flushed |
| `bounds` | `updateTranscriptBounds()` called — `caller` has `rows=N chrome=N maxH=N` |
| `clamp` | `GutterContainer.render()` sliced output — `caller` has `lines=N maxH=N sliced=N` |

### Reading the Log

```bash
cat /tmp/kimi-code/render-log-*.jsonl | python3 -c "
import sys, json
from collections import Counter
types = Counter()
for line in sys.stdin:
    e = json.loads(line.strip())
    types[e.get('type','?')] += 1
for t, c in types.most_common(): print(f'  {t}: {c}')
"
```

### What to Look For

- **`bounds` events**: Verify `maxH` = `rows - chrome`. If `chrome` looks wrong, check `measureChromeHeight()`.
- **`clamp` events**: If `sliced` is 0 or very small, the transcript isn't growing past the limit — virtualization isn't the bottleneck.
- **No `clamp` events**: Either the transcript is small enough, or `maxHeight` isn't being set (check `bounds` events).
- **`clamp` with `sliced` very large**: Normal for long sessions. The transcript is being aggressively trimmed.

## Timeline

1. **2026-06-24**: Initial investigation — `_isCommitting` flag, handler wrapping for transaction leaks
2. **2026-06-25**: Exhaustive investigation — pi-tui rendering pipeline analysis, root cause identified
3. **2026-06-25**: Layout virtualization implemented — `GutterContainer.maxHeight`, chrome measurement
4. **2026-06-25**: Resize gap fix + diagnostic logging added
5. **2026-06-25**: Verified with `/render-log` — `clamp` events confirm 1301→35 line clamping

## Lessons Learned

1. **Don't confuse symptoms with causes**: The `[DUP]` counter was a red herring. Transaction leaks ≠ visual duplication.
2. **pi-tui's design is intentional**: Hard-clamping in the library would break scrollback. The fix belongs in the application layer.
3. **Resize is a special path**: pi-tui's `requestRender({ force: true })` bypasses normal transaction flow. Any bounds/state that affects rendering must be updated in the force-render path too.
4. **1-frame lag is acceptable**: Using the previous frame's chrome height avoids chicken-and-egg problems and is imperceptible to users.
5. **Slice safety requires audit**: Before slicing a container's output, verify that child components have no internal viewport/cursor state that would become inconsistent.
