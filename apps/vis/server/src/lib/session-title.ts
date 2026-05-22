import type { SessionState } from './types';

function titleString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readSessionTitle(state: SessionState | null | undefined): string | null {
  if (state === null || state === undefined) return null;
  if (typeof state.isCustomTitle === 'boolean') {
    const title = titleString(state.title);
    if (title !== null) return title;
  }
  return (
    titleString(state.customTitle) ??
    titleString(state.custom_title) ??
    titleString(state.title)
  );
}

export function readSessionLastPrompt(state: SessionState | null | undefined): string | null {
  if (state === null || state === undefined) return null;
  return titleString(state.lastPrompt) ?? titleString(state.last_prompt);
}
