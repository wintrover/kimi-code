import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PolicyRule {
  id: string;
  patternType: 'ast' | 'regex' | 'command';
  language?: string;
  pattern: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'none';
  action: 'block' | 'warn' | 'allow';
  description: string;
}

export interface AstViolation {
  nodeType: string;
  language?: string;
}

export type PolicyDecision = {
  action: 'block' | 'warn' | 'allow';
  ruleId: string;
  riskLevel: string;
  description: string;
};

/* ------------------------------------------------------------------ */
/*  Minimal TOML parser for [[security_policy.rules]] arrays of tables */
/* ------------------------------------------------------------------ */

/** Parse a subset of TOML: key-value pairs, inline arrays of tables. */
function parseMinimalToml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');

  let currentArrayKey: string | null = null;
  let currentTableArray: Record<string, unknown>[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (line === '' || line.startsWith('#')) continue;

    // Array of tables: [[section.name]]
    const arrayTableMatch = line.match(/^\[\[(\w+)\.(\w+)\]\]$/);
    if (arrayTableMatch) {
      const containerKey = arrayTableMatch[1]!;
      const tableName = arrayTableMatch[2]!;

      if (containerKey !== currentArrayKey) {
        // Start a new container
        currentArrayKey = containerKey;
        currentTableArray = [];
        // Store the array under result[containerKey][tableName] so that
        // parseRulesFromToml can access it via parsed['security_policy']['rules'].
        if (typeof result[containerKey] !== 'object' || result[containerKey] === null || Array.isArray(result[containerKey])) {
          result[containerKey] = {};
        }
        (result[containerKey] as Record<string, unknown>)[tableName] = currentTableArray;
      }

      if (currentTableArray !== null) {
        currentTableArray.push({ _tableName: tableName });
      }
      continue;
    }

    // Single table header: [section]
    const singleTableMatch = line.match(/^\[(\w+)\]$/);
    if (singleTableMatch) {
      const key = singleTableMatch[1]!;
      if (result[key] === undefined) {
        result[key] = {};
      }
      currentArrayKey = null;
      currentTableArray = null;
      continue;
    }

    // Key-value: key = value
    const kvMatch = line.match(/^(\w[\w_]*)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const rawValue = kvMatch[2]!;
      const value = parseTomlValue(rawValue.trim());

      if (currentTableArray !== null && currentTableArray.length > 0) {
        const lastEntry = currentTableArray.at(-1)!;
        delete lastEntry['_tableName'];
        lastEntry[key] = value;
      } else if (currentArrayKey === null && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
        (result[key] as Record<string, unknown>)[key] = value;
      } else {
        result[key] = value;
      }
      continue;
    }
  }

  return result;
}

/** Parse a TOML value literal: strings, integers, booleans. */
function parseTomlValue(raw: string): unknown {
  // Bare string (no quotes)
  if (raw.startsWith('"') && raw.endsWith('"')) {
    // Basic string – unescape simple sequences
    return raw
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\\\', '\\')
      .replaceAll('\\"', '"');
  }

  // Multi-line basic string
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    return raw
      .slice(3, -3)
      .replace(/^\\n/, '')
      .replace(/\\n$/m, '')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\\\', '\\')
      .replaceAll('\\"', '"');
  }

  // Integer
  if (/^-?\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }

  // Float
  if (/^-?\d+\.\d+$/.test(raw)) {
    return parseFloat(raw);
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Inline array [val1, val2]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((v) => parseTomlValue(v.trim()))
      .filter((v) => v !== '');
  }

  // Bare string fallback
  return raw;
}

/* ------------------------------------------------------------------ */
/*  Default rules (baked-in when no file exists)                       */
/* ------------------------------------------------------------------ */

const DEFAULT_POLICY_TOML = `
[[security_policy.rules]]
id = "no-eval"
pattern_type = "regex"
pattern = "\\\\beval\\\\s*\\\\("
risk_level = "critical"
action = "block"
description = "Block eval() function calls"

[[security_policy.rules]]
id = "no-sudo"
pattern_type = "command"
pattern = "sudo *"
risk_level = "high"
action = "block"
description = "Block sudo commands"

[[security_policy.rules]]
id = "safe-git"
pattern_type = "command"
pattern = "git *"
risk_level = "none"
action = "allow"
description = "Allow git commands"
`;

function getDefaultPolicyPath(): string {
  return join(homedir(), '.kimi-code', 'security-policy.toml');
}

function parseRulesFromToml(text: string): PolicyRule[] {
  const parsed = parseMinimalToml(text);
  const container = parsed['security_policy'] as
    | Record<string, unknown>
    | undefined;

  if (container === undefined) return [];

  const rawRules = container['rules'];
  if (!Array.isArray(rawRules)) return [];

  return rawRules
    .filter(
      (r): r is Record<string, unknown> =>
        typeof r === 'object' && r !== null && !Array.isArray(r),
    )
    .map((r) => ({
      id: typeof r['id'] === 'string' ? r['id'] : '',
      patternType: normalizePatternType(r['pattern_type']),
      language: typeof r['language'] === 'string' ? r['language'] : undefined,
      pattern: typeof r['pattern'] === 'string' ? r['pattern'] : '',
      riskLevel: normalizeRiskLevel(r['risk_level']),
      action: normalizeAction(r['action']),
      description: typeof r['description'] === 'string' ? r['description'] : '',
    }))
    .filter((r) => r.id !== '' && r.pattern !== '');
}

