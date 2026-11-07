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
const seedKinds = {
  v1: "public-release-auth-seed-v1",
  v2: "public-release-auth-seed-v2",
} as const;
const scopeSchema = z.strictObject({
  appId: id,
  authResourceIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
  authority: hostedTenantAuthoritySchema,
  projectId: id,
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
  sessionId: id,
});
export type PublicReleaseAuthSeedScope = z.infer<typeof scopeSchema>;
const seedSchema = z.strictObject({
  BETTER_AUTH_SECRET: z.string().min(32),
  PLATFORM_GATEWAY_IDENTITY_KEY_ID: z.string().regex(/^[a-f0-9]{64}$/u),
  PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: z.string().min(32),
});
export type PublicReleaseAuthSeed = z.infer<typeof seedSchema>;
const recordSchema = z.strictObject({
  kind: z.enum([seedKinds.v1, seedKinds.v2]),
  scope: scopeSchema,
  sealed: z.strictObject({ encryptedToken: id, keyVersion: id, tokenIv: id, tokenTag: id }),
});
const unavailable = () => new Error("public_release_auth_seed_unavailable");
const appScope = (scope: PublicReleaseAuthSeedScope) => ({
  appId: scope.appId,
  authResourceIdentity: scope.authResourceIdentity,
  authority: scope.authority,
  projectId: scope.projectId,
  publicOrigin: scope.publicOrigin,
});
const identity = (scope: PublicReleaseAuthSeedScope, version: 1 | 2 = 2) => {
  const digest = hash(
    JSON.stringify([
      `public-release-auth-seed-v${version}`,
      version === 1 ? scopeSchema.parse(scope) : appScope(scopeSchema.parse(scope)),
    ]),
  );
  return {
    digest,
    ref: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  };
};
const associatedDataFor = (scope: PublicReleaseAuthSeedScope, version: 1 | 2) => {
  const { digest, ref } = identity(scope, version);
  const base = {
    digest,
    purpose: `public-release-auth-seed-v${version}`,
    ref,
  };
  const data = version === 1 ? base : { ...base, creationSessionId: scope.sessionId };
  return JSON.stringify(data);
};
export const createFreshPublicAuthSeed = (): PublicReleaseAuthSeed => {
  const key = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return {
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    PLATFORM_GATEWAY_IDENTITY_KEY_ID: hash(key.publicKey),
    PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: key.privateKey,
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
  const associatedData = associatedDataFor(scope, 2);
  const predicate = and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, ref),
    sql`${builderProvisioningJournals.record}->>'kind' = 'public-release-auth-seed-v2'`,
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
    if (
      record.kind !== seedKinds.v2 ||
      row.requestDigest !== digest ||
      !isDeepStrictEqual(appScope(record.scope), appScope(scope))
    ) {
      throw unavailable();
    }
    try {
      return seedSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...record.sealed,
            associatedData: associatedDataFor(record.scope, 2),
            config: input.keyring,
          }),
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
  // The initial app-owned v1 seed remains inspectable and is copied without rotating keys.
  // More than one legacy key source is ambiguous; no session/time/name election is permitted.
  await input.assertCurrentOwner();
  const legacyRows = await input.database
    .select()
    .from(builderProvisioningJournals)
    .where(
      and(
        eq(builderProvisioningJournals.issuer, scope.authority.issuer),
        eq(builderProvisioningJournals.audience, scope.authority.audience),
        eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
        eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
        sql`${builderProvisioningJournals.record}->>'kind' = 'public-release-auth-seed-v1'`,
        sql`${builderProvisioningJournals.record}->'scope'->>'appId' = ${scope.appId}`,
        sql`${builderProvisioningJournals.record}->'scope'->>'projectId' = ${scope.projectId}`,
        sql`${builderProvisioningJournals.record}->'scope'->>'publicOrigin' = ${scope.publicOrigin}`,
        sql`${builderProvisioningJournals.record}->'scope'->>'authResourceIdentity' = ${scope.authResourceIdentity}`,
      ),
    )
    .limit(2);
  await input.assertCurrentOwner();
  if (legacyRows.length > 1) {
    throw unavailable();
  }
  const legacy = legacyRows.at(0);
  let seed: PublicReleaseAuthSeed;
  if (legacy === undefined) {
    seed = createFreshPublicAuthSeed();
  } else {
    const record = recordSchema.parse(legacy.record);
    const expected = identity(record.scope, 1);
    if (
      record.kind !== seedKinds.v1 ||
      !isDeepStrictEqual(appScope(record.scope), appScope(scope)) ||
      legacy.requestId !== expected.ref ||
      legacy.requestDigest !== expected.digest
    ) {
      throw unavailable();
    }
    try {
      seed = seedSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...record.sealed,
            associatedData: associatedDataFor(record.scope, 1),
            config: input.keyring,
          }),
        ),
      );
    } catch {
      throw unavailable();
    }
  }
  const sealed = {
    ...encryptVercelToken({
      associatedData,
      key: input.keyring.tokenKey,
      token: JSON.stringify(seed),
    }),
    keyVersion: input.keyring.tokenKeyVersion,
  };
  await input.assertCurrentOwner();
  const now = new Date();
  await input.database
    .insert(builderProvisioningJournals)
    .values({
      ...scope.authority,
      createdAt: now,
      record: recordSchema.parse({ kind: seedKinds.v2, scope, sealed }),
      requestDigest: digest,
      requestId: ref,
      revision: 1,
      state: "pending",
      updatedAt: now,
    })
    .onConflictDoNothing();
  const acknowledged = await read();
  if (acknowledged === undefined) {
    throw unavailable();
  }
  return acknowledged;
};
