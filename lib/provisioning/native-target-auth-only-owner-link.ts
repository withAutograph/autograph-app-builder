import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the complete database schema type.
import type * as databaseSchema from "../db/schema";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  createRealmIdentityBrowserUrl,
  realmIdentityNonceSha256,
  realmPhysicalResourceSchema,
} from "./hosted-operator-auth-identity";
import {
  HostedOperatorError,
  operatorDeploymentCandidateSchema,
  operatorRealmIdentityLinkSchema,
  projectPendingRealmIdentityLink,
} from "./hosted-operator-contract";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(512);
const sessionId = id.max(200);
const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value;
});
const previewSenderSchema = z.strictObject({
  audience: z.url(),
  environment: z.literal("preview"),
  issuer: z.url(),
  ownerId: id,
  projectId: id,
  subject: id,
});
export const nativeTargetAuthOnlyOwnerLinkBindingSchema = z
  .strictObject({
    audience: httpsOrigin,
    authOnlyPlanDigest: digest,
    authResourceId: id,
    authority: hostedTenantAuthoritySchema,
    bootstrapResource: realmPhysicalResourceSchema.extend({
      environment: z.literal("preview"),
      port: z.literal(5432),
      neon: realmPhysicalResourceSchema.shape.neon.unwrap(),
    }),
    browserOrigin: httpsOrigin,
    gateway: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
    gatewayDeliveryPlanDigest: digest,
    issuer: httpsOrigin,
    operationRef: z.uuid(),
    resourcePlanDigest: digest,
    sender: previewSenderSchema,
    target: hostedRuntimeTargetSchema.extend({
      environment: z.literal("preview"),
      scopeType: z.literal("team"),
      sessionId,
    }),
  })
  .superRefine((binding, context) => {
    if (
      binding.gateway.projectId === binding.target.projectId ||
      binding.gateway.projectId !== binding.sender.projectId ||
      binding.target.scopeId !== binding.sender.ownerId ||
      binding.audience === binding.gateway.origin ||
      binding.audience === binding.browserOrigin ||
      binding.audience === binding.issuer
    ) {
      context.addIssue({ code: "custom", message: "The Preview identity boundaries disagree." });
    }
  });
export type NativeTargetAuthOnlyOwnerLinkBinding = z.infer<
  typeof nativeTargetAuthOnlyOwnerLinkBindingSchema
>;

const selectorSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema.optional(),
  nonceSha256: digest,
  ownerSessionId: sessionId,
});
type Selector = z.infer<typeof selectorSchema>;
const recordSchema = z.strictObject({
  binding: nativeTargetAuthOnlyOwnerLinkBindingSchema,
  kind: z.literal("native-target-auth-only-owner-link"),
  link: operatorRealmIdentityLinkSchema,
  version: z.literal(1),
});
type Record = z.infer<typeof recordSchema>;
interface Row {
  record: Record;
  revision: number;
}

export interface NativeTargetAuthOnlyOwnerLinkStore {
  read(binding: NativeTargetAuthOnlyOwnerLinkBinding): Promise<Row | undefined>;
  lookup(selector: Selector): Promise<Row | undefined>;
  compareAndSet(record: Record, expectedRevision: number | undefined): Promise<Row | undefined>;
}

const denied = () => new HostedOperatorError("auth_identity_required");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const bindingDigest = (binding: NativeTargetAuthOnlyOwnerLinkBinding) =>
  sha256(JSON.stringify(binding));
