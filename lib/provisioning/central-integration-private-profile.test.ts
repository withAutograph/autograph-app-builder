import { createHash, createPublicKey } from "node:crypto";
import { expect, it } from "vitest";
import { centralPrivateProfileFixture } from "./central-integration-private-profile-test-fixture";
import {
  centralIntegrationPrivateProfileSchema,
  readCentralIntegrationPrivateProfile,
  centralIntegrationPrivateProfileDigest,
  centralPrivateRuntimeFingerprint,
  CENTRAL_PRIVATE_RUNTIME_KEYS,
} from "./central-integration-private-profile";
import {
  createFreshCentralIntegrationPrivateSeed,
  centralIntegrationPrivateSeedSchema,
  centralAcceptedReceiverSchema,
} from "./central-integration-private-custody";
it("requires explicit isolated private setup with no ambient credential fallback", () => {
  expect(() => readCentralIntegrationPrivateProfile({ AMPERSAND_API_KEY: "ambient-key" })).toThrow(
    "central_integration_private_profile_required",
  );
  const profile = centralPrivateProfileFixture();
  expect(
    readCentralIntegrationPrivateProfile({
      HOSTED_CENTRAL_INTEGRATIONS_CONFIGURATION: JSON.stringify(profile),
    }),
  ).toEqual(profile);
  for (const privateScope of [
    {
      ...profile.private.bootstrap,
      connectionString: profile.private.bootstrap.connectionString.replace(
        "verify-full",
        "disable",
      ),
    },
    {
      ...profile.private.bootstrap,
      productionDatabaseIdentity: `${profile.control.resource.hostname}/production`,
    },
    {
      ...profile.private.bootstrap,
      connectionString: profile.private.bootstrap.connectionString.replace(
        profile.control.resource.hostname,
        "foreign.neon.tech",
      ),
    },
    {
      ...profile.private.bootstrap,
      connectionString: `${profile.private.bootstrap.connectionString}&host=ep-production.neon.tech`,
    },
    {
      ...profile.private.bootstrap,
      connectionString: `${profile.private.bootstrap.connectionString}&sslmode=disable`,
    },
  ]) {
    expect(
      centralIntegrationPrivateProfileSchema.safeParse({
        ...profile,
        private: { ...profile.private, bootstrap: privateScope },
      }).success,
    ).toBe(false);
  }
});
it("profile metadata never includes credentials or a circular global setup pointer", () => {
  const profile = centralPrivateProfileFixture();
  const rotated = {
    ...profile,
    private: { ...profile.private, providerApiKey: "changed-private-key" },
    globalSetup: {
      authority: profile.owners[0],
      operationRef: "11111111-1111-4111-a111-111111111111",
      planDigest: "a".repeat(64),
    },
  };
  expect(centralIntegrationPrivateProfileDigest(rotated)).toBe(
    centralIntegrationPrivateProfileDigest(profile),
  );
  expect(
    centralIntegrationPrivateProfileDigest({
      ...profile,
      target: { ...profile.target, projectId: "another-project" },
    }),
  ).not.toBe(centralIntegrationPrivateProfileDigest(profile));
});
it("generates fresh infrastructure keys that verify against the public activation digest", () => {
  const seed = createFreshCentralIntegrationPrivateSeed();
  const other = createFreshCentralIntegrationPrivateSeed();
  expect(other.activation.publicKeySha256).not.toBe(seed.activation.publicKeySha256);
  expect(seed.runtimePassword).not.toBe(seed.migratorPassword);
  const key = createPublicKey(seed.activation.privateKeyPem);
  expect(
    createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex"),
  ).toBe(seed.activation.publicKeySha256);
  expect(
    centralIntegrationPrivateSeedSchema.safeParse({
      ...seed,
      activation: { ...seed.activation, publicKeyPem: other.activation.publicKeyPem },
    }).success,
  ).toBe(false);
});
it("fingerprints the exact ten loaded keys separately from the public manifest", () => {
  const values = Object.fromEntries(
    CENTRAL_PRIVATE_RUNTIME_KEYS.map((key) => [key, `synthetic-${key}`]),
  );
  const expected = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(values)
          .toSorted(([a], [b]) => {
            if (a < b) {
              return -1;
            }
            if (a > b) {
              return 1;
            }
            return 0;
          })
          .map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")]),
      ),
    )
    .digest("hex");
  expect(
    centralPrivateRuntimeFingerprint({
      ...values,
      INTEGRATIONS_CENTRAL_CONFIGURATION: "public-only",
    }),
  ).toBe(expected);
  expect(
    centralPrivateRuntimeFingerprint({ ...values, INTEGRATIONS_AMPERSAND_API_KEY: "changed" }),
  ).not.toBe(expected);
});
it("rejects a mismatched accepted receiver secret hash before custody", () => {
  expect(
    centralAcceptedReceiverSchema.safeParse({
      subscriptionRef: "11111111-1111-4111-a111-111111111111",
      id: "accepted",
      secret: "private",
      secretSha256: "a".repeat(64),
    }).success,
  ).toBe(false);
});
