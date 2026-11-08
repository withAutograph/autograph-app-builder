import { createHash } from "node:crypto";
import { publicRealmResourceSchema } from "./public-realm-enrollment";
import { createFreshPublicAuthSeed } from "./public-release-auth-seed";
import type { PublicReleaseAuthSeed } from "./public-release-auth-seed";
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

const PUBLIC_RELEASE_CONFIGURATION_KIND = "public-release-runtime-configuration-v1";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1);
const origin = z
  .url()
  .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value);
export const publicReleaseRuntimeConfigurationScopeSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  appId: id,
  sessionId: id,
  projectId: id,
  runtimeOperationRef: z.uuid(),
  runtimePlanDigest: digest,
  releaseId: id,
  publicOrigin: origin,
  realmEnrollmentRef: z.uuid().optional(),
  integrationCapability: z
    .strictObject({
      operationRef: z.uuid(),
      planDigest: digest,
      capabilitySha256: digest,
      configurationSha256: digest,
    })
    .optional(),
});
export type PublicReleaseRuntimeConfigurationScope = z.infer<
  typeof publicReleaseRuntimeConfigurationScopeSchema
>;
const sealedSchema = z.strictObject({
  encryptedToken: id,
  tokenIv: id,
  tokenTag: id,
  keyVersion: id,
});
const valuesSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().min(1));
const recordSchema = z.strictObject({
  kind: z.literal(PUBLIC_RELEASE_CONFIGURATION_KIND),
  scope: publicReleaseRuntimeConfigurationScopeSchema,
  sealed: sealedSchema,
});
const authResourceSchema = publicRealmResourceSchema.omit({ version: true });
const unavailable = () => new Error("public_release_runtime_configuration_unavailable");
const normalized = (hostname: string) => hostname.replace(/-pooler(?=\.)/u, "");
const identity = (scope: PublicReleaseRuntimeConfigurationScope) => {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        PUBLIC_RELEASE_CONFIGURATION_KIND,
        publicReleaseRuntimeConfigurationScopeSchema.parse(scope),
      ]),
    )
    .digest("hex");
  return {
    digest: hash,
    ref: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  };
};
const associatedData = (scope: PublicReleaseRuntimeConfigurationScope) =>
  JSON.stringify({ purpose: "public-release-runtime-values-v1", ...identity(scope) });

/** Internal preparation only; no provider, account or runtime effects occur here. */
export const createFreshPublicAuthValues = (input: {
  publicOrigin: string;
  appId: string;
  authRuntimeUrl: string;
  productionDatabaseIdentity: string;
  authResource: z.infer<typeof authResourceSchema>;
  seed?: PublicReleaseAuthSeed;
}) => {
  const publicOrigin = origin.parse(input.publicOrigin);
  const resource = authResourceSchema.parse(input.authResource);
  let runtime: URL;
  try {
    runtime = new URL(input.authRuntimeUrl);
  } catch {
    throw unavailable();
  }
  const production = /^(?<hostname>[a-z0-9.-]+\.neon\.tech)\/[^/]+$/u.exec(
    input.productionDatabaseIdentity,
  );
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Dedicated restricted runtime and a different normalized production endpoint are mandatory together.
    resource.hostname !== runtime.hostname ||
    resource.database !== decodeURIComponent(runtime.pathname.slice(1)) ||
    resource.runtimeRole !== decodeURIComponent(runtime.username) ||
    resource.runtimeRole === resource.migratorRole ||
    production === null ||
    normalized(production.groups?.hostname ?? "") === normalized(runtime.hostname) ||
    !["postgres:", "postgresql:"].includes(runtime.protocol) ||
    !runtime.hostname.endsWith(".neon.tech") ||
    runtime.username === "" ||
    ["postgres", "neondb_owner"].includes(decodeURIComponent(runtime.username)) ||
    runtime.password === "" ||
    ["/postgres", "/neondb", "/"].includes(runtime.pathname) ||
    runtime.searchParams.get("sslmode") !== "verify-full" ||
    runtime.hash !== ""
  ) {
    throw unavailable();
  }
  const seed = input.seed ?? createFreshPublicAuthSeed();
  return {
    PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: seed.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY,
    PLATFORM_GATEWAY_IDENTITY_KEY_ID: seed.PLATFORM_GATEWAY_IDENTITY_KEY_ID,
    PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: JSON.stringify([
      z
        .string()
        .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
        .parse(input.appId),
    ]),
    PLATFORM_ORIGIN: publicOrigin,
    PLATFORM_JWKS_URL: `${publicOrigin}/_platform/jwks.json`,
    BETTER_AUTH_URL: publicOrigin,
    BETTER_AUTH_SECRET: seed.BETTER_AUTH_SECRET,
    PLATFORM_AUTH_DATABASE_URL: input.authRuntimeUrl,
    AUTH_DATABASE_RESOURCE: JSON.stringify({
      version: 1,
      ...resource,
    }),
    AUTH_PRODUCTION_DATABASE_IDENTITY: input.productionDatabaseIdentity,
    PLATFORM_AUTH_TRUSTED_ORIGINS: publicOrigin,
    PLATFORM_PUBLIC_ORIGIN: publicOrigin,
    PLATFORM_AUTH_DEPLOYMENT_PROFILE: "isolated-development",
  };
};