/* ------------------------------------------------------------------ */
/*  Normalization helpers                                              */
/* ------------------------------------------------------------------ */

function normalizePatternType(
  value: unknown,
): 'ast' | 'regex' | 'command' {
  if (value === 'ast' || value === 'regex' || value === 'command') return value;
  return 'regex';
}

function normalizeRiskLevel(
  value: unknown,
): 'critical' | 'high' | 'medium' | 'none' {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'none')
    return value;
  return 'medium';
}

function normalizeAction(value: unknown): 'block' | 'warn' | 'allow' {
  if (value === 'block' || value === 'warn' || value === 'allow') return value;
  return 'warn';
}

/* ------------------------------------------------------------------ */
/*  Pattern matching                                                   */
/* ------------------------------------------------------------------ */

function matchRule(
  rule: PolicyRule,
  context: {
    toolName: string;
    command?: string;
    codeBlock?: string;
    language?: string;
    astViolations?: AstViolation[];
  },
): boolean {
  switch (rule.patternType) {
    case 'command': {
      if (context.command === undefined) return false;
      return minimatch(context.command, rule.pattern);
    }
    case 'regex': {
      const target = context.codeBlock ?? context.command ?? '';
      if (target === '') return false;
      try {
        const regex = new RegExp(rule.pattern);
        return regex.test(target);
      } catch {
        // Invalid regex – never match
        return false;
      }
    }
    case 'ast': {
      if (context.astViolations === undefined || context.astViolations.length === 0)
        return false;
      return context.astViolations.some((v) => {
        const typeMatch = minimatch(v.nodeType, rule.pattern);
        if (!typeMatch) return false;
        if (rule.language !== undefined && v.language !== undefined) {
          return v.language === rule.language;
        }
        return true;
      });
    }
  }
}

/** Simple glob-like matcher supporting only `*` as a wildcard. */
function minimatch(str: string, pattern: string): boolean {
  // Convert the simple glob pattern to a regex.
  // Escape all regex-special chars except *, then replace * with .*
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexStr = `^${escaped.replaceAll('*', '.*')}$`;
  try {
    return new RegExp(regexStr).test(str);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  PolicyEngine                                                       */
/* ------------------------------------------------------------------ */

export class PolicyEngine {
  private policyPath: string;
  private rules: readonly PolicyRule[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  /** Lock to prevent concurrent reads during a reload. */
  private reloadMutex: Promise<void> = Promise.resolve();

  constructor(policyPath?: string) {
    this.policyPath = policyPath ?? getDefaultPolicyPath();
  }

  /** Load rules from TOML file. Falls back to built-in defaults. */
  async load(): Promise<void> {
    let text: string;

    if (existsSync(this.policyPath)) {
      try {
        text = readFileSync(this.policyPath, 'utf-8');
      } catch {
        // Read error – fall back to defaults
        text = DEFAULT_POLICY_TOML;
      }
    } else {
      text = DEFAULT_POLICY_TOML;
    }

    const parsedRules = parseRulesFromToml(text);
    const newRules = parsedRules.length > 0 ? parsedRules : parseRulesFromToml(DEFAULT_POLICY_TOML);

    // Atomic swap: build the new list first, then assign.
    this.rules = Object.freeze([...newRules]);
  }

  /** Reload rules from disk. Thread-safe: concurrent calls are serialized. */
  private async reload(): Promise<void> {
    // Chain onto the previous reload so they serialize.
    this.reloadMutex = this.reloadMutex.then(() => this.load());
    await this.reloadMutex;
  }

  /** Evaluate a command/code against all rules. First match wins. */
  evaluate(context: {
    toolName: string;
    command?: string;
    codeBlock?: string;
    language?: string;
    astViolations?: AstViolation[];
  }): PolicyDecision | null {
    const currentRules = this.rules; // snapshot the frozen array for this evaluation

    for (const rule of currentRules) {
      if (matchRule(rule, context)) {
        return {
          action: rule.action,
          ruleId: rule.id,
          riskLevel: rule.riskLevel,
          description: rule.description,
        };
      }
    }

    return null;
  }

  /** Start watching the policy file for changes (hot-reload). */
  startWatcher(): void {
    if (this.watcher !== null) return;

    const dir = this.policyPath.includes('/')
      ? this.policyPath.substring(0, this.policyPath.lastIndexOf('/'))
      : '.';

    this.watcher = watch(dir, (_eventType, filename) => {
      if (filename !== null && this.policyPath.endsWith(filename)) {
        // Debounce: ignore events that fire in rapid succession by letting
        // the serialized reload chain deduplicate naturally.
        void this.reload();
      }
    });

    // Ensure the watcher does not keep the process alive.
    this.watcher.unref();
  }

  /** Stop watching. */
  stopWatcher(): void {
    if (this.watcher === null) return;
    this.watcher.close();
    this.watcher = null;
  }

  /** Get all loaded rules (for diagnostics). */
  getRules(): readonly PolicyRule[] {
    return this.rules;
  }
}
