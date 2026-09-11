import { describe, expect, it } from "vitest";

import { builderIntegrationStateSchema } from "./builder-state";

const models = { cached: false, entries: [], status: "unavailable" } as const;

describe("builder integration state", () => {
  it("requires an allowlisted reason for every unavailable provider", () => {
    expect(
      builderIntegrationStateSchema.safeParse({
        github: {
          scopes: [],
          status: "unavailable",
          unavailableReason: "configuration-unavailable",
        },
        models,
        vercel: {
          scopes: [],
          status: "unavailable",
          unavailableReason: "configuration-unavailable",
        },
      }).success
    ).toBe(true);

    expect(
      builderIntegrationStateSchema.safeParse({
        github: { scopes: [], status: "disconnected" },
        models,
        vercel: { scopes: [], status: "unavailable" },
      }).success
    ).toBe(false);
  });
});
