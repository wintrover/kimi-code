// Structured query language for the Wire tab's search box.
//
// Grammar (whitespace-separated; AND between tokens):
//   key:value            exact/contains match on a specific field
//   key:a,b,c            OR across values
//   key:!value           NOT match
//   key:>N / <N / >=N / <=N   numeric comparison (seq only)
//   bare word            substring match on full record JSON (fallback)
//
// Supported keys:
//   type   — r.type exact (OR-able, NOT-able)
//   tool   — tool_call.data.tool_name substring (also matches paired tool_result)
//   turn   — r.turn_id substring
//   seq    — numeric compare on r.seq
//   error  — boolean; true → records that represent failure/error states
//   agent  — substring over any agent_id field
//   id     — substring over any *_id / uuid field
//
// Unknown keys become `errors[]` entries; chip UI shows them in red.

import type { VisWireRecord, WireRecordType } from '../types';

export type TokenOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~';

export interface QueryToken {
  /** null = bare text token (substring across whole record). */
  key: string | null;
  op: TokenOp;
  /** Comma-split values; length >= 1 always. */
  values: string[];
  /** Source slice in the query string; useful to rewrite/remove a single chip. */
  raw: string;
}

export interface ParsedQuery {
  tokens: QueryToken[];
  errors: { token: string; reason: string }[];
}

const KNOWN_KEYS = new Set(['type', 'tool', 'turn', 'seq', 'error', 'agent', 'id']);

export function parseQuery(input: string): ParsedQuery {
  const tokens: QueryToken[] = [];
  const errors: { token: string; reason: string }[] = [];
  // Simple whitespace split — no quoted-string support yet (keep it minimal).
  const parts = input.split(/\s+/).filter((s) => s.length > 0);
  for (const raw of parts) {
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      tokens.push({ key: null, op: '~', values: [raw], raw });
      continue;
    }
    const key = raw.slice(0, colon);
    let rest = raw.slice(colon + 1);
    let op: TokenOp = '=';
    if (rest.startsWith('!')) {
      op = '!=';
      rest = rest.slice(1);
    } else if (rest.startsWith('>=')) {
      op = '>=';
      rest = rest.slice(2);
    } else if (rest.startsWith('<=')) {
      op = '<=';
      rest = rest.slice(2);
    } else if (rest.startsWith('>')) {
      op = '>';
      rest = rest.slice(1);
    } else if (rest.startsWith('<')) {
      op = '<';
      rest = rest.slice(1);
    }
    const values = rest.split(',').filter((s) => s.length > 0);
    if (values.length === 0) {
      errors.push({ token: raw, reason: 'missing value' });
      continue;
    }
    if (!KNOWN_KEYS.has(key)) {
      errors.push({
        token: raw,
        reason: `unknown key "${key}" — try: ${[...KNOWN_KEYS].join(', ')}`,
      });
      // Still push so the chip can render (in red) and be removable.
      tokens.push({ key, op, values, raw });
      continue;
    }
    tokens.push({ key, op, values, raw });
  }
  return { tokens, errors };
}

/** Pre-compute helper sets used by some matchers. Call once per records[] + query. */
export interface MatchContext {
  /** tool_call_ids of tool_call records whose tool_name matches a `tool:` token. */
  toolMatchingCallIds: Set<string>;
}

export function buildMatchContext(
  records: readonly VisWireRecord[],
  query: ParsedQuery,
): MatchContext {
  const ctx: MatchContext = { toolMatchingCallIds: new Set() };
  const toolTokens = query.tokens.filter((t) => t.key === 'tool');
  if (toolTokens.length === 0) return ctx;
  for (const r of records) {
    if (r.type !== 'tool_call') continue;
    const name = getToolName(r);
    if (name === null) continue;
    const lower = name.toLowerCase();
    const anyMatch = toolTokens.every((t) => matchTextToken(lower, t));
    if (!anyMatch) continue;
    const id = getToolCallId(r);
    if (id !== null) ctx.toolMatchingCallIds.add(id);
  }
  return ctx;
}

export function matchesQuery(
  record: VisWireRecord,
  query: ParsedQuery,
  ctx: MatchContext,
): boolean {
  if (query.tokens.length === 0) return true;
  for (const token of query.tokens) {
    if (!matchesOne(record, token, ctx)) return false;
  }
  return true;
}

function matchesOne(r: VisWireRecord, t: QueryToken, ctx: MatchContext): boolean {
  if (t.key === null) {
    // Bare text — fallback to JSON substring, case-insensitive.
    const needle = (t.values[0] ?? '').toLowerCase();
    if (needle.length === 0) return true;
    try {
      return JSON.stringify(r).toLowerCase().includes(needle);
    } catch {
      return false;
    }
  }
  switch (t.key) {
    case 'type':
      return matchType(r.type, t);
    case 'tool':
      return matchTool(r, t, ctx);
    case 'turn':
      return matchText(getField(r, 'turn_id'), t);
    case 'seq':
      return matchNumber(r.seq, t);
    case 'error':
      return matchError(r, t);
    case 'agent':
      return matchAgent(r, t);
    case 'id':
      return matchAnyId(r, t);
    default:
      // Unknown key — treat as no-match so chip is clearly inert.
      return false;
  }
}

