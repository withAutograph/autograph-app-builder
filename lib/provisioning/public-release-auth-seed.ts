import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
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

const id = z.string().min(1);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  appId: id,
  sessionId: id,
  projectId: id,
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
  authResourceIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type PublicReleaseAuthSeedScope = z.infer<typeof scopeSchema>;
const seedSchema = z.strictObject({
  BETTER_AUTH_SECRET: z.string().min(32),
  PLATFORM_GATEWAY_IDENTITY_KEY_ID: z.string().regex(/^[a-f0-9]{64}$/u),
  PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: z.string().min(32),
});
export type PublicReleaseAuthSeed = z.infer<typeof seedSchema>;
const recordSchema = z.strictObject({
  kind: z.literal("public-release-auth-seed-v1"),
  scope: scopeSchema,
  sealed: z.strictObject({ encryptedToken: id, tokenIv: id, tokenTag: id, keyVersion: id }),
});
const unavailable = () => new Error("public_release_auth_seed_unavailable");
const identity = (scope: PublicReleaseAuthSeedScope) => {
  const digest = hash(JSON.stringify(["public-release-auth-seed-v1", scopeSchema.parse(scope)]));
  return {
    digest,
    ref: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  };
};
export const createFreshPublicAuthSeed = (): PublicReleaseAuthSeed => {
  const key = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: key.privateKey,
    PLATFORM_GATEWAY_IDENTITY_KEY_ID: hash(key.publicKey),
  };
};

/** Bootstrap and later revisions retain only this app's own keys; no customer seed is adopted. */
export const reservePublicReleaseAuthSeed = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  scope: PublicReleaseAuthSeedScope;
  keyring: VercelTokenKeyringConfig;
  assertCurrentOwner: () => Promise<void>;
}): Promise<PublicReleaseAuthSeed> => {
  const scope = scopeSchema.parse(input.scope);
  const { digest, ref } = identity(scope);
  const associatedData = JSON.stringify({ purpose: "public-release-auth-seed-v1", digest, ref });
  const predicate = and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, ref),
    sql`${builderProvisioningJournals.record}->>'kind' = 'public-release-auth-seed-v1'`,
  );
  const read = async () => {
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    await input.assertCurrentOwner();
    const row = rows.at(0);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent private app seed is prepared once and never replaced on retry.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    if (row.requestDigest !== digest || !isDeepStrictEqual(record.scope, scope)) {
      throw unavailable();
    }
    try {
      return seedSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({ ...record.sealed, associatedData, config: input.keyring }),
        ),
      );
    } catch {
      throw unavailable();
    }
  };
  const prior = await read();
  if (prior !== undefined) {
    return prior;
  }
  const seed = createFreshPublicAuthSeed();
  const sealed = {
    ...encryptVercelToken({
      key: input.keyring.tokenKey,
      token: JSON.stringify(seed),
      associatedData,
    }),
    keyVersion: input.keyring.tokenKeyVersion,
  };
  await input.assertCurrentOwner();
  const now = new Date();
  await input.database
    .insert(builderProvisioningJournals)
    .values({
      ...scope.authority,
      requestId: ref,
      requestDigest: digest,
      record: recordSchema.parse({ kind: "public-release-auth-seed-v1", scope, sealed }),
      revision: 1,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const acknowledged = await read();
  if (acknowledged === undefined) {
    throw unavailable();
  }
  return acknowledged;
};
