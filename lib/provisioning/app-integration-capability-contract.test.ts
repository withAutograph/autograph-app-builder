import { expect, it } from "vitest";
import { integrationCapabilityPlan as plan } from "./app-integration-capability-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  canonicalAppIntegrationCapabilityPlanBytes,
} from "./app-integration-capability-contract";

it("canonicalizes complete approved intent independently of object insertion order", () => {
  const reordered = {
    ...plan,
    project: Object.fromEntries(Object.entries(plan.project).toReversed()),
  };
  expect(
    canonicalAppIntegrationCapabilityPlanBytes(appIntegrationCapabilityPlanSchema.parse(reordered)),
  ).toBe(canonicalAppIntegrationCapabilityPlanBytes(plan));
  expect(
    appIntegrationCapabilityPlanDigest({
      ...plan,
      serviceMemberships: [{ ...plan.serviceMemberships[0], actorId: "different-service" }],
    }),
  ).not.toBe(appIntegrationCapabilityPlanDigest(plan));
  expect(
    appIntegrationCapabilityPlanDigest({
      ...plan,
      release: { ...plan.release, artifactSha256: "5".repeat(64) },
    }),
  ).not.toBe(appIntegrationCapabilityPlanDigest(plan));
});
it("requires isolated distinct app/control resources and fresh exact service declarations", () => {
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...plan,
      control: { ...plan.control, database: plan.runtime.appDatabase },
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...plan,
      serviceMemberships: [plan.serviceMemberships[0], plan.serviceMemberships[0]],
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...plan,
      provider: { ...plan.provider, kind: "quickbooksProduction" },
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...plan,
      runtime: {
        ...plan.runtime,
        appDatabase: { ...plan.runtime.appDatabase, environment: "production" },
      },
    }).success,
  ).toBe(false);
});
it("rejects hidden plan fields and never treats a private configuration reference as plaintext authority", () => {
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({ ...plan, arbitraryProviderToken: "secret" })
      .success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanDigest({
      ...plan,
      privateConfigurationSeed: { ...plan.privateConfigurationSeed, sha256: "6".repeat(64) },
    }),
  ).not.toBe(appIntegrationCapabilityPlanDigest(plan));
});
it("binds actual provider configuration and exact machine endpoints to the captured release", () => {
  for (const providerConfiguration of [
    { ...plan.providerConfiguration, artifactRef: "foreign-release" },
    { ...plan.providerConfiguration, recipeId: "foreign-recipe" },
    { ...plan.providerConfiguration, readObjectsSha256: "a".repeat(64) },
  ]) {
    expect(
      appIntegrationCapabilityPlanSchema.safeParse({ ...plan, providerConfiguration }).success,
    ).toBe(false);
  }
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...plan,
      machineIngress: [
        { kind: "readiness", method: "POST", path: "/other-app/api/integrations/readiness" },
      ],
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({ ...plan, readinessPath: "/foreign" }).success,
  ).toBe(false);
});
