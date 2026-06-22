/**
 * code-block-analyzer — Extract code blocks from markdown and analyze each
 * with the appropriate language-specific AST analyzer.
 *
 * Combines:
 *   - code-block-extractor (fenced + indented block extraction)
 *   - multi-lang-analyzer  (tree-sitter WASM pattern matching)
 *
 * HARD CONSTRAINT: Uses web-tree-sitter WASM ONLY.
 * ❌ NEVER import from 'tree-sitter' (native addon, ABI fragmentation)
 */

import { extractCodeBlocks } from './code-block-extractor.js';
import { analyzeCode, resolveLanguage, type MultiLangAnalysisResult } from './multi-lang-analyzer.js';
import type { AstViolation } from './bash-analyzer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Violation originating from a specific code block within the document. */
export interface CodeBlockViolation extends AstViolation {
  /** 1-based start line of the code block in the original document. */
  blockStartLine: number;
  /** 1-based end line of the code block in the original document. */
  blockEndLine: number;
  /** Normalised language tag, or `null` if unknown. */
  language: string | null;
}

/** Per-block analysis result. */
export interface CodeBlockResult {
  /** Normalised language tag, or `null` if the block had no language hint. */
  language: string | null;
  /** 1-based line range of the block in the original document. */
  startLine: number;
  endLine: number;
  /** Violations found within this block. */
  violations: AstViolation[];
  /** Whether analysis fell back to no-op for this block. */
  fallback: boolean;
}

/** Aggregate result for the full document. */
export interface CodeBlockAnalysisResult {
  /** All violations across every code block, with block location metadata. */
  violations: CodeBlockViolation[];
  /** Per-block breakdown. */
  blocks: CodeBlockResult[];
  /** `true` when at least one block fell back (unsupported language or WASM error). */
  anyFallback: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all code blocks from a markdown string and run the multi-language
 * AST analyzer on each one.
 *
 * Blocks whose language is not supported by tree-sitter WASM are recorded
 * with `fallback: true` so the caller can fall through to regex-based checks.
 *
 * @param text — full markdown document
 * @returns aggregated analysis results
 */
export async function analyzeCodeBlocks(text: string): Promise<CodeBlockAnalysisResult> {
  const extracted = extractCodeBlocks(text);
  const allViolations: CodeBlockViolation[] = [];
  const blockResults: CodeBlockResult[] = [];
  let anyFallback = false;

  for (const block of extracted) {
    const lang = block.language;
    const canonical = lang !== null ? resolveLanguage(lang) : null;

    let result: MultiLangAnalysisResult;

    if (canonical !== null && canonical !== undefined) {
      result = await analyzeCode(block.code, canonical);
    } else {
      // No language tag or unsupported language — skip AST analysis.
      result = { violations: [], fallback: true, fallbackReason: lang !== null ? `Unsupported language: ${lang}` : 'No language tag' };
    }

    if (result.fallback) anyFallback = true;

    blockResults.push({
      language: lang,
      startLine: block.startLine,
      endLine: block.endLine,
      violations: result.violations,
      fallback: result.fallback,
    });

    for (const v of result.violations) {
      allViolations.push({
        ...v,
        blockStartLine: block.startLine,
        blockEndLine: block.endLine,
        language: lang,
      });
    }
  }

  return {
    violations: allViolations,
    blocks: blockResults,
    anyFallback,
  };
}
