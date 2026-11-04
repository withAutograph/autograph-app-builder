import {
  createHash,
  randomBytes,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderProvisioningJournals } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { centralHostSetupPlanSchema } from "./central-integration-host-contract";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const centralIntegrationPrivateScopeSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  profileId: z.string().min(1),
  resourceProfileId: z.string().min(1),
  target: centralHostSetupPlanSchema.shape.target,
  control: centralHostSetupPlanSchema.shape.control.omit({ schemaSha256: true }),
  provider: centralHostSetupPlanSchema.shape.provider.pick({
    kind: true,
    projectId: true,
    integrationId: true,
  }),
});
export type CentralIntegrationPrivateScope = z.infer<typeof centralIntegrationPrivateScopeSchema>;
const scopeSchema = z.strictObject({
  central: centralIntegrationPrivateScopeSchema,
  purpose: z.enum(["central-seed", "runtime-configuration", "accepted-receiver"]),
  version: z.literal(1),
  checkpoint: z.string().min(1),
});
export type CentralPrivateCheckpointScope = z.infer<typeof scopeSchema>;
const sealedSchema = z.strictObject({
  encryptedToken: z.string().min(1),
  tokenIv: z.string().min(1),
  tokenTag: z.string().min(1),
  keyVersion: z.string().min(1),
});
const recordSchema = z.strictObject({
  kind: z.literal("central-integration-private-custody-v1"),
  scope: scopeSchema,
  sealed: sealedSchema,
  plaintextSha256: digest,
});
const jsonSchema = z.json();
export type CentralIntegrationPrivateJson = z.infer<typeof jsonSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("central_integration_private_custody_unavailable");
const identity = (scope: CentralPrivateCheckpointScope) => {
  const sha256 = hash(
    JSON.stringify(["central-integration-private-custody-v1", scopeSchema.parse(scope)]),
  );
  const reference = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-5${sha256.slice(13, 16)}-a${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
  return { sha256, reference };
};
/** Existing owner-scoped encrypted journal custody. The first sealed bytes win; no update or key rotation on retry. */
const createCentralPrivateStore = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  scope: CentralIntegrationPrivateScope;
  assertCurrent: () => Promise<void>;
}) => {
  const central = centralIntegrationPrivateScopeSchema.parse(input.scope);
  const parseScope = (raw: CentralPrivateCheckpointScope) => {
    const scope = scopeSchema.parse(raw);
    if (!isDeepStrictEqual(scope.central, central)) {
      throw unavailable();
    }
    return scope;
  };
  const read = async (raw: CentralPrivateCheckpointScope) => {
    const scope = parseScope(raw);
    const key = identity(scope);
    await input.assertCurrent();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.issuer, central.authority.issuer),
          eq(builderProvisioningJournals.audience, central.authority.audience),
          eq(builderProvisioningJournals.workspaceId, central.authority.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, central.authority.ownerUserId),
          eq(builderProvisioningJournals.requestId, key.reference),
          sql`${builderProvisioningJournals.record}->>'kind'='central-integration-private-custody-v1'`,
        ),
      )
      .limit(1);
    await input.assertCurrent();
    const row = rows.at(0);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent private checkpoint has never been reserved.
      return undefined;
    }
    try {
      const record = recordSchema.parse(row.record);
      if (row.requestDigest !== key.sha256 || !isDeepStrictEqual(record.scope, scope)) {
        throw unavailable();
      }
      const plaintext = decryptVersionedVercelToken({
        ...record.sealed,
        associatedData: JSON.stringify({ purpose: record.kind, ...key }),
        config: input.keyring,
      });
      if (hash(plaintext) !== record.plaintextSha256) {
        throw unavailable();
      }
      return {
        reference: key.reference,
        sha256: record.plaintextSha256,
        value: jsonSchema.parse(JSON.parse(plaintext)),
      };
    } catch {
      throw unavailable();
    }
  };
  return {
    reference: (scope: CentralPrivateCheckpointScope) => identity(parseScope(scope)).reference,
    read,
    reserve: async (
      raw: CentralPrivateCheckpointScope,
      prepare: () => CentralIntegrationPrivateJson,
    ) => {
      const scope = parseScope(raw);
      const prior = await read(scope);
      if (prior !== undefined) {
        return prior;
      }
      const key = identity(scope);
      const plaintext = JSON.stringify(jsonSchema.parse(prepare()));
      const record = recordSchema.parse({
        kind: "central-integration-private-custody-v1",
        scope,
        plaintextSha256: hash(plaintext),
        sealed: {
          ...encryptVercelToken({
            key: input.keyring.tokenKey,
            token: plaintext,
            associatedData: JSON.stringify({
              purpose: "central-integration-private-custody-v1",
              ...key,
            }),
          }),
          keyVersion: input.keyring.tokenKeyVersion,
        },
      });
      await input.assertCurrent();
      await input.database
        .insert(builderProvisioningJournals)
        .values({
          ...central.authority,
          requestId: key.reference,
          requestDigest: key.sha256,
          record,
          revision: 1,
          state: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      const stored = await read(scope);
      if (stored === undefined) {
        throw unavailable();
      }
      return stored;
    },
  };
};

export const centralIntegrationPrivateSeedSchema = z
  .strictObject({
    migratorPassword: z.string().min(32),
    runtimePassword: z.string().min(32),
    activation: z.strictObject({
      keyId: z.string().min(1),
      privateKeyPem: z.string().min(1),
      publicKeyPem: z.string().min(1),
      publicKeySha256: digest,
    }),
    authorityKeyring: z.strictObject({
      activeKeyId: z.string().min(1),
      keys: z.record(z.string(), z.string()),
    }),
    setupProofSecret: z.string().min(32),
  })
  .superRefine((seed, context) => {
    try {
      const publicKey = createPublicKey(createPrivateKey(seed.activation.privateKeyPem));
      const expected = publicKey.export({ format: "pem", type: "spki" });
      if (publicKey.asymmetricKeyType !== "ed25519" || expected !== seed.activation.publicKeyPem)
        throw unavailable();
      const sha = createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      if (sha !== seed.activation.publicKeySha256) throw unavailable();
      const key = seed.authorityKeyring.keys[seed.authorityKeyring.activeKeyId];
      if (
        !key ||
        Buffer.from(key, "base64").length !== 32 ||
        Buffer.from(key, "base64").toString("base64") !== key
      )
        throw unavailable();
    } catch {
      context.addIssue({
        code: "custom",
        message: "Private central seed key material is invalid.",
      });
    }
  });
export const createFreshCentralIntegrationPrivateSeed = () => {
  const keys = generateKeyPairSync("ed25519");
  const keyId = randomBytes(16).toString("hex");
  return centralIntegrationPrivateSeedSchema.parse({
    migratorPassword: randomBytes(32).toString("base64url"),
    runtimePassword: randomBytes(32).toString("base64url"),
    activation: {
      keyId,
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }),
      publicKeySha256: createHash("sha256")
        .update(keys.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex"),
    },
    authorityKeyring: { activeKeyId: keyId, keys: { [keyId]: randomBytes(32).toString("base64") } },
    setupProofSecret: randomBytes(32).toString("base64url"),
  });
};
export const centralAcceptedReceiverSchema = z
  .strictObject({
    subscriptionRef: z.uuid(),
    id: z.string().min(1),
    secret: z.string().min(1),
    secretSha256: digest,
  })
  .refine((value) => hash(value.secret) === value.secretSha256, {
    message: "Accepted receiver secret digest mismatch.",
  });
