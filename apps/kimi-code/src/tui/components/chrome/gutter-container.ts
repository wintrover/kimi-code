/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 *
 * When `maxHeight` is set, the output is clamped to that many lines. If the
 * rendered content exceeds the limit, the oldest (top) lines are dropped so
 * that the most recent content stays visible.
 */

import { Container } from '@earendil-works/pi-tui';

import type { RenderDiagnostics } from '#/tui/render-diagnostics';

export class GutterContainer extends Container {
  private maxHeight: number | undefined;
  private readonly renderDiagnostics: RenderDiagnostics | null;

  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
    maxHeight?: number,
    renderDiagnostics?: RenderDiagnostics,
  ) {
    super();
    this.maxHeight = maxHeight;
    this.renderDiagnostics = renderDiagnostics ?? null;
  }

  setMaxHeight(height: number | undefined): void {
    this.maxHeight = height;
  }

  getMaxHeight(): number | undefined {
    return this.maxHeight;
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);
    const out: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(inner)) {
        out.push(lead + line);
      }
    }
    if (this.maxHeight !== undefined && out.length > this.maxHeight) {
      this.renderDiagnostics?.record({
        type: 'clamp',
        caller: `lines=${out.length} maxH=${this.maxHeight} sliced=${out.length - this.maxHeight}`,
        force: false,
        depth: 0,
        suppressedCount: 0,
      });
      return out.slice(out.length - this.maxHeight);
    }
    return out;
  }
}
