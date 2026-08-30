import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());

vi.mock("../lib/feature-flags.ts", () => ({
  builderConnectionsFlag: { run },
}));

import { resolveBuilderConnectionsForStorybook } from "./main";

describe("Storybook feature flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the builder-connections Vercel flag value", async () => {
    vi.stubEnv("FLAGS", "storybook-sdk-key");
    run.mockResolvedValue(true);

    await expect(resolveBuilderConnectionsForStorybook()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith({
      identify: {},
      request: expect.any(Request),
    });
  });

  it("fails closed when the flag cannot be resolved", async () => {
    vi.stubEnv("FLAGS", "storybook-sdk-key");
    run.mockRejectedValue(new Error("feature flags unavailable"));

    await expect(resolveBuilderConnectionsForStorybook()).resolves.toBe(false);
  });
});
