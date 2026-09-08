import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runs = vi.hoisted(() => ({
  connections: vi.fn(),
  comingSoon: vi.fn(),
  provisioning: vi.fn(),
}));

vi.mock("../lib/feature-flags.ts", () => ({
  builderConnectionsFlag: { run: runs.connections },
  builderComingSoonFlag: { run: runs.comingSoon },
  builderResourceProvisioningFlag: { run: runs.provisioning },
}));

import { resolveBuilderFlagsForStorybook } from "./main";

describe("Storybook feature flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the production Vercel flag values", async () => {
    vi.stubEnv("FLAGS", "storybook-sdk-key");
    runs.connections.mockResolvedValue(true);
    runs.comingSoon.mockResolvedValue(false);
    runs.provisioning.mockResolvedValue(true);

    await expect(resolveBuilderFlagsForStorybook()).resolves.toEqual({
      connectionsEnabled: true,
      comingSoonEnabled: false,
      provisioningEnabled: true,
    });
    for (const run of Object.values(runs)) {
      expect(run).toHaveBeenCalledWith({
        identify: {},
        request: expect.any(Request),
      });
    }
  });

  it("fails each flag closed when it cannot be resolved", async () => {
    vi.stubEnv("FLAGS", "storybook-sdk-key");
    runs.connections.mockResolvedValue(true);
    runs.comingSoon.mockRejectedValue(new Error("feature flags unavailable"));
    runs.provisioning.mockResolvedValue(false);

    await expect(resolveBuilderFlagsForStorybook()).resolves.toEqual({
      connectionsEnabled: true,
      comingSoonEnabled: false,
      provisioningEnabled: false,
    });
  });

  it("uses the production defaults when Vercel Flags is not configured", async () => {
    vi.stubEnv("FLAGS", "");

    await expect(resolveBuilderFlagsForStorybook()).resolves.toEqual({
      connectionsEnabled: false,
      comingSoonEnabled: false,
      provisioningEnabled: false,
    });
    expect(runs.connections).not.toHaveBeenCalled();
    expect(runs.comingSoon).not.toHaveBeenCalled();
    expect(runs.provisioning).not.toHaveBeenCalled();
  });
});
