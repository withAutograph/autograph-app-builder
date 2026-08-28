import { describe, expect, it, vi } from "vitest";

import { sandboxBackendPlan, selectSandboxDefinition } from "./backend";

describe("sandbox backend selection", () => {
  it.each(["preview", "production"] as const)(
    "uses Eve's supported Vercel Sandbox for an exact %s binding",
    (environmentName) => {
      expect(
        sandboxBackendPlan({
          environment: {
            VERCEL: "1",
            EVE_HOSTED_ADAPTER: "1",
            VERCEL_ENV: environmentName,
            EVE_HOSTED_VERCEL_ENVIRONMENT: environmentName,
          },
          fixture: false,
          localImageConfigured: true,
        }),
      ).toEqual({
        kind:
          environmentName === "preview"
            ? "vercel-preview"
            : "vercel-production",
        blockers: [],
      });
    },
  );

  it("does not bind the local microsandbox image into hosted execution", () => {
    const plan = sandboxBackendPlan({
      environment: {
        VERCEL: "1",
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "preview",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
      },
      fixture: false,
      localImageConfigured: true,
    });
    expect(plan.kind).toBe("vercel-preview");
    expect(plan.blockers).toEqual([]);
  });

  it("preserves local microsandbox and fixture paths", () => {
    expect(
      sandboxBackendPlan({
        environment: {},
        fixture: false,
        localImageConfigured: true,
      }),
    ).toEqual({ kind: "local-microsandbox", blockers: [] });
    expect(
      sandboxBackendPlan({
        environment: { VERCEL: "1", VERCEL_ENV: "production" },
        fixture: true,
        localImageConfigured: true,
      }),
    ).toEqual({ kind: "fixture-just-bash", blockers: [] });
  });

  it("fails closed when Vercel and the configured environment disagree", () => {
    expect(
      sandboxBackendPlan({
        environment: {
          VERCEL: "1",
          EVE_HOSTED_ADAPTER: "1",
          VERCEL_ENV: "production",
          EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
        },
        fixture: false,
        localImageConfigured: false,
      }),
    ).toEqual({
      kind: "unsupported-vercel",
      blockers: [
        "The hosted App Builder sandbox requires an exact matching Preview or Production environment binding.",
      ],
    });
  });

  it("constructs only the hosted backend for a supported Vercel deployment", () => {
    const localMicrosandbox = vi.fn(() => {
      throw new Error("Local sandbox backends are pruned");
    });
    const nonExecuting = vi.fn(() => {
      throw new Error("Local sandbox backends are pruned");
    });
    const vercelHosted = vi.fn(() => "vercel");

    expect(
      selectSandboxDefinition("vercel-production", {
        localMicrosandbox,
        nonExecuting,
        vercelHosted,
      }),
    ).toBe("vercel");
    expect(vercelHosted).toHaveBeenCalledOnce();
    expect(localMicrosandbox).not.toHaveBeenCalled();
    expect(nonExecuting).not.toHaveBeenCalled();
  });
});
