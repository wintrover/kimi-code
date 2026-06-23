/**
 * PlanBoxComponent — renders an ExitPlanMode plan inside a full box
 * border, width-aware. The plan text is parsed as Markdown so headings,
 * lists, bold, inline code etc. render the same way assistant messages do.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import { Markdown, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { drawBorderedBox, SIDE_PADDING } from '#/tui/utils/draw-bordered-box';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2; // two-space indent matching other tool call children
const TITLE_PREFIX = ' plan: ';
const TITLE_SUFFIX = ' ';

const PLAN_CORNERS = { tl: '┌', tr: '┐', bl: '└', br: '┘' } as const;

export interface PlanBoxOptions {
  status?: {
    readonly label: string;
    readonly colorHex: string;
  };
}

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private readonly status: PlanBoxOptions['status'];
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderHex: string,
    private readonly planPath?: string,
    opts?: PlanBoxOptions,
  ) {
    // Build the Markdown instance once — pi-tui's Markdown caches its own
    // parse + wrap output keyed on (text, width), so reusing the same
    // instance means repeated render() calls from the parent Container
    // hit the cache instead of re-parsing on every frame.
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const horzLen = Math.max(2, width - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);
    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const title = this.buildTitle(horzLen);

    const lines = drawBorderedBox({
      lines: this.markdown.render(contentWidth),
      contentWidth,
      title,
      titlePosition: 'bottom',
      corners: PLAN_CORNERS,
      leftMargin: LEFT_MARGIN,
      paint,
    });

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private buildTitle(horzLen: number): string {
    const fallback = ' plan ';
    const statusSuffix = this.buildStatusSuffix();
    const fallbackWithStatus = ` plan${statusSuffix} `;
    const budget = horzLen - 1;
    const fallbackTitle = visibleWidth(fallbackWithStatus) <= budget ? fallbackWithStatus : fallback;
    const planPath = this.planPath;
    if (planPath === undefined || planPath.length === 0) return fallbackTitle;
    const basename = path.basename(planPath);
    if (basename.length === 0) return fallbackTitle;
    const linked = path.isAbsolute(planPath)
      ? toTerminalHyperlink(basename, pathToFileURL(planPath).href)
      : basename;
    const title = TITLE_PREFIX + linked + statusSuffix + TITLE_SUFFIX;
    if (visibleWidth(title) > budget) return fallbackTitle;
    return title;
  }

  private buildStatusSuffix(): string {
    const status = this.status;
    if (status === undefined || status.label.length === 0) return '';
    return ` · ${chalk.hex(status.colorHex)(status.label)}`;
  }
}
