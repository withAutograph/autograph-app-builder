import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- The opened control-plane database uses the complete Drizzle schema.
import type * as databaseSchema from "../db/schema";
import { builderProvisioningJournals } from "../db/schema";
import {
  readPrivateNativeTargetApproval,
  privateNativeTargetApprovalObservationSchema,
} from "../eve/private-native-target-approval";
import type { PrivateNativeTargetApprovalObservation } from "../eve/private-native-target-approval";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import { createBuilderApprovalStreamFetch } from "./hosted-operator-approval-observer";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { HostedOperatorError, operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
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
import type { NativeTargetTransportRequest } from "./native-target-onboarding-transport";
import {
  createNativeTargetVercelProject,
  observeNativeTargetVercelProject,
} from "./native-target-vercel-provider";
import type {
  NativeTargetCapturedRelease,
  NativeTargetPlanRequest,
} from "../agent/native-target-onboarding-runtime";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Current = NativeTargetCurrentOwner & { historyOwner: OperatorOwnerContext };
interface AppOwner {
  verifyWorkload: (request: Request) => Promise<void>;
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

/** Pick an actual configured generic installer capability; never synthesize worker bytes. */
export const selectNativeTargetInstaller = (
  workers: HostedOperatorSourceConfiguration["sandbox"]["workers"],
  appId: string,
) => {
  const configured = workers[appId];
  const compatible = (worker: typeof configured) =>
    worker?.operationScope === "generated-app-release-install-v1" &&
    worker.subcommand === "protected-generated-app-install";
  const worker = compatible(configured) ? configured : Object.values(workers).find(compatible);
  if (worker === undefined) {
    throw unavailable();
  }
  return worker;
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

export const nativeTargetApprovalCheckpointId = (
  authority: Current["authority"],
  appId: string,
  planDigest: string,
) => {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "native-target-approval-observation-v1",
        nativeTargetOnboardingRegistryId(authority, appId),
        planDigest,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const approvalCheckpointRecordSchema = z.strictObject({
  kind: z.literal("native-target-approval-observation"),
  version: z.literal(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  observation: privateNativeTargetApprovalObservationSchema,
});

/** Checkpoint only incomplete native tails. The authenticated stream remains settlement authority. */
export const createNativeTargetApprovalCheckpoint = (
  database: Database,
  authority: Current["authority"],
  appId: string,
  planDigest: string,
) => {
  const requestId = nativeTargetApprovalCheckpointId(authority, appId, planDigest);
  const key = authority;
  const predicate = and(
    eq(builderProvisioningJournals.issuer, key.issuer),
    eq(builderProvisioningJournals.audience, key.audience),
    eq(builderProvisioningJournals.workspaceId, key.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, key.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
  );
  const read = async (): Promise<PrivateNativeTargetApprovalObservation | undefined> => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const parsed = approvalCheckpointRecordSchema.parse(row.record);
    if (row.requestDigest !== planDigest || parsed.planDigest !== planDigest) {
      throw mismatch();
    }
    return parsed.observation;
  };
  const save = async (observation: PrivateNativeTargetApprovalObservation) => {
    const parsed = privateNativeTargetApprovalObservationSchema.parse(observation);
    const value = approvalCheckpointRecordSchema.parse({
      kind: "native-target-approval-observation",
      version: 1,
      planDigest,
      observation: parsed,
    });
    const now = new Date();
    await database
      .insert(builderProvisioningJournals)
      .values({
        ...key,
        requestId,
        requestDigest: planDigest,
        record: value,
        revision: 1,
        state: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const existing = rows[0];
    if (existing === undefined || existing.requestDigest !== planDigest) {
      throw mismatch();
    }
    const previous = approvalCheckpointRecordSchema.parse(existing.record).observation;
    if (isDeepStrictEqual(previous, parsed)) {
      return;
    }
    if (previous.native.nextNativeIndex >= parsed.native.nextNativeIndex) {
      throw unavailable();
    }
    const updated = await database
      .update(builderProvisioningJournals)
      .set({ record: value, revision: existing.revision + 1, updatedAt: now })
      .where(and(predicate, eq(builderProvisioningJournals.revision, existing.revision)))
      .returning({ revision: builderProvisioningJournals.revision });
    if (updated.length !== 1) {
      throw unavailable();
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
    workloadIdentity: { token: () => Promise.resolve(carrier.slice(7)) },
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
  });
};

export const createNativeTargetOnboardingDeployment = (input: {
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
    if (historyOwner.adapterSessionId !== request.adapterSessionId) {
      throw denied();
    }
    return {
      authority: historyOwner.authority,
      publicSessionId: historyOwner.sessionId,
      adapterSessionId: historyOwner.adapterSessionId,
      adapterGeneration: historyOwner.adapterGeneration,
      historyOwner,
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
    const artifactStore = createPostgresOperatorArtifactStore({ database, assertCurrentOwner });
    const selections = createPostgresOperatorArtifactSelections({ database, assertCurrentOwner });
    const selection = await selections.read(context, appSpecDigest);
    if (
      selection === undefined ||
      selection.appId !== appId ||
      selection.appSpecDigest !== appSpecDigest
    ) {
      throw mismatch();
    }
    const publication = createOperatorArtifactPublication({
      store: artifactStore,
      assertCurrentOwner,
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
        id: selection.releaseId,
        artifactRef: selection.artifactRef,
        manifestSha256: selection.manifestSha256,
        schemaSha256: selection.schemaSha256,
      },
    };
  };
  const readInstallation = async (owner: Current, installationId: string, teamId: string) => {
    const credential = await readActiveVercelInstallationToken({
      database,
      config: keyring,
      authority: owner.authority,
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
    assertNoConfiguredNativeTarget(configuration.applications, proposal.appId);
    if (proposal.project.teamId !== configuration.teamId) {
      throw mismatch();
    }
    await readInstallation(owner, proposal.project.installationId, proposal.project.teamId);
    const worker = selectNativeTargetInstaller(configuration.sandbox.workers, proposal.appId);
    const nativeNeon = configuration.nativeNeon;
    return nativeTargetOnboardingPlanSchema.parse({
      version: 1,
      appId: proposal.appId,
      origin: {
        publicSessionId: owner.publicSessionId,
        adapterSessionId: owner.adapterSessionId,
        adapterGeneration: owner.adapterGeneration,
        appSpecDigest: source.appSpecDigest,
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
        ownership: "current-owner",
        description:
          "Vercel Preview usage is billed to the approved team under its current plan; no fixed credit purchase or subscription upgrade is included.",
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
    );
    const observation = await checkpoint.read();
    const transport = createNativeTargetApprovalHistoryTransport({
      builderOrigin: input.builderOrigin,
      owner,
      appId: record.appId,
      workload,
      assertCanonicalAppOwner: input.owner.assertCanonicalAppOwner,
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
          principal: owner.historyOwner.principal,
          adapterSessionId: owner.adapterSessionId,
          sessionId: owner.publicSessionId,
          startIndex,
          onEvent,
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
  return createNativeTargetOnboardingService({
    store,
    verifyWorkload: input.owner.verifyWorkload,
    authorize,
    readCapturedRelease,
    resolvePlan,
    readApproval,
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
  });
};
