import { expect, it } from "vitest";

import { hostedSessionCheckpointDigest, hostedSessionCheckpointSchema } from "./hosted-store";
import { resultFromHostedCheckpoint } from "./hosted-checkpoint-result";
import { targetProposalSchema } from "../repository/target-planning";

it("retains legacy checkpoint bytes for resume and cancellation without public planning data", () => {
  const stored = {
    capturedAtEpochMs: 123,
    events: [],
    implementationPlan: {
      appId: "inventory",
      readOnly: true,
      routes: ["/inventory"],
      runtime: "nextjs",
    },
    inputRequests: [
      {
        allowFreeform: false,
        kind: "approval" as const,
        requestId: "build",
        title: "Build this app?",
      },
    ],
    status: "input_required" as const,
    version: 1 as const,
  };
  const resumed = hostedSessionCheckpointSchema.parse(stored);
  expect(resumed).toEqual(stored);
  expect(hostedSessionCheckpointDigest(resumed)).toBe(
    hostedSessionCheckpointDigest(hostedSessionCheckpointSchema.parse(stored)),
  );
  expect(resultFromHostedCheckpoint("session", resumed)).toMatchObject({
    inputRequests: stored.inputRequests,
    status: "input_required",
  });
  expect(resultFromHostedCheckpoint("session", resumed)).not.toHaveProperty("implementationPlan");
  expect(resultFromHostedCheckpoint("session", { ...resumed, status: "cancelled" })).toMatchObject({
    status: "cancelled",
  });
});

it("reads a stored creation receipt without rewriting its retired metadata", () => {
  const spec = { path: "prototype/inventory/app-spec.md", sha256: "a".repeat(64) };
  const stored = {
    blockers: [],
    contract: { appId: "inventory", appSpec: spec, version: 1 },
    futurePath: "apps/inventory/app.contract.json",
    mutations: [],
    plan: {
      product: {
        appSpec: spec,
        optionalCapabilities: { hostedResources: [], integrations: [] },
        owner: "operations",
      },
      source: {
        packageName: "@autograph/inventory",
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: "apps/inventory",
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: "@autograph/inventory",
        projectName: "apps-inventory",
        routes: ["/inventory", "/inventory/:path*"],
      },
    },
  };
  const original = JSON.stringify(stored);
  expect(targetProposalSchema.safeParse(stored).success).toBe(true);
  expect(JSON.stringify(stored)).toBe(original);
  expect(
    targetProposalSchema.safeParse({
      ...stored,
      iteration: {
        changes: [
          {
            after: { content: "changed", digest: "a".repeat(64), mode: "644" },
            path: "apps/inventory/app/page.tsx",
          },
        ],
        digest: "0".repeat(64),
      },
      operation: "iterate-existing-app",
    }).success,
  ).toBe(false);
});
