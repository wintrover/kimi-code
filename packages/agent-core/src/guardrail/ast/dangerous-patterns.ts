/**
 * Dangerous AST patterns database.
 *
 * Each entry is a declarative rule consumed by the shell AST analyzer middleware.
 * Patterns are data-only — no evaluation logic lives here.
 */

export type PatternLanguage = 'bash' | 'javascript' | 'python' | 'nim' | '*';

export type RiskLevel = 'critical' | 'high' | 'medium';

export type PatternAction = 'block' | 'warn';

export interface DangerousPattern {
  /** Unique rule identifier, e.g. `'no-eval'`. */
  id: string;
  /** Target language. `'*'` matches any language. */
  language: PatternLanguage;
  /** Tree-sitter node types to match. */
  nodeTypes: string[];
  /** Optional regex patterns matched against node text. */
  textPatterns?: string[];
  /** Assessed severity of the pattern. */
  riskLevel: RiskLevel;
  /** Recommended action when the pattern is detected. */
  action: PatternAction;
  /** Neutral description of what the pattern does. */
  description: string;
  /** Categorisation tags, e.g. `['code-execution', 'privilege-escalation']`. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const patterns: readonly DangerousPattern[] = [
  // ── Bash ──────────────────────────────────────────────────────────────────

  {
    id: 'bash-eval',
    language: 'bash',
    nodeTypes: ['command_name'],
    textPatterns: ['^eval$', '^exec$'],
    riskLevel: 'critical',
    action: 'block',
    description:
      'The eval/exec builtin re-parses and executes its arguments as shell code.',
    tags: ['code-execution'],
  },

  {
    id: 'bash-rm-rf-root',
    language: 'bash',
    nodeTypes: ['command'],
    textPatterns: ['rm\\s+(-\\S*\\s+)*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+(-\\S*\\s+)*(/|~)'],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Recursive forced removal targeting the filesystem root or home directory.',
    tags: ['filesystem-destruction'],
  },

  {
    id: 'bash-sudo',
    language: 'bash',
    nodeTypes: ['command_name'],
    textPatterns: ['^sudo$'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Elevates command privileges via superuser execution.',
    tags: ['privilege-escalation'],
  },

  {
    id: 'bash-ld-preload',
    language: 'bash',
    nodeTypes: ['variable_assignment', 'command'],
    textPatterns: ['LD_PRELOAD', 'LD_LIBRARY_PATH'],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Overrides shared library loading paths, which can inject arbitrary native code into processes.',
    tags: ['code-injection', 'privilege-escalation'],
  },

  {
    id: 'bash-chmod-suid',
    language: 'bash',
    nodeTypes: ['command'],
    textPatterns: ['chmod\\s+(-\\S*\\s+)*(\\+s|4[0-7]{3}|2[0-7]{3})'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Sets the setuid or setgid bit on a file, granting elevated privileges to the binary.',
    tags: ['privilege-escalation'],
  },

  {
    id: 'bash-chmod-777',
    language: 'bash',
    nodeTypes: ['command'],
    textPatterns: ['chmod\\s+(-\\S*\\s+)*777'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Grants world-writable permissions on a file or directory.',
    tags: ['filesystem-destruction', 'privilege-escalation'],
  },

  {
    id: 'bash-pipe-to-shell',
    language: 'bash',
    nodeTypes: ['pipeline'],
    textPatterns: ['\\|\\s*(ba)?sh(\\s|$)'],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Pipes output directly into a shell interpreter for execution.',
    tags: ['code-execution', 'remote-code-execution'],
  },

  {
    id: 'bash-curl-pipe-bash',
    language: 'bash',
    nodeTypes: ['pipeline', 'command'],
    textPatterns: ['curl\\s+[^|]*\\|\\s*(ba)?sh', 'wget\\s+[^|]*\\|\\s*(ba)?sh'],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Downloads content from a remote URL and pipes it directly into a shell interpreter.',
    tags: ['remote-code-execution'],
  },

  {
    id: 'bash-hidden-dangerous-output',
    language: 'bash',
    nodeTypes: ['redirect'],
    textPatterns: ['>/dev/null\\s+2>&1|2>&1\\s+>/dev/null'],
    riskLevel: 'medium',
    action: 'warn',
    description:
      'Suppresses both stdout and stderr, which can hide errors or warnings from dangerous commands.',
    tags: ['output-suppression'],
  },

  // ── JavaScript / TypeScript ───────────────────────────────────────────────

  {
    id: 'js-eval',
    language: 'javascript',
    nodeTypes: ['call_expression'],
    textPatterns: ['\\beval\\s*\\('],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Passes a string to the eval function, which is interpreted as code at runtime.',
    tags: ['code-execution'],
  },

  {
    id: 'js-function-constructor',
    language: 'javascript',
    nodeTypes: ['call_expression', 'new_expression'],
    textPatterns: ['new\\s+Function\\s*\\(|Function\\s*\\('],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Dynamically constructs a function from a string body, equivalent to eval.',
    tags: ['code-execution'],
  },

  {
    id: 'js-child-process-require',
    language: 'javascript',
    nodeTypes: ['call_expression'],
    textPatterns: ['require\\s*\\(\\s*[\'"]child_process[\'"]\\s*\\)'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Imports the child_process module, enabling spawning of system processes.',
    tags: ['code-execution', 'system-access'],
  },

  {
    id: 'js-process-binding',
    language: 'javascript',
    nodeTypes: ['call_expression'],
    textPatterns: ['process\\.binding\\s*\\('],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Accesses internal Node.js bindings, which can bypass sandboxing and access native APIs.',
    tags: ['sandbox-escape'],
  },

  // ── Python ────────────────────────────────────────────────────────────────

  {
    id: 'py-exec',
    language: 'python',
    nodeTypes: ['call'],
    textPatterns: ['\\bexec\\s*\\('],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Executes dynamically constructed code via the exec builtin or function.',
    tags: ['code-execution'],
  },

  {
    id: 'py-eval',
    language: 'python',
    nodeTypes: ['call'],
    textPatterns: ['\\beval\\s*\\('],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Evaluates a dynamically constructed expression at runtime.',
    tags: ['code-execution'],
  },

  {
    id: 'py-os-system',
    language: 'python',
    nodeTypes: ['call'],
    textPatterns: ['os\\.system\\s*\\('],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Runs a shell command via os.system, passing the command string to the system shell.',
    tags: ['code-execution', 'system-access'],
  },

  {
    id: 'py-subprocess-shell-true',
    language: 'python',
    nodeTypes: ['call'],
    textPatterns: ['subprocess\\.(call|run|Popen|check_output|check_call)\\s*\\([^)]*shell\\s*=\\s*True'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Invokes a subprocess with shell=True, enabling shell metacharacter interpretation.',
    tags: ['code-execution', 'system-access'],
  },

  {
    id: 'py-import-call',
    language: 'python',
    nodeTypes: ['call'],
    textPatterns: ['__import__\\s*\\('],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Dynamically imports a module by name at runtime, which may load untrusted code.',
    tags: ['code-execution'],
  },

  // ── Nim ───────────────────────────────────────────────────────────────────

  {
    id: 'nim-cast',
    language: 'nim',
    nodeTypes: ['cast'],
    textPatterns: ['cast\\['],
    riskLevel: 'critical',
    action: 'block',
    description:
      'Performs an unchecked type reinterpretation, bypassing memory safety guarantees.',
    tags: ['memory-safety'],
  },

  {
    id: 'nim-unsafe-addr',
    language: 'nim',
    nodeTypes: ['command'],
    textPatterns: ['unsafeAddr'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Obtains a raw pointer to a memory location, bypassing borrow-checker protections.',
    tags: ['memory-safety'],
  },

  {
    id: 'nim-exec-cmd',
    language: 'nim',
    nodeTypes: ['call'],
    textPatterns: ['\\bexecCmd\\b', '\\bexecProcess\\b'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Executes an external command or process via the system shell.',
    tags: ['code-execution', 'system-access'],
  },

  {
    id: 'nim-gorge',
    language: 'nim',
    nodeTypes: ['call'],
    textPatterns: ['\\bgorge\\b', '\\bgorgeEx\\b'],
    riskLevel: 'high',
    action: 'warn',
    description:
      'Executes a shell command at compile time and captures its output.',
    tags: ['code-execution', 'compile-time-execution'],
  },
] as const satisfies readonly DangerousPattern[];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { patterns as DANGEROUS_PATTERNS };

/** All defined pattern ids, in definition order. */
export const ALL_PATTERN_IDS: readonly string[] = patterns.map((p) => p.id);

/** Return every pattern whose `language` matches the query or is `'*'`. */
export function getPatternsByLanguage(language: string): DangerousPattern[] {
  return patterns.filter(
    (p) => p.language === language || p.language === '*',
  );
}

/** Look up a single pattern by its id. */
export function getPatternById(id: string): DangerousPattern | undefined {
  return patterns.find((p) => p.id === id);
}