const requestIdFor = (binding: NativeTargetAuthOnlyOwnerLinkBinding) => {
  const hex = sha256(
    JSON.stringify([
      "native-target-auth-only-owner-link-v1",
      binding.target.appId,
      binding.target.sessionId,
      binding.operationRef,
    ]),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const linkScope = (binding: NativeTargetAuthOnlyOwnerLinkBinding) => ({
  audience: binding.audience,
  authResourceId: binding.authResourceId,
  bootstrapPlanDigest: binding.resourcePlanDigest,
  browserOrigin: binding.browserOrigin,
  endpointOrigin: binding.gateway.origin,
  issuer: binding.issuer,
  organizationId: null,
  ownerSessionId: binding.target.sessionId,
});
const validateRecord = (value: unknown): Record => {
  const record = recordSchema.parse(value);
  const { link } = record;
  const scope = linkScope(record.binding);
  if (
    Object.entries(scope).some(([key, expected]) => link[key as keyof typeof scope] !== expected) ||
    link.publicRelease !== undefined ||
    link.browserSession !== undefined ||
    (link.consumedAt === undefined) !== (link.sealedNonce !== undefined)
  ) {
    throw denied();
  }
  return record;
};

type Database = PostgresJsDatabase<typeof databaseSchema>;

/** Tenant-scoped writes and a closed nonce-hash lookup against the private journal. */
export const createPostgresNativeTargetAuthOnlyOwnerLinkStore = (
  database: Database,
): NativeTargetAuthOnlyOwnerLinkStore => {
  const kind = sql`${builderProvisioningJournals.record}->>'kind' = 'native-target-auth-only-owner-link'`;
  const predicate = (binding: NativeTargetAuthOnlyOwnerLinkBinding) =>
    and(
      eq(builderProvisioningJournals.issuer, binding.authority.issuer),
      eq(builderProvisioningJournals.audience, binding.authority.audience),
      eq(builderProvisioningJournals.workspaceId, binding.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, binding.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, requestIdFor(binding)),
      kind,
    );
  const parseRow = (row: typeof builderProvisioningJournals.$inferSelect): Row => {
    const record = validateRecord(row.record);
    const authority = hostedTenantAuthoritySchema.parse({
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    });
    if (
      !isDeepStrictEqual(authority, record.binding.authority) ||
      row.requestId !== requestIdFor(record.binding) ||
      row.requestDigest !== bindingDigest(record.binding) ||
      row.state !== (record.link.consumedAt === undefined ? "pending" : "settled")
    ) {
      throw denied();
    }
    return { record, revision: row.revision };
  };
  return {
    async compareAndSet(rawRecord, expectedRevision) {
      const record = validateRecord(rawRecord);
      const { binding, link } = record;
      const requestDigest = bindingDigest(binding);
      const state = link.consumedAt === undefined ? "pending" : "settled";
      const updatedAt = new Date();
      const values = { record, state, updatedAt, revision: (expectedRevision ?? 0) + 1 };
      const [row] =
        expectedRevision === undefined
          ? await database
              .insert(builderProvisioningJournals)
              .values({
                ...binding.authority,
                ...values,
                requestDigest,
                requestId: requestIdFor(binding),
                createdAt: updatedAt,
              })
              .onConflictDoNothing()
              .returning()
          : await database
              .update(builderProvisioningJournals)
              .set(values)
              .where(
                and(
                  predicate(binding),
                  eq(builderProvisioningJournals.requestDigest, requestDigest),
                  eq(builderProvisioningJournals.revision, expectedRevision),
                  eq(builderProvisioningJournals.state, "pending"),
                ),
              )
              .returning();
      return row === undefined ? undefined : parseRow(row);
    },
    async lookup(rawSelector) {
      const selector = selectorSchema.parse(rawSelector);
      const rows = await database
        .select()
        .from(builderProvisioningJournals)
        .where(
          and(
            kind,
            sql`${builderProvisioningJournals.record}->'link'->>'ownerSessionId' = ${selector.ownerSessionId}`,
            sql`${builderProvisioningJournals.record}->'link'->>'nonceSha256' = ${selector.nonceSha256}`,
          ),
        )
        .limit(2);
      const [row] = rows;
      if (rows.length > 1) throw denied();
      return row === undefined ? undefined : parseRow(row);
    },
    async read(binding) {
      const [row] = await database
        .select()
        .from(builderProvisioningJournals)
        .where(predicate(binding))
        .limit(1);
      return row === undefined ? undefined : parseRow(row);
    },
  };
};

/** The canonical callback verifies the JWT and live Realm session before consuming this nonce. */
export const createNativeTargetAuthOnlyOwnerLink = (ports: {
  store: NativeTargetAuthOnlyOwnerLinkStore;
  keyring: VercelTokenKeyringConfig;
  /** Re-read the registered owner, current session, settled approvals and actual READY Gateway. */
  assertCurrent: (binding: NativeTargetAuthOnlyOwnerLinkBinding) => Promise<void>;
  readPublishedProof: (
    binding: NativeTargetAuthOnlyOwnerLinkBinding,
    proofRef: string,
  ) => Promise<string | undefined>;
  now?: () => number;
}) => {
  const now = ports.now ?? Date.now;
  const associatedData = (binding: NativeTargetAuthOnlyOwnerLinkBinding) =>
    `native-target-auth-only-owner-link-nonce-v1:${bindingDigest(binding)}`;
  const read = async (binding: NativeTargetAuthOnlyOwnerLinkBinding) => {
    await ports.assertCurrent(binding);
    const row = await ports.store.read(binding);
    await ports.assertCurrent(binding);
    if (row !== undefined && !isDeepStrictEqual(validateRecord(row.record).binding, binding)) {
      throw denied();
    }
    return row;
  };
  const pending = (link: Record["link"]) =>
    link.consumedAt === undefined && Date.parse(link.expiresAt) > now();
  return {
    async consume(input: {
      binding: NativeTargetAuthOnlyOwnerLinkBinding;
      nonceSha256: string;
      proofRef: string;
      proofSha256: string;
    }) {
      const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(input.binding);
      const current = await read(binding);
      if (
        current === undefined ||
        !pending(current.record.link) ||
        digest.parse(input.nonceSha256) !== current.record.link.nonceSha256 ||
        input.proofRef !==
          `_protected-operator/artifacts/realm-identity-proof/${binding.target.appId}/${digest.parse(input.proofSha256)}`
      )
        throw denied();
      const proof = await ports.readPublishedProof(binding, input.proofRef);
      if (proof === undefined || sha256(proof) !== input.proofSha256) throw denied();
      const link = operatorRealmIdentityLinkSchema.parse({
        ...projectPendingRealmIdentityLink(current.record.link),
        consumedAt: new Date(now()).toISOString(),
        proofRef: input.proofRef,
        proofSha256: input.proofSha256,
      });
      await ports.assertCurrent(binding);
      if (!pending(current.record.link)) throw denied();
      const saved = await ports.store.compareAndSet({ ...current.record, link }, current.revision);
      if (
        saved === undefined ||
        saved.revision !== current.revision + 1 ||
        !isDeepStrictEqual(validateRecord(saved.record), { ...current.record, link })
      )
        throw denied();
      await ports.assertCurrent(binding);
    },
    async prepare(rawBinding: NativeTargetAuthOnlyOwnerLinkBinding) {
      const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(rawBinding);
      let current = await read(binding);
      if (
        current === undefined ||
        (current.record.link.consumedAt === undefined && !pending(current.record.link))
      ) {
        const nonce = randomBytes(32).toString("hex");
        const link = operatorRealmIdentityLinkSchema.parse({
          ...linkScope(binding),
          expiresAt: new Date(now() + 15 * 60_000).toISOString(),
          nonceSha256: realmIdentityNonceSha256(nonce),
          sealedNonce: {
            ...encryptVercelToken({
              associatedData: associatedData(binding),
              key: ports.keyring.tokenKey,
              token: nonce,
            }),
            keyVersion: ports.keyring.tokenKeyVersion,
          },
        });
        await ports.assertCurrent(binding);
        current =
          (await ports.store.compareAndSet(
            { kind: "native-target-auth-only-owner-link", version: 1, binding, link },
            current?.revision,
          )) ?? (await read(binding));
      }
      if (current === undefined) throw denied();
      const { link, binding: retainedBinding } = validateRecord(current.record);
      if (!isDeepStrictEqual(retainedBinding, binding)) throw denied();
      await ports.assertCurrent(binding);
      if (link.consumedAt !== undefined) {
        return {
          status: "linked" as const,
          operationRef: binding.operationRef,
          sessionId: binding.target.sessionId,
        };
      }
      if (!pending(link) || link.sealedNonce === undefined) throw denied();
      const nonce = decryptVersionedVercelToken({
        ...link.sealedNonce,
        associatedData: associatedData(binding),
        config: ports.keyring,
      });
      return {
        status: "waiting-for-owner" as const,
        browserUrl: createRealmIdentityBrowserUrl({ link, nonce }),
        expiresAt: link.expiresAt,
        operationRef: binding.operationRef,
        sessionId: binding.target.sessionId,
      };
    },
    async readCaptured(rawBinding: NativeTargetAuthOnlyOwnerLinkBinding) {
      const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(rawBinding);
      const current = await read(binding);
      const link = current?.record.link;
      if (link?.consumedAt === undefined || link.proofRef === undefined) return undefined;
      const proof = await ports.readPublishedProof(binding, link.proofRef);
      if (proof === undefined || sha256(proof) !== link.proofSha256) throw denied();
      await ports.assertCurrent(binding);
      return projectPendingRealmIdentityLink(link);
    },
    /** Undefined means no Auth-only routing record. An invalid matching record fails closed. */
    async readPending(rawSelector: Selector) {
      const selector = selectorSchema.parse(rawSelector);
      const row = await ports.store.lookup(selector);
      if (row === undefined) return undefined;
      const { binding, link } = validateRecord(row.record);
      if (
        binding.target.sessionId !== selector.ownerSessionId ||
        link.nonceSha256 !== selector.nonceSha256 ||
        (selector.authority !== undefined &&
          !isDeepStrictEqual(selector.authority, binding.authority))
      )
        throw denied();
      const current = await read(binding);
      if (
        current === undefined ||
        current.revision !== row.revision ||
        !isDeepStrictEqual(current.record.link, link) ||
        !pending(link)
      )
        throw denied();
      return {
        binding,
        link: projectPendingRealmIdentityLink(link),
        bootstrapResource: binding.bootstrapResource,
        jwksUrl: new URL("/_platform/jwks.json", binding.gateway.origin).href,
        sender: binding.sender,
      };
    },
  };
};
