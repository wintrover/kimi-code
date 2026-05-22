import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { VisWireRecord } from '../types';

export type FocusKind = 'turn_id' | 'tool_call_id' | 'agent_id' | 'step_uuid';

export interface Focus {
  kind: FocusKind;
  value: string;
}

interface FocusContextShape {
  focus: Focus | null;
  /** Toggle — clicking the same focused id again clears it. */
  toggle: (f: Focus) => void;
  clear: () => void;
}

const FocusCtx = createContext<FocusContextShape | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<Focus | null>(null);
  const toggle = useCallback((f: Focus) => {
    setFocus((prev) =>
      prev !== null && prev.kind === f.kind && prev.value === f.value ? null : f,
    );
  }, []);
  const clear = useCallback(() =>{  setFocus(null); }, []);
  // ESC clears the focus — one-liner keyboard affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () =>{  window.removeEventListener('keydown', onKey); };
  }, [clear]);
  const value = useMemo<FocusContextShape>(
    () => ({ focus, toggle, clear }),
    [focus, toggle, clear],
  );
  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocus(): FocusContextShape {
  const ctx = useContext(FocusCtx);
  if (ctx === null) {
    // Safe default so components outside a provider don't crash.
    return { focus: null, toggle: () => {}, clear: () => {} };
  }
  return ctx;
}

/**
 * A record "belongs to" the focused id when any of its identifiers matches.
 * Scope is intentionally broad per id kind so click-to-focus behaves like
 * "show me everything related to this thing":
 *
 *   turn_id      → all records with r.turn_id === value
 *   tool_call_id → the tool_call, its tool_result, any approval linked by id
 *   agent_id     → spawn/completed/failed + mail records mentioning this agent
 *   step_uuid    → the step_begin/end + content_parts + tool_calls under it
 */
export function recordMatchesFocus(r: VisWireRecord, focus: Focus | null): boolean {
  if (focus === null) return true;
  const { kind, value } = focus;
  const rec = r as Record<string, unknown>;
  const data = (rec['data'] as Record<string, unknown> | undefined) ?? undefined;

  switch (kind) {
    case 'turn_id':
      return rec['turn_id'] === value;

    case 'tool_call_id': {
      if (rec['tool_call_id'] === value) return true;
      if (data?.['tool_call_id'] === value) return true;
      if (data?.['parent_tool_call_id'] === value) return true;
      return false;
    }

    case 'agent_id': {
      if (rec['agent_id'] === value) return true;
      if (data?.['agent_id'] === value) return true;
      if (data?.['parent_agent_id'] === value) return true;
      if (data?.['from_agent'] === value) return true;
      if (data?.['to_agent'] === value) return true;
      return false;
    }

    case 'step_uuid':
      return rec['uuid'] === value || rec['step_uuid'] === value;
  }
  // Unreachable — `FocusKind` is exhausted above. Here to satisfy
  // consistent-return (switch-exhaustiveness isn't narrowed by the rule).
  return false;
}
