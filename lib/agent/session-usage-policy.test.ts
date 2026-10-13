import { defineAgent } from "eve";
import { expect, it } from "vitest";
import { activeBuilderModelId } from "../integrations/active-model";
import { builderSessionUsageLimits } from "./session-usage-policy";

it("authors only the three documented uncapped usage axes without disabling session lifetime", () => {
  // defineAgent is a pure authored definition; this does not create or run a session.
  const agent = defineAgent({ limits: builderSessionUsageLimits, model: activeBuilderModelId });
  expect(agent.limits).toBe(builderSessionUsageLimits);
  expect(agent.limits).toEqual({
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    maxTokenCostUsdPerSession: false,
  });
  expect(agent.limits).not.toHaveProperty("sessionTimeoutMs");
  expect(agent.model).toBe(activeBuilderModelId);
});
