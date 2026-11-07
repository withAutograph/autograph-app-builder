import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  resolveNativeTargetResourceProfile,
  nativeTargetResourceProfileAuthorityDigest,
} from "./native-target-resource-profile";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- The opened control-plane database uses the complete Drizzle schema.
import type * as databaseSchema from "../db/schema";
import { builderProvisioningJournals } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  readPrivateNativeTargetApproval,
  privateNativeTargetApprovalObservationSchema,
} from "../eve/private-native-target-approval";
import { readPrivateNativeTargetAuthOnlyApproval } from "../eve/private-native-target-auth-only-approval";
import type { PrivateNativeTargetApprovalObservation } from "../eve/private-native-target-approval";
import type { PrivateOperatorApprovalCapture } from "../eve/private-operator-approval-observation";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import { createBuilderApprovalStreamFetch } from "./hosted-operator-approval-observer";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { inspectNativeTargetVercelAuthorization } from "./native-target-vercel-authorization";
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createHostedOperatorAuthProposal } from "./hosted-operator-auth-proposal";
import { createAuthOnlySchemaArtifactReader } from "./native-target-auth-only-schema-artifact";
import {
  createNativeTargetAuthOnlyMaintenanceReader,
  nativeTargetAuthOnlyResourceApprovalPlanSchema,
} from "./native-target-auth-only-maintenance";
import {
  createNativeTargetAuthOnlyResourcePlanStore,
  nativeTargetAuthOnlyResourcePlanDigest,
} from "./native-target-auth-only-resource-plan-store";
import {
  createNativeTargetAuthOnlyCredentialCustody,
  nativeTargetAuthOnlyCredentialContextForPlan,
  nativeTargetAuthOnlyCredentialOperationRef,
} from "./native-target-auth-only-credential-store";
import {
  readPrivateNativeTargetAuthOnlyResourceApproval,
  nativeTargetAuthOnlyResourcePreparationInputSchema,
} from "../eve/private-native-target-auth-only-resource-approval";
import { createCapturedAppDescriptionStore } from "./captured-app-description";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  workerEffectCheckpointFrameSchema,
} from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import {
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
  nativeTargetOnboardingRegistryId,
} from "./native-target-onboarding-contract";
import type {
  NativeTargetOnboardingPlan,
  NativeTargetOnboardingRecord,
} from "./native-target-onboarding-contract";
import {
  createNativeTargetOnboardingService,
  NativeTargetExistingConfiguredTargetError,
} from "./native-target-onboarding-service";
import { createPostgresNativeTargetOnboardingStore } from "./native-target-onboarding-store";
import type { NativeTargetCurrentOwner } from "./native-target-onboarding-store";
import type {
  NativeTargetTransportRequest,
  NativeTargetRequest,
} from "./native-target-onboarding-transport";
import {
  nativeTargetAuthOnlyPlanRequestSchema,
  nativeTargetAuthOnlyPlanResponseSchema,
} from "./native-target-onboarding-transport";
import { createNativeTargetAuthOnlyPlanStore } from "./native-target-auth-only-plan-store";
import { resolveNativeTargetAuthOnlyRegistration } from "./native-target-configuration-resolver";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyAuthorityDigest } from "./native-target-auth-only-planner";
import {
  createNativeTargetAuthOnlyRuntime,
  createPostgresNativeTargetAuthOnlyRuntimeStore,
  readNativeTargetAuthOnlyPublishedSource,
} from "./hosted-operator-auth-only-runtime";
import { createHostedOperatorAuthReadiness } from "./hosted-operator-auth-readiness";
import {
  buildNativeTargetAuthOnlyDeliveryPlanBytes,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "./native-target-auth-only-delivery-plan";
import { createNativeTargetAuthOnlyPreviewDelivery } from "./native-target-auth-only-preview-delivery";
import {
  createPostgresNativeTargetAuthOnlyDeliveryStore,
  prepareNativeTargetAuthOnlyDelivery,
  readNativeTargetAuthOnlyDeliveryPlan,
  nativeTargetAuthOnlyRoutingRequired,
  withNativeTargetAuthOnlyFinalRoutingLease,
} from "./native-target-auth-only-delivery-runtime";
import type {
  NativeTargetAuthOnlyDeliveryEnvironmentInput,
  NativeTargetAuthOnlyAfterGatewayReadyInput,
  NativeTargetAuthOnlyEntryReadiness,
} from "./native-target-auth-only-delivery-runtime";
import {
  createNativeTargetAuthOnlyFinalRouting,
  createPostgresNativeTargetAuthOnlyFinalRoutingStore,
  nativeTargetAuthOnlyFinalRoutingPlanSchema,
} from "./native-target-auth-only-final-routing";
import {
  readPrivateNativeTargetAuthOnlyFinalRoutingApproval,
  nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
} from "../eve/private-native-target-auth-only-final-routing-approval";
import type { NativeTargetAuthOnlyFinalRoutingAuthority } from "./native-target-auth-only-final-routing-deployment";
import {
  readPrivateNativeTargetAuthOnlyDeliveryApproval,
  nativeTargetAuthOnlyDeliveryPreparationInputSchema,
} from "../eve/private-native-target-auth-only-delivery-approval";
import {
  nativeTargetAuthOnlyEntryApprovalAction,
  readPrivateNativeTargetAuthOnlyEntryApproval,
} from "../eve/private-native-target-auth-only-entry-approval";
import { createPostgresNativeTargetAuthOnlyEntryPlanStore } from "./native-target-auth-only-entry-plan-store";
import {
  canReadNativeTargetAuthOnlyEntryParent,
  createNativeTargetAuthOnlyEntryDeployment,
  withNativeTargetAuthOnlyEntryLease,
} from "./native-target-auth-only-entry-deployment";
import type { NativeTargetAuthOnlyEntryAuthority } from "./native-target-auth-only-entry-deployment";

import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import {
  createNativeTargetAuthOnlyDispatch,
  createPostgresNativeTargetAuthOnlyDispatchStore,
  nativeTargetAuthOnlyApprovalSchema,
} from "./native-target-auth-only-dispatch";
import {
  nativeTargetAuthOnlyPrepareRequestSchema,
  nativeTargetAuthOnlyDispatchResultSchema,
  nativeTargetAuthOnlyResourceResultSchema,
} from "./native-target-onboarding-transport";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import {
  createNativeTargetVercelProject,
  observeNativeTargetVercelProject,
} from "./native-target-vercel-provider";
import {
  runAuthResourceFileSpool,
  runAuthSchemaFileSpool,
} from "./hosted-operator-sandbox-launcher";
import type {
  NativeTargetCapturedRelease,
  NativeTargetPlanRequest,
} from "../agent/native-target-onboarding-runtime";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Current = NativeTargetCurrentOwner & { historyOwner: OperatorOwnerContext };
interface AppOwner {
  verifyWorkload: (request: Request) => Promise<void>;
  assertNoStandardBuilderDestination?: AppOwner["assertCanonicalAppOwner"];

  assertCanonicalAppOwner: (input: {
    authority: OperatorOwnerContext["authority"];
    ownerContext: OperatorOwnerContext;
    target: { appId: string; sessionId: string };
  }) => Promise<void>;
}
const unavailable = () => new HostedOperatorError("operator_unavailable");
const denied = () => new HostedOperatorError("authorization_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");

/** Distinct, bounded SQL names are frozen in the human-approved plan. */
export const nativeTargetDatabaseNames = (appId: string) => {
  const slug = nativeTargetOnboardingPlanSchema.shape.appId.parse(appId).replaceAll("-", "_");
  const suffix = createHash("sha256").update(appId).digest("hex").slice(0, 20);
  const prefix = slug.slice(0, 35);
  return {
    database: `app_${prefix}_${suffix}`,
    migratorRole: `app_${prefix}_m_${suffix}`,
    runtimeRole: `app_${prefix}_r_${suffix}`,
  };
};

/** Construct the one-resource approval bytes only from a verified registered Auth-only target. */
export const buildNativeTargetAuthOnlyResourcePlanBytes = (input: {
  plan: NativeTargetAuthOnlyPlan;
  selected: HostedOperatorSourceConfiguration;
  registration: { ownerUserId: string; sessionId: string; projectId: string; branch: string };
}) => {
  const { plan, selected, registration } = input;
  if (
    registration.ownerUserId !== plan.origin.authority.ownerUserId ||
    registration.sessionId !== plan.origin.publicSessionId ||
    registration.branch !== plan.branch ||
    selected.teamId !== plan.project.teamId ||
    selected.authDatabase.resourceId !== plan.authResource.resourceId ||
    selected.authDatabase.database !== plan.authResource.database ||
    selected.nativeNeon.scope.endpointId !== plan.authResource.endpointId ||
    selected.nativeNeon.scope.hostname !== plan.authResource.hostname
  ) {
    throw mismatch();
  }
  const worker = selected.sandbox.resourcesWorker;
  if (worker === undefined || worker.id !== "neon-resource-bootstrap-v1") {
    throw unavailable();
  }
  const nativeNeonConfiguration =
    nativeTargetAuthOnlyResourceApprovalPlanSchema.shape.nativeNeonConfiguration.parse(
      selected.nativeNeon.configuration,
    );
  const target = hostedRuntimeTargetSchema.parse({
    appId: plan.appId,
    branch: plan.branch,
    environment: "preview",
    installationId: plan.project.installationId,
    projectId: registration.projectId,
    scopeId: plan.project.teamId,
    scopeType: "team",
    sessionId: plan.origin.publicSessionId,
  });
  const resourcePlan = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse({
    action: "prepare",
    authDatabase: selected.authDatabase,
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    authSchema: plan.authSchema,
    bootstrap: {
      endpointId: selected.nativeNeon.scope.endpointId,
      maintenanceDatabase: selected.nativeNeon.scope.maintenanceDatabase,
      role: selected.nativeNeon.scope.maintenanceRole,
    },
    effects: [
      { id: "auth_resources", kind: "resources", resourceId: selected.authDatabase.resourceId },
    ],
    nativeNeonConfiguration,
    neon: {
      branchId: selected.nativeNeon.scope.branchId,
      endpoint: selected.nativeNeon.scope.hostname,
      projectId: selected.nativeNeon.scope.projectId,
    },
    resourcesInstaller: { reference: worker.id, sha256: worker.sha256 },
    target,
    version: 1,
  });
  return Buffer.from(JSON.stringify(resourcePlan));
};

/** Existing per-app pins remain historical; fresh apps require an explicit captured generic capability. */
export const selectNativeTargetInstaller = (
  workers: HostedOperatorSourceConfiguration["sandbox"]["workers"],
  appId: string,
  generic?: HostedOperatorSourceConfiguration["sandbox"]["genericInstallerWorker"],
) => {
  const configured = workers[appId];
  if (configured !== undefined) {
    if (
      configured.operationScope !== "generated-app-release-install-v1" ||
      configured.subcommand !== "protected-generated-app-install"
    ) {
      throw unavailable();
    }
    return configured;
  }
  if (generic === undefined) {
    throw new HostedOperatorError("generic_installer_configuration_required");
  }
  return generic;
};

/** A configured physical target already owns this app ID, including its existing resource names. */
export const assertNoConfiguredNativeTarget = (
  applications: HostedOperatorSourceConfiguration["applications"],
  appId: string,
) => {
  if (applications[appId] !== undefined) {
    throw new NativeTargetExistingConfiguredTargetError();
  }
};

type NativeTargetApprovalAction = Extract<
  PrivateOperatorApprovalCapture["request"]["action"],
  `native-target${string}`
>;

export const nativeTargetApprovalCheckpointId = (
  authority: Current["authority"],
  appId: string,
  planDigest: string,
  action: NativeTargetApprovalAction = "native-target",
) => {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        `native-target-approval-observation-v1:${action}`,
        nativeTargetOnboardingRegistryId(authority, appId),
        planDigest,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const approvalCheckpointRecordSchema = z.strictObject({
  kind: z.literal("native-target-approval-observation"),
  observation: privateNativeTargetApprovalObservationSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});

/** Checkpoint only incomplete native tails. The authenticated stream remains settlement authority. */
export const createNativeTargetApprovalCheckpoint = (
  database: Database,
  authority: Current["authority"],
  appId: string,
  planDigest: string,
  writeAuthority?: {
    adapterSessionId: string;
    adapterGeneration: number;
    assertCurrent: () => Promise<void>;
  },
  action: NativeTargetApprovalAction = "native-target",
) => {
  const requestId = nativeTargetApprovalCheckpointId(authority, appId, planDigest, action);
  const key = authority;
  const predicate = and(
    eq(builderProvisioningJournals.issuer, key.issuer),
    eq(builderProvisioningJournals.audience, key.audience),
    eq(builderProvisioningJournals.workspaceId, key.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, key.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
  );
  let expected:
    | { revision: number; observation: PrivateNativeTargetApprovalObservation }
    | null
    | undefined;
  const read = async (): Promise<PrivateNativeTargetApprovalObservation | undefined> => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      expected = null;
      return undefined;
    }
    const parsed = approvalCheckpointRecordSchema.parse(row.record);
    if (row.requestDigest !== planDigest || parsed.planDigest !== planDigest) {
      throw mismatch();
    }
    expected = { observation: structuredClone(parsed.observation), revision: row.revision };
    return parsed.observation;
  };
  const assertObservationBinding = (parsed: PrivateNativeTargetApprovalObservation) => {
    const intentMatches = [
      parsed.native.capture.ownerUserId === authority.ownerUserId,
      parsed.native.capture.request.action === action,
      parsed.native.capture.request.planDigest === planDigest,
      parsed.native.capture.request.idempotencyKey === appId,
    ].every(Boolean);
    if (!intentMatches) {
      throw mismatch();
    }
    if (
      writeAuthority !== undefined &&
      (parsed.native.adapterSessionId !== writeAuthority.adapterSessionId ||
        parsed.native.adapterGeneration !== writeAuthority.adapterGeneration)
    ) {
      throw mismatch();
    }
  };
  const insertInitial = async (
    value: z.infer<typeof approvalCheckpointRecordSchema>,
    parsed: PrivateNativeTargetApprovalObservation,
    now: Date,
  ) => {
    await database
      .insert(builderProvisioningJournals)
      .values({
        ...key,
        createdAt: now,
        record: value,
        requestDigest: planDigest,
        requestId,
        revision: 1,
        state: "pending",
        updatedAt: now,
      })
      .onConflictDoNothing();
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const inserted = rows[0];
    if (inserted === undefined || inserted.requestDigest !== planDigest) {
      throw mismatch();
    }
    const stored = approvalCheckpointRecordSchema.parse(inserted.record);
    await writeAuthority?.assertCurrent();
    // An insert conflict is not permission to replace a row we never read.
    if (stored.planDigest !== planDigest || !isDeepStrictEqual(stored.observation, parsed)) {
      throw unavailable();
    }
    expected = { observation: structuredClone(parsed), revision: inserted.revision };
  };
  const assertForwardObservation = (
    previous: PrivateNativeTargetApprovalObservation,
    parsed: PrivateNativeTargetApprovalObservation,
    previouslyRead: boolean,
  ) => {
    const sameAdapter =
      previous.native.adapterSessionId === parsed.native.adapterSessionId &&
      previous.native.adapterGeneration === parsed.native.adapterGeneration;
    if (sameAdapter) {
      if (previous.native.nextNativeIndex >= parsed.native.nextNativeIndex) {
        throw unavailable();
      }
      return;
    }
    if (writeAuthority === undefined || !previouslyRead) {
      throw unavailable();
    }
    if (!isDeepStrictEqual(previous.native.capture.request, parsed.native.capture.request)) {
      throw unavailable();
    }
  };
  const save = async (observation: PrivateNativeTargetApprovalObservation) => {
    const parsed = privateNativeTargetApprovalObservationSchema.parse(observation);
    assertObservationBinding(parsed);
    await writeAuthority?.assertCurrent();
    const previouslyRead = expected !== undefined;
    if (!previouslyRead) {
      await read();
    }
    const value = approvalCheckpointRecordSchema.parse({
      kind: "native-target-approval-observation",
      observation: parsed,
      planDigest,
      version: 1,
    });
    const now = new Date();
    if (expected === null) {
      await insertInitial(value, parsed, now);
      return;
    }
    if (expected === undefined) {
      throw unavailable();
    }
    const expectedSnapshot = expected;
    const previous = expectedSnapshot.observation;
    if (isDeepStrictEqual(previous, parsed)) {
      return;
    }
    assertForwardObservation(previous, parsed, previouslyRead);
    await writeAuthority?.assertCurrent();
    const updated = await database
      .update(builderProvisioningJournals)
      .set({ record: value, revision: expectedSnapshot.revision + 1, updatedAt: now })
      .where(and(predicate, eq(builderProvisioningJournals.revision, expectedSnapshot.revision)))
      .returning({ revision: builderProvisioningJournals.revision });
    if (updated.length !== 1) {
      throw unavailable();
    }
    if ((expected?.revision ?? 0) <= expectedSnapshot.revision) {
      expected = {
        observation: structuredClone(parsed),
        revision: expectedSnapshot.revision + 1,
      };
    }
  };
  return { read, save };
};

export const createNativeTargetApprovalHistoryTransport = (input: {
  builderOrigin: string;
  owner: Current;
  appId: string;
  workload: { authorization: string | null; signal: AbortSignal };
  assertCanonicalAppOwner: AppOwner["assertCanonicalAppOwner"];
  fetch?: typeof fetch;
}) => {
  const carrier = input.workload.authorization;
  if (carrier === null || !carrier.startsWith("Bearer ") || carrier.length === 7) {
    throw denied();
  }
  return createSameOriginEveTransport({
    config: { baseUrl: input.builderOrigin },
    fetchImplementation: createBuilderApprovalStreamFetch({
      origin: input.builderOrigin,
      adapterSessionId: input.owner.adapterSessionId,
      signal: input.workload.signal,
      fetchImplementation: input.fetch ?? fetch,
    }),
    verifyReadAuthority: async ({ adapterSessionId, principal, sessionId }) => {
      if (
        adapterSessionId !== input.owner.adapterSessionId ||
        sessionId !== input.owner.publicSessionId ||
        !isDeepStrictEqual(principal, input.owner.historyOwner.principal)
      ) {
        return false;
      }
      await input.assertCanonicalAppOwner({
        authority: input.owner.authority,
        ownerContext: input.owner.historyOwner,
        target: { appId: input.appId, sessionId },
      });
      return true;
    },
    workloadIdentity: { token: async () => Promise.resolve(carrier.slice(7)) },
  });
};

const authOnlyWorkerRecordSchema = z.strictObject({
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  fenceGeneration: z.number().int().positive(),
  frames: z.array(workerEffectCheckpointFrameSchema),
  kind: z.literal("native-target-auth-only-worker"),
  operationRef: z.uuid(),
  stage: z.enum(["resources", "auth"]),
  workerAttemptId: z.uuid(),
});

/** Persist exact worker evidence before acknowledging a checkpoint. Each fenced attempt has its own row. */
const createAuthOnlyWorkerJournal = (input: {
  database: Database;
  authority: Current["authority"];
  appId: string;
  resourceId: string;
  operationRef: string;
  workerAttemptId: string;
  fenceGeneration: number;
  resourcePlanDigest: string;
  assertCurrent: () => Promise<void>;
}) => {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const attempt = {
    fenceGeneration: input.fenceGeneration,
    operationRef: input.operationRef,
    workerAttemptId: input.workerAttemptId,
  };
  const predicateFor = (stage: "resources" | "auth") => {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          "native-target-auth-only-worker",
          input.resourcePlanDigest,
          attempt,
          stage,
        ]),
      )
      .digest("hex");
    const requestId = nativeTargetApprovalCheckpointId(authority, input.appId, digest);
    const where = and(
      eq(builderProvisioningJournals.issuer, authority.issuer),
      eq(builderProvisioningJournals.audience, authority.audience),
      eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, requestId),
      eq(builderProvisioningJournals.requestDigest, digest),
    );
    return { digest, requestId, where };
  };
  const read = async (stage: "resources" | "auth") => {
    const { where } = predicateFor(stage);
    const [row] = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(where)
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    const record = authOnlyWorkerRecordSchema.parse(row.record);
    if (
      record.operationRef !== attempt.operationRef ||
      record.workerAttemptId !== attempt.workerAttemptId ||
      record.fenceGeneration !== attempt.fenceGeneration ||
      record.stage !== stage
    ) {
      throw mismatch();
    }
    return { record, revision: row.revision };
  };
  const bind =
    (stage: "resources" | "auth"): HostedOperatorWorkerEffectContext["bindWorkerContext"] =>
    async ({ contextDigest }) => {
      await input.assertCurrent();
      const { requestId, digest, where } = predicateFor(stage);
      const now = new Date();
      await input.database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          createdAt: now,
          record: authOnlyWorkerRecordSchema.parse({
            kind: "native-target-auth-only-worker",
            ...attempt,
            stage,
            contextDigest,
            frames: [],
          }),
          requestDigest: digest,
          requestId,
          revision: 1,
          state: "pending",
          updatedAt: now,
        })
        .onConflictDoNothing();
      const bound = await read(stage);
      if (bound === undefined || bound.record.contextDigest !== contextDigest) {
        throw mismatch();
      }
      await input.assertCurrent();
      return async (rawFrame) => {
        const frame = workerEffectCheckpointFrameSchema.parse(rawFrame);
        const current = await read(stage);
        if (
          current === undefined ||
          current.record.contextDigest !== contextDigest ||
          frame.contextDigest !== contextDigest ||
          frame.operationId !== attempt.operationRef ||
          frame.fenceGeneration !== attempt.fenceGeneration ||
          frame.resourceId !== input.resourceId ||
          frame.tenantId != null
        ) {
          throw mismatch();
        }
        await input.assertCurrent();
        const prior = current.record.frames[frame.sequence - 1];
        if (prior !== undefined && isDeepStrictEqual(prior, frame)) {
          return;
        }
        if (frame.sequence !== current.record.frames.length + 1) {
          throw mismatch();
        }
        const record = { ...current.record, frames: [...current.record.frames, frame] };
        const [updated] = await input.database
          .update(builderProvisioningJournals)
          .set({ record, revision: current.revision + 1, updatedAt: new Date() })
          .where(and(where, eq(builderProvisioningJournals.revision, current.revision)))
          .returning();
        if (updated === undefined) {
          throw mismatch();
        }
        await input.assertCurrent();
      };
    };
  return { bind, read };
};