function matchType(type: WireRecordType, t: QueryToken): boolean {
  const hit = t.values.includes(type);
  return t.op === '!=' ? !hit : hit;
}

function matchTool(r: VisWireRecord, t: QueryToken, ctx: MatchContext): boolean {
  if (r.type === 'tool_call') {
    const name = getToolName(r);
    return name !== null && matchTextToken(name.toLowerCase(), t);
  }
  if (r.type === 'tool_result') {
    const id = getField(r, 'tool_call_id');
    return id !== null && ctx.toolMatchingCallIds.has(id);
  }
  if (r.type === 'tool_denied') {
    const name = (getField(r, 'data.tool_name') ?? '').toLowerCase();
    return matchTextToken(name, t);
  }
  return false;
}

function matchText(value: string | null, t: QueryToken): boolean {
  if (value === null) return t.op === '!=';
  return matchTextToken(value.toLowerCase(), t);
}

function matchTextToken(haystackLower: string, t: QueryToken): boolean {
  const hit = textHit(haystackLower, t);
  return t.op === '!=' ? !hit : hit;
}

/** Pure "does this haystack contain any of the token values?" — no op
 *  inversion. Callers that check multiple candidate fields must invert
 *  the combined result themselves, otherwise `agent:!abc` over a record
 *  that has one matching field and three null fields would incorrectly
 *  flip for the null fields and report success. */
function textHit(haystackLower: string, t: QueryToken): boolean {
  return t.values.some((v) => haystackLower.includes(v.toLowerCase()));
}

function matchNumber(value: number, t: QueryToken): boolean {
  const n = Number(t.values[0]);
  if (!Number.isFinite(n)) return false;
  switch (t.op) {
    case '>':
      return value > n;
    case '<':
      return value < n;
    case '>=':
      return value >= n;
    case '<=':
      return value <= n;
    case '!=':
      return value !== n;
    case '=':
    case '~':
      return value === n;
    default:
      return false;
  }
}

function matchError(r: VisWireRecord, t: QueryToken): boolean {
  const want = (t.values[0] ?? 'true').toLowerCase() !== 'false';
  const isError =
    r.type === 'subagent_failed' ||
    r.type === 'tool_denied' ||
    (r.type === 'tool_result' && (r as { is_error?: boolean }).is_error === true) ||
    (r.type === 'turn_end' && (r as { success?: boolean }).success === false);
  return want ? isError : !isError;
}

function matchAgent(r: VisWireRecord, t: QueryToken): boolean {
  const candidates: string[] = [
    getField(r, 'agent_id'),
    getField(r, 'data.agent_id'),
    getField(r, 'parent_agent_id'),
    getField(r, 'data.parent_agent_id'),
  ].filter((c): c is string => c !== null);
  return matchAcrossCandidates(candidates, t);
}

function matchAnyId(r: VisWireRecord, t: QueryToken): boolean {
  const candidates: string[] = [
    getField(r, 'uuid'),
    getField(r, 'step_uuid'),
    getField(r, 'turn_id'),
    getField(r, 'tool_call_id'),
    getField(r, 'session_id'),
    getField(r, 'agent_id'),
    getField(r, 'data.agent_id'),
    getField(r, 'data.tool_call_id'),
    getField(r, 'data.mail_id'),
  ].filter((c): c is string => c !== null);
  return matchAcrossCandidates(candidates, t);
}

/** op='=' : any candidate contains any token value
 *  op='!=': NO candidate contains any token value
 *  Handles the op inversion at the aggregate level so records with
 *  multiple candidate fields behave sanely (the per-field `matchTextToken`
 *  would flip on each null/non-match independently — wrong for multi-field
 *  records). */
function matchAcrossCandidates(candidates: string[], t: QueryToken): boolean {
  const anyHit = candidates.some((c) => textHit(c.toLowerCase(), t));
  return t.op === '!=' ? !anyHit : anyHit;
}

// ── field access helpers ─────────────────────────────────────────────

function getField(r: VisWireRecord, path: string): string | null {
  const parts = path.split('.');
  let cur: unknown = r;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : null;
}

function getToolName(r: VisWireRecord): string | null {
  // Prefer `tool_call.data.tool_name`; fall back to a legacy top-level field
  // for older records.
  const data = (r as { data?: Record<string, unknown> }).data;
  if (data && typeof data['tool_name'] === 'string') return data['tool_name'];
  const top = (r as Record<string, unknown>)['tool_name'];
  return typeof top === 'string' ? top : null;
}

function getToolCallId(r: VisWireRecord): string | null {
  const data = (r as { data?: Record<string, unknown> }).data;
  if (data && typeof data['tool_call_id'] === 'string') return data['tool_call_id'];
  const top = (r as Record<string, unknown>)['tool_call_id'];
  return typeof top === 'string' ? top : null;
}
