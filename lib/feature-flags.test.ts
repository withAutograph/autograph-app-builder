import { afterEach, describe, expect, it, vi } from "vitest";

import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  selfServiceSignupFlag,
} from "./feature-flags";

describe("Vercel feature flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares the supported Boolean flags with fail-closed defaults", () => {
    expect(builderConnectionsFlag.key).toBe("builder-connections");
    expect(builderConnectionsFlag.defaultValue).toBe(false);
    expect(builderConnectionsFlag.options).toEqual([
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ]);
    expect(builderComingSoonFlag.key).toBe("builder-coming-soon");
    expect(builderComingSoonFlag.defaultValue).toBe(false);
    expect(selfServiceSignupFlag.key).toBe("self-service-signup");
    expect(selfServiceSignupFlag.defaultValue).toBe(false);
    expect(selfServiceSignupFlag.options).toEqual([
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ]);
  });

  it("falls closed when Vercel does not provide an SDK key", async () => {
    vi.stubEnv("FLAGS", "");
    vi.resetModules();
    const { builderConnectionsFlag: unavailableFlag } =
      await import("./feature-flags");

    await expect(
      unavailableFlag.run({
        identify: {},
        request: new Request("https://agent.example.com"),
      }),
    ).resolves.toBe(false);
  });

  it("waits to create the Vercel adapter until a server SDK key is available", async () => {
    vi.stubEnv("FLAGS", "");
    vi.resetModules();
    const decide = vi.fn(async () => true);
    const createVercelAdapter = vi.fn(() => () => ({ decide }));
    vi.doMock("@flags-sdk/vercel", () => ({ createVercelAdapter }));

    const { builderConnectionsFlag: delayedFlag } =
      await import("./feature-flags");
    vi.stubEnv("FLAGS", "server-sdk-key");

    await expect(
      delayedFlag.run({
        identify: {},
        request: new Request("https://agent.example.com"),
      }),
    ).resolves.toBe(true);
    expect(createVercelAdapter).toHaveBeenCalledWith("server-sdk-key");
    expect(decide).toHaveBeenCalledOnce();
  });
});
