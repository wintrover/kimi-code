/**
 * Key input adapter — wraps pi-tui's keyboard APIs with Caps Lock normalization.
 *
 * When Kitty keyboard protocol is active AND caps_lock is on, terminals emit
 * capitalized codepoints for ctrl+letter sequences (e.g. ESC[68;69u for ctrl+d
 * instead of ESC[100;5u). pi-tui's `matchesKey` masks caps_lock from the
 * modifier but not the codepoint, causing every ctrl-shortcut to silently fail.
 *
 * This adapter centralizes the workaround so call sites just use `safeMatchesKey`
 * instead of `matchesKey`, and `normalizeKeyData` when they need the cleaned
 * string for purposes beyond matching (buffer storage, `isKeyRelease`, etc.).
 *
 * TODO(upstream): pi-tui bug — Kitty keyboard protocol + Caps Lock produces
 * capitalized codepoints that matchesKey fails to match.
 * When a future pi-tui release includes the fix, set this to true or remove
 * the adapter entirely.
 */

import {
  matchesKey as piTuiMatchesKey,
  Key,
  isKeyRelease,
  decodeKittyPrintable,
} from '@earendil-works/pi-tui';
import type { KeyId } from '@earendil-works/pi-tui';

// ── Feature flag ─────────────────────────────────────────────────────────────
// Set to true once upstream pi-tui ships a fix for the Caps Lock + Kitty
// codepoint mismatch.  When true, normalization is bypassed entirely.
const PI_TUI_BUG_CAPS_LOCK_FIXED = false;

// ── Kitty CSI-u normalization constants ──────────────────────────────────────
// Kitty keyboard protocol CSI-u sequence: ESC [ keycode ; modifier[:eventType] u.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match CSI
const KITTY_CSI_U = /^\u001B\[(\d+);(\d+)((?::\d+)*)u$/;
// Kitty modifier bit layout: shift=1, alt=2, ctrl=4, super=8, hyper=16,
// meta=32, caps_lock=64, num_lock=128. Reported value is `mask + 1`.
const CAPS_LOCK_BIT = 64;
const CTRL_BIT = 4;
const SHIFT_BIT = 1;

// ── Core normalization ───────────────────────────────────────────────────────

/**
 * Normalize a raw key data string for Caps Lock + Kitty keyboard protocol.
 *
 * When Caps Lock is active, ctrl+\<letter\> produces capitalized codepoints
 * (e.g. ESC[68;69u for ctrl+d instead of ESC[100;5u). pi-tui's matchesKey
 * masks caps_lock from the modifier but not the codepoint, causing mismatches.
 * This function rewrites the sequence back to its unlocked form.
 *
 * Only rewrites when ctrl is held, shift is NOT held, and the codepoint is
 * in the A-Z range.  Plain uppercase (caps_lock only) and ctrl+shift+letter
 * are left alone.
 */
export function normalizeKeyData(data: string): string {
  if (PI_TUI_BUG_CAPS_LOCK_FIXED) return data;

  const m = data.match(KITTY_CSI_U);
  if (m === null) return data;
  const codepoint = Number(m[1]);
  const modifierPlus1 = Number(m[2]);
  const tail = m[3] ?? '';
  if (!Number.isFinite(codepoint) || !Number.isFinite(modifierPlus1)) return data;
  const modifier = modifierPlus1 - 1;
  if ((modifier & CAPS_LOCK_BIT) === 0) return data;
  if ((modifier & CTRL_BIT) === 0) return data;
  if ((modifier & SHIFT_BIT) !== 0) return data;
  if (codepoint < 65 || codepoint > 90) return data;
  const loweredCodepoint = codepoint + 32;
  const strippedModifier = (modifier & ~CAPS_LOCK_BIT) + 1;
  return `\u001B[${String(loweredCodepoint)};${String(strippedModifier)}${tail}u`;
}

// ── Safe wrapper ─────────────────────────────────────────────────────────────

/**
 * Wrapper around pi-tui's `matchesKey` with Caps Lock normalization.
 *
 * Use this instead of `matchesKey` for all key comparisons that may encounter
 * Kitty keyboard protocol sequences.  The normalization is applied transparently
 * before delegating to pi-tui.
 */
export function safeMatchesKey(data: string, keyId: KeyId): boolean {
  return piTuiMatchesKey(normalizeKeyData(data), keyId);
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export {
  Key,
  isKeyRelease,
  decodeKittyPrintable,
  piTuiMatchesKey as matchesKey,
};
export type { KeyId };
