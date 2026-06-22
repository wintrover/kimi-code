/**
 * bash-analyzer — web-tree-sitter based AST analysis for bash commands.
 *
 * Parses a bash command string into an AST and walks it to detect
 * dangerous node patterns relevant to shell command guardrails.
 *
 * HARD CONSTRAINT: Uses web-tree-sitter WASM ONLY.
 * ❌ NEVER import from 'tree-sitter' (native addon, ABI fragmentation)
 * ❌ NEVER use relative './vendor/...' paths (CWD-dependent)
 *
 * Singleton parser pattern: lazy-init, cached in module-level variable.
 * Graceful fallback: if WASM unavailable, returns empty violations array
 * (the regex fallback in middleware will handle it).
 */

import { getParserForGrammar, type GrammarSpec } from './wasm-loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AstViolation {
  /** tree-sitter node type, e.g. 'command_name' */
  nodeType: string;
  /** the matched text */
  text: string;
  /** 1-based line number */
  line: number;
  /** 0-based column number */
  column: number;
  /** which rule triggered */
  rule: string;
  riskLevel: 'critical' | 'high' | 'medium';
  /** neutral description */
  description: string;
}

export interface BashAnalysisResult {
  /** Detected violations (empty array if no issues or if WASM is unavailable) */
  violations: AstViolation[];
  /** Whether the analysis fell back to no-op (WASM unavailable) */
  fallback: boolean;
  /** Reason for fallback, if any */
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Tree-sitter minimal type definitions (same pattern as ast-analyzer.ts)
// ---------------------------------------------------------------------------

interface TreeSitterNode {
  type: string;
  childCount: number;
  children: TreeSitterNode[];
  text: string;
  startPosition: { row: number; column: number };
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  parse(source: string): TreeSitterTree;
}

// ---------------------------------------------------------------------------
// Singleton parser (lazy init, delegates to wasm-loader)
// ---------------------------------------------------------------------------

const BASH_GRAMMAR_SPEC: GrammarSpec = {
  name: 'bash',
  wasmFilename: 'tree-sitter-bash.wasm',
  cdnUrl: 'https://code.kimi.com/kimi-code/wasm/tree-sitter-bash.wasm',
};

let parserInstance: TreeSitterParser | undefined;

async function getParser(): Promise<TreeSitterParser> {
  if (parserInstance !== undefined) return parserInstance;

  // Delegate WASM loading + download to the generic wasm-loader.
  const loaded = await getParserForGrammar(BASH_GRAMMAR_SPEC);
  // The wasm-loader returns its own TreeSitterParser; we cast to our local
  // interface which is structurally identical (parse → TreeSitterTree).
  parserInstance = loaded as unknown as TreeSitterParser;
  return parserInstance;
}

// ---------------------------------------------------------------------------
// AST walking helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk all nodes in the tree, invoking `visit` on each.
 */
function walkNodes(node: TreeSitterNode, visit: (node: TreeSitterNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walkNodes(child, visit);
  }
}

/**
 * Collect all descendant nodes whose type matches one of the given types.
 */
function findNodesByType(root: TreeSitterNode, types: Set<string>): TreeSitterNode[] {
  const results: TreeSitterNode[] = [];
  walkNodes(root, (node) => {
    if (types.has(node.type)) {
      results.push(node);
    }
  });
  return results;
}

/**
 * Check if any descendant of `node` has one of the given types.
 */
function _hasDescendantOfType(node: TreeSitterNode, types: Set<string>): boolean {
  for (const child of node.children) {
    if (types.has(child.type)) return true;
    if (_hasDescendantOfType(child, types)) return true;
  }
  return false;
}

/**
 * Get the first descendant command_name text under a node, if any.
 */
function getCommandName(node: TreeSitterNode): string | undefined {
  const names = findNodesByType(node, new Set(['command_name']));
  const first = names[0];
  return first !== undefined ? first.text : undefined;
}

/**
 * Collect all command_name texts under a node.
 */
function getAllCommandNames(node: TreeSitterNode): string[] {
  return findNodesByType(node, new Set(['command_name'])).map((n) => n.text);
}

/**
 * Collect all word texts under a node (flags and arguments).
 */
function getAllWordTexts(node: TreeSitterNode): string[] {
  return findNodesByType(node, new Set(['word', 'flag'])).map((n) => n.text);
}

/**
 * Collect all string literal texts under a node.
 */
function getAllStringTexts(node: TreeSitterNode): string[] {
  return findNodesByType(node, new Set(['string', 'raw_string'])).map((n) => n.text);
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface DetectionRule {
  /** Unique rule identifier */
  id: string;
  /** Short description for the violation */
  description: string;
  /** Risk level */
  riskLevel: 'critical' | 'high' | 'medium';
  /** The check function: returns a violation or undefined */
  check: (node: TreeSitterNode, source: string) => AstViolation | undefined;
}

const SUDO_NODE_TYPES = new Set(['sudo_command']);

const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

const DANGEROUS_ENV_VAR_PATTERNS = [
  /^\s*LD_PRELOAD\s*[=]/,
  /^\s*LD_LIBRARY_PATH\s*[=]/,
];

const PIPE_TO_SHELL_NAMES = new Set(['bash', 'sh']);

const HIDE_OUTPUT_REDIRECT_PATTERNS = [
  />\s*\/dev\/null\s+2>&1/,
  /2>&1\s+>\s*\/dev\/null/,
];

// ---------------------------------------------------------------------------
// Rule: eval command
// ---------------------------------------------------------------------------

const ruleEval: DetectionRule = {
  id: 'bash-eval-command',
  description: 'Direct eval command can execute arbitrary strings as code',
  riskLevel: 'critical',
  check(node) {
    if (node.type !== 'command') return undefined;
    const name = getCommandName(node);
    if (name === 'eval') {
      return {
        nodeType: node.type,
        text: node.text,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        rule: this.id,
        riskLevel: this.riskLevel,
        description: this.description,
      };
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: exec command
// ---------------------------------------------------------------------------

const ruleExec: DetectionRule = {
  id: 'bash-exec-command',
  description: 'Exec replaces the current process, bypassing guardrails',
  riskLevel: 'critical',
  check(node) {
    if (node.type !== 'command') return undefined;
    const name = getCommandName(node);
    if (name === 'exec') {
      return {
        nodeType: node.type,
        text: node.text,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        rule: this.id,
        riskLevel: this.riskLevel,
        description: this.description,
      };
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: rm -rf / or rm -rf ~
// ---------------------------------------------------------------------------

const RM_RF_TARGET_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+([/~])\b/,
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\.\.?(?:\s|$)/,
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+\/?\s*$/,
];

const ruleRmRf: DetectionRule = {
  id: 'bash-rm-rf-root',
  description: 'Recursive forced removal of root or home directory',
  riskLevel: 'critical',
  check(node) {
    if (node.type !== 'command') return undefined;
    const name = getCommandName(node);
    if (name !== 'rm') return undefined;

    const fullText = node.text;
    for (const pattern of RM_RF_TARGET_PATTERNS) {
      if (pattern.test(fullText)) {
        return {
          nodeType: node.type,
          text: node.text,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          rule: this.id,
          riskLevel: this.riskLevel,
          description: this.description,
        };
      }
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: sudo command
// ---------------------------------------------------------------------------

const ruleSudo: DetectionRule = {
  id: 'bash-sudo-command',
  description: 'Sudo elevation detected — command runs with elevated privileges',
  riskLevel: 'high',
  check(node) {
    if (SUDO_NODE_TYPES.has(node.type)) {
      return {
        nodeType: node.type,
        text: node.text,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        rule: this.id,
        riskLevel: this.riskLevel,
        description: this.description,
      };
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: dangerous environment variable injection
// ---------------------------------------------------------------------------

const ruleEnvVarInjection: DetectionRule = {
  id: 'bash-env-var-injection',
  description: 'Environment variable injection can hijack dynamic linker behavior',
  riskLevel: 'high',
  check(node) {
    // Check for variable_assignment nodes like LD_PRELOAD=/evil.so
    if (node.type === 'variable_assignment') {
      const text = node.text;
      for (const pattern of DANGEROUS_ENV_VAR_PATTERNS) {
        if (pattern.test(text)) {
          return {
            nodeType: node.type,
            text: node.text,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            rule: this.id,
            riskLevel: this.riskLevel,
            description: this.description,
          };
        }
      }
    }

    // Also check for `export LD_PRELOAD=...` patterns
    if (node.type === 'command') {
      const name = getCommandName(node);
      if (name === 'export' || name === 'env') {
        const words = getAllWordTexts(node);
        const strings = getAllStringTexts(node);
        const allTexts = [...words, ...strings, ...getAllCommandNames(node)];
        for (const text of allTexts) {
          for (const varName of DANGEROUS_ENV_VARS) {
            if (text.includes(varName + '=') || text.includes(varName + ' =')) {
              return {
                nodeType: node.type,
                text: node.text,
                line: node.startPosition.row + 1,
                column: node.startPosition.column,
                rule: this.id,
                riskLevel: this.riskLevel,
                description: this.description,
              };
            }
          }
        }
      }
    }

    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: command substitution with dangerous commands
// ---------------------------------------------------------------------------

const DANGEROUS_IN_SUBSTITUTION = new Set([
  'eval',
  'exec',
  'rm',
  'mkfs',
  'dd',
  'wget',
  'curl',
  'nc',
  'ncat',
]);

const ruleCommandSubstitution: DetectionRule = {
  id: 'bash-dangerous-command-substitution',
  description: 'Command substitution contains a potentially dangerous command',
  riskLevel: 'high',
  check(node) {
    if (node.type !== 'command_substitution') return undefined;

    // Find all command_name nodes within the substitution
    const names = getAllCommandNames(node);
    for (const name of names) {
      if (DANGEROUS_IN_SUBSTITUTION.has(name)) {
        return {
          nodeType: node.type,
          text: node.text,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          rule: this.id,
          riskLevel: this.riskLevel,
          description: `${this.description}: \`${name}\``,
        };
      }
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: pipe to bash/sh (pipe injection)
// ---------------------------------------------------------------------------

const rulePipeInjection: DetectionRule = {
  id: 'bash-pipe-to-shell',
  description: 'Piping output to a shell interpreter can execute untrusted code',
  riskLevel: 'high',
  check(node) {
    if (node.type !== 'pipeline') return undefined;

    // In a pipeline, check if any command after a pipe is bash/sh
    const commands = findNodesByType(node, new Set(['command']));
    // A pipeline with 2+ segments: the last segment being bash/sh is suspicious
    if (commands.length < 2) return undefined;

    const lastCommand = commands.at(-1);
    if (lastCommand === undefined) return undefined;
    const name = getCommandName(lastCommand);
    if (name !== undefined && PIPE_TO_SHELL_NAMES.has(name)) {
      return {
        nodeType: node.type,
        text: node.text,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        rule: this.id,
        riskLevel: this.riskLevel,
        description: this.description,
      };
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: redirects that hide output
// ---------------------------------------------------------------------------

const ruleHideOutput: DetectionRule = {
  id: 'bash-hide-output',
  description: 'Redirect suppresses stdout and stderr, potentially hiding errors or traces',
  riskLevel: 'medium',
  check(node) {
    if (node.type !== 'redirected_statement') return undefined;

    const text = node.text;
    for (const pattern of HIDE_OUTPUT_REDIRECT_PATTERNS) {
      if (pattern.test(text)) {
        return {
          nodeType: node.type,
          text: node.text,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          rule: this.id,
          riskLevel: this.riskLevel,
          description: this.description,
        };
      }
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Rule: chmod 777 / chmod +s
// ---------------------------------------------------------------------------

const CHMOD_DANGEROUS_PATTERNS = [
  /\bchmod\s+.*\b777\b/,
  /\bchmod\s+.*\+s\b/,
  /\bchmod\s+.*\b4[0-7]{3}\b/,  // setuid bit patterns
];

const ruleChmodDangerous: DetectionRule = {
  id: 'bash-chmod-dangerous',
  description: 'Dangerous permission change: world-writable or setuid',
  riskLevel: 'high',
  check(node) {
    if (node.type !== 'command') return undefined;
    const name = getCommandName(node);
    if (name !== 'chmod') return undefined;

    const text = node.text;
    for (const pattern of CHMOD_DANGEROUS_PATTERNS) {
      if (pattern.test(text)) {
        return {
          nodeType: node.type,
          text: node.text,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          rule: this.id,
          riskLevel: this.riskLevel,
          description: this.description,
        };
      }
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// All rules
// ---------------------------------------------------------------------------

const ALL_RULES: DetectionRule[] = [
  ruleEval,
  ruleExec,
  ruleRmRf,
  ruleSudo,
  ruleEnvVarInjection,
  ruleCommandSubstitution,
  rulePipeInjection,
  ruleHideOutput,
  ruleChmodDangerous,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a bash command string using tree-sitter-bash AST.
 *
 * Returns a list of AstViolation objects for each dangerous pattern detected.
 * If WASM loading fails, returns an empty violations array with fallback=true
 * so the downstream regex-based middleware can handle it.
 *
 * @param command — the raw bash command string
 * @returns BashAnalysisResult with violations and fallback info
 */
export async function analyzeBashCommand(command: string): Promise<BashAnalysisResult> {
  let parser: TreeSitterParser;
  try {
    parser = await getParser();
  } catch (error) {
    return {
      violations: [],
      fallback: true,
      fallbackReason:
        error instanceof Error ? error.message : String(error),
    };
  }

  let tree: TreeSitterTree;
  try {
    tree = parser.parse(command);
  } catch (error) {
    return {
      violations: [],
      fallback: true,
      fallbackReason: `Parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const rootNode = tree.rootNode;
  const violations: AstViolation[] = [];

  walkNodes(rootNode, (node) => {
    for (const rule of ALL_RULES) {
      const violation = rule.check(node, command);
      if (violation !== undefined) {
        violations.push(violation);
      }
    }
  });

  return {
    violations,
    fallback: false,
  };
}

/**
 * Get the WASM grammar spec for bash (for external use / testing).
 */
export const BASH_GRAMMAR = BASH_GRAMMAR_SPEC;
