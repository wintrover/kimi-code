/** tool_use capability guaranteed model config marker */
export interface ToolCapableModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly string[];
}

/** type guard: check if model config supports tool_use at runtime */
export function isToolCapable(config: { readonly capabilities?: readonly string[] }): config is ToolCapableModelConfig {
  return config.capabilities?.some(c => c.trim().toLowerCase() === 'tool_use') === true;
}
