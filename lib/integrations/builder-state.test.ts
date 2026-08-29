import { describe, expect, it } from "vitest";

import { builderIntegrationStateSchema } from "./builder-state";

const models = { status: "unavailable", entries: [], cached: false } as const;

describe("builder integration state", () => {
  it("requires an allowlisted reason for every unavailable provider", () => {
    expect(
      builderIntegrationStateSchema.safeParse({
        vercel: {
          status: "unavailable",
          scopes: [],
          unavailableReason: "configuration-unavailable",
        },
        github: {
          status: "unavailable",
          scopes: [],
          unavailableReason: "workspace-unavailable",
        },
        models,
      }).success,
    ).toBe(true);

    expect(
      builderIntegrationStateSchema.safeParse({
        vercel: { status: "unavailable", scopes: [] },
        github: { status: "disconnected", scopes: [] },
        models,
      }).success,
    ).toBe(false);
  });
});
