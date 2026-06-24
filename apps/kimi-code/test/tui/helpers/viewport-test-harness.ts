import type { Component, Terminal } from '@earendil-works/pi-tui';
import { TUI } from '@earendil-works/pi-tui';

/**
 * Headless fake terminal that captures all write() output.
 * Extended from the pattern in approval-preview.test.ts.
 */
export function fakeTerminal(rows: number, columns = 120): Terminal & { written: string[] } {
  const written: string[] = [];
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: (data: string) => { written.push(data); },
    get columns() { return columns; },
    get rows() { return rows; },
    get kittyProtocolActive() { return false; },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    written,
  };
}

/**
 * Simple component that returns a mutable line array.
 * Call setLines() between renders to simulate content changes.
 */
export function createMockComponent(initialLines: string[]): Component & { setLines: (lines: string[]) => void } {
  let currentLines = initialLines;
  return {
    render: () => currentLines,
    invalidate: () => {},
    setLines: (lines: string[]) => { currentLines = lines; },
  };
}

/**
 * Create a headless TUI instance with internal state accessible for testing.
 * JS has no runtime `private`, so `(tui as any)` gives full access to state fields.
 */
export function createHeadlessTUI(rows: number, cols: number) {
  const terminal = fakeTerminal(rows, cols);
  const tui = new TUI(terminal) as any;
  return { tui, terminal };
}
