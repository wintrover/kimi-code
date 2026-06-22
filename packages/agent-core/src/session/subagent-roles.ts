/**
 * Agent role profiles that restrict tool access and context based on role.
 *
 * This module is purely data + utility functions — no middleware or runtime
 * integration yet. Phase 3 will wire these profiles into {@link SessionSubagentHost}.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRole = 'orchestrator' | 'executor' | 'reviewer';

export interface RoleProfile {
  role: AgentRole;
  /** Tools this role is allowed to use. Empty array = all tools. */
  allowedTools: string[];
  /** Tools explicitly forbidden for this role. */
  forbiddenTools: string[];
  /** Whether this role can spawn subagents. */
  canSpawnSubagents: boolean;
  /** Whether this role can modify guardrail configuration. */
  canModifyGuardrails: boolean;
  /** Maximum context depth (number of messages to retain). Undefined = unlimited. */
  maxContextDepth?: number;
}

// ---------------------------------------------------------------------------
// Built-in role profiles
// ---------------------------------------------------------------------------

export const ROLE_PROFILES: Record<AgentRole, RoleProfile> = {
  orchestrator: {
    role: 'orchestrator',
    allowedTools: [],  // all tools
    forbiddenTools: [],
    canSpawnSubagents: true,
    canModifyGuardrails: true,
  },
  executor: {
    role: 'executor',
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    forbiddenTools: ['Agent', 'CronCreate', 'CronDelete'],
    canSpawnSubagents: false,
    canModifyGuardrails: false,
    maxContextDepth: 50,
  },
  reviewer: {
    role: 'reviewer',
    allowedTools: ['Read', 'Glob', 'Grep'],  // read-only
    forbiddenTools: ['Bash', 'Write', 'Edit', 'Agent'],
    canSpawnSubagents: false,
    canModifyGuardrails: false,
  },
};

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Return the {@link RoleProfile} for the given role.
 * Throws if the role is unknown.
 */
export function getRoleProfile(role: AgentRole): RoleProfile {
  const profile = ROLE_PROFILES[role];
  if (profile === undefined) {
    throw new Error(`Unknown agent role: "${role}"`);
  }
  return profile;
}

/**
 * Filter a list of tool names down to only those permitted by the role.
 *
 * The filtering logic:
 * 1. If `allowedTools` is non-empty, only tools present in it are kept.
 * 2. Any tool in `forbiddenTools` is always removed regardless of the allow-list.
 */
export function filterToolsForRole(tools: string[], role: AgentRole): string[] {
  const profile = getRoleProfile(role);
  return tools.filter((tool) => {
    if (profile.forbiddenTools.includes(tool)) return false;
    if (profile.allowedTools.length === 0) return true;
    return profile.allowedTools.includes(tool);
  });
}

/**
 * Check whether a single tool is allowed for the given role.
 */
export function isToolAllowedForRole(toolName: string, role: AgentRole): boolean {
  const profile = getRoleProfile(role);
  if (profile.forbiddenTools.includes(toolName)) return false;
  if (profile.allowedTools.length === 0) return true;
  return profile.allowedTools.includes(toolName);
}
