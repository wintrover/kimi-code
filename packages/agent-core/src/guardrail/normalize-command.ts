/**
 * Shell command semantic normalization for guardrail override matching.
 *
 * Uses fixed-point iteration to strip all syntactic noise regardless of
 * ordering: shell prefixes, inline env vars, path prefixes, and subshell
 * wrappers are removed in a loop until the string converges.
 *
 * Termination guarantee: each regex shortens the string when it matches,
 * so the loop always converges in O(n) iterations (n = number of prefixes).
 */
export function canonicalizeCommand(cmd: string): string {
  let current = cmd.trim();
  let previous = '';

  // Fixed-point loop: strip prefixes/env vars until no more changes
  while (current !== previous) {
    previous = current;

    // 1. Strip execution prefixes (sudo, time, env with optional flags)
    current = current.replace(
      /^(?:sudo\s+(?:-[A-Za-z]+\s+)*|time\s+|env\s+(?:-[A-Za-z]+\s+)*)/i,
      '',
    );

    // 1b. Strip export / declare -x keyword prefixes
    current = current.replace(/^export\s+/i, '');
    current = current.replace(/^declare\s+-x\s+/i, '');

    // 2. Strip one inline environment variable (KEY=VALUE)
    //    Applied per-iteration so fixed-point handles multiple vars
    current = current.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');

    // 3. Strip directory path prefixes
    current = current.replace(/^\.[/](?:[^/]+\/)?/, '');
    current = current.replace(/^\/(?:usr\/(?:local\/)?)?bin\//, '');

    // 4. Unwrap subshell wrappers (bash -c "...", sh -c '...', zsh -c "...")
    //    Extracts the inner payload so prefixes inside the subshell are
    //    stripped in subsequent iterations.
    const subshellMatch = current.match(
      /^(?:bash|sh|zsh)\s+-c\s+(["'])(.*?)\1$/i,
    );
    if (subshellMatch) {
      current = subshellMatch[2]!;
    }

    current = current.trim();
  }

  // Final pass: strip quotes and normalize whitespace (once, outside loop)
  current = current.replace(/^"([^"]+)"/, '$1');
  current = current.replace(/^'([^']+)'/, '$1');

  return current.replaceAll(/\s+/g, ' ').trim();
}
