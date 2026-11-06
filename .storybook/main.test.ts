import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runs = {
  comingSoon: vi.fn<() => Promise<boolean>>(),
  connections: vi.fn<() => Promise<boolean>>(),
  provisioning: vi.fn<() => Promise<boolean>>(),
};

const resolveFlagForStorybook = async (
  flag: { run: () => Promise<boolean> },
  configured: boolean,
) => {
  if (!configured) {
    return false;
  }
  try {
    return await flag.run();
  } catch {
    return false;
  }
};

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

    await expect(
      Promise.all([
        resolveFlagForStorybook({ run: runs.comingSoon }, true),
        resolveFlagForStorybook({ run: runs.connections }, true),
        resolveFlagForStorybook({ run: runs.provisioning }, true),
      ]),
    ).resolves.toEqual([false, true, true]);
    expect(runs.comingSoon).toHaveBeenCalledWith();
    expect(runs.connections).toHaveBeenCalledWith();
    expect(runs.provisioning).toHaveBeenCalledWith();
  });

  it("fails each flag closed when it cannot be resolved", async () => {
    vi.stubEnv("FLAGS", "storybook-sdk-key");
    runs.connections.mockResolvedValue(true);
    runs.comingSoon.mockRejectedValue(new Error("feature flags unavailable"));
    runs.provisioning.mockResolvedValue(false);

    await expect(
      Promise.all([
        resolveFlagForStorybook({ run: runs.comingSoon }, true),
        resolveFlagForStorybook({ run: runs.connections }, true),
        resolveFlagForStorybook({ run: runs.provisioning }, true),
      ]),
    ).resolves.toEqual([false, true, false]);
  });

  it("uses the production defaults when Vercel Flags is not configured", async () => {
    vi.stubEnv("FLAGS", "");

    await expect(
      Promise.all([
        resolveFlagForStorybook({ run: runs.comingSoon }, false),
        resolveFlagForStorybook({ run: runs.connections }, false),
        resolveFlagForStorybook({ run: runs.provisioning }, false),
      ]),
    ).resolves.toEqual([false, false, false]);
    expect(runs.connections).not.toHaveBeenCalled();
    expect(runs.comingSoon).not.toHaveBeenCalled();
    expect(runs.provisioning).not.toHaveBeenCalled();
  });
});
