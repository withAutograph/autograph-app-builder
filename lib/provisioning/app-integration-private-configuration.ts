import {
  providerDestinationCustodyScopes,
  integrationProviderDestinationKeySchema,
} from "./app-integration-provider-destination";
import { isDeepStrictEqual } from "node:util";
import { createHash, createHmac, createCipheriv, randomBytes, createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
  preparedAppIntegrationCapabilitySchema,
} from "./app-integration-capability-contract";
import type {
  AppIntegrationCapabilityPlan,
  IntegrationCapabilityReceipt,
} from "./app-integration-capability-contract";
import { appIntegrationPrivateSeedSchema } from "./app-integration-private-custody";
import type {
  createAppIntegrationPrivateCustody,
  IntegrationPrivateAppScope,
  IntegrationPrivateScope,
} from "./app-integration-private-custody";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("app_integration_private_configuration_unavailable");
const registryKeyringSchema = z.strictObject({
  activeKeyId: z.string().min(1),
  keys: z.record(z.string().min(1), z.string().min(1)),
});
const authorityDigest = z.string().regex(/^[a-f0-9]{64}$/u);
export const appIntegrationAuthorityEnvelopeSchema = z.strictObject({
  kind: z.literal("app-integration-application-authority-v1"),
  resourceProfileId: z.string().min(1),
  appId: z.string().min(1),
  registrationIdentitySha256: authorityDigest,
  operationRef: z.uuid(),
  planDigest: authorityDigest,
  principalName: z.string().min(1),
  principalGeneration: z.number().int().positive(),
  customerIds: z.array(z.string().min(1)).min(1),
  scopeSha256: authorityDigest,
  configurationRef: z.uuid(),
  configurationSha256: authorityDigest,
  authoritySha256: authorityDigest,
  keyId: z.string().min(1),
  active: z.literal(true),
  sealed: z.strictObject({
    encryptedToken: z.string().min(1),
    tokenIv: z.string().min(1),
    tokenTag: z.string().min(1),
  }),
});
export type AppIntegrationAuthorityEnvelope = z.infer<typeof appIntegrationAuthorityEnvelopeSchema>;
export type IntegrationAuthorityKeyring = z.infer<typeof registryKeyringSchema>;
const resource = (value: AppIntegrationCapabilityPlan["control"]["database"]) => ({
  resourceId: value.resourceId,
  hostname: value.hostname,
  port: value.port,
  database: value.database,
  schema: value.schema,
  runtimeRole: value.runtimeRole,
});
export const createAppIntegrationPrivateConfiguration = (input: {
  plan: AppIntegrationCapabilityPlan;
  custody: ReturnType<typeof createAppIntegrationPrivateCustody>;
  appScope: IntegrationPrivateAppScope;
  activationPublicKeyPem: string;
  productionControlDatabaseIdentity: string;
  authorityKeyring: IntegrationAuthorityKeyring;
  assertCurrent: () => Promise<void>;
}) => {
  const plan = input.plan;
  const publicKey = createPublicKey(input.activationPublicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex") !== plan.control.activationPublicKeySha256
  ) {
    throw unavailable();
  }
  const production = /^(?<hostname>[a-z0-9.-]+\.neon\.tech)\/[a-z][a-z0-9_]*$/u.exec(
    input.productionControlDatabaseIdentity,
  );
  const normalize = (hostname: string) => hostname.replace(/-pooler(?=\.)/u, "");
  if (
    production === null ||
    normalize(production.groups?.hostname ?? "") === normalize(plan.control.database.hostname)
  ) {
    throw unavailable();
  }

  const checkpoint = appIntegrationCapabilityPlanDigest(plan);
  const create = async (
    receipts: readonly IntegrationCapabilityReceipt[],
    principalGeneration: number,
  ) => {
    await input.assertCurrent();
    const memberships = receipts.find((receipt) => receipt.effect === "bind-service-memberships");
    if (memberships?.effect !== "bind-service-memberships") {
      throw unavailable();
    }
    const seedStored = await input.custody.read({
      app: input.appScope,
      purpose: "app-seed",
      version: 1,
      checkpoint: "stable-app-integration-seed-v1",
    });
    if (
      seedStored === undefined ||
      seedStored.reference !== plan.privateConfigurationSeed.reference ||
      seedStored.sha256 !== plan.privateConfigurationSeed.sha256
    ) {
      throw unavailable();
    }
    const seed = appIntegrationPrivateSeedSchema.parse(seedStored.value);
    let destination:
      | {
          destinationId: string;
          name: string;
          url: string;
          secretSha256: string;
          signingSecret: string;
        }
      | undefined;
    if (plan.version === 2) {
      const target = plan.providerDestination,
        receipt = receipts.find((value) => value.effect === "prepare-provider-destination");
      if (target === undefined || receipt?.effect !== "prepare-provider-destination") {
        throw unavailable();
      }
      const { keyScope } = providerDestinationCustodyScopes(
        input.appScope,
        plan.provider.projectId,
        target.name,
        new URL(target.path, target.origin).href,
      );
      const saved = await input.custody.read(keyScope);
      await input.assertCurrent();
      if (saved === undefined || saved.reference !== receipt.secretRef) {
        throw unavailable();
      }
      const material = integrationProviderDestinationKeySchema.parse(saved.value);
      const { signingSecret, ...tuple } = material;
      if (
        !isDeepStrictEqual(tuple, {
          destinationId: receipt.destinationId,
          name: receipt.name,
          url: receipt.url,
        }) ||
        hash(signingSecret) !== receipt.secretSha256
      ) {
        throw unavailable();
      }
      destination = { ...tuple, secretSha256: receipt.secretSha256, signingSecret };
    }
    const publicDestination =
      destination === undefined
        ? undefined
        : {
            destinationId: destination.destinationId,
            name: destination.name,
            url: destination.url,
            secretSha256: destination.secretSha256,
          };
    const provisional = preparedAppIntegrationCapabilitySchema.parse({
      kind: "app-integrations-development-v1",
      appId: plan.selection.appId,
      environment: "development",
      resourceProfile: "isolated-development",
      release: {
        id: plan.release.id,
        manifestSha256: plan.release.manifestSha256,
        artifactSha256: plan.release.artifactSha256,
      },
      appDatabase: resource(plan.runtime.appDatabase),
      control: {
        origin: plan.control.origin,
        resourceProfileId: plan.control.resourceProfileId,
        principalGeneration,
        database: resource(plan.control.database),
        activationKeyId: plan.control.activationKeyId,
        activationPublicKeySha256: plan.control.activationPublicKeySha256,
      },
      provider: plan.provider,
      ...(publicDestination === undefined ? {} : { providerDestination: publicDestination }),
      serviceMemberships: memberships.memberships,
      ...(plan.machineIngress === undefined ? {} : { machineIngress: plan.machineIngress }),
      privateConfiguration: {
        reference: plan.privateConfigurationSeed.reference,
        sha256: "0".repeat(64),
      },
    });
    const { privateConfiguration: ignored, ...scope } = provisional;
    void ignored;
    const scopeSha256 = hash(JSON.stringify(scope));
    const configurationScope: IntegrationPrivateScope = {
      app: input.appScope,
      purpose: "runtime-configuration",
      version: 1,
      checkpoint: `${checkpoint}:${scopeSha256}`,
    };
    const reference = input.custody.reference(configurationScope);
    const url = new URL(`postgresql://${plan.control.database.hostname}:5432/`);
    url.username = plan.control.database.runtimeRole;
    url.password = seed.controlRuntimePassword;
    url.pathname = `/${plan.control.database.database}`;
    url.searchParams.set("sslmode", "verify-full");
    const stored = await input.custody.reserve(configurationScope, () => ({
      reference,
      scopeSha256,
      controlDatabaseUrl: url.toString(),
      productionControlDatabaseIdentity: input.productionControlDatabaseIdentity,
      activationPublicKeyPem: input.activationPublicKeyPem,
      serviceSecret: seed.serviceSecret,
      catalogAuthoritySecret: seed.catalogAuthoritySecret,
      setupProofSecret: seed.setupProofSecret,
      ingressSecret: seed.ingressSecret,
    }));
    const capability = preparedAppIntegrationCapabilitySchema.parse({
      ...scope,
      privateConfiguration: { reference: stored.reference, sha256: stored.sha256 },
    });
    const authority = {
      kind: "app-integrations-public-development-v1",
      capability,
      publicOrigin: plan.publicOrigin,
      workload: plan.workload,
      jwksUrl: `${plan.publicOrigin}/_platform/jwks.json`,
      authOrigin: plan.publicOrigin,
      serviceSecret: seed.serviceSecret,
      catalogAuthoritySecret: seed.catalogAuthoritySecret,
      ingressSecret: seed.ingressSecret,
      authAuthoritySecret: createHmac("sha256", seed.setupProofSecret)
        .update("app-integrations/auth-authority/v1\n")
        .update(scopeSha256)
        .digest("base64url"),
      readObjects: plan.providerConfiguration.readObjects,
      ...(destination === undefined ? {} : { providerDestination: destination }),
    };
    const registrationScope: IntegrationPrivateScope = {
      app: input.appScope,
      purpose: "central-registration",
      version: 1,
      checkpoint: `${checkpoint}:${scopeSha256}:${stored.sha256}`,
    };
    const registration = await input.custody.reserve(registrationScope, () => {
      const keyring = registryKeyringSchema.parse(input.authorityKeyring);
      const encoded = Object.hasOwn(keyring.keys, keyring.activeKeyId)
        ? keyring.keys[keyring.activeKeyId]
        : undefined;
      if (encoded === undefined) {
        throw unavailable();
      }
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32 || key.toString("base64") !== encoded) {
        throw unavailable();
      }
      const plaintext = JSON.stringify(authority);
      const metadata = {
        kind: "app-integration-application-authority-v1",
        resourceProfileId: plan.control.resourceProfileId,
        appId: plan.selection.appId,
        registrationIdentitySha256: plan.control.registrationIdentitySha256,
        operationRef: appIntegrationCapabilityOperationRef(plan),
        planDigest: checkpoint,
        principalName: plan.control.database.runtimeRole,
        principalGeneration,
        customerIds: plan.serviceMemberships.map((member) => member.organizationId).toSorted(),
        scopeSha256,
        configurationRef: stored.reference,
        configurationSha256: stored.sha256,
        authoritySha256: hash(plaintext),
        keyId: keyring.activeKeyId,
        active: true,
      };
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(
        Buffer.from("app-integration-application-authority-v1\n" + JSON.stringify(metadata)),
      );
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ...metadata,
        sealed: {
          encryptedToken: ciphertext.toString("base64"),
          tokenIv: iv.toString("base64"),
          tokenTag: cipher.getAuthTag().toString("base64"),
        },
      };
    });
    await input.assertCurrent();
    return {
      capability,
      scopeSha256,
      serializedConfiguration: JSON.stringify(stored.value),
      registration: appIntegrationAuthorityEnvelopeSchema.parse(registration.value),
    };
  };
  return { create };
};
