/**
 * code-block-extractor — Extract fenced and indented code blocks from markdown.
 *
 * Handles:
 *   - Fenced code blocks (```lang ... ``` or ~~~lang ... ~~~)
 *   - Indented code blocks (4-space or tab indent)
 *   - Nested fences (tildes vs backticks, fence-length matching)
 *   - Unclosed blocks (treated as continuing to end of input)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedCodeBlock {
  /** Language tag from the fence opening, or null if none */
  language: string | null;
  /** Code content (leading indent stripped for indented blocks) */
  code: string;
  /** 1-based line number of the opening fence/indent in the original text */
  startLine: number;
  /** 1-based line number of the closing fence or last code line + 1 */
  endLine: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all code blocks from a markdown string.
 * Returns blocks in document order with 1-based line positions.
 */
export function extractCodeBlocks(text: string): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // --- Fenced code block (``` or ~~~) ---
    const fenceMatch = line.match(/^([`~]{3,})(\s*\S.*)?$/);
    if (fenceMatch !== null) {
      const fenceChar = fenceMatch[1]![0]!;
      const fenceLen = fenceMatch[1]!.length;
      const language = fenceMatch[2]?.trim();
      const startLine = i + 1; // 1-based
      const codeLines: string[] = [];

      i++;
      while (i < lines.length) {
        const closingMatch = lines[i]!.match(/^([`~]{3,})\s*$/);
        if (
          closingMatch !== null &&
          closingMatch[1]![0] === fenceChar &&
          closingMatch[1]!.length >= fenceLen
        ) {
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }

      blocks.push({
        language: language !== undefined && language !== '' ? language : null,
        code: codeLines.join('\n'),
        startLine,
        endLine: i + 1, // 1-based: closing fence line or EOF
      });

      // Skip closing fence if present
      if (i < lines.length) i++;
      continue;
    }

    // --- Indented code block (4 spaces or 1 tab) ---
    if (line.startsWith('    ') || line.startsWith('\t')) {
      const startLine = i + 1;
      const codeLines: string[] = [];

      while (i < lines.length) {
        const current = lines[i]!;
        if (current.startsWith('    ')) {
          codeLines.push(current.slice(4));
          i++;
        } else if (current.startsWith('\t')) {
          codeLines.push(current.slice(1));
          i++;
        } else if (current === '') {
          // Blank line may belong to the indented block if the next line continues it
          if (
            i + 1 < lines.length &&
            (lines[i + 1]!.startsWith('    ') || lines[i + 1]!.startsWith('\t'))
          ) {
            codeLines.push('');
            i++;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      blocks.push({
        language: null,
        code: codeLines.join('\n'),
        startLine,
        endLine: i + 1,
      });
      continue;
    }

    i++;
  }

  return blocks;
}
