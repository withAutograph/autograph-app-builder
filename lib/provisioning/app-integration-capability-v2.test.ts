import { integrationCapabilityV2PlanInput as candidate } from "./app-integration-capability-v2-test-fixture";
import { expect, it } from "vitest";
import { integrationCapabilityPlan as legacy } from "./app-integration-capability-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  canonicalAppIntegrationCapabilityPlanBytes,
} from "./app-integration-capability-contract";
import { initialAppIntegrationCapabilityRecord } from "./app-integration-capability-store";

it("preserves legacy intent bytes and acquires no destination state", () => {
  const parsed = appIntegrationCapabilityPlanSchema.parse(legacy);
  expect(canonicalAppIntegrationCapabilityPlanBytes(parsed)).toBe(
    canonicalAppIntegrationCapabilityPlanBytes(legacy),
  );
  expect(
    initialAppIntegrationCapabilityRecord(parsed).effects["prepare-provider-destination"],
  ).toBeUndefined();
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...legacy,
      resourceWorker: candidate().resourceWorker,
    }).success,
  ).toBe(false);
});
it("freezes the actual resource worker and installed app ingress in new consent", () => {
  const plan = appIntegrationCapabilityPlanSchema.parse(candidate());
  expect(
    initialAppIntegrationCapabilityRecord(plan).effects["prepare-provider-destination"]?.state,
  ).toBe("idle");
  expect(
    appIntegrationCapabilityPlanDigest({
      ...plan,
      resourceWorker: { id: "neon-resource-bootstrap-v1", sha256: "b".repeat(64) },
    }),
  ).not.toBe(appIntegrationCapabilityPlanDigest(plan));
  expect(
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    appIntegrationCapabilityPlanSchema.safeParse({ ...candidate(), resourceWorker: undefined })
      .success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({ ...candidate(), machineIngress: [] }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...candidate(),
      providerDestination: {
        ...candidate().providerDestination,
        path: "/other/api/integrations/quickbooks",
      },
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({
      ...candidate(),
      providerDestination: { ...candidate().providerDestination, name: "other-destination" },
    }).success,
  ).toBe(false);
  expect(
    appIntegrationCapabilityPlanSchema.safeParse({ ...candidate(), effects: legacy.effects })
      .success,
  ).toBe(false);
});
