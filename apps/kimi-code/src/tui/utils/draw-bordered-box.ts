/**
 * drawBorderedBox — shared helper that renders a bordered box with optional
 * title on the top or bottom border. Extracted from the duplicated layout
 * pattern in plan-box.ts, usage-panel.ts, and security-dashboard.ts.
 *
 * The caller is responsible for computing `contentWidth` and preparing the
 * content lines (including any colour). This helper only handles the border
 * geometry.
 */

import { visibleWidth } from '@earendil-works/pi-tui';

export const SIDE_PADDING = 1;

export interface BorderedBoxOptions {
  /** Pre-rendered content lines (may contain ANSI colour). */
  readonly lines: readonly string[];
  /** Width available for content between the side borders. */
  readonly contentWidth: number;
  /** Optional title embedded in one of the horizontal borders. */
  readonly title?: string;
  /** Which border carries the title. Defaults to `'top'`. */
  readonly titlePosition?: 'top' | 'bottom';
  /**
   * Border corner characters.
   * Defaults to rounded corners `{ tl: '╭', tr: '╮', bl: '╰', br: '╯' }`.
   */
  readonly corners?: { readonly tl: string; readonly tr: string; readonly bl: string; readonly br: string };
  /** Left margin in spaces. Defaults to `2`. */
  readonly leftMargin?: number;
  /** Colourize a border string (e.g. `chalk.hex(hex)` or `currentTheme.fg(token, s)`). */
  readonly paint: (s: string) => string;
}

/**
 * Renders a bordered box and returns the lines as a `string[]`.
 *
 * ```text
 *   ╭ title ─────────╮
 *   │ content        │
 *   ╰────────────────╯
 * ```
 */
export function drawBorderedBox(options: BorderedBoxOptions): string[] {
  const {
    lines,
    contentWidth,
    title,
    titlePosition = 'top',
    corners = { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
    leftMargin = 2,
    paint,
  } = options;

  const horzLen = contentWidth + 2 * SIDE_PADDING;
  const indent = ' '.repeat(leftMargin);

  const borderLine = (corner: string, endCorner: string, titleText?: string): string => {
    if (titleText !== undefined) {
      const trailingDashLen = Math.max(0, horzLen - visibleWidth(titleText));
      return indent + paint(corner) + paint(titleText) + paint('─'.repeat(trailingDashLen)) + paint(endCorner);
    }
    return indent + paint(corner + '─'.repeat(horzLen) + endCorner);
  };

  const topTitle = titlePosition === 'top' ? title : undefined;
  const bottomTitle = titlePosition === 'bottom' ? title : undefined;

  const out: string[] = [borderLine(corners.tl, corners.tr, topTitle)];
  for (const raw of lines) {
    const pad = Math.max(0, contentWidth - visibleWidth(raw));
    out.push(indent + paint('│') + ' ' + raw + ' '.repeat(pad) + ' ' + paint('│'));
  }
  out.push(borderLine(corners.bl, corners.br, bottomTitle));
  return out;
}
