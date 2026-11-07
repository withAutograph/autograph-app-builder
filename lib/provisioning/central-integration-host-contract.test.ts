import { centralEffectReceiptMatches } from "./central-integration-host-checkpoint";
import { describe, expect, it } from "vitest";
import {
  centralHostSetupPlanSchema,
  centralHostReadyReceiptSchema,
  centralHostPlanDigest,
} from "./central-integration-host-contract";
import { plan, ready, activation, keys } from "./central-integration-host-test-fixture";

describe("Separate isolated central infrastructure authority", () => {
  it("binds complete scope canonically while preserving object construction freedom", () => {
    expect(centralHostPlanDigest({ ...plan, authority: { ...plan.authority } })).toBe(
      centralHostPlanDigest(plan),
    );
    expect(
      centralHostPlanDigest({
        ...plan,
        authority: { ...plan.authority, workspaceId: "foreign-workspace" },
      }),
    ).not.toBe(centralHostPlanDigest(plan));
    expect(
      centralHostPlanDigest({ ...plan, target: { ...plan.target, projectId: "another-project" } }),
    ).not.toBe(centralHostPlanDigest(plan));
  });
  it("rejects retargeting the operation to an existing branch, another receiver or Production", () => {
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        source: { ...plan.source, operationBranch: "main" },
      }).success,
    ).toBe(false);
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        receiver: { ...plan.receiver, path: "/api/central-integrations/deployment-events/other" },
      }).success,
    ).toBe(false);
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        target: { ...plan.target, environment: "production" },
      }).success,
    ).toBe(false);
  });
  it("keeps provider system state and secret values out of the binding plan", () => {
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        environment: [{ key: "VERCEL_ENV", sha256: "a".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        environment: [{ key: "NEXT_PUBLIC_PROVIDER_SECRET", sha256: "a".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      centralHostSetupPlanSchema.safeParse({
        ...plan,
        environment: [
          {
            key: "INTEGRATIONS_DATABASE_URL",
            sha256: "a".repeat(64),
            value: "unapproved-private-value",
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("accepts an exact public verification key and rejects private or mismatched custody", () => {
    expect(centralHostReadyReceiptSchema.safeParse(ready).success).toBe(true);
    expect(
      centralHostReadyReceiptSchema.safeParse({
        ...ready,
        activation: {
          ...activation,
          publicKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
        },
      }).success,
    ).toBe(false);
    expect(
      centralHostReadyReceiptSchema.safeParse({
        ...ready,
        activation: { ...activation, publicKeySha256: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });
});
it("preserves absent legacy source mode while requiring receipt-backed exact graph for a new machine intent", () => {
  const legacy = structuredClone(plan);
  delete legacy.source.deploymentProfile;
  delete legacy.source.buildReceiptSha256;
  legacy.source.serviceIds = ["gateway", "apps", "integrations"];
  expect(centralHostSetupPlanSchema.parse(legacy).source.deploymentProfile).toBeUndefined();
  const missing = structuredClone(plan);
  delete missing.source.buildReceiptSha256;
  expect(() => centralHostSetupPlanSchema.parse(missing)).toThrow();
  expect(() =>
    centralHostSetupPlanSchema.parse({
      ...plan,
      source: { ...plan.source, serviceIds: ["gateway", "apps", "integrations"] },
    }),
  ).toThrow();
});

it("keeps an app-caller authorization receipt outside infrastructure setup authority", () => {
  expect(
    centralEffectReceiptMatches(
      plan,
      {
        callerProjectId: plan.inspector.projectId,
        effect: "authorize-app-central-caller",
        environment: plan.inspector.environment,
        projectId: plan.target.projectId,
        targetEnvironment: "preview",
        trustedSourcesGrantSha256: "b".repeat(64),
        trustedSourcesSha256: "a".repeat(64),
      },
      1,
    ),
  ).toBe(false);
});
