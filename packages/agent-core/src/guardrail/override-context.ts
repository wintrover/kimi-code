import picomatch from 'picomatch';

import type { GuardrailOverride } from './context.js';
import { canonicalizeCommand } from './normalize-command.js';

export interface GuardrailContextEnvelope {
  readonly override: 'allow' | 'warn' | 'block';
  readonly pattern: string;
  readonly canonical_cmd: string;
}

export function computeOverrideContext(
  overrides: readonly GuardrailOverride[] | undefined,
  toolName: string,
  args: Record<string, unknown> | null,
): GuardrailContextEnvelope | undefined {
  if (!overrides?.length) return undefined;

  let subject = toolName;
  if (toolName === 'Bash' && args !== null && typeof args === 'object') {
    const cmd = args['command'];
    if (typeof cmd === 'string') subject = canonicalizeCommand(cmd);
  }

  for (const override of overrides) {
    if (picomatch.isMatch(subject, override.match)) {
      const policy = override.repeatPolicy
        ?? (override.behavior === 'stateless_search' ? 'allow' : 'block');
      return { override: policy, pattern: override.match, canonical_cmd: subject };
    }
  }

  return undefined;
}