/** Sealed values share the existing tenant journal. Only hashes and an opaque reference leave this adapter. */
export const createPublicReleaseRuntimeConfigurationStore = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  target: Pick<
    PublicReleaseRuntimeConfigurationScope,
    "authority" | "appId" | "sessionId" | "projectId"
  >;
  assertCurrentOwner: () => Promise<void>;
}) => {
  const predicate = (scope: PublicReleaseRuntimeConfigurationScope) =>
    and(
      eq(builderProvisioningJournals.issuer, scope.authority.issuer),
      eq(builderProvisioningJournals.audience, scope.authority.audience),
      eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, identity(scope).ref),
      sql`${builderProvisioningJournals.record}->>'kind' = 'public-release-runtime-configuration-v1'`,
    );
  const read = async (scopeInput: PublicReleaseRuntimeConfigurationScope) => {
    const scope = publicReleaseRuntimeConfigurationScopeSchema.parse(scopeInput);
    if (
      !isDeepStrictEqual(scope.authority, input.target.authority) ||
      scope.appId !== input.target.appId ||
      scope.sessionId !== input.target.sessionId ||
      scope.projectId !== input.target.projectId
    ) {
      throw unavailable();
    }
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(scope))
      .limit(1);
    await input.assertCurrentOwner();
    const row = rows.at(0);
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent sealed runtime config has no current private values.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    if (!isDeepStrictEqual(record.scope, scope) || row.requestDigest !== identity(scope).digest) {
      throw unavailable();
    }
    try {
      return valuesSchema.parse(
        JSON.parse(
          decryptVersionedVercelToken({
            ...record.sealed,
            config: input.keyring,
            associatedData: associatedData(scope),
          }),
        ),
      );
    } catch {
      throw unavailable();
    }
  };
  return {
    reference: (scope: PublicReleaseRuntimeConfigurationScope) => identity(scope).ref,
    read,
    async reserve(
      scopeInput: PublicReleaseRuntimeConfigurationScope,
      prepareValues: () => Record<string, string>,
    ) {
      const scope = publicReleaseRuntimeConfigurationScopeSchema.parse(scopeInput);
      const existing = await read(scope);
      let values = existing;
      if (values === undefined) {
        const proposed = valuesSchema.parse(prepareValues());
        const sealed = {
          ...encryptVercelToken({
            key: input.keyring.tokenKey,
            token: JSON.stringify(proposed),
            associatedData: associatedData(scope),
          }),
          keyVersion: input.keyring.tokenKeyVersion,
        };
        await input.assertCurrentOwner();
        const now = new Date();
        await input.database
          .insert(builderProvisioningJournals)
          .values({
            ...scope.authority,
            requestId: identity(scope).ref,
            requestDigest: identity(scope).digest,
            revision: 1,
            record: recordSchema.parse({
              kind: PUBLIC_RELEASE_CONFIGURATION_KIND,
              scope,
              sealed,
            }),
            state: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        // A competing planner retains the first acknowledged sealed values; never rotate on retry.
        values = await read(scope);
      }
      if (values === undefined) {
        throw unavailable();
      }
      await input.assertCurrentOwner();
      return {
        configurationRef: identity(scope).ref,
        environment: Object.entries(values)
          .map(([key, value]) => ({
            key,
            sha256: createHash("sha256").update(value).digest("hex"),
          }))
          .toSorted((left, right) => left.key.localeCompare(right.key)),
      };
    },
  };
};
