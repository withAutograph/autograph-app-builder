import { integrationCapabilityV2PlanInput } from "../../../../../lib/provisioning/app-integration-capability-v2-test-fixture";
import { providerDestinationCustodyScopes } from "../../../../../lib/provisioning/app-integration-provider-destination";
import { z } from "zod";
import { appIntegrationReadObjectsSchema } from "../../../../../lib/repository/app-integration-metadata";
import assert from "node:assert/strict";
import { createPublicKey, createHash, createDecipheriv } from "node:crypto";
import type { openHostedPostgresDatabase } from "../../../../../lib/mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../../../../../lib/integrations/vercel-installation";
import {
  createAppIntegrationPrivateCustody,
  createFreshAppIntegrationPrivateSeed,
} from "../../../../../lib/provisioning/app-integration-private-custody";
import { createAppIntegrationPrivateConfiguration } from "../../../../../lib/provisioning/app-integration-private-configuration";
import { integrationCapabilityPlan as fixture } from "../../../../../lib/provisioning/app-integration-capability-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  preparedAppIntegrationCapabilitySchema,
} from "../../../../../lib/provisioning/app-integration-capability-contract";
/** Actual journal/encryption proof. Approvals and actor generations here are controlled inputs, not hosted evidence. */
export const proveAppIntegrationPrivateCustody = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
}) => {
  const app = {
    authority: fixture.authority,
    appId: fixture.selection.appId,
    projectId: fixture.project.projectId,
    provisioningRequestId: fixture.project.provisioningRequestId,
    provisioningDigest: fixture.project.provisioningDigest,
    resourceProfileId: fixture.control.resourceProfileId,
    controlResource: fixture.control.database,
    controlNeon: fixture.control.neon,
  };
  let current = true;
  const assertCurrent = async () => {
    await Promise.resolve();
    if (!current) {
      throw new Error("revoked");
    }
  };
  const scope = {
    app,
    purpose: "app-seed" as const,
    version: 1 as const,
    checkpoint: "stable-app-integration-seed-v1",
  };
  const custody = createAppIntegrationPrivateCustody({ ...input, app, assertCurrent });
  let generated = 0;
  const seed = await custody.reserve(scope, () => {
    generated += 1;
    return createFreshAppIntegrationPrivateSeed();
  });
  const restarted = createAppIntegrationPrivateCustody({ ...input, app, assertCurrent });
  const reused = await restarted.reserve(scope, () => {
    throw new Error("must not regenerate");
  });
  assert.equal(generated, 1);
  assert.equal(seed.reference, reused.reference);
  assert.equal(seed.sha256, reused.sha256);
  assert.equal(JSON.stringify(seed.value) === JSON.stringify(reused.value), true);
  const key = createPublicKey({
    key: Buffer.from(
      "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    ),
    format: "der",
    type: "spki",
  });
  const publicKeyPem = key.export({ type: "spki", format: "pem" });
  const plan = appIntegrationCapabilityPlanSchema.parse({
    ...fixture,
    control: {
      ...fixture.control,
      activationPublicKeySha256: createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex"),
    },
    privateConfigurationSeed: { reference: seed.reference, sha256: seed.sha256 },
  });
  const authorityKeyring = {
    activeKeyId: "owned-registry-v1",
    keys: { "owned-registry-v1": Buffer.alloc(32, 7).toString("base64") },
  };
  const create = () =>
    createAppIntegrationPrivateConfiguration({
      plan,
      custody: restarted,
      appScope: app,
      activationPublicKeyPem: publicKeyPem,
      productionControlDatabaseIdentity: "ep-production.neon.tech/integrations",
      authorityKeyring,
      assertCurrent,
    });
  const receipts = [
    {
      effect: "bind-service-memberships" as const,
      resourceVersion: "owned-actor-readback",
      memberships: plan.serviceMemberships.map((member) => ({ ...member, fenceGeneration: 7 })),
    },
  ];
  const prepared = await create().create(receipts, 8);
  const replay = await create().create(receipts, 8);
  assert.equal(JSON.stringify(prepared) === JSON.stringify(replay), true);
  assert.equal(prepared.capability.control.principalGeneration, 8);
  assert.equal(prepared.capability.serviceMemberships[0]?.fenceGeneration, 7);
  const { sealed, ...metadata } = prepared.registration;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.alloc(32, 7),
    Buffer.from(sealed.tokenIv, "base64"),
  );
  decipher.setAAD(
    Buffer.from(`app-integration-application-authority-v1\n${JSON.stringify(metadata)}`),
  );
  decipher.setAuthTag(Buffer.from(sealed.tokenTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.encryptedToken, "base64")),
    decipher.final(),
  ]).toString("utf-8");
  assert.equal(createHash("sha256").update(plaintext).digest("hex"), metadata.authoritySha256);
  const authority = z
    .object({
      readObjects: appIntegrationReadObjectsSchema,
      capability: preparedAppIntegrationCapabilitySchema,
    })
    .parse(JSON.parse(plaintext));
  assert.equal(
    JSON.stringify(authority.readObjects) ===
      JSON.stringify(plan.providerConfiguration.readObjects),
    true,
  );
  assert.equal(JSON.stringify(authority.capability) === JSON.stringify(prepared.capability), true);
  const privateValue = z
    .record(z.string(), z.string())
    .parse(JSON.parse(prepared.serializedConfiguration));
  assert.equal(privateValue.scopeSha256, prepared.scopeSha256);
  for (const name of ["activationPrivateKeyPem", "providerApiKey", "webhookSigningSecret"]) {
    assert.equal(name in privateValue, false);
  }
  const foreign = createAppIntegrationPrivateCustody({
    ...input,
    app: { ...app, authority: { ...app.authority, ownerUserId: "foreign-owner" } },
    assertCurrent,
  });
  assert.equal(
    await foreign.read({
      ...scope,
      app: { ...app, authority: { ...app.authority, ownerUserId: "foreign-owner" } },
    }),
    undefined,
  );
  // New provider signing material stays in encrypted central authority, never the app's runtime projection.
  const v2 = appIntegrationCapabilityPlanSchema.parse({
    ...integrationCapabilityV2PlanInput(),
    control: plan.control,
    privateConfigurationSeed: plan.privateConfigurationSeed,
  });
  const target = v2.providerDestination;
  if (target === undefined) {
    throw new Error("missing v2 destination");
  }
  const url = new URL(target.path, target.origin).href;
  const destinationKey = await custody.reserve(
    providerDestinationCustodyScopes(app, v2.provider.projectId, target.name, url).keyScope,
    () => ({
      destinationId: "owned-provider-destination",
      name: target.name,
      url,
      signingSecret: "whsec_c3ludGhldGljLWN1c3RvZHkta2V5",
    }),
  );
  const destinationReceipt = {
    effect: "prepare-provider-destination" as const,
    destinationId: "owned-provider-destination",
    name: target.name,
    url,
    secretRef: destinationKey.reference,
    secretSha256: createHash("sha256").update("whsec_c3ludGhldGljLWN1c3RvZHkta2V5").digest("hex"),
  };
  const v2Prepared = await createAppIntegrationPrivateConfiguration({
    plan: v2,
    custody: restarted,
    appScope: app,
    activationPublicKeyPem: publicKeyPem,
    productionControlDatabaseIdentity: "ep-production.neon.tech/integrations",
    authorityKeyring,
    assertCurrent,
  }).create([...receipts, destinationReceipt], 8);
  assert.equal(
    v2Prepared.capability.providerDestination?.destinationId,
    "owned-provider-destination",
  );
  assert.equal(v2Prepared.serializedConfiguration.includes("whsec_"), false);
  assert.equal(JSON.stringify(v2Prepared.capability).includes("whsec_"), false);
  const { sealed: v2Sealed, ...v2Metadata } = v2Prepared.registration;
  const v2Decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.alloc(32, 7),
    Buffer.from(v2Sealed.tokenIv, "base64"),
  );
  v2Decipher.setAAD(
    Buffer.from(`app-integration-application-authority-v1\n${JSON.stringify(v2Metadata)}`),
  );
  v2Decipher.setAuthTag(Buffer.from(v2Sealed.tokenTag, "base64"));
  const v2Plaintext = Buffer.concat([
    v2Decipher.update(Buffer.from(v2Sealed.encryptedToken, "base64")),
    v2Decipher.final(),
  ]).toString("utf8");
  const v2Authority = z
    .object({
      providerDestination: z.object({ signingSecret: z.string(), destinationId: z.string() }),
    })
    .parse(JSON.parse(v2Plaintext));
  assert.equal(v2Authority.providerDestination.signingSecret, "whsec_c3ludGhldGljLWN1c3RvZHkta2V5");
  assert.equal(v2Authority.providerDestination.destinationId, "owned-provider-destination");
  await assert.rejects(
    createAppIntegrationPrivateConfiguration({
      plan: v2,
      custody: restarted,
      appScope: app,
      activationPublicKeyPem: publicKeyPem,
      productionControlDatabaseIdentity: "ep-production.neon.tech/integrations",
      authorityKeyring,
      assertCurrent,
    }).create([...receipts, { ...destinationReceipt, secretSha256: "f".repeat(64) }], 8),
  );
  current = false;
  await assert.rejects(restarted.read(scope), /^Error: revoked$/u);
  await assert.rejects(create().create(receipts, 8), /^Error: revoked$/u);
};
