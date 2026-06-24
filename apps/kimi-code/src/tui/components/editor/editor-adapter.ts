/**
 * EditorAdapter — single entry point for all pi-tui private/internal access.
 *
 * Every `as unknown as` cast that reaches into pi-tui's undocumented fields
 * lives here. When pi-tui renames an internal, only this file needs updating.
 *
 * Public API usage (Container, Text, Markdown, etc.) does NOT go through this
 * adapter — pi-tui's semver protects those symbols.
 */

import type { SelectList, SelectItem } from '@earendil-works/pi-tui';

// ─── Mirrored pi-tui layout constants ────────────────────────────────────

/**
 * Mirror of pi-tui's private SLASH_COMMAND_SELECT_LIST_LAYOUT
 * (dist/components/editor.js); keep in sync when bumping pi-tui.
 */
export const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
} as const;

/**
 * Mirror of pi-tui's private select-list layout constants
 * (dist/components/select-list.js); keep in sync when bumping pi-tui.
 */
export const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
export const PRIMARY_COLUMN_GAP = 2;
export const MIN_DESCRIPTION_WIDTH = 10;

// ─── Reverse-engineered shapes of pi-tui private internals ──────────────

interface AutocompleteInternals {
  cancelAutocomplete(): void;
  readonly autocompleteAbort?: AbortController;
  readonly autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
}

interface AutocompleteListFactoryInternals {
  createAutocompleteList?: (prefix: string, items: SelectItem[]) => SelectList;
}

export interface SelectListInternals {
  readonly filteredItems: SelectItem[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly theme: import('@earendil-works/pi-tui').SelectListTheme;
  readonly layout: import('@earendil-works/pi-tui').SelectListLayoutOptions;
}

// ─── Editor private field access ─────────────────────────────────────────

/** Override pi-tui's private `createAutocompleteList` factory method. */
export function overrideCreateAutocompleteList(
  editor: unknown,
  factory: (prefix: string, items: SelectItem[]) => SelectList,
): void {
  (editor as AutocompleteListFactoryInternals).createAutocompleteList = factory;
}

/** Read the private `pastes` map from pi-tui's Editor. */
export function getEditorPastes(editor: unknown): Map<number, string> {
  return (editor as { pastes: Map<number, string> }).pastes;
}

/** Check if autocomplete is in-flight (pending request or debounce timer). */
export function hasAutocompleteActivity(editor: unknown): boolean {
  const ac = editor as AutocompleteInternals;
  return ac.autocompleteAbort !== undefined || ac.autocompleteDebounceTimer !== undefined;
}

/** Cancel an in-flight autocomplete request (pi-tui's private method). */
export function cancelAutocomplete(editor: unknown): void {
  (editor as AutocompleteInternals).cancelAutocomplete();
}

// ─── SelectList private field access ─────────────────────────────────────

/** Read pi-tui SelectList's private row state for custom rendering. */
export function getSelectListInternals(selectList: unknown): SelectListInternals {
  return selectList as SelectListInternals;
}