export type CentralAcceptedReceiver = z.infer<typeof centralAcceptedReceiverSchema>;
/** Stable global custody has no app receipt or initiating-session authority. Every returned value is private. */
export const createCentralIntegrationPrivateCustody = (
  input: Parameters<typeof createCentralPrivateStore>[0],
) => {
  const central = centralIntegrationPrivateScopeSchema.parse(input.scope);
  const store = createCentralPrivateStore({ ...input, scope: central });
  const scope = (
    purpose: CentralPrivateCheckpointScope["purpose"],
    checkpoint: string,
  ): CentralPrivateCheckpointScope => ({ central, purpose, checkpoint, version: 1 });
  return {
    reference: (purpose: CentralPrivateCheckpointScope["purpose"], checkpoint: string) =>
      store.reference(scope(purpose, checkpoint)),
    read: (purpose: CentralPrivateCheckpointScope["purpose"], checkpoint: string) =>
      store.read(scope(purpose, checkpoint)),
    reserve: (
      purpose: CentralPrivateCheckpointScope["purpose"],
      checkpoint: string,
      prepare: () => CentralIntegrationPrivateJson,
    ) => store.reserve(scope(purpose, checkpoint), prepare),
    seed: async () => {
      const saved = await store.reserve(
        scope("central-seed", "stable-v1"),
        createFreshCentralIntegrationPrivateSeed,
      );
      return { ...saved, value: centralIntegrationPrivateSeedSchema.parse(saved.value) };
    },
    recordAcceptedReceiver: async (raw: CentralAcceptedReceiver) => {
      const receiver = centralAcceptedReceiverSchema.parse(raw);
      const saved = await store.reserve(
        scope("accepted-receiver", receiver.subscriptionRef),
        () => receiver,
      );
      const stored = centralAcceptedReceiverSchema.parse(saved.value);
      if (!isDeepStrictEqual(stored, receiver))
        throw new Error("central_integration_receiver_custody_conflict");
      return { ...saved, value: stored };
    },
  };
};