export const createNativeTargetOnboardingDeployment = (input: {
  authOnlyEntryAuthority?: NativeTargetAuthOnlyEntryAuthority;
  authOnlyDeliveryEnvironment?: (
    value: NativeTargetAuthOnlyDeliveryEnvironmentInput,
  ) => Promise<void>;
  authOnlyAfterGatewayReady?: (
    value: NativeTargetAuthOnlyAfterGatewayReadyInput,
  ) => Promise<NativeTargetAuthOnlyEntryReadiness>;
  authOnlyFinalRoutingAuthority?: NativeTargetAuthOnlyFinalRoutingAuthority;
  authOnlyPrepareFinalRoutingPlan?: NonNullable<
    Parameters<typeof prepareNativeTargetAuthOnlyDelivery>[0]["prepareFinalRoutingPlan"]
  >;
  database: Database;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  owner: AppOwner;
  builderOrigin: string;
  fetch?: typeof fetch;
}) => {
  const { database, configuration } = input;
  const keyring = readVercelTokenKeyringEnvironment(input.environment);
  const store = createPostgresNativeTargetOnboardingStore(database);
  const authorize = async (
    _request: Request,
    request: NativeTargetTransportRequest,
  ): Promise<Current> => {
    const historyOwner = operatorOwnerContextSchema.parse(request.ownerContext);
    const context = {
      authority: historyOwner.authority,
      ownerContext: historyOwner,
      target: { appId: request.input.appId, sessionId: historyOwner.sessionId },
    };
    await input.owner.assertCanonicalAppOwner(context);
    if (
      request.action === "native-target-prepare" ||
      (request.action === "native-target-plan" && request.selectedApp !== undefined)
    ) {
      if (input.owner.assertNoStandardBuilderDestination === undefined) {
        throw unavailable();
      }
      await input.owner.assertNoStandardBuilderDestination(context);
    }
    if (historyOwner.adapterSessionId !== request.adapterSessionId) {
      throw denied();
    }
    return {
      adapterGeneration: historyOwner.adapterGeneration,
      adapterSessionId: historyOwner.adapterSessionId,
      authority: historyOwner.authority,
      historyOwner,
      publicSessionId: historyOwner.sessionId,
    };
  };
  const artifactContext = (owner: Current, appId: string) => ({
    authority: owner.authority,
    target: { appId, sessionId: owner.publicSessionId },
  });
  const readCapturedRelease = async (
    owner: Current,
    appId: string,
    appSpecDigest: string,
  ): Promise<NativeTargetCapturedRelease> => {
    const context = artifactContext(owner, appId);
    const assertCurrentOwner = async () => {
      await input.owner.assertCanonicalAppOwner({
        authority: owner.authority,
        ownerContext: owner.historyOwner,
        target: context.target,
      });
    };
    const artifactStore = createPostgresOperatorArtifactStore({ assertCurrentOwner, database });
    const selections = createPostgresOperatorArtifactSelections({ assertCurrentOwner, database });
    const selection = await selections.read(context, appSpecDigest);
    if (
      selection === undefined ||
      selection.appId !== appId ||
      selection.appSpecDigest !== appSpecDigest
    ) {
      throw mismatch();
    }
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner,
      store: artifactStore,
    });
    const captured = await publication.readGeneratedRelease(context, selection);
    if (
      captured.description === undefined ||
      captured.description.backend.kind !== "generated-postgres"
    ) {
      throw mismatch();
    }
    return {
      description: captured.description,
      release: {
        artifactRef: selection.artifactRef,
        id: selection.releaseId,
        manifestSha256: selection.manifestSha256,
        schemaSha256: selection.schemaSha256,
      },
    };
  };
  const readInstallation = async (owner: Current, installationId: string, teamId: string) => {
    const credential = await readActiveVercelInstallationToken({
      authority: owner.authority,
      config: keyring,
      database,
      installationId,
    });
    if (
      credential === undefined ||
      !credential.binding.active ||
      credential.binding.scopeType !== "team" ||
      credential.binding.scopeId !== teamId
    ) {
      throw denied();
    }
    return credential;
  };
  const resolvePlan = async (
    owner: Current,
    proposal: NativeTargetPlanRequest,
    source: {
      appSpecDigest: string;
      captured: NativeTargetCapturedRelease;
    },
  ): Promise<NativeTargetOnboardingPlan> => {
    let selectedConfiguration: HostedOperatorSourceConfiguration;
    try {
      selectedConfiguration = resolveNativeTargetResourceProfile({
        appId: proposal.appId,
        authority: owner.authority,
        base: configuration,
        environment: input.environment,
        resourceProfileId: proposal.resourceProfileId,
      });
    } catch {
      throw mismatch();
    }
    assertNoConfiguredNativeTarget(selectedConfiguration.applications, proposal.appId);
    if (proposal.project.teamId !== selectedConfiguration.teamId) {
      throw mismatch();
    }
    await readInstallation(owner, proposal.project.installationId, proposal.project.teamId);
    const worker = selectNativeTargetInstaller(
      selectedConfiguration.sandbox.workers,
      proposal.appId,
      selectedConfiguration.sandbox.genericInstallerWorker,
    );
    const { nativeNeon } = selectedConfiguration;
    return nativeTargetOnboardingPlanSchema.parse({
      version: 1,
      appId: proposal.appId,
      ...(proposal.resourceProfileId === undefined
        ? {}
        : {
            resourceProfileAuthorityDigest:
              nativeTargetResourceProfileAuthorityDigest(selectedConfiguration),
            resourceProfileId: proposal.resourceProfileId,
          }),
      origin: {
        adapterGeneration: owner.adapterGeneration,
        adapterSessionId: owner.adapterSessionId,
        appSpecDigest: source.appSpecDigest,
        publicSessionId: owner.publicSessionId,
        release: source.captured.release,
      },
      project: {
        ...proposal.project,
        protection: nativeTargetRequiredProjectProtection,
      },
      branch: proposal.branch,
      appDatabase: {
        resourceId: nativeNeon.configuration.nativeStore.resourceId,
        ...nativeTargetDatabaseNames(proposal.appId),
      },
      productRoles:
        source.captured.description.backend.kind === "generated-postgres"
          ? source.captured.description.backend.roles
          : [],
      nativeNeon: {
        ...(nativeNeon.configuration.syntheticEnrollment === undefined
          ? {}
          : {
              approvalReference:
                nativeNeon.configuration.syntheticEnrollment.creationApprovalReference,
            }),
        nativeStore: nativeNeon.configuration.nativeStore,
        scope: nativeNeon.scope,
      },
      worker,
      cost: {
        description:
          "Vercel Preview usage is billed to the approved team under its current plan; no fixed credit purchase or subscription upgrade is included.",
        ownership: "current-owner",
      },
      retention: {
        policy:
          "Retain the dedicated Preview project until explicit authorized deletion; session completion or failure does not delete it. App database cleanup is a separate approved operation.",
      },
      conflictPolicy: proposal.conflictPolicy,
    });
  };
  const readApproval = async (
    owner: Current,
    record: NativeTargetOnboardingRecord,
    callId: string | undefined,
    workload: { authorization: string | null; signal: AbortSignal },
  ) => {
    await input.owner.assertCanonicalAppOwner({
      authority: owner.authority,
      ownerContext: owner.historyOwner,
      target: { appId: record.appId, sessionId: owner.publicSessionId },
    });
    const checkpoint = createNativeTargetApprovalCheckpoint(
      database,
      owner.authority,
      record.appId,
      record.planDigest,
      {
        adapterGeneration: owner.adapterGeneration,
        adapterSessionId: owner.adapterSessionId,
        assertCurrent: async () => {
          await input.owner.assertCanonicalAppOwner({
            authority: owner.authority,
            ownerContext: owner.historyOwner,
            target: { appId: record.appId, sessionId: owner.publicSessionId },
          });
        },
      },
    );
    const observation = await checkpoint.read();
    const transport = createNativeTargetApprovalHistoryTransport({
      appId: record.appId,
      assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
      builderOrigin: input.builderOrigin,
      owner,
      workload,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    if (transport.observePrivateHistory === undefined) {
      throw unavailable();
    }
    const result = await readPrivateNativeTargetApproval({
      owner,
      record,
      historyOwner: owner.historyOwner,
      ...(callId === undefined ? {} : { callId }),
      observation: {
        ...(observation === undefined ? {} : { state: observation }),
        save: checkpoint.save,
      },
      readHistory: async (startIndex, onEvent) =>
        (await transport.observePrivateHistory?.({
          adapterSessionId: owner.adapterSessionId,
          onEvent,
          principal: owner.historyOwner.principal,
          sessionId: owner.publicSessionId,
          startIndex,
        })) ?? { complete: false, nativeTailIndex: startIndex, nextNativeIndex: startIndex },
      assertOwner: async () => {
        await input.owner.assertCanonicalAppOwner({
          authority: owner.authority,
          ownerContext: owner.historyOwner,
          target: { appId: record.appId, sessionId: owner.publicSessionId },
        });
      },
    });
    return result.status === "pending" ? null : result.proof;
  };
  const nativeTargetService = createNativeTargetOnboardingService({
    authorize,
    createProject: async ({ owner, plan, name, authorizeAttempt, acceptProjectId }) => {
      let credential: Awaited<ReturnType<typeof readInstallation>>;
      try {
        credential = await readInstallation(
          owner,
          plan.project.installationId,
          plan.project.teamId,
        );
      } catch {
        // This failure precedes the provider dispatch and is a definite non-creation.
        return { status: "rejected", reason: "authorization_denied" };
      }
      return await createNativeTargetVercelProject({
        installation: credential.binding,
        token: credential.token,
        name,
        settings: plan.project.projectSettings,
        protection: plan.project.protection,
        authorizeAttempt,
        acceptProjectId,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
    },
    inspectProviderAuthorization: async ({ owner, plan, signal }) =>
      await inspectNativeTargetVercelAuthorization({
        expectedInstallationId: plan.project.installationId,
        expectedTeamId: plan.project.teamId,
        readInstallationToken: async () => {
          const credential = await readInstallation(
            owner,
            plan.project.installationId,
            plan.project.teamId,
          );
          return credential.token;
        },
        fetch: input.fetch ?? fetch,
        signal,
      }),
    observeProject: async ({ owner, plan, name, projectId }) => {
      const credential = await readInstallation(
        owner,
        plan.project.installationId,
        plan.project.teamId,
      );
      return await observeNativeTargetVercelProject({
        installation: credential.binding,
        token: credential.token,
        name,
        settings: plan.project.projectSettings,
        protection: plan.project.protection,
        projectId,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
    },
    readApproval,
    readCapturedRelease,
    resolvePlan,
    store,
    verifyWorkload: input.owner.verifyWorkload,
  });
  const entryFor = (
    request: Request,
    currentOwner: Current,
    appId: string,
    assertCurrentOwner: () => Promise<void>,
  ) => {
    if (input.authOnlyEntryAuthority === undefined) {
      throw unavailable();
    }
    const transport = createNativeTargetApprovalHistoryTransport({
      appId,
      assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
      builderOrigin: input.builderOrigin,
      owner: currentOwner,
      workload: { authorization: request.headers.get("authorization"), signal: request.signal },
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    const observe = transport.observePrivateHistory;
    if (observe === undefined) {
      throw unavailable();
    }
    const readHistory = async (
      startIndex: number,
      onEvent: Parameters<NonNullable<typeof observe>>[0]["onEvent"],
    ) =>
      await observe({
        adapterSessionId: currentOwner.adapterSessionId,
        onEvent,
        principal: currentOwner.historyOwner.principal,
        sessionId: currentOwner.publicSessionId,
        startIndex,
      });
    const childStore = createPostgresNativeTargetAuthOnlyEntryPlanStore({
      assertCurrentOwner: async (key) => {
        if (
          key.appId !== appId ||
          key.sessionId !== currentOwner.publicSessionId ||
          !isDeepStrictEqual(key.authority, currentOwner.authority)
        ) {
          throw denied();
        }
        await assertCurrentOwner();
      },
      database,
    });
    const entry = createNativeTargetAuthOnlyEntryDeployment({
      authority: input.authOnlyEntryAuthority,
      readApproval: async (key, approvalInput, assertCurrent) => {
        const checkpoint = createNativeTargetApprovalCheckpoint(
          database,
          currentOwner.authority,
          appId,
          approvalInput.childPlanDigest,
          {
            adapterSessionId: currentOwner.adapterSessionId,
            adapterGeneration: currentOwner.adapterGeneration,
            assertCurrent,
          },
          nativeTargetAuthOnlyEntryApprovalAction,
        );
        return await readPrivateNativeTargetAuthOnlyEntryApproval({
          historyOwner: currentOwner.historyOwner,
          key,
          approvalInput,
          store: childStore,
          observation: { state: await checkpoint.read(), save: checkpoint.save },
          readHistory,
          assertCurrentOwner: assertCurrent,
        });
      },
      store: childStore,
    });
    return { entry, readHistory };
  };
  type EntryRequest = Extract<
    NativeTargetTransportRequest,
    {
      action:
        | "native-target-auth-only-entry-plan"
        | "native-target-auth-only-entry-approval-read"
        | "native-target-auth-only-entry";
    }
  >;
  const handleEntry = async (request: Request, rawInput: EntryRequest) => {
    await input.owner.verifyWorkload(request);
    const currentOwner = await authorize(request, rawInput);
    const proposal = rawInput.input;
    const context = artifactContext(currentOwner, proposal.appId);
    const ownerRequest = { ...context, ownerContext: currentOwner.historyOwner };
    const assertOwner = async () => {
      request.signal.throwIfAborted();
      await input.owner.assertCanonicalAppOwner(ownerRequest);
      if (input.owner.assertNoStandardBuilderDestination === undefined) {
        throw unavailable();
      }
      await input.owner.assertNoStandardBuilderDestination(ownerRequest);
    };
    const { entry, readHistory } = entryFor(request, currentOwner, proposal.appId, assertOwner);
    const deliveryStore = createPostgresNativeTargetAuthOnlyDeliveryStore(database);
    const key = {
      appId: proposal.appId,
      authority: currentOwner.authority,
      operationRef: proposal.deliveryOperationRef,
      sessionId: currentOwner.publicSessionId,
    };
    await assertOwner();
    const readDelivery = async () => {
      await assertOwner();
      const row = await deliveryStore.read(key);
      if (
        row === undefined ||
        row.record.deliveryPlanDigest !== proposal.deliveryPlanDigest ||
        row.record.approval?.outcome !== "approved" ||
        row.record.gateway.receipt === undefined
      ) {
        throw mismatch();
      }
      const retained = readNativeTargetAuthOnlyDeliveryPlan(key, row.record);
      return {
        row,
        ...retained,
        approval: row.record.approval,
        gateway: row.record.gateway.receipt,
      };
    };
    const exact = await readDelivery();
    if (!canReadNativeTargetAuthOnlyEntryParent(exact.row)) {
      throw new HostedOperatorError("reconciliation_required");
    }
    const dispatchStore = createPostgresNativeTargetAuthOnlyDispatchStore(database);
    const planStore = createNativeTargetAuthOnlyPlanStore({
      assertCurrentOwner: async (observed) => {
        if (!isDeepStrictEqual(observed, context)) {
          throw denied();
        }
        await assertOwner();
      },
      database,
    });
    const readNativePlan = async () => {
      const dispatch = await dispatchStore.read({
        appId: key.appId,
        authority: currentOwner.authority,
      });
      const created = dispatch?.state;
      if (
        created?.stage !== "created" ||
        created.planDigest !== exact.plan.authOnlyPlanDigest ||
        created.projectId !== exact.plan.target.projectId ||
        nativeTargetAuthOnlyCredentialOperationRef(created.plan) !== key.operationRef
      ) {
        throw mismatch();
      }
      const plan = await planStore.read(
        context,
        created.plan.origin.appSpecDigest,
        created.planDigest,
      );
      if (plan === undefined || !isDeepStrictEqual(plan, created.plan)) {
        throw mismatch();
      }
      return plan;
    };
    const plan = await readNativePlan();
    const assertExact = async () => {
      const current = await readDelivery();
      if (
        !isDeepStrictEqual(current.gateway, exact.gateway) ||
        !isDeepStrictEqual(current.approval, exact.approval) ||
        !isDeepStrictEqual(await readNativePlan(), plan)
      ) {
        throw mismatch();
      }
    };
    const checkpoint = createNativeTargetApprovalCheckpoint(
      database,
      currentOwner.authority,
      key.appId,
      proposal.deliveryPlanDigest,
      {
        adapterGeneration: currentOwner.adapterGeneration,
        adapterSessionId: currentOwner.adapterSessionId,
        assertCurrent: assertExact,
      },
      "native-target-auth-only-delivery",
    );
    const assertCurrent = async () => {
      const approved = await readPrivateNativeTargetAuthOnlyDeliveryApproval({
        assertOwner: assertExact,
        deliveryPlanBytes: exact.bytes,
        deliveryPlanDigest: proposal.deliveryPlanDigest,
        historyOwner: currentOwner.historyOwner,
        observation: { save: checkpoint.save, state: await checkpoint.read() },
        operationRef: key.operationRef,
        owner: currentOwner,
        plan,
        readHistory,
        resourcePlanDigest: exact.plan.resourcePlanDigest,
        retainedApproval: exact.approval,
      });
      if (!isDeepStrictEqual(approved, exact.approval)) {
        throw denied();
      }
    };
    const parent: NativeTargetAuthOnlyAfterGatewayReadyInput = {
      approval: exact.approval,
      assertCurrent,
      authority: currentOwner.authority,
      deliveryPlan: exact.plan,
      deliveryPlanDigest: proposal.deliveryPlanDigest,
      fenceGeneration: exact.row.record.fenceGeneration,
      gateway: exact.gateway,
      operationRef: key.operationRef,
      plan,
      signal: request.signal,
      target: exact.plan.target,
    };
    const headers = { "cache-control": "private, no-store" };
    if (rawInput.action === "native-target-auth-only-entry") {
      const result = await withNativeTargetAuthOnlyEntryLease({
        key,
        parent,
        run: async (fenced) => await entry.execute(fenced, rawInput.input),
        store: deliveryStore,
      });
      return Response.json(result, { headers });
    }
    const retained = {
      ...parent,
      assertCurrent: async () => {
        await assertCurrent();
        const current = await readDelivery();
        if (!canReadNativeTargetAuthOnlyEntryParent(current.row)) {
          throw new HostedOperatorError("reconciliation_required");
        }
      },
    };
    if (rawInput.action === "native-target-auth-only-entry-plan") {
      return Response.json(await entry.plan(retained, proposal.effect), { headers });
    }
    return Response.json(
      { status: await entry.readSettlement(retained, rawInput.input) },
      { headers },
    );
  };
  return async (request: Request, rawInput: NativeTargetRequest): Promise<Response> => {
    if (
      rawInput.action === "native-target-auth-only-entry-plan" ||
      rawInput.action === "native-target-auth-only-entry-approval-read" ||
      rawInput.action === "native-target-auth-only-entry"
    ) {
      return await handleEntry(request, rawInput);
    }
    if (
      rawInput.action === "native-target-auth-only-delivery-plan" ||
      rawInput.action === "native-target-auth-only-delivery-approval-read" ||
      rawInput.action === "native-target-auth-only-delivery" ||
      rawInput.action === "native-target-auth-only-final-routing-plan" ||
      rawInput.action === "native-target-auth-only-final-routing-approval-read" ||
      rawInput.action === "native-target-auth-only-final-routing"
    ) {
      await input.owner.verifyWorkload(request);
      const historyOwner = operatorOwnerContextSchema.parse(rawInput.ownerContext);
      if (rawInput.adapterSessionId !== historyOwner.adapterSessionId) {
        throw denied();
      }
      const currentOwner: Current = {
        adapterGeneration: historyOwner.adapterGeneration,
        adapterSessionId: historyOwner.adapterSessionId,
        authority: historyOwner.authority,
        historyOwner,
        publicSessionId: historyOwner.sessionId,
      };
      const { appId, operationRef } = rawInput.input;
      const finalAction = rawInput.action.startsWith("native-target-auth-only-final-routing");
      const context = artifactContext(currentOwner, appId);
      const ownerRequest = { ...context, ownerContext: historyOwner };
      const assertCurrentOwner = async (observed: OperatorArtifactContext) => {
        if (!isDeepStrictEqual(observed, context)) {
          throw denied();
        }
        await input.owner.assertCanonicalAppOwner(ownerRequest);
        if (input.owner.assertNoStandardBuilderDestination === undefined) {
          throw unavailable();
        }
        await input.owner.assertNoStandardBuilderDestination(ownerRequest);
      };
      await assertCurrentOwner(context);
      const dispatchStore = createPostgresNativeTargetAuthOnlyDispatchStore(database);
      const created = (await dispatchStore.read({ appId, authority: currentOwner.authority }))
        ?.state;
      if (
        created?.stage !== "created" ||
        nativeTargetAuthOnlyCredentialOperationRef(created.plan) !== operationRef
      ) {
        throw mismatch();
      }
      const deliveryStore = createPostgresNativeTargetAuthOnlyDeliveryStore(database);
      const key = {
        appId,
        authority: currentOwner.authority,
        operationRef,
        sessionId: currentOwner.publicSessionId,
      };
      const priorDelivery = finalAction ? await deliveryStore.read(key) : undefined;
      const planDigest =
        "planDigest" in rawInput.input ? rawInput.input.planDigest : created.planDigest;
      const resourcePlanDigest =
        "resourcePlanDigest" in rawInput.input
          ? rawInput.input.resourcePlanDigest
          : priorDelivery === undefined
            ? undefined
            : readNativeTargetAuthOnlyDeliveryPlan(key, priorDelivery.record).plan
                .resourcePlanDigest;
      if (created.planDigest !== planDigest || resourcePlanDigest === undefined) {
        throw mismatch();
      }
      const planStore = createNativeTargetAuthOnlyPlanStore({ assertCurrentOwner, database });
      const plan = await planStore.read(context, created.plan.origin.appSpecDigest, planDigest);
      if (
        plan === undefined ||
        !isDeepStrictEqual(plan, created.plan) ||
        plan.origin.publicSessionId !== currentOwner.publicSessionId ||
        !isDeepStrictEqual(plan.origin.authority, currentOwner.authority)
      ) {
        throw mismatch();
      }
      const resourceStore = createNativeTargetAuthOnlyResourcePlanStore({
        assertCurrentOwner,
        database,
      });
      const authRuntimeStore = createPostgresNativeTargetAuthOnlyRuntimeStore(database);
      const capturedStore = createCapturedAppDescriptionStore({ assertCurrentOwner, database });
      const readRegistered = async () => {
        await assertCurrentOwner(context);
        const selected = await resolveNativeTargetAuthOnlyRegistration({
          appId,
          authority: currentOwner.authority,
          configuration,
          environment: input.environment,
          sessionId: currentOwner.publicSessionId,
          store: dispatchStore,
        });
        const registration = selected?.authOnlyApplications?.[appId]?.registration;
        const resource = await resourceStore.read(context, planDigest, resourcePlanDigest);
        const retained = await planStore.read(context, plan.origin.appSpecDigest, planDigest);
        const prepared = (
          await authRuntimeStore.read({
            appId,
            authority: currentOwner.authority,
            sessionId: currentOwner.publicSessionId,
          })
        )?.state;
        const description = await capturedStore.read(context, plan.origin.appSpecDigest);
        if (
          selected === undefined ||
          registration === undefined ||
          registration.projectId !== created.projectId ||
          resource === undefined ||
          !isDeepStrictEqual(retained, plan) ||
          prepared?.stage !== "prepared" ||
          prepared.planDigest !== planDigest ||
          !isDeepStrictEqual(prepared.plan, plan) ||
          !isDeepStrictEqual(prepared.authSchema, {
            artifactRef: plan.authSchema.artifactRef,
            planDigest: plan.authSchema.planDigest,
            targetDigest: plan.authSchema.targetDigest,
          }) ||
          description?.backend.kind !== "static" ||
          !resource.bytes.equals(
            buildNativeTargetAuthOnlyResourcePlanBytes({ plan, registration, selected }),
          )
        ) {
          throw mismatch();
        }
        const published = await readNativeTargetAuthOnlyPublishedSource({
          appSpecDigest: plan.origin.appSpecDigest,
          assertCurrentOwner,
          context,
          database,
          description,
        });
        if (!isDeepStrictEqual(published, plan.publishedSource)) {
          throw mismatch();
        }
        const bytes = buildNativeTargetAuthOnlyDeliveryPlanBytes({
          plan,
          registration,
          resourcePlanBytes: resource.bytes,
          resourcePlanDigest,
          selected,
        });
        await assertCurrentOwner(context);
        return { bytes, selected };
      };
      const registered = await readRegistered();
      if (rawInput.action === "native-target-auth-only-delivery-plan") {
        const retained = await deliveryStore.retain(key, registered.bytes);
        await readRegistered();
        const { plan: deliveryPlan } = readNativeTargetAuthOnlyDeliveryPlan(key, retained.record);
        return Response.json(
          nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse({
            appId,
            deliveryPlan,
            deliveryPlanDigest: retained.record.deliveryPlanDigest,
            operationRef,
            planDigest,
            resourcePlanDigest,
          }),
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      const proposal = nativeTargetAuthOnlyDeliveryPreparationInputSchema.parse(
        finalAction
          ? {
              appId,
              deliveryPlan:
                priorDelivery === undefined
                  ? undefined
                  : readNativeTargetAuthOnlyDeliveryPlan(key, priorDelivery.record).plan,
              deliveryPlanDigest: priorDelivery?.record.deliveryPlanDigest,
              operationRef,
              planDigest,
              resourcePlanDigest,
            }
          : rawInput.input,
      );
      if (finalAction && proposal.deliveryPlanDigest !== rawInput.input.deliveryPlanDigest) {
        throw mismatch();
      }
      const readExactDelivery = async () => {
        const current = await readRegistered();
        const retained = await deliveryStore.read(key);
        if (
          retained === undefined ||
          retained.record.deliveryPlanDigest !== proposal.deliveryPlanDigest ||
          nativeTargetAuthOnlyDeliveryPlanDigest(current.bytes) !== proposal.deliveryPlanDigest
        ) {
          throw mismatch();
        }
        const frozen = readNativeTargetAuthOnlyDeliveryPlan(key, retained.record);
        if (
          !frozen.bytes.equals(current.bytes) ||
          !isDeepStrictEqual(frozen.plan, proposal.deliveryPlan)
        ) {
          throw mismatch();
        }
        return { ...current, retained, ...frozen };
      };
      const exact = await readExactDelivery();
      const transport = createNativeTargetApprovalHistoryTransport({
        appId,
        assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
        builderOrigin: input.builderOrigin,
        owner: currentOwner,
        workload: { authorization: request.headers.get("authorization"), signal: request.signal },
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
      const { observePrivateHistory } = transport;
      if (observePrivateHistory === undefined) {
        throw unavailable();
      }
      const assertRegistered = async () => {
        await readExactDelivery();
      };
      const checkpoint = createNativeTargetApprovalCheckpoint(
        database,
        currentOwner.authority,
        appId,
        proposal.deliveryPlanDigest,
        {
          adapterGeneration: currentOwner.adapterGeneration,
          adapterSessionId: currentOwner.adapterSessionId,
          assertCurrent: assertRegistered,
        },
        "native-target-auth-only-delivery",
      );
      const readApproval = async () => {
        const current = await readExactDelivery();
        const state = await checkpoint.read();
        return await readPrivateNativeTargetAuthOnlyDeliveryApproval({
          assertOwner: assertRegistered,
          deliveryPlanBytes: current.bytes,
          deliveryPlanDigest: proposal.deliveryPlanDigest,
          historyOwner,
          observation: { save: checkpoint.save, state },
          operationRef,
          owner: currentOwner,
          plan,
          readHistory: async (startIndex, onEvent) =>
            await observePrivateHistory({
              principal: historyOwner.principal,
              adapterSessionId: currentOwner.adapterSessionId,
              sessionId: currentOwner.publicSessionId,
              startIndex,
              onEvent,
            }),
          resourcePlanDigest,
          retainedApproval: current.retained.record.approval,
        });
      };
      const approval = await readApproval();
      if (approval?.outcome === "cancelled") {
        throw denied();
      }
      if (rawInput.action === "native-target-auth-only-delivery-approval-read") {
        return Response.json(
          { status: approval === null ? "pending" : "approved" },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      if (approval === null) {
        throw denied();
      }
      const environment = input.authOnlyDeliveryEnvironment;
      const composedEntry =
        input.authOnlyEntryAuthority === undefined
          ? undefined
          : entryFor(request, currentOwner, appId, async () => {
              await assertCurrentOwner(context);
            }).entry;
      const afterGatewayReady =
        composedEntry === undefined
          ? input.authOnlyAfterGatewayReady
          : async (value: NativeTargetAuthOnlyAfterGatewayReadyInput) =>
              composedEntry.afterGatewayReady(value);
      if (
        environment === undefined ||
        afterGatewayReady === undefined ||
        (input.authOnlyFinalRoutingAuthority === undefined &&
          input.authOnlyPrepareFinalRoutingPlan === undefined)
      ) {
        throw unavailable();
      }
      const assertApproved = async () => {
        request.signal.throwIfAborted();
        if (!isDeepStrictEqual(await readApproval(), approval)) {
          throw denied();
        }
      };
      const finalAuthority = input.authOnlyFinalRoutingAuthority;
      const environmentInput = (
        fenceGeneration: number,
        assertCurrent: () => Promise<void>,
      ): NativeTargetAuthOnlyDeliveryEnvironmentInput => ({
        approval,
        assertCurrent,
        authority: currentOwner.authority,
        deliveryPlan: exact.plan,
        effect: "gateway",
        fenceGeneration,
        operationRef,
        plan,
        signal: request.signal,
        target: exact.plan.target,
      });
      const resumeFinal = async () => {
        const { retained } = await readExactDelivery();
        const invitation = nativeTargetAuthOnlyRoutingRequired(key, retained.record);
        const proposal = invitation.finalRoutingPlan;
        if (
          finalAction &&
          rawInput.action !== "native-target-auth-only-final-routing-plan" &&
          !isDeepStrictEqual(
            nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(rawInput.input),
            proposal,
          )
        ) {
          throw mismatch();
        }
        if (rawInput.action === "native-target-auth-only-final-routing-plan") {
          return invitation.finalRoutingPlan;
        }
        const routingBytes = Buffer.from(retained.record.finalRoutingPlan!.base64, "base64");
        const routingPlan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
          JSON.parse(routingBytes.toString("utf-8")),
        );
        const routingKey = { ...key, operationRef: proposal.routingOperationRef };
        const routingStore = createPostgresNativeTargetAuthOnlyFinalRoutingStore(database);
        const routingCheckpoint = createNativeTargetApprovalCheckpoint(
          database,
          currentOwner.authority,
          appId,
          proposal.routingPlanDigest,
          {
            adapterGeneration: currentOwner.adapterGeneration,
            adapterSessionId: currentOwner.adapterSessionId,
            assertCurrent: assertRegistered,
          },
          "native-target-auth-only-final-routing",
        );
        const readRoutingApproval = async () => {
          await assertApproved();
          const current = (await readExactDelivery()).retained;
          if (
            !isDeepStrictEqual(current.record.finalRoutingPlan, retained.record.finalRoutingPlan)
          ) {
            throw mismatch();
          }
          return await readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
            approvalInput: proposal,
            assertOwner: assertRegistered,
            historyOwner,
            observation: { save: routingCheckpoint.save, state: await routingCheckpoint.read() },
            owner: currentOwner,
            readHistory: async (startIndex, onEvent) =>
              await observePrivateHistory({
                principal: historyOwner.principal,
                adapterSessionId: currentOwner.adapterSessionId,
                sessionId: currentOwner.publicSessionId,
                startIndex,
                onEvent,
              }),
            retainedApproval: (await routingStore.read(routingKey))?.record.approval,
            routingPlanBytes: routingBytes,
          });
        };
        const routingApproval = await readRoutingApproval();
        if (routingApproval?.outcome === "cancelled") {
          throw denied();
        }
        if (rawInput.action === "native-target-auth-only-final-routing-approval-read") {
          return { status: routingApproval === null ? "pending" : "approved" };
        }
        if (routingApproval === null) {
          if (finalAction) {
            throw denied();
          }
          return invitation;
        }
        if (finalAuthority === undefined) {
          throw unavailable();
        }
        await routingStore.retain(routingKey, routingBytes, routingApproval);
        let heldRoutingFence: (() => Promise<void>) | undefined;
        return await withNativeTargetAuthOnlyFinalRoutingLease({
          app: routingPlan.app,
          approval,
          assertAuthorized: async () => {
            if (!isDeepStrictEqual(await readRoutingApproval(), routingApproval)) throw denied();
          },
          deliveryPlanDigest: proposal.deliveryPlanDigest,
          gateway: routingPlan.bootstrap,
          key,
          run: async ({ fenceGeneration, assertCurrent: assertLease }) => {
            const assertCurrent = async () => {
              await assertLease();
              if (!isDeepStrictEqual(await readRoutingApproval(), routingApproval)) throw denied();
              if (heldRoutingFence === undefined) throw unavailable();
              await heldRoutingFence();
              await assertLease();
            };
            const finalEnvironment = environmentInput(fenceGeneration, assertCurrent);
            const readiness = await afterGatewayReady({
              ...finalEnvironment,
              gateway: routingPlan.bootstrap,
              deliveryPlanDigest: proposal.deliveryPlanDigest,
              assertCurrent,
            });
            if (readiness.status !== "ready")
              throw new HostedOperatorError("auth_identity_required");
            const run = createNativeTargetAuthOnlyFinalRouting({
              readCredential: async (authority, installationId) => {
                await assertCurrent();
                if (
                  !isDeepStrictEqual(authority, currentOwner.authority) ||
                  installationId !== plan.project.installationId
                )
                  throw denied();
                return await readInstallation(currentOwner, installationId, plan.project.teamId);
              },
              ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
              assertCatalogApp: finalAuthority.assertCatalogApp,
              store: {
                read: async () => routingStore.read(routingKey),
                compareAndSet: async (revision, record) =>
                  routingStore.compareAndSet(routingKey, revision, record),
              },
              readRetainedParent: async () => {
                await assertCurrent();
                const row = (await readExactDelivery()).retained;
                return row.record.gateway.receipt === undefined ||
                  row.record.app.receipt === undefined
                  ? undefined
                  : { bootstrap: row.record.gateway.receipt, app: row.record.app.receipt };
              },
            });
            const result = await run({
              projection: {
                environment: { ...finalEnvironment, assertCurrent },
                appReceipt: routingPlan.app,
                source: routingPlan.source,
              },
              routingPlanBytes: routingBytes,
              approval: routingApproval,
              fenceGeneration,
              assertCurrent,
            });
            return { ...result, deliveryPlanDigest: proposal.deliveryPlanDigest };
          },
          store: deliveryStore,
          withExecutionLease: async ({ fenceGeneration, assertCurrent }, complete) => {
            const finalEnvironment = environmentInput(fenceGeneration, assertCurrent);
            return await finalAuthority.withGatewayLease(
              {
                environment: finalEnvironment,
                readCurrentFence: async () => {
                  await assertCurrent();
                  const row = await deliveryStore.read(key);
                  if (row?.record.lease === undefined) throw mismatch();
                  return {
                    operationRef: proposal.routingOperationRef,
                    leaseId: row.record.lease.id,
                    fenceGeneration,
                  };
                },
              },
              async (assertFence) => {
                heldRoutingFence = assertFence;
                try {
                  return await complete(assertFence);
                } finally {
                  heldRoutingFence = undefined;
                }
              },
            );
          },
        });
      };
      if (exact.retained.record.finalRoutingPlan !== undefined) {
        const result = await resumeFinal();
        return Response.json(
          !finalAction &&
            result !== null &&
            typeof result === "object" &&
            "status" in result &&
            result.status === "prepared"
            ? {
                ...result,
                finalRoutingPlan: nativeTargetAuthOnlyRoutingRequired(key, exact.retained.record)
                  .finalRoutingPlan,
              }
            : result,
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      if (finalAction) {
        throw mismatch();
      }
      const result = await prepareNativeTargetAuthOnlyDelivery({
        adapter: (effect, assertCurrent, fenceGeneration) =>
          createNativeTargetAuthOnlyPreviewDelivery({
            target: effect,
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
            readCredential: async (authority, installationId) => {
              await assertCurrent();
              if (
                !isDeepStrictEqual(authority, currentOwner.authority) ||
                installationId !== plan.project.installationId
              )
                throw denied();
              return await readInstallation(currentOwner, installationId, plan.project.teamId);
            },
            assertEnvironment: async () => {
              await assertCurrent();
              if (effect === "app") {
                const credential = await readInstallation(
                  currentOwner,
                  plan.project.installationId,
                  plan.project.teamId,
                );
                await assertCurrent();
                const observed = await observeNativeTargetVercelProject({
                  installation: credential.binding,
                  token: credential.token,
                  projectId: exact.plan.target.projectId,
                  name: plan.project.name,
                  settings: plan.project.projectSettings,
                  protection: plan.project.protection,
                  ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
                });
                if (observed.status !== "verified") throw mismatch();
                await assertCurrent();
              }
              await environment({
                authority: structuredClone(currentOwner.authority),
                target: structuredClone(exact.plan.target),
                plan: structuredClone(plan),
                deliveryPlan: structuredClone(exact.plan),
                operationRef,
                approval: structuredClone(approval),
                fenceGeneration,
                effect,
                assertCurrent,
                signal: request.signal,
              });
              await assertCurrent();
            },
          }),
        afterGatewayReady: async ({
          gateway,
          deliveryPlanDigest,
          fenceGeneration,
          assertCurrent,
        }) =>
          await afterGatewayReady({
            authority: structuredClone(currentOwner.authority),
            target: structuredClone(exact.plan.target),
            plan: structuredClone(plan),
            deliveryPlan: structuredClone(exact.plan),
            operationRef,
            approval: structuredClone(approval),
            gateway: structuredClone(gateway),
            deliveryPlanDigest,
            fenceGeneration,
            assertCurrent,
            signal: request.signal,
          }),
        approval,
        assertCurrent: assertApproved,
        key,
        prepareFinalRoutingPlan: async (value) => {
          if (finalAuthority !== undefined)
            return await finalAuthority.preparePlan({
              environment: environmentInput(value.fenceGeneration, value.assertCurrent),
              gateway: value.gateway,
              app: value.app,
              routingOperationRef: randomUUID(),
            });
          if (input.authOnlyPrepareFinalRoutingPlan === undefined) throw unavailable();
          return await input.authOnlyPrepareFinalRoutingPlan(value);
        },
        signal: request.signal,
        store: deliveryStore,
      });
      return Response.json(result, { headers: { "cache-control": "private, no-store" } });
    }
    if (
      rawInput.action === "native-target-auth-only-prepare" ||
      rawInput.action === "native-target-auth-only-approval-read"
    ) {
      const authPrepare =
        rawInput.action === "native-target-auth-only-prepare"
          ? nativeTargetAuthOnlyPrepareRequestSchema.parse(rawInput)
          : rawInput;
      await input.owner.verifyWorkload(request);
      const historyOwner = operatorOwnerContextSchema.parse(authPrepare.ownerContext);
      const currentOwner: Current = {
        adapterGeneration: historyOwner.adapterGeneration,
        adapterSessionId: historyOwner.adapterSessionId,
        authority: historyOwner.authority,
        historyOwner,
        publicSessionId: historyOwner.sessionId,
      };
      const context = {
        authority: currentOwner.authority,
        target: { appId: authPrepare.input.appId, sessionId: currentOwner.publicSessionId },
      };
      const assertCurrentOwner = async (observed: OperatorArtifactContext) => {
        if (!isDeepStrictEqual(observed, context)) {
          throw denied();
        }
        await input.owner.assertCanonicalAppOwner({
          authority: currentOwner.authority,
          ownerContext: historyOwner,
          target: context.target,
        });
      };
      await assertCurrentOwner(context);
      if (input.owner.assertNoStandardBuilderDestination === undefined) {
        throw unavailable();
      }
      await input.owner.assertNoStandardBuilderDestination({
        authority: currentOwner.authority,
        ownerContext: historyOwner,
        target: context.target,
      });
      const planStore = createNativeTargetAuthOnlyPlanStore({ assertCurrentOwner, database });
      const retained = await planStore.read(
        context,
        authPrepare.input.plan.origin.appSpecDigest,
        authPrepare.input.planDigest,
      );
      if (retained === undefined || !isDeepStrictEqual(retained, authPrepare.input.plan)) {
        throw mismatch();
      }
      const workload = {
        authorization: request.headers.get("authorization"),
        signal: request.signal,
      };
      const transport = createNativeTargetApprovalHistoryTransport({
        appId: retained.appId,
        assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
        builderOrigin: input.builderOrigin,
        owner: currentOwner,
        workload,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
      if (transport.observePrivateHistory === undefined) {
        throw unavailable();
      }
      const approvalCheckpoint = createNativeTargetApprovalCheckpoint(
        database,
        currentOwner.authority,
        retained.appId,
        authPrepare.input.planDigest,
        {
          adapterGeneration: currentOwner.adapterGeneration,
          adapterSessionId: currentOwner.adapterSessionId,
          assertCurrent: async () => assertCurrentOwner(context),
        },
        "native-target-auth-only",
      );
      const authDispatchStore = createPostgresNativeTargetAuthOnlyDispatchStore(database);
      const existing = (
        await authDispatchStore.read({
          appId: retained.appId,
          authority: currentOwner.authority,
        })
      )?.state;
      if (existing !== undefined && existing.planDigest !== authPrepare.input.planDigest) {
        throw mismatch();
      }
      const originalApproval =
        existing !== undefined && "approval" in existing ? existing.approval : undefined;
      const approvalCallId =
        originalApproval?.callId ??
        (rawInput.action === "native-target-auth-only-prepare" ? authPrepare.callId : undefined);
      const artifactStore = createPostgresOperatorArtifactStore({
        assertCurrentOwner: async (artifactContext) => {
          await assertCurrentOwner(artifactContext);
        },
        database,
      });
      const artifactPublication = createOperatorArtifactPublication({
        assertCurrentOwner: async (artifactContext) => {
          await assertCurrentOwner(artifactContext);
        },
        store: artifactStore,
      });
      const readSettledApproval = async () => {
        const state = await approvalCheckpoint.read();
        const settled = await readPrivateNativeTargetAuthOnlyApproval({
          assertOwner: async () => {
            await assertCurrentOwner(context);
          },
          callId: approvalCallId,
          historyOwner,
          observation: { save: approvalCheckpoint.save, state },
          owner: currentOwner,
          plan: retained,
          readHistory: async (startIndex, onEvent) =>
            (await transport.observePrivateHistory?.({
              principal: historyOwner.principal,
              adapterSessionId: currentOwner.adapterSessionId,
              sessionId: currentOwner.publicSessionId,
              startIndex,
              onEvent,
            })) ?? { complete: false, nativeTailIndex: startIndex, nextNativeIndex: startIndex },
        });
        if (originalApproval !== undefined && !isDeepStrictEqual(settled, originalApproval)) {
          throw denied();
        }
        return settled;
      };
      if (rawInput.action === "native-target-auth-only-approval-read") {
        const settled = await readSettledApproval();
        return Response.json(
          { status: settled?.outcome === "approved" ? "approved" : "pending" },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      const authSchemaArtifactReader = createAuthOnlySchemaArtifactReader({
        assertCurrentApproval: async (binding) => {
          await assertCurrentOwner(binding.context);
          const currentPlan = await planStore.read(
            binding.context,
            retained.origin.appSpecDigest,
            authPrepare.input.planDigest,
          );
          const settled = await readSettledApproval();
          const currentProfile = resolveNativeTargetResourceProfile({
            base: configuration,
            resourceProfileId: retained.authResource.profileId,
            authority: currentOwner.authority,
            appId: retained.appId,
            environment: input.environment,
          });
          if (
            currentPlan === undefined ||
            !isDeepStrictEqual(currentPlan, retained) ||
            !isDeepStrictEqual(binding.selection, retained.authSchema) ||
            settled === null ||
            settled.outcome !== "approved" ||
            settled.planDigest !== nativeTargetAuthOnlyPlanDigest(retained) ||
            settled.sourceDigest !==
              nativeTargetAuthOnlySchemaEffectDigest(retained, retained.publishedSource) ||
            settled.publicSessionId !== retained.origin.publicSessionId ||
            settled.responderPrincipalId !== retained.origin.authority.ownerUserId ||
            currentProfile.sandbox.authWorker.id !== binding.worker.id ||
            currentProfile.sandbox.authWorker.sha256 !== binding.worker.sha256
          )
            throw denied();
          await assertCurrentOwner(binding.context);
        },
        readAuthPlan: async (artifactContext, selection) =>
          await artifactPublication.readAuthPlan(artifactContext, selection),
      });
      const dispatch = createNativeTargetAuthOnlyDispatch({
        authorize: async (invocation, appId) => {
          if (invocation !== authPrepare || appId !== retained.appId) throw denied();
          await assertCurrentOwner(context);
          return {
            authority: currentOwner.authority,
            ownerUserId: currentOwner.authority.ownerUserId,
            publicSessionId: currentOwner.publicSessionId,
          };
        },
        createProject: async ({ plan, authorizeAttempt, acceptProjectId }) => {
          const credential = await readInstallation(
            currentOwner,
            plan.project.installationId,
            plan.project.teamId,
          );
          const result = await createNativeTargetVercelProject({
            installation: credential.binding,
            token: credential.token,
            name: plan.project.name,
            settings: plan.project.projectSettings,
            protection: plan.project.protection,
            authorizeAttempt,
            acceptProjectId,
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          });
          if (result.status === "verified")
            return { status: "created" as const, projectId: result.projectId };
          if (result.status === "rejected")
            return { status: "rejected" as const, reason: result.reason };
          return {
            status: "uncertain" as const,
            ...("projectId" in result && result.projectId !== undefined
              ? { projectId: result.projectId }
              : {}),
          };
        },
        observeProject: async ({ plan, projectId }) => {
          const credential = await readInstallation(
            currentOwner,
            plan.project.installationId,
            plan.project.teamId,
          );
          const result = await observeNativeTargetVercelProject({
            installation: credential.binding,
            token: credential.token,
            name: plan.project.name,
            settings: plan.project.projectSettings,
            protection: plan.project.protection,
            projectId,
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          });
          return result.status === "verified"
            ? { status: "verified" as const, projectId: result.projectId }
            : { status: "uncertain" as const };
        },
        readApproval: async (invocation, plan) => {
          if (invocation !== authPrepare || !isDeepStrictEqual(plan, retained)) throw denied();
          const settled = await readSettledApproval();
          if (settled === null) return null;
          const currentProfile = resolveNativeTargetResourceProfile({
            base: configuration,
            resourceProfileId: plan.authResource.profileId,
            authority: currentOwner.authority,
            appId: plan.appId,
            environment: input.environment,
          });
          const worker = currentProfile.sandbox.authWorker;
          await authSchemaArtifactReader.read({
            context,
            selection: plan.authSchema,
            worker: { id: worker.id, sha256: worker.sha256 },
          });
          return settled;
        },
        revalidate: async (invocation, plan) => {
          if (invocation !== authPrepare || !isDeepStrictEqual(plan, retained)) throw denied();
          await assertCurrentOwner(context);
          const selected = resolveNativeTargetResourceProfile({
            base: configuration,
            resourceProfileId: plan.authResource.profileId,
            authority: currentOwner.authority,
            appId: plan.appId,
            environment: input.environment,
          });
          const roles = selected.authOnlyApplications?.[plan.appId]?.accessRoles;
          const binding = {
            authDatabase: selected.authDatabase,
            nativeNeon: selected.nativeNeon,
            gateway: {
              projectId: selected.gateway.projectId,
              environment: selected.gateway.environment,
              branch: selected.gateway.branch,
              authBrowserOrigin: selected.gateway.authBrowserOrigin,
              gatewayOrigin: selected.gateway.gatewayOrigin,
              publicOrigin: selected.gateway.publicOrigin,
              workload: selected.gateway.workload,
            },
            operator: {
              projectId: selected.operator.projectId,
              environment: selected.operator.environment,
              origin: selected.operator.origin,
            },
          };
          const profileDigest = nativeTargetAuthOnlyAuthorityDigest({
            authority: currentOwner.authority,
            appId: plan.appId,
            profileId: plan.authResource.profileId,
            authDatabase: selected.authDatabase,
            roles: roles ?? [],
            authorityBinding: binding,
            physicalEndpointId: selected.nativeNeon.scope.endpointId,
          });
          if (
            selected.teamId !== plan.project.teamId ||
            selected.authDatabase.resourceId !== plan.authResource.resourceId ||
            selected.authDatabase.database !== plan.authResource.database ||
            selected.nativeNeon.scope.endpointId !== plan.authResource.endpointId ||
            selected.nativeNeon.scope.hostname !== plan.authResource.hostname ||
            profileDigest !== plan.authResource.authorityDigest ||
            selected.applications[plan.appId]?.nativeTargetRegistration === true
          )
            throw mismatch();
          await readInstallation(currentOwner, plan.project.installationId, plan.project.teamId);
          await assertCurrentOwner(context);
        },
        store: authDispatchStore,
      });
      await dispatch.approve(authPrepare, retained);
      const result = await dispatch.dispatch(authPrepare, retained);
      await assertCurrentOwner(context);
      if (result.status === "created") {
        const registered = await resolveNativeTargetAuthOnlyRegistration({
          appId: retained.appId,
          authority: currentOwner.authority,
          configuration,
          environment: input.environment,
          sessionId: currentOwner.publicSessionId,
          store: authDispatchStore,
        });
        const registration = registered?.authOnlyApplications?.[retained.appId]?.registration;
        if (
          registered === undefined ||
          registration === undefined ||
          registration.projectId !== result.projectId
        ) {
          throw mismatch();
        }
        const resourceBytes = buildNativeTargetAuthOnlyResourcePlanBytes({
          plan: retained,
          registration,
          selected: registered,
        });
        const resourcePlanStore = createNativeTargetAuthOnlyResourcePlanStore({
          assertCurrentOwner,
          database,
        });
        const saved = await resourcePlanStore.writeIfAbsent(
          context,
          authPrepare.input.planDigest,
          resourceBytes,
        );
        const resourceApprovalInput = nativeTargetAuthOnlyResourcePreparationInputSchema.parse({
          appId: retained.appId,
          operationRef: nativeTargetAuthOnlyCredentialOperationRef(retained),
          planDigest: authPrepare.input.planDigest,
          resourcePlan: saved.plan,
          resourcePlanDigest: saved.resourcePlanDigest,
        });
        return Response.json(
          {
            projectId: result.projectId,
            resourceApprovalInput,
            status: "resource-approval-required",
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      return Response.json(nativeTargetAuthOnlyDispatchResultSchema.parse(result), {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (
      rawInput.action === "native-target-auth-only-resource-approval-read" ||
      rawInput.action === "native-target-auth-only-resources"
    ) {
      const requestInput = nativeTargetAuthOnlyResourcePreparationInputSchema.parse(rawInput.input);
      const { appId, operationRef, planDigest, resourcePlanDigest } = requestInput;
      await input.owner.verifyWorkload(request);
      const historyOwner = operatorOwnerContextSchema.parse(rawInput.ownerContext);
      if (rawInput.adapterSessionId !== historyOwner.adapterSessionId) {
        throw denied();
      }
      const currentOwner: Current = {
        adapterGeneration: historyOwner.adapterGeneration,
        adapterSessionId: historyOwner.adapterSessionId,
        authority: historyOwner.authority,
        historyOwner,
        publicSessionId: historyOwner.sessionId,
      };
      const context = artifactContext(currentOwner, appId);
      const ownerRequest = { ...context, ownerContext: historyOwner };
      const assertCurrentOwner = async (observed: OperatorArtifactContext) => {
        if (!isDeepStrictEqual(observed, context)) {
          throw denied();
        }
        await input.owner.assertCanonicalAppOwner(ownerRequest);
        if (input.owner.assertNoStandardBuilderDestination === undefined) {
          throw unavailable();
        }
        await input.owner.assertNoStandardBuilderDestination(ownerRequest);
      };
      await assertCurrentOwner(context);
      const dispatchStore = createPostgresNativeTargetAuthOnlyDispatchStore(database);
      const dispatchKey = { appId, authority: currentOwner.authority };
      const created = (await dispatchStore.read(dispatchKey))?.state;
      if (
        created?.stage !== "created" ||
        created.planDigest !== planDigest ||
        nativeTargetAuthOnlyCredentialOperationRef(created.plan) !== operationRef
      ) {
        throw mismatch();
      }
      const planStore = createNativeTargetAuthOnlyPlanStore({ assertCurrentOwner, database });
      const readRetainedPlan = async () =>
        await planStore.read(context, created.plan.origin.appSpecDigest, planDigest);
      const plan = await readRetainedPlan();
      if (plan === undefined || !isDeepStrictEqual(plan, created.plan)) {
        throw mismatch();
      }
      const resourcePlanStore = createNativeTargetAuthOnlyResourcePlanStore({
        assertCurrentOwner,
        database,
      });
      const readRegisteredResource = async () => {
        await assertCurrentOwner(context);
        const current = await readRetainedPlan();
        const selected = await resolveNativeTargetAuthOnlyRegistration({
          appId,
          authority: currentOwner.authority,
          configuration,
          environment: input.environment,
          sessionId: currentOwner.publicSessionId,
          store: dispatchStore,
        });
        const registration = selected?.authOnlyApplications?.[appId]?.registration;
        const resource = await resourcePlanStore.read(context, planDigest, resourcePlanDigest);
        if (
          !isDeepStrictEqual(current, plan) ||
          selected === undefined ||
          registration === undefined ||
          registration.projectId !== created.projectId ||
          resource === undefined ||
          !isDeepStrictEqual(resource.plan, requestInput.resourcePlan) ||
          !resource.bytes.equals(
            buildNativeTargetAuthOnlyResourcePlanBytes({ plan, registration, selected }),
          )
        ) {
          throw mismatch();
        }
        await assertCurrentOwner(context);
        return { resource, selected };
      };
      const { selected, resource } = await readRegisteredResource();
      const transport = createNativeTargetApprovalHistoryTransport({
        appId,
        assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
        builderOrigin: input.builderOrigin,
        owner: currentOwner,
        workload: { authorization: request.headers.get("authorization"), signal: request.signal },
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      });
      const { observePrivateHistory } = transport;
      if (observePrivateHistory === undefined) {
        throw unavailable();
      }
      const readHistory: Parameters<
        typeof readPrivateNativeTargetAuthOnlyResourceApproval
      >[0]["readHistory"] = async (startIndex, onEvent) =>
        await observePrivateHistory({
          adapterSessionId: currentOwner.adapterSessionId,
          onEvent,
          principal: historyOwner.principal,
          sessionId: currentOwner.publicSessionId,
          startIndex,
        });
      const assertRegistered = async () => {
        await readRegisteredResource();
      };
      const checkpointAuthority = {
        adapterGeneration: currentOwner.adapterGeneration,
        adapterSessionId: currentOwner.adapterSessionId,
        assertCurrent: assertRegistered,
      };
      const resourceCheckpoint = createNativeTargetApprovalCheckpoint(
        database,
        currentOwner.authority,
        appId,
        resourcePlanDigest,
        checkpointAuthority,
        "native-target-auth-only-resources",
      );
      const readResourceApproval = async (
        retainedApproval?: NonNullable<
          Awaited<ReturnType<typeof readPrivateNativeTargetAuthOnlyResourceApproval>>
        >,
      ) => {
        const state = await resourceCheckpoint.read();
        return await readPrivateNativeTargetAuthOnlyResourceApproval({
          assertOwner: assertRegistered,
          historyOwner,
          observation: { save: resourceCheckpoint.save, state },
          operationRef,
          owner: currentOwner,
          plan,
          readHistory,
          resourcePlanBytes: resource.bytes,
          resourcePlanDigest,
          retainedApproval,
        });
      };
      const settledId = nativeTargetApprovalCheckpointId(
        currentOwner.authority,
        appId,
        createHash("sha256")
          .update(
            JSON.stringify(["auth-only-resource-settlement", operationRef, resourcePlanDigest]),
          )
          .digest("hex"),
        "native-target-auth-only-resources",
      );
      const settledPredicate = and(
        eq(builderProvisioningJournals.issuer, currentOwner.authority.issuer),
        eq(builderProvisioningJournals.audience, currentOwner.authority.audience),
        eq(builderProvisioningJournals.workspaceId, currentOwner.authority.workspaceId),
        eq(builderProvisioningJournals.ownerUserId, currentOwner.authority.ownerUserId),
        eq(builderProvisioningJournals.requestId, settledId),
        eq(builderProvisioningJournals.requestDigest, resourcePlanDigest),
      );
      const readOriginalResourceApproval = async () => {
        await assertRegistered();
        const [row] = await database
          .select()
          .from(builderProvisioningJournals)
          .where(settledPredicate)
          .limit(1);
        if (row === undefined) {
          return undefined;
        }
        if (row.state !== "settled") {
          throw mismatch();
        }
        return nativeTargetAuthOnlyApprovalSchema.parse(row.record);
      };
      const resourceApproval = await readResourceApproval(await readOriginalResourceApproval());
      if (resourceApproval?.outcome === "cancelled") {
        throw denied();
      }
      if (rawInput.action === "native-target-auth-only-resource-approval-read") {
        return Response.json(
          { status: resourceApproval === null ? "pending" : "approved" },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      if (resourceApproval === null) {
        throw denied();
      }
      const now = new Date();
      await assertRegistered();
      await database
        .insert(builderProvisioningJournals)
        .values({
          ...currentOwner.authority,
          createdAt: now,
          record: resourceApproval,
          requestDigest: resourcePlanDigest,
          requestId: settledId,
          revision: 1,
          state: "settled",
          updatedAt: now,
        })
        .onConflictDoNothing();
      if (!isDeepStrictEqual(await readOriginalResourceApproval(), resourceApproval)) {
        throw denied();
      }

      const schemaCheckpoint = createNativeTargetApprovalCheckpoint(
        database,
        currentOwner.authority,
        appId,
        planDigest,
        checkpointAuthority,
        "native-target-auth-only",
      );
      const readSchemaApproval = async () => {
        const state = await schemaCheckpoint.read();
        const proof = await readPrivateNativeTargetAuthOnlyApproval({
          assertOwner: assertRegistered,
          callId: created.approval.callId,
          historyOwner,
          observation: { save: schemaCheckpoint.save, state },
          owner: currentOwner,
          plan,
          readHistory,
        });
        if (!isDeepStrictEqual(proof, created.approval)) {
          throw denied();
        }
        return proof;
      };
      const artifactPublication = createOperatorArtifactPublication({
        assertCurrentOwner,
        store: createPostgresOperatorArtifactStore({ database, assertCurrentOwner }),
      });
      const capturedDescriptions = createCapturedAppDescriptionStore({
        assertCurrentOwner,
        database,
      });
      const readCapturedDescription = async () => {
        const description = await capturedDescriptions.read(context, plan.origin.appSpecDigest);
        if (description === undefined || description.backend.kind !== "static") {
          throw mismatch();
        }
        return description;
      };
      const runtimeStore = createPostgresNativeTargetAuthOnlyRuntimeStore(database);
      const runtimeKey = {
        appId,
        authority: currentOwner.authority,
        sessionId: context.target.sessionId,
      };
      const hostedContext = { ...ownerRequest, target: resource.plan.target };
      const profileInput = { configuration, environment: input.environment, plan };
      const credentialContext = nativeTargetAuthOnlyCredentialContextForPlan(profileInput);
      const approvedAuthSchema = resource.plan.authSchema;
      if (!isDeepStrictEqual(approvedAuthSchema, plan.authSchema)) {
        throw mismatch();
      }
      const readinessPlan = {
        authDatabase: resource.plan.authDatabase,
        authSchema: plan.authSchema,
        neon: resource.plan.neon,
      };
      type RuntimeEffect = Parameters<
        Parameters<typeof createNativeTargetAuthOnlyRuntime>[0]["prepareAuthSchema"]
      >[0];
      const bindExecution = async (effect: RuntimeEffect, stage: "dispatching" | "unknown") => {
        const readRuntimeLease = async () => {
          await effect.assertCurrent();
          await assertRegistered();
          const latest = await runtimeStore.read(runtimeKey);
          if (
            latest?.state.stage !== stage ||
            latest.state.planDigest !== planDigest ||
            latest.state.attemptId !== effect.attemptId ||
            latest.state.leaseId !== effect.leaseId
          ) {
            throw new HostedOperatorError("reconciliation_required");
          }
          return latest.revision;
        };
        const revision = await readRuntimeLease();
        const execution = {
          operationRef,
          workerAttemptId: effect.attemptId,
          leaseId: effect.leaseId,
          // Moving an expired or failed lease from dispatching to unknown increments the CAS revision once.
          fenceGeneration: stage === "dispatching" ? revision : revision - 1,
        };
        if (execution.fenceGeneration < 1) {
          throw mismatch();
        }
        const assertCurrent = async () => {
          request.signal.throwIfAborted();
          if ((await readRuntimeLease()) !== revision) {
            throw new HostedOperatorError("reconciliation_required");
          }
        };
        const custody = createNativeTargetAuthOnlyCredentialCustody({
          ...profileInput,
          artifactContext: context,
          assertCurrentOwner: async (observed) => {
            if (!isDeepStrictEqual(observed, context)) throw denied();
            await assertCurrent();
          },
          context: credentialContext,
          database,
          keyring,
          readApproval: readSchemaApproval,
          readRetainedPlan,
        });
        const journal = createAuthOnlyWorkerJournal({
          ...execution,
          appId,
          assertCurrent,
          authority: currentOwner.authority,
          database,
          resourceId: resource.plan.authDatabase.resourceId,
          resourcePlanDigest,
        });
        const readAuthArtifact = async () =>
          await createAuthOnlySchemaArtifactReader({
            assertCurrentApproval: async (binding) => {
              if (!isDeepStrictEqual(binding.context, context)) throw denied();
              await assertCurrent();
              if (!isDeepStrictEqual(await readSchemaApproval(), effect.approval)) throw denied();
            },
            readAuthPlan: artifactPublication.readAuthPlan,
          }).read({
            context,
            selection: plan.authSchema,
            worker: selected.sandbox.authWorker,
          });
        const runResources = async (
          reference: NonNullable<Awaited<ReturnType<typeof custody.findReference>>>,
          inspectOnly: boolean,
        ) => {
          const credentials = await custody.readSecrets(reference);
          const credentialBytes = Buffer.from(JSON.stringify(credentials));
          const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
          const digest = sha256(credentialBytes);
          return await createNativeTargetAuthOnlyMaintenanceReader({
            ...profileInput,
            approval: resourceApproval,
            approvedResourcePlanBytes: resource.bytes,
            assertCurrent: async () => {
              await assertCurrent();
            },
            assertCurrentOwner: async (observed) => {
              if (!isDeepStrictEqual(observed, hostedContext)) throw denied();
              await assertCurrent();
            },
            context: hostedContext,
            execution,
            readCredential: async (authority, installationId) => {
              if (!isDeepStrictEqual(authority, currentOwner.authority)) throw denied();
              return await readInstallation(currentOwner, installationId, plan.project.teamId);
            },
            readRetainedResourceApproval: async () => {
              const { resource: current } = await readRegisteredResource();
              const settled = await readResourceApproval(resourceApproval);
              return settled === null
                ? undefined
                : {
                    plan,
                    approvedResourcePlanBytes: current.bytes,
                    approval: settled,
                  };
            },
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          }).withMaintenanceCredential(async ({ maintenanceUrl }) => {
            const invocation = {
              ...execution,
              approvalDigest: resourcePlanDigest,
              approvedPlanBytes: resource.bytes,
              assertCredentialsCheckpointed: async ({
                approvalDigest,
                resourceId,
                credentialsSha256,
              }: {
                approvalDigest: string;
                resourceId: string;
                credentialsSha256: string;
              }) => {
                if (
                  approvalDigest !== resourcePlanDigest ||
                  resourceId !== resource.plan.authDatabase.resourceId ||
                  credentialsSha256 !==
                    sha256(Buffer.from(JSON.stringify(await custody.readSecrets(reference))))
                )
                  throw mismatch();
              },
              assertCurrent,
              credentials: { bytes: credentialBytes, maintenanceUrl, sha256: digest },
              effectId: resource.plan.effects[0]!.id,
              signal: request.signal,
            };
            return await runAuthResourceFileSpool(
              selected.sandbox,
              inspectOnly
                ? { ...invocation, readbackOnly: true }
                : { ...invocation, bindWorkerContext: journal.bind("resources") },
            );
          });
        };
        const readReadiness = async (
          reference: NonNullable<Awaited<ReturnType<typeof custody.findReference>>>,
        ) => {
          const readiness = await createHostedOperatorAuthReadiness<typeof readinessPlan>({
            assertAuthorized: async () => {
              await assertCurrent();
            },
            readAuthPlan: async () => (await readAuthArtifact()).content,
            readRuntimeUrl: async () => (await custody.read(reference)).runtimeUrl,
          }).verify({ ...hostedContext, assertCurrent, plan: readinessPlan });
          return {
            authSchema: {
              artifactRef: plan.authSchema.artifactRef,
              planDigest: plan.authSchema.planDigest,
              targetDigest: plan.authSchema.targetDigest,
            },
            readiness: readiness.catalogFingerprint,
          };
        };
        return {
          assertCurrent,
          custody,
          execution,
          journal,
          readAuthArtifact,
          readReadiness,
          runResources,
        };
      };
      const runtime = createNativeTargetAuthOnlyRuntime({
        ...profileInput,
        assertCurrentOwner,
        database,
        prepareAuthSchema: async (effect) => {
          const attempt = await bindExecution(effect, "dispatching");
          const reference =
            (await attempt.custody.findReference()) ??
            (await attempt.custody.seal({
              migratorPassword: randomBytes(32).toString("base64url"),
              runtimePassword: randomBytes(32).toString("base64url"),
            }));
          const observed = await attempt.runResources(reference, true);
          if (observed?.status === "absent" || observed?.status === "retryable") {
            await attempt.runResources(reference, false);
            const verified = await attempt.runResources(reference, true);
            if (verified?.status !== "applied")
              throw new HostedOperatorError("reconciliation_required");
          } else if (observed?.status !== "applied") {
            throw new HostedOperatorError("reconciliation_required");
          }
          const artifact = await attempt.readAuthArtifact();
          const { migrationUrl } = await attempt.custody.read(reference);
          await runAuthSchemaFileSpool(selected.sandbox, {
            ...attempt.execution,
            approvedPlanBytes: resource.bytes,
            approvalDigest: resourcePlanDigest,
            authSchemaPlan: artifact,
            credentials: { migrationUrl },
            assertCurrent: attempt.assertCurrent,
            bindWorkerContext: attempt.journal.bind("auth"),
            signal: request.signal,
          });
          return await attempt.readReadiness(reference);
        },
        readApproval: readSchemaApproval,
        readAuthSchemaSelection: async () => plan.authSchema,
        readCapturedDescription,
        readPublishedSource: async () =>
          await readNativeTargetAuthOnlyPublishedSource({
            database,
            context,
            appSpecDigest: plan.origin.appSpecDigest,
            description: await readCapturedDescription(),
            assertCurrentOwner,
          }),
        reconcileAuthSchema: async (effect) => {
          const attempt = await bindExecution(effect, "unknown");
          const reference = await attempt.custody.findReference();
          const schemaBound = (await attempt.journal.read("auth")) !== undefined;
          if (schemaBound) {
            if (reference === null) return { status: "uncertain" };
            try {
              return { status: "prepared", ...(await attempt.readReadiness(reference)) };
            } catch {
              return { status: "uncertain" };
            }
          }
          if (reference === null) {
            return (await attempt.journal.read("resources")) === undefined
              ? { status: "not-applied" }
              : { status: "uncertain" };
          }
          // The schema worker was never allocated. Independently inspect any partial resource effect before retry.
          const observed = await attempt.runResources(reference, true);
          return observed?.status === "applied" ||
            observed?.status === "absent" ||
            observed?.status === "retryable"
            ? { status: "not-applied" }
            : { status: "uncertain" };
        },
        store: runtimeStore,
      });
      const result = await runtime.prepare(context, plan, planDigest);
      if (result.stage !== "prepared") {
        throw unavailable();
      }
      await assertRegistered();
      return Response.json(
        nativeTargetAuthOnlyResourceResultSchema.parse({
          authSchema: result.authSchema,
          readiness: result.readiness,
          resourcePlanDigest,
          status: "prepared",
        }),
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    if (rawInput.action !== "native-target-auth-only-plan") {
      return await nativeTargetService(request, rawInput);
    }
    const authRequest = nativeTargetAuthOnlyPlanRequestSchema.parse(rawInput);
    await input.owner.verifyWorkload(request);
    const historyOwner = operatorOwnerContextSchema.parse(authRequest.ownerContext);
    const target = {
      authority: historyOwner.authority,
      ownerContext: historyOwner,
      target: { appId: authRequest.input.appId, sessionId: historyOwner.sessionId },
    };
    await input.owner.assertCanonicalAppOwner(target);
    if (
      authRequest.adapterSessionId !== historyOwner.adapterSessionId ||
      authRequest.selectedApp.appId !== authRequest.input.appId
    ) {
      throw denied();
    }
    if (input.owner.assertNoStandardBuilderDestination === undefined) {
      throw unavailable();
    }
    await input.owner.assertNoStandardBuilderDestination(target);
    const currentOwner: Current = {
      adapterGeneration: historyOwner.adapterGeneration,
      adapterSessionId: historyOwner.adapterSessionId,
      authority: historyOwner.authority,
      historyOwner,
      publicSessionId: historyOwner.sessionId,
    };
    const context = {
      authority: currentOwner.authority,
      target: { appId: authRequest.input.appId, sessionId: currentOwner.publicSessionId },
    };
    const assertCurrentOwner = async (observed: OperatorArtifactContext) => {
      if (!isDeepStrictEqual(observed, context)) {
        throw denied();
      }
      await input.owner.assertCanonicalAppOwner(target);
    };
    const capturedDescriptions = createCapturedAppDescriptionStore({
      assertCurrentOwner,
      database,
    });
    const planStore = createNativeTargetAuthOnlyPlanStore({ assertCurrentOwner, database });
    const description = await capturedDescriptions.read(
      context,
      authRequest.selectedApp.appSpecDigest,
    );
    if (description === undefined || description.backend.kind !== "static") {
      throw mismatch();
    }
    let selectedConfiguration: HostedOperatorSourceConfiguration;
    try {
      selectedConfiguration = resolveNativeTargetResourceProfile({
        appId: authRequest.input.appId,
        authority: currentOwner.authority,
        base: configuration,
        environment: input.environment,
        resourceProfileId: authRequest.input.authProfileId,
      });
    } catch {
      throw mismatch();
    }
    const configuredAppRoles =
      selectedConfiguration.authOnlyApplications?.[authRequest.input.appId]?.accessRoles;
    if (
      authRequest.input.project.teamId !== selectedConfiguration.teamId ||
      configuredAppRoles === undefined ||
      selectedConfiguration.applications[authRequest.input.appId]?.nativeTargetRegistration === true
    ) {
      throw mismatch();
    }
    await readInstallation(
      currentOwner,
      authRequest.input.project.installationId,
      authRequest.input.project.teamId,
    );
    const authRuntime = createNativeTargetAuthOnlyRuntime({
      assertCurrentOwner: async (artifactContext) => {
        if (
          artifactContext.target.appId !== context.target.appId ||
          artifactContext.target.sessionId !== context.target.sessionId ||
          !isDeepStrictEqual(artifactContext.authority, context.authority)
        )
          throw denied();
        await assertCurrentOwner(context);
      },
      configuration,
      database,
      environment: input.environment,
      prepareAuthSchema: async () => {
        throw unavailable();
      },
      readApproval: async () => null,
      readAuthSchemaSelection: async ({ context: observed, source }) => {
        await assertCurrentOwner(observed);
        if (source.branch !== authRequest.input.branch) throw mismatch();
        const currentProfile = resolveNativeTargetResourceProfile({
          base: configuration,
          resourceProfileId: authRequest.input.authProfileId,
          authority: currentOwner.authority,
          appId: authRequest.input.appId,
          environment: input.environment,
        });
        const proposed = await createHostedOperatorAuthProposal(currentProfile)({
          assertCurrentOwner: async () => {
            await assertCurrentOwner(observed);
          },
          resource: {
            version: 1,
            environment: "preview",
            hostname: currentProfile.nativeNeon.scope.hostname,
            port: 5432,
            database: currentProfile.authDatabase.database,
            schema: "public",
            runtimeRole: currentProfile.authDatabase.runtimeRole,
            migratorRole: currentProfile.authDatabase.migratorRole,
            neon: {
              projectId: currentProfile.nativeNeon.scope.projectId,
              branchId: currentProfile.nativeNeon.scope.branchId,
            },
          },
        });
        const artifactStore = createPostgresOperatorArtifactStore({
          database,
          assertCurrentOwner: async (artifactContext) => {
            await assertCurrentOwner(artifactContext);
          },
        });
        const publication = createOperatorArtifactPublication({
          store: artifactStore,
          assertCurrentOwner: async (artifactContext) => {
            await assertCurrentOwner(artifactContext);
          },
        });
        const artifactRef = await publication.publishAuthPlan({
          ...proposed,
          context: observed,
        });
        const worker = currentProfile.sandbox.authWorker;
        if (worker === undefined) throw unavailable();
        const selected: NativeTargetAuthOnlyPlan["authSchema"] = {
          artifactRef,
          planDigest: proposed.planDigest,
          targetDigest: proposed.targetDigest,
          installer: { reference: worker.id, sha256: worker.sha256 },
        };
        await assertCurrentOwner(observed);
        return selected;
      },
      readCapturedDescription: async () => description,
      readPublishedSource: async () =>
        await readNativeTargetAuthOnlyPublishedSource({
          database,
          context,
          appSpecDigest: authRequest.selectedApp.appSpecDigest,
          description,
          assertCurrentOwner: async () => {
            await assertCurrentOwner(context);
          },
        }),
      reconcileAuthSchema: async () => ({ status: "uncertain" as const }),
    });
    const authPlan = await authRuntime.plan(context, {
      adapterGeneration: currentOwner.adapterGeneration,
      adapterSessionId: currentOwner.adapterSessionId,
      appId: authRequest.input.appId,
      appRole: authRequest.input.appRole,
      appSpecDigest: authRequest.selectedApp.appSpecDigest,
      authProfileId: authRequest.input.authProfileId,
      branch: authRequest.input.branch,
      project: authRequest.input.project,
    });
    await assertCurrentOwner(context);
    const retained = await planStore.record(context, authPlan.plan);
    await assertCurrentOwner(context);
    return Response.json(
      nativeTargetAuthOnlyPlanResponseSchema.parse({
        plan: retained,
        planDigest: nativeTargetAuthOnlyPlanDigest(retained),
        status: "planned",
      }),
      { headers: { "cache-control": "private, no-store" } },
    );
  };
};
