import { describe, expect, it, vi } from "vitest";
import { resolveBuilderFlagsForStorybook } from "./main";
import type { StorybookFlag } from "./main";

const createFlag = (result: boolean): StorybookFlag => ({
  run: vi.fn(async () => {
    await Promise.resolve();
    return result;
  }),
});

describe("Storybook feature flags", () => {
  it("uses the production Vercel flag values", async () => {
    const flags = {
      comingSoon: createFlag(false),
      connections: createFlag(true),
      provisioning: createFlag(true),
    } satisfies Record<string, StorybookFlag>;

    await expect(resolveBuilderFlagsForStorybook(flags, true)).resolves.toEqual({
      comingSoonEnabled: false,
      connectionsEnabled: true,
      provisioningEnabled: true,
    });
    for (const flag of Object.values(flags)) {
      const run = vi.mocked(flag.run);
      expect(run).toHaveBeenCalledOnce();
      const context = run.mock.lastCall?.[0];
      expect(context).toBeDefined();
      expect(context.identify).toEqual({});
      expect(context.request).toBeInstanceOf(Request);
    }
  });

  it("fails each flag closed when it cannot be resolved", async () => {
    const flags = {
      comingSoon: {
        run: vi
          .fn<StorybookFlag["run"]>()
          .mockRejectedValue(new Error("feature flags unavailable")),
      },
      connections: createFlag(true),
      provisioning: createFlag(false),
    } satisfies Record<string, StorybookFlag>;

    await expect(resolveBuilderFlagsForStorybook(flags, true)).resolves.toEqual({
      comingSoonEnabled: false,
      connectionsEnabled: true,
      provisioningEnabled: false,
    });
  });

  it("uses the production defaults when Vercel Flags is not configured", async () => {
    const flags = {
      comingSoon: createFlag(true),
      connections: createFlag(true),
      provisioning: createFlag(true),
    };

    await expect(resolveBuilderFlagsForStorybook(flags, false)).resolves.toEqual({
      comingSoonEnabled: false,
      connectionsEnabled: false,
      provisioningEnabled: false,
    });
    for (const flag of Object.values(flags)) {
      expect(flag.run).not.toHaveBeenCalled();
    }
  });
});
