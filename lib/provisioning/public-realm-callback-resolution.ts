import { createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { RetainedOperatorAuth } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { retainedOperatorAuthFromJournal } from "./hosted-runtime-journal";
import {
  publicReleaseRecordSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "./public-release-contract";
import type { PublicReleasePlan } from "./public-release-contract";
import {
  publicRealmEnrollmentSchema,
  publicRealmReleaseBindingSchema,
} from "./public-realm-enrollment";
import type { PublicRealmReleaseBinding } from "./public-realm-enrollment";
import { readPublicRealmLinkConfiguration } from "./public-realm-link-configuration";
import { createPublicReleaseRuntimeConfigurationStore } from "./public-release-runtime-configuration";
import {
  assertOwnedAppAuthRuntimeScope,
  ownedAppPublicEnvironmentManifest,
} from "./owned-app-auth-environment";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const unavailable = () => new Error("public_realm_callback_unavailable");
const publicKeySchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
});
export interface PublicRealmCallbackCandidate {
  requestId: string;
  requestDigest: string;
  record: unknown;
}

/** READY is necessary but never substitutes for current owner, original setup approval, or genuine public consent. */
export const createPublicRealmCallbackResolver =
  (deps: {
    configuration: Pick<HostedOperatorSourceConfiguration, "standardRuntime">;
    readReleases: (
      context: HostedOperatorContext,
      binding?: PublicRealmReleaseBinding,
    ) => Promise<PublicRealmCallbackCandidate[]>;
    readRuntime: (context: HostedOperatorContext) => Promise<HostedRuntimeJournalRecord>;
    readEnrollment: (
      context: HostedOperatorContext,
      enrollmentRef: string,
    ) => ReturnType<typeof readPublicRealmLinkConfiguration>;
    readValues: (
      context: HostedOperatorContext,
      plan: PublicReleasePlan,
    ) => Promise<Record<string, string>>;
    assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
    assertSourceApproval: (
      context: HostedOperatorContext,
      source: RetainedOperatorAuth,
    ) => Promise<void>;
    assertPublicApproval: (
      context: HostedOperatorContext,
      plan: PublicReleasePlan,
      receipt: { approvalId: string; approvedByCallId: string },
    ) => Promise<void>;
  }) =>
  // oxlint-disable-next-line eslint/complexity -- Keep the owner, approved setup, public release, sealed resource, and public key checks conjunctive before exposing a callback transport.
  async (context: HostedOperatorContext, expected?: PublicRealmReleaseBinding) => {
    await deps.assertCurrentOwner(context);
    const rows = await deps.readReleases(context, expected);
    const selected = rows.length === 1 ? rows[0] : undefined;
    if (selected === undefined) {
      throw unavailable();
    }
    const record = publicReleaseRecordSchema.parse(selected.record);
    const { plan } = record;
    const digest = publicReleasePlanDigest(plan);
    const operationRef = publicReleaseOperationRef(plan);
    const enrollmentRef = plan.runtime.realmEnrollmentRef;
    const matches = [
      plan.purpose === "auth-bootstrap",
      enrollmentRef !== undefined,
      selected.requestId === operationRef,
      selected.requestDigest === digest,
      record.planDigest === digest,
      isDeepStrictEqual(plan.authority, context.authority),
      plan.selection.appId === context.target.appId,
      plan.selection.sessionId === context.target.sessionId,
      plan.project.projectId === context.target.projectId,
      record.effects["bind-production-runtime"] === "applied",
      record.effects["publish-release-source"] === "applied",
      record.observation?.status === "ready",
      plan.environment.every((entry) => record.bindings[entry.key]?.state === "applied"),
    ].every(Boolean);
    if (!matches || enrollmentRef === undefined || record.observation?.status !== "ready") {
      throw unavailable();
    }
    const binding = publicRealmReleaseBindingSchema.parse({
      enrollmentRef,
      operationRef,
      planDigest: digest,
    });
    if (expected !== undefined && !isDeepStrictEqual(expected, binding)) {
      throw unavailable();
    }
    if (
      record.observation.releaseId !== plan.runtime.releaseId ||
      record.observation.projectId !== plan.project.projectId ||
      record.observation.publicOrigin !== plan.publicOrigin
    ) {
      throw unavailable();
    }
    const receipts = record.approvalReceipts ?? [];
    if (receipts.length === 0) {
      throw unavailable();
    }
    for (const receipt of receipts) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Reverify every retained genuine consent without racing its durable native-history checkpoint.
      await deps.assertPublicApproval(context, plan, receipt);
    }
    const runtime = await deps.readRuntime(context);
    const possible = [runtime.retainedAuth, retainedOperatorAuthFromJournal(runtime)].filter(
      (entry): entry is RetainedOperatorAuth => entry !== undefined,
    );
    const source = possible.find(
      (entry) =>
        entry.operationRef === plan.runtime.operationRef &&
        entry.planDigest === plan.runtime.planDigest,
    );
    if (source === undefined) {
      throw unavailable();
    }
    await deps.assertSourceApproval(context, source);
    const linkConfiguration = await deps.readEnrollment(context, enrollmentRef);
    const enrollment = publicRealmEnrollmentSchema.parse(linkConfiguration.publicEnrollment);
    const auth = source.plan.authDatabase;
    const physical = {
      version: 1,
      environment: source.plan.selection.environment,
      hostname: source.plan.neon.endpoint,
      port: 5432,
      database: auth.database,
      schema: "public",
      runtimeRole: auth.runtimeRole,
      migratorRole: auth.migratorRole,
      neon: { projectId: source.plan.neon.projectId, branchId: source.plan.neon.branchId },
    };
    const bound = [
      enrollment.enrollmentRef === enrollmentRef,
      isDeepStrictEqual(enrollment.authority, context.authority),
      enrollment.appId === context.target.appId,
      enrollment.ownerSessionId === context.target.sessionId,
      enrollment.project.projectId === plan.project.projectId,
      enrollment.project.ownerId === plan.project.teamId,
      enrollment.publicOrigin === plan.publicOrigin,
      enrollment.sourceBootstrap.operationRef === source.operationRef,
      enrollment.sourceBootstrap.planDigest === source.planDigest,
      enrollment.sourceBootstrap.authResourceId === auth.resourceId,
      isDeepStrictEqual(enrollment.resource, physical),
    ].every(Boolean);
    if (!bound) {
      throw unavailable();
    }
    const values = await deps.readValues(context, plan);
    const profile = deps.configuration.standardRuntime;
    if (profile === undefined) {
      throw unavailable();
    }
    assertOwnedAppAuthRuntimeScope({
      appId: context.target.appId,
      appResource: source.plan.appDatabase,
      authResource: auth,
      neon: source.plan.neon,
      profile,
      publicOrigin: plan.publicOrigin,
      bindings: {
        appDatabase: {
          runtimeUrl:
            values[`${context.target.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`] ?? "",
        },
        authDatabase: { runtimeUrl: values.PLATFORM_AUTH_DATABASE_URL ?? "" },
      },
    });
    if (
      !isDeepStrictEqual(
        ownedAppPublicEnvironmentManifest(context.target.appId, values),
        plan.environment.map(({ key, sha256 }) => ({ key, sha256 })),
      )
    ) {
      throw unavailable();
    }
    if (
      !isDeepStrictEqual(
        JSON.parse(values.PLATFORM_REALM_OPERATOR_LINK_CONFIG ?? "null"),
        linkConfiguration,
      )
    ) {
      throw unavailable();
    }
    const key = publicKeySchema.parse(
      createPublicKey(values.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY ?? "").export({ format: "jwk" }),
    );
    const publicJwk = {
      ...key,
      kid: z.string().min(1).parse(values.PLATFORM_GATEWAY_IDENTITY_KEY_ID),
      alg: "EdDSA",
      use: "sig",
    };
    await deps.assertCurrentOwner(context);
    const latest = await deps.readReleases(context, binding);
    if (latest.length !== 1 || !isDeepStrictEqual(latest[0], selected)) {
      throw unavailable();
    }
    return { binding, plan, enrollment, linkConfiguration, publicJwk };
  };

