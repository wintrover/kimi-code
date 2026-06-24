import { describe, it, expect, beforeEach } from 'vitest';

import {
  safeMatchesKey,
  normalizeKeyData,
  Key,
} from '#/tui/utils/key-input-adapter';

describe('safeMatchesKey', () => {
  it('matches ctrl+d under caps_lock (the pi-tui bug)', () => {
    // ctrl(4) + caps_lock(64) = 68, reported = 69.
    // Raw sequence: ESC[68;69u — pi-tui would reject this, but safeMatchesKey normalizes it.
    const capsLockCtrlD = '\u001B[68;69u';
    expect(safeMatchesKey(capsLockCtrlD, Key.ctrl('d'))).toBe(true);
  });

  it('matches ctrl+c under caps_lock', () => {
    const capsLockCtrlC = '\u001B[67;69u';
    expect(safeMatchesKey(capsLockCtrlC, Key.ctrl('c'))).toBe(true);
  });

  it('matches regular (non-caps-lock) ctrl+d', () => {
    const ctrlD = '\u001B[100;5u';
    expect(safeMatchesKey(ctrlD, Key.ctrl('d'))).toBe(true);
  });

  it('matches escape key', () => {
    // Legacy escape
    expect(safeMatchesKey('\u001B', Key.escape)).toBe(true);
  });

  it('does not match wrong key', () => {
    const ctrlD = '\u001B[100;5u';
    expect(safeMatchesKey(ctrlD, Key.ctrl('c'))).toBe(false);
  });

  it('matches ctrl+alt+letter under caps_lock', () => {
    // alt(2) + ctrl(4) + caps_lock(64) = 70, reported = 71
    expect(safeMatchesKey('\u001B[68;71u', Key.ctrlAlt('d'))).toBe(true);
  });

  it('matches ctrl+shift+letter under caps_lock (shift is explicit)', () => {
    // shift(1) + ctrl(4) + caps_lock(64) = 69, reported = 70.
    // pi-tui correctly matches this because the uppercase codepoint (68 = 'D')
    // is what you'd expect with shift held — no normalization needed.
    const capsLockShiftCtrlD = '\u001B[68;70u';
    expect(safeMatchesKey(capsLockShiftCtrlD, Key.ctrlShift('d'))).toBe(true);
  });
});

describe('normalizeKeyData', () => {
  it('returns the same string when input is not a Kitty CSI-u sequence', () => {
    expect(normalizeKeyData('H')).toBe('H');
    expect(normalizeKeyData('\u0004')).toBe('\u0004'); // ctrl+d legacy
    expect(normalizeKeyData('\u001B[A')).toBe('\u001B[A'); // arrow CSI
    expect(normalizeKeyData('')).toBe('');
  });

  it('rewrites ctrl+D under caps_lock back to ctrl+d', () => {
    expect(normalizeKeyData('\u001B[68;69u')).toBe('\u001B[100;5u');
  });

  it('leaves ctrl+letter without caps_lock alone', () => {
    expect(normalizeKeyData('\u001B[100;5u')).toBe('\u001B[100;5u');
  });

  it('leaves plain uppercase (caps_lock only) alone', () => {
    // caps_lock(64) alone = 64, reported = 65
    expect(normalizeKeyData('\u001B[68;65u')).toBe('\u001B[68;65u');
  });
});
