/**
 * multi-lang-analyzer — web-tree-sitter based AST analysis for multiple languages.
 *
 * Parses code strings into ASTs using language-specific tree-sitter WASM grammars
 * and walks them to detect dangerous node patterns from dangerous-patterns.ts.
 *
 * HARD CONSTRAINT: Uses web-tree-sitter WASM ONLY.
 * ❌ NEVER import from 'tree-sitter' (native addon, ABI fragmentation)
 * ❌ NEVER use relative './vendor/...' paths (CWD-dependent)
 *
 * Supports: JavaScript (+ TypeScript alias), Python (extensible via GRAMMAR_SPECS).
 * Graceful fallback: if no grammar is available or WASM fails, returns empty
 * violations with fallback=true so downstream regex middleware can handle it.
 */

import { getParserForGrammar, type GrammarSpec } from './wasm-loader.js';
import { getPatternsByLanguage, type DangerousPattern } from './dangerous-patterns.js';
import type { AstViolation, BashAnalysisResult } from './bash-analyzer.js';

// Re-export the result type for consumers.
export type { AstViolation };

export type MultiLangAnalysisResult = BashAnalysisResult;

// ---------------------------------------------------------------------------
// Grammar specs for each supported language
// ---------------------------------------------------------------------------

const GRAMMAR_SPECS: Record<string, GrammarSpec> = {
  javascript: {
    name: 'javascript',
    wasmFilename: 'tree-sitter-javascript.wasm',
    cdnUrl: 'https://code.kimi.com/kimi-code/wasm/tree-sitter-javascript.wasm',
  },
  python: {
    name: 'python',
    wasmFilename: 'tree-sitter-python.wasm',
    cdnUrl: 'https://code.kimi.com/kimi-code/wasm/tree-sitter-python.wasm',
  },
};

/**
 * Language aliases that map to a canonical grammar name.
 * TypeScript uses the same tree-sitter grammar as JavaScript.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'javascript',
  typescript: 'javascript',
  jsx: 'javascript',
  tsx: 'javascript',
  py: 'python',
  python3: 'python',
};

// ---------------------------------------------------------------------------
// Tree-sitter minimal type definitions (same pattern as bash-analyzer.ts)
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
// Parser cache (one parser per grammar, wasm-loader handles WASM caching)
// ---------------------------------------------------------------------------

const parserCache = new Map<string, TreeSitterParser>();

async function getParserForLanguage(language: string): Promise<TreeSitterParser> {
  const cached = parserCache.get(language);
  if (cached !== undefined) return cached;

  const spec = GRAMMAR_SPECS[language];
  if (spec === undefined) {
    throw new Error(`No grammar spec for language: ${language}`);
  }

  const loaded = await getParserForGrammar(spec);
  const parser = loaded as unknown as TreeSitterParser;
  parserCache.set(language, parser);
  return parser;
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

// ---------------------------------------------------------------------------
// Pattern matching engine
// ---------------------------------------------------------------------------

/**
 * Pre-compile textPatterns from a DangerousPattern into RegExp objects.
 * Caches compiled regexes by pattern id.
 */
const regexCache = new Map<string, RegExp[]>();

function getCompiledPatterns(pattern: DangerousPattern): RegExp[] {
  const cached = regexCache.get(pattern.id);
  if (cached !== undefined) return cached;

  const regexes =
    pattern.textPatterns !== undefined
      ? pattern.textPatterns.map((p) => new RegExp(p, 'm'))
      : [];
  regexCache.set(pattern.id, regexes);
  return regexes;
}

/**
 * Check whether a single AST node matches a dangerous pattern.
 *
 * A node matches when:
 *  1. Its `type` is in the pattern's `nodeTypes`, AND
 *  2. Either the pattern has no `textPatterns`, OR at least one textPattern
 *     regex matches the node's `text`.
 */
function matchesPattern(node: TreeSitterNode, pattern: DangerousPattern): boolean {
  if (!pattern.nodeTypes.includes(node.type)) return false;

  const regexes = getCompiledPatterns(pattern);
  if (regexes.length === 0) return true;

  for (const re of regexes) {
    if (re.test(node.text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve language name
// ---------------------------------------------------------------------------

/**
 * Normalise a user-supplied language tag to a canonical grammar name.
 * Returns `undefined` when no grammar is available.
 */
export function resolveLanguage(language: string): string | undefined {
  const lower = language.toLowerCase().trim();
  if (lower in GRAMMAR_SPECS) return lower;
  const alias = LANGUAGE_ALIASES[lower];
  if (alias !== undefined && alias in GRAMMAR_SPECS) return alias;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a code string using a language-specific tree-sitter WASM grammar.
 *
 * Walks the AST and matches every node against the dangerous patterns
 * defined for the given language in `dangerous-patterns.ts`.
 *
 * @param code     — the raw source code string
 * @param language — language tag (e.g. `'javascript'`, `'python'`, `'ts'`)
 * @returns MultiLangAnalysisResult with violations and fallback info
 */
export async function analyzeCode(
  code: string,
  language: string,
): Promise<MultiLangAnalysisResult> {
  const canonical = resolveLanguage(language);
  if (canonical === undefined) {
    // No grammar available — fall through to regex-based middleware.
    return { violations: [], fallback: true, fallbackReason: `Unsupported language: ${language}` };
  }

  const patterns = getPatternsByLanguage(canonical);
  if (patterns.length === 0) {
    return { violations: [], fallback: true, fallbackReason: `No patterns defined for: ${canonical}` };
  }

  // Collect the set of node types we care about to avoid unnecessary text checks.
  const relevantNodeTypes = new Set<string>();
  for (const p of patterns) {
    for (const t of p.nodeTypes) {
      relevantNodeTypes.add(t);
    }
  }

  let parser: TreeSitterParser;
  try {
    parser = await getParserForLanguage(canonical);
  } catch (error) {
    return {
      violations: [],
      fallback: true,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }

  let tree: TreeSitterTree;
  try {
    tree = parser.parse(code);
  } catch (error) {
    return {
      violations: [],
      fallback: true,
      fallbackReason: `Parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const violations: AstViolation[] = [];

  walkNodes(tree.rootNode, (node) => {
    if (!relevantNodeTypes.has(node.type)) return;

    for (const pattern of patterns) {
      if (matchesPattern(node, pattern)) {
        violations.push({
          nodeType: node.type,
          text: node.text,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          rule: pattern.id,
          riskLevel: pattern.riskLevel,
          description: pattern.description,
        });
      }
    }
  });

  return { violations, fallback: false };
}
