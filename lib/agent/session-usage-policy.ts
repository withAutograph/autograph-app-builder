import type { AgentLimitsDefinition } from "eve";

/** Product policy: provider capacity is external; Builder has no session usage quotas. */
export const builderSessionUsageLimits = {
  maxInputTokensPerSession: false,
  maxOutputTokensPerSession: false,
  maxTokenCostUsdPerSession: false,
} satisfies AgentLimitsDefinition;
