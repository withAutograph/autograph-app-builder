import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { openHostedPostgresDatabase } from "../../../../../lib/mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../../../../../lib/integrations/vercel-installation";
import { builderProvisioningJournals } from "../../../../../lib/db/schema";
import { centralPrivateProfileFixture } from "../../../../../lib/provisioning/central-integration-private-profile-test-fixture";
import {
  resolveCentralRuntimeConfiguration,
  centralIntegrationPrivateProfileDigest,
  readCentralRuntimeConfiguration,
} from "../../../../../lib/provisioning/central-integration-private-profile";
import { centralHostCanonicalBytes } from "../../../../../lib/provisioning/central-integration-host-contract";
import { createCentralIntegrationPrivateCustody } from "../../../../../lib/provisioning/central-integration-private-custody";
/** Actual restricted-writer SQL/encryption proof; synthetic metadata is not hosted authority. */
export const proveCentralPrivateCustody = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
}) => {
  const profile = centralPrivateProfileFixture();
  const authority = profile.owners[0];

  let authorized = true;
  const assertCurrent = () => {
    assert.ok(authorized, "revoked");
    return Promise.resolve();
  };
  const create = () =>
    resolveCentralRuntimeConfiguration({ ...input, profile, authority, assertCurrent });
  const [first, restarted] = await Promise.all([create(), create()]);
  assert.equal(first.configurationRef, restarted.configurationRef);
  assert.equal(first.privateConfigurationSha256, restarted.privateConfigurationSha256);
  assert.deepEqual(first.values, restarted.values);
  assert.deepEqual(first.resourceCredentials, restarted.resourceCredentials);
  assert.equal(Object.keys(first.values).length, 12);
  assert.equal(new URL(first.connections.runtime).hostname, profile.control.resource.hostname);
  assert.equal(
    decodeURIComponent(new URL(first.connections.runtime).username),
    profile.control.centralRuntimeRole,
  );
  assert.notEqual(
    new URL(first.connections.runtime).password,
    new URL(first.connections.migrator).password,
  );
  const rows = await input.database
    .select()
    .from(builderProvisioningJournals)
    .where(eq(builderProvisioningJournals.requestId, first.configurationRef));
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]?.record);
  assert.equal(serialized.includes(profile.private.providerApiKey), false);
  assert.equal(serialized.includes(first.resourceCredentials.runtimePassword), false);
  const activationPrivateKey = first.values.INTEGRATIONS_ACTIVATION_PRIVATE_KEY_PEM;
  assert.equal(typeof activationPrivateKey, "string");
  assert.equal(serialized.includes(String(activationPrivateKey)), false);
  const receiver = {
    subscriptionRef: "77777777-7777-4777-a777-777777777777",
    id: "actual-accepted-provider-id",
    secret: "private-receiver-secret",
    secretSha256: createHash("sha256").update("private-receiver-secret").digest("hex"),
  };
  const accepted = await first.custody.recordAcceptedReceiver(receiver);
  const same = await restarted.custody.recordAcceptedReceiver(receiver);
  assert.equal(accepted.sha256, same.sha256);
  await assert.rejects(
    restarted.custody.recordAcceptedReceiver({ ...receiver, id: "changed-id" }),
    /conflict/u,
  );
  const unchanged = await restarted.custody.read("accepted-receiver", receiver.subscriptionRef);
  assert.deepEqual(unchanged?.value, receiver);
  const foreign = createCentralIntegrationPrivateCustody({
    ...input,
    scope: { ...first.scope, authority: { ...authority, ownerUserId: "foreign-owner" } },
    assertCurrent,
  });
  assert.equal(await foreign.read("central-seed", "stable-v1"), undefined);
  const otherResource = createCentralIntegrationPrivateCustody({
    ...input,
    scope: { ...first.scope, resourceProfileId: "another-resource" },
    assertCurrent,
  });
  assert.equal(await otherResource.read("central-seed", "stable-v1"), undefined);
  await assert.rejects(
    resolveCentralRuntimeConfiguration({
      ...input,
      profile,
      authority: { ...authority, ownerUserId: "foreign-owner" },
      assertCurrent,
    }),
    /profile_required/u,
  );
  const rotated = {
    ...profile,
    private: { ...profile.private, providerApiKey: "new-approved-provider-key" },
  };
  assert.equal(
    centralIntegrationPrivateProfileDigest(rotated),
    centralIntegrationPrivateProfileDigest(profile),
  );
  const next = await resolveCentralRuntimeConfiguration({
    ...input,
    profile: rotated,
    authority,
    assertCurrent,
  });
  assert.notEqual(next.configurationRef, first.configurationRef);
  assert.deepEqual(next.resourceCredentials, first.resourceCredentials);
  assert.deepEqual(next.activation, first.activation);
  const sourceRevision = {
    ...profile,
    source: { ...profile.source, reviewedSourceSha: "b".repeat(40), reviewDigest: "c".repeat(64) },
  };
  const revised = await resolveCentralRuntimeConfiguration({
    ...input,
    profile: sourceRevision,
    authority,
    assertCurrent,
  });
  assert.notEqual(revised.configurationRef, first.configurationRef);
  assert.equal(revised.configurationSha256, first.configurationSha256);
  assert.deepEqual(revised.resourceCredentials, first.resourceCredentials);
  assert.deepEqual(revised.activation, first.activation);
  const frozenInput = {
    ...input,
    profile: sourceRevision,
    authority,
    assertCurrent,
    configurationRef: first.configurationRef,
    configurationSha256: first.configurationSha256,
    profileDigest: centralIntegrationPrivateProfileDigest(profile),
  };
  const frozen = await readCentralRuntimeConfiguration(frozenInput);
  assert.deepEqual(frozen?.values, first.values);
  assert.deepEqual(frozen?.resourceCredentials, first.resourceCredentials);
  const missingSha = "f".repeat(64);
  const missingIdentity = createHash("sha256")
    .update(
      centralHostCanonicalBytes({
        configurationSha256: missingSha,
        profileDigest: frozenInput.profileDigest,
      }),
    )
    .digest("hex");
  const beforeMissing = await input.database
    .select({ count: sql<number>`count(*)::int` })
    .from(builderProvisioningJournals);
  const absent = await readCentralRuntimeConfiguration({
    ...frozenInput,
    configurationSha256: missingSha,
    configurationRef: first.custody.reference("runtime-configuration", missingIdentity),
  });
  assert.equal(absent, undefined);
  const afterMissing = await input.database
    .select({ count: sql<number>`count(*)::int` })
    .from(builderProvisioningJournals);
  assert.deepEqual(afterMissing, beforeMissing);
  await assert.rejects(
    readCentralRuntimeConfiguration({ ...frozenInput, configurationSha256: missingSha }),
  );

  await assert.rejects(
    createCentralIntegrationPrivateCustody({
      ...input,
      keyring: { tokenKey: Buffer.alloc(32, 2), tokenKeyVersion: "wrong" },
      scope: first.scope,
      assertCurrent,
    }).read("central-seed", "stable-v1"),
  );
  const before = await input.database
    .select({ count: sql<number>`count(*)::int` })
    .from(builderProvisioningJournals);
  authorized = false;
  await assert.rejects(create(), /revoked/u);
  authorized = true;
  const after = await input.database
    .select({ count: sql<number>`count(*)::int` })
    .from(builderProvisioningJournals);
  assert.deepEqual(after, before);
  console.log(
    "PASS central private custody: real restricted SQL, sealed first seed, immutable accepted receiver, owner/resource/key isolation, stable credentials across source/config changes, revoked write denial",
  );
};
