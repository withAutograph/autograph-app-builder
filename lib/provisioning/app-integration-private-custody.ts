import { createHash, randomBytes } from "node:crypto";
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
import { integrationCapabilityResourceSchema } from "./app-integration-capability-contract";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const custodyKind = "app-integration-private-custody-v1";
export const integrationPrivateAppScopeSchema = z.strictObject({
  appId: z.string().min(1),
  authority: hostedTenantAuthoritySchema,
  controlNeon: z.strictObject({
    branchId: z.string().min(1),
    endpointId: z.string().min(1),
    projectId: z.string().min(1),
    source: z.literal("synthetic-only"),
  }),
  controlResource: integrationCapabilityResourceSchema,
  projectId: z.string().min(1),
  provisioningDigest: digest,
  provisioningRequestId: z.uuid(),
  resourceProfileId: z.string().min(1),
});
export type IntegrationPrivateAppScope = z.infer<typeof integrationPrivateAppScopeSchema>;
const scopeSchema = z.strictObject({
  app: integrationPrivateAppScopeSchema,
  checkpoint: z.string().min(1),
  purpose: z.enum([
    "app-seed",
    "runtime-configuration",
    "central-registration",
    "provider-destination",
    "provider-destination-key",
  ]),
  version: z.literal(1),
});
export type IntegrationPrivateScope = z.infer<typeof scopeSchema>;
const sealedSchema = z.strictObject({
  encryptedToken: z.string().min(1),
  keyVersion: z.string().min(1),
  tokenIv: z.string().min(1),
  tokenTag: z.string().min(1),
});
const recordSchema = z.strictObject({
  kind: z.literal(custodyKind),
  plaintextSha256: digest,
  scope: scopeSchema,
  sealed: sealedSchema,
});
const jsonSchema = z.json();
export type IntegrationPrivateJson = z.infer<typeof jsonSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("app_integration_private_custody_unavailable");
const identity = (scope: IntegrationPrivateScope) => {
  const sha256 = hash(JSON.stringify([custodyKind, scopeSchema.parse(scope)]));
  const reference = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-5${sha256.slice(13, 16)}-a${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
  return { reference, sha256 };
};
/** Existing owner-scoped encrypted journal custody. The first sealed bytes win; no update or key rotation on retry. */
export const createAppIntegrationPrivateCustody = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  app: IntegrationPrivateAppScope;
  assertCurrent: () => Promise<void>;
}) => {
  const app = integrationPrivateAppScopeSchema.parse(input.app);
  const parseScope = (raw: IntegrationPrivateScope) => {
    const scope = scopeSchema.parse(raw);
    if (!isDeepStrictEqual(scope.app, app)) {
      throw unavailable();
    }
    return scope;
  };
  const read = async (raw: IntegrationPrivateScope) => {
    const scope = parseScope(raw);
    const key = identity(scope);
    await input.assertCurrent();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.issuer, app.authority.issuer),
          eq(builderProvisioningJournals.audience, app.authority.audience),
          eq(builderProvisioningJournals.workspaceId, app.authority.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, app.authority.ownerUserId),
          eq(builderProvisioningJournals.requestId, key.reference),
          sql`${builderProvisioningJournals.record}->>'kind'='app-integration-private-custody-v1'`,
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
    read,
    reference: (scope: IntegrationPrivateScope) => identity(parseScope(scope)).reference,
    reserve: async (raw: IntegrationPrivateScope, prepare: () => IntegrationPrivateJson) => {
      const scope = parseScope(raw);
      const prior = await read(scope);
      if (prior !== undefined) {
        return prior;
      }
      const key = identity(scope);
      const plaintext = JSON.stringify(jsonSchema.parse(prepare()));
      const record = recordSchema.parse({
        kind: custodyKind,
        plaintextSha256: hash(plaintext),
        scope,
        sealed: {
          ...encryptVercelToken({
            associatedData: JSON.stringify({
              purpose: custodyKind,
              ...key,
            }),
            key: input.keyring.tokenKey,
            token: plaintext,
          }),
          keyVersion: input.keyring.tokenKeyVersion,
        },
      });
      await input.assertCurrent();
      await input.database
        .insert(builderProvisioningJournals)
        .values({
          ...app.authority,
          createdAt: new Date(),
          record,
          requestDigest: key.sha256,
          requestId: key.reference,
          revision: 1,
          state: "pending",
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
export const appIntegrationPrivateSeedSchema = z.strictObject({
  catalogAuthoritySecret: z.string().min(32),
  controlRuntimePassword: z.string().min(32),
  ingressSecret: z.string().min(32),
  serviceSecret: z.string().min(32),
  setupProofSecret: z.string().min(32),
});
export const createFreshAppIntegrationPrivateSeed = () =>
  appIntegrationPrivateSeedSchema.parse({
    catalogAuthoritySecret: randomBytes(32).toString("base64url"),
    controlRuntimePassword: randomBytes(32).toString("base64url"),
    ingressSecret: randomBytes(32).toString("base64url"),
    serviceSecret: randomBytes(32).toString("base64url"),
    setupProofSecret: randomBytes(32).toString("base64url"),
  });
/** Shared canonical sealed-envelope digest: includes ciphertext and all metadata, never returned raw. */
export const canonicalIntegrationPrivateJsonBytes = (value: IntegrationPrivateJson): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalIntegrationPrivateJsonBytes).join(",")}]`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical serialization branches only on the validated JSON domain.
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => {
        if (a < b) {
          return -1;
        }
        if (a > b) {
          return 1;
        }
        return 0;
      })
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntegrationPrivateJsonBytes(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
