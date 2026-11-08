import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { plan as base } from "./public-release-test-fixture";
import {
  publicReleasePlanSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "./public-release-contract";
import {
  assertOwnedAppProductionEnvironment,
  ownedAppPublicEnvironmentKeys,
  ownedAppReleaseEnvironmentManifest,
} from "./owned-app-auth-environment";
import {
  integrationTestAttachment as integration,
  integrationTestConfiguration,
} from "./app-integration-release-test-fixture";

const authValues = Object.fromEntries(
  ownedAppPublicEnvironmentKeys(base.selection.appId).map((key) => [key, `unit-${key}`]),
);
const values = {
  ...authValues,
  APP_INTEGRATIONS_CAPABILITY: JSON.stringify(integration.capability),
  APP_INTEGRATIONS_RUNTIME_CONFIGURATION: integrationTestConfiguration,
};
const manifest = ownedAppReleaseEnvironmentManifest(base.selection.appId, values, integration);
const published = publicReleasePlanSchema.parse({
  ...base,
  environment: manifest,
  integrationCapability: integration,
  purpose: "application",
  runtime: { ...base.runtime, releaseId: integration.capability.release.id },
});
const retained = (
  ["APP_INTEGRATIONS_CAPABILITY", "APP_INTEGRATIONS_RUNTIME_CONFIGURATION"] as const
).map((key) => ({
  acceptedEnvId: `owned-${key}`,
  key,
  sha256: createHash("sha256").update(values[key]).digest("hex"),
  sourceOperationRef: publicReleaseOperationRef(published),
  sourcePlanDigest: publicReleasePlanDigest(published),
}));
test("only a separately approved attachment admits exactly its two private configuration hashes", () => {
  expect(manifest).toHaveLength(17);
  expect(() => {
    assertOwnedAppProductionEnvironment(published, Object.keys(values));
  }).not.toThrow();
  expect(() => ownedAppReleaseEnvironmentManifest(base.selection.appId, values)).toThrow();
  expect(() =>
    ownedAppReleaseEnvironmentManifest(
      base.selection.appId,
      { ...values, APP_INTEGRATIONS_RUNTIME_CONFIGURATION: `${integrationTestConfiguration} ` },
      integration,
    ),
  ).toThrow();
  expect(
    publicReleasePlanSchema.safeParse({
      ...published,
      environment: manifest.map((entry) =>
        entry.key === "APP_INTEGRATIONS_RUNTIME_CONFIGURATION"
          ? { ...entry, sha256: "f".repeat(64) }
          : entry,
      ),
    }).success,
  ).toBe(false);
  expect(
    publicReleasePlanSchema.safeParse({ ...published, purpose: "auth-bootstrap" }).success,
  ).toBe(false);
});
test("fresh Auth bootstrap retains proven optional rows read-only while its write set remains fifteen", () => {
  const bootstrap = publicReleasePlanSchema.parse({
    ...base,
    environment: ownedAppReleaseEnvironmentManifest(base.selection.appId, authValues),
    purpose: "auth-bootstrap",
    retainedOptionalBindings: retained,
  });
  expect(bootstrap.environment).toHaveLength(15);
  expect(bootstrap.environment.some((entry) => entry.key.startsWith("APP_INTEGRATIONS_"))).toBe(
    false,
  );
  expect(() => {
    assertOwnedAppProductionEnvironment(bootstrap, Object.keys(values));
  }).not.toThrow();
  expect(() => {
    assertOwnedAppProductionEnvironment(
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      { ...bootstrap, retainedOptionalBindings: undefined },
      Object.keys(values),
    );
  }).toThrow();
  expect(publicReleasePlanSchema.safeParse({ ...bootstrap, purpose: "application" }).success).toBe(
    false,
  );
  expect(publicReleasePlanSchema.safeParse({ ...bootstrap, environment: manifest }).success).toBe(
    false,
  );
});