export const createPostgresPublicRealmCallbackResolver = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  configuration: Pick<HostedOperatorSourceConfiguration, "standardRuntime">;
  readRuntime: Parameters<typeof createPublicRealmCallbackResolver>[0]["readRuntime"];
  assertCurrentOwner: Parameters<typeof createPublicRealmCallbackResolver>[0]["assertCurrentOwner"];
  assertSourceApproval: Parameters<
    typeof createPublicRealmCallbackResolver
  >[0]["assertSourceApproval"];
  assertPublicApproval: Parameters<
    typeof createPublicRealmCallbackResolver
  >[0]["assertPublicApproval"];
}) =>
  createPublicRealmCallbackResolver({
    ...input,
    readEnrollment: async (context, enrollmentRef) =>
      await readPublicRealmLinkConfiguration({
        database: input.database,
        keyring: input.keyring,
        authority: context.authority,
        enrollmentRef,
        assertCurrentOwner: async () => {
          await input.assertCurrentOwner(context);
        },
      }),
    readReleases: async (context, binding) =>
      await input.database
        .select({
          requestId: builderProvisioningJournals.requestId,
          requestDigest: builderProvisioningJournals.requestDigest,
          record: builderProvisioningJournals.record,
        })
        .from(builderProvisioningJournals)
        .where(
          and(
            eq(builderProvisioningJournals.issuer, context.authority.issuer),
            eq(builderProvisioningJournals.audience, context.authority.audience),
            eq(builderProvisioningJournals.workspaceId, context.authority.workspaceId),
            eq(builderProvisioningJournals.ownerUserId, context.authority.ownerUserId),
            sql`${builderProvisioningJournals.record}->>'kind' = 'public-app-release-v1'`,
            sql`${builderProvisioningJournals.record}->'plan'->>'purpose' = 'auth-bootstrap'`,
            sql`${builderProvisioningJournals.record}->'plan'->'selection'->>'appId' = ${context.target.appId}`,
            sql`${builderProvisioningJournals.record}->'plan'->'selection'->>'sessionId' = ${context.target.sessionId}`,
            sql`${builderProvisioningJournals.record}->'plan'->'project'->>'projectId' = ${context.target.projectId}`,
            sql`${builderProvisioningJournals.record}->'observation'->>'status' = 'ready'`,
            ...(binding === undefined
              ? []
              : [eq(builderProvisioningJournals.requestId, binding.operationRef)]),
          ),
        )
        .limit(2),
    readValues: async (context, plan) => {
      const store = createPublicReleaseRuntimeConfigurationStore({
        database: input.database,
        keyring: input.keyring,
        target: {
          authority: context.authority,
          appId: context.target.appId,
          sessionId: context.target.sessionId,
          projectId: context.target.projectId,
        },
        assertCurrentOwner: async () => {
          await input.assertCurrentOwner(context);
        },
      });
      const scope: Parameters<typeof store.read>[0] = {
        authority: context.authority,
        appId: context.target.appId,
        sessionId: context.target.sessionId,
        projectId: context.target.projectId,
        runtimeOperationRef: plan.runtime.operationRef,
        runtimePlanDigest: plan.runtime.planDigest,
        releaseId: plan.runtime.releaseId,
        publicOrigin: plan.publicOrigin,
      };
      if (plan.runtime.realmEnrollmentRef !== undefined) {
        scope.realmEnrollmentRef = plan.runtime.realmEnrollmentRef;
      }
      if (store.reference(scope) !== plan.runtime.configurationRef) {
        throw unavailable();
      }
      const values = await store.read(scope);
      if (values === undefined) {
        throw unavailable();
      }
      return values;
    },
  });
