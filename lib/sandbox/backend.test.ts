import { describe, expect, it } from "vitest";

import { VERCEL_SANDBOX_ARTIFACT_BLOCKER, sandboxBackendPlan } from "./backend";

describe("sandbox backend selection", () => {
  it("uses Eve's supported Vercel Sandbox only for Preview", () => {
    expect(
      sandboxBackendPlan({
        environment: { VERCEL: "1", VERCEL_ENV: "preview" },
        fixture: false,
        localImageConfigured: true,
      }),
    ).toEqual({
      kind: "vercel-preview",
      blockers: [VERCEL_SANDBOX_ARTIFACT_BLOCKER],
    });
  });

  it("does not bind the local microsandbox image into hosted execution", () => {
    const plan = sandboxBackendPlan({
      environment: { VERCEL: "1", VERCEL_ENV: "preview" },
      fixture: false,
      localImageConfigured: true,
    });
    expect(plan.kind).toBe("vercel-preview");
    expect(plan.blockers.join(" ")).toContain(
      "no digest-bound offline dependency cache",
    );
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

  it("fails closed outside Preview when hosted by Vercel", () => {
    expect(
      sandboxBackendPlan({
        environment: { VERCEL: "1", VERCEL_ENV: "production" },
        fixture: false,
        localImageConfigured: false,
      }),
    ).toEqual({
      kind: "unsupported-vercel",
      blockers: [
        "The hosted App Builder sandbox is enabled only for Vercel Preview.",
      ],
    });
  });
});
