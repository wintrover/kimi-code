import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';
import { DEFAULT_AGENT_PROFILES } from '../profile/default';

const ModelAliasConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  capabilities: z.array(z.string()).optional(),
});

function requiredCapabilitiesForProfile(profileName: string): readonly string[] {
  const profile = DEFAULT_AGENT_PROFILES[profileName];
  if (profile === undefined) return [];
  const hasTools = profile.tools.length > 0;
  if (hasTools) return ['tool_use'];
  return [];
}

export function validateModelCapabilityConsistency(
  models: Record<string, z.infer<typeof ModelAliasConfigSchema>>,
  defaultModel: string | undefined,
  subagentModel: string | undefined,
  activeProfiles: readonly string[] = ['agent', 'coder', 'explore', 'plan'],
): void {
  const modelsToValidate = new Map<string, string[]>();
  for (const profileName of activeProfiles) {
    const requiredCaps = requiredCapabilitiesForProfile(profileName);
    if (requiredCaps.length === 0) continue;
    const isSubagentProfile = profileName !== 'agent';
    const modelAlias = isSubagentProfile ? (subagentModel ?? defaultModel) : defaultModel;
    if (modelAlias === undefined) continue;
    const existing = modelsToValidate.get(modelAlias) ?? [];
    for (const cap of requiredCaps) {
      if (!existing.includes(cap)) existing.push(cap);
    }
    modelsToValidate.set(modelAlias, existing);
  }
  for (const [modelAlias, requiredCaps] of modelsToValidate) {
    const modelConfig = models[modelAlias];
    if (modelConfig === undefined) continue;
    const caps = modelConfig.capabilities ?? [];
    for (const reqCap of requiredCaps) {
      const hasCap = caps.some(c => c.trim().toLowerCase() === reqCap);
      if (!hasCap) {
        throw new KimiError(
          ErrorCodes.CAPABILITY_MISMATCH,
          `Model '${modelAlias}' requires '${reqCap}' capability (needed by profiles: ${activeProfiles.join(', ')}) but its capabilities are [${caps.join(', ')}]. Add '${reqCap}' to [models."${modelAlias}"].capabilities in config.toml.`,
          {
            details: {
              modelAlias,
              requiredCapability: reqCap,
              declaredCapabilities: caps,
              affectedProfiles: activeProfiles,
              configSection: `models."${modelAlias}"`,
            },
          },
        );
      }
    }
  }
}
