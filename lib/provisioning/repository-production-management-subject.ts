import type { AppDescription } from "../repository/app-description";
import { isDeepStrictEqual } from "node:util";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
  RepositoryProductionRow,
} from "./repository-production-contract";
import type { RepositoryProductionStore } from "./repository-production-setup";
import {
  repositoryProductionOperationRef,
  repositoryProductionScopeSchema,
} from "./repository-production-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import { RepositoryProductionDestinationRequiredError } from "./repository-production-destination";
import { HostedOperatorError } from "./hosted-operator-contract";
import { isExistingRepositoryDestination } from "./builder-session-destination-contract";
import type { BuilderSessionDestination } from "./builder-session-destination-contract";
import type { EveSessionStatus } from "../mcp/contracts";
import type { HostedPrincipal } from "../eve/hosted-auth";

export interface ManagementProfile {
  workspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  projectId: string;
  organization: { id: string; name: string };
  publicOrigin: string;
}

/** Canonical identity metadata only; observation does not consume a Build or setup grant. */
export interface RepositoryProductionObservationSession {
  adapterSessionId: string;
  adapterGeneration: number;
  appId?: string;
  builderDestination?: BuilderSessionDestination;
  cancellationRevision?: number;
  resumedCancellationRevision?: number;
  status: EveSessionStatus;
}
export interface RepositoryProductionObservationSubject {
  scope: RepositoryProductionScope;
  entryPath?: string;
  assertCurrentOwner: () => Promise<void>;
}

interface CanonicalObservationSession extends RepositoryProductionObservationSession {
  principal: HostedPrincipal;
  sourceHandoffId?: string;
  nativeRecoveryBinding?: { logicalSessionId: string };
}
const sameObservationPrincipal = (left: HostedPrincipal, right: HostedPrincipal) =>
  (["issuer", "audience", "workspaceId", "ownerUserId"] as const).every(
    (field) => left[field] === right[field],
  ) &&
  isDeepStrictEqual([...new Set(left.scopes)].toSorted(), [...new Set(right.scopes)].toSorted());

const assertObservationSession = (
  session: RepositoryProductionObservationSession,
  owner: RepositoryProductionRequestOwner,
) => {
  const cancellationRevision = session.cancellationRevision ?? 0;
  const resumedCancellationRevision = session.resumedCancellationRevision ?? 0;
  if (
    session.appId !== owner.appId ||
    session.status === "cancelled" ||
    cancellationRevision !== resumedCancellationRevision
  ) {
    throw new HostedOperatorError("authorization_required");
  }
};

/** Preserve canonical app authority while reading the current physical owner's actual Stop epoch. */
export const readRepositoryProductionObservationSession = async (
  owner: RepositoryProductionRequestOwner,
  ports: {
    readCanonical: (
      owner: RepositoryProductionRequestOwner,
    ) => Promise<CanonicalObservationSession>;
    readCurrent: (
      owner: RepositoryProductionRequestOwner,
      logicalSessionId: string,
    ) => Promise<CanonicalObservationSession>;
  },
): Promise<RepositoryProductionObservationSession> => {
  const canonical = await ports.readCanonical(owner);
  if (canonical.appId !== undefined && canonical.appId !== owner.appId) {
    throw new HostedOperatorError("authorization_required");
  }
  const current = await ports.readCurrent(
    owner,
    canonical.nativeRecoveryBinding?.logicalSessionId ?? canonical.adapterSessionId,
  );
  const sameAdapter =
    current.adapterSessionId === canonical.adapterSessionId &&
    current.adapterGeneration === canonical.adapterGeneration;
  if (
    !sameAdapter ||
    current.appId !== canonical.appId ||
    current.sourceHandoffId !== canonical.sourceHandoffId ||
    !sameObservationPrincipal(current.principal, canonical.principal)
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  // The canonical reader may prove a legacy handoff's app through its saved intent.
  const projected = {
    adapterSessionId: current.adapterSessionId,
    adapterGeneration: current.adapterGeneration,
    appId: current.appId ?? owner.appId,
    builderDestination: current.builderDestination ?? canonical.builderDestination,
    cancellationRevision: current.cancellationRevision,
    resumedCancellationRevision: current.resumedCancellationRevision,
    status: current.status,
  };
  assertObservationSession(projected, owner);
  return projected;
};

const observationRepository = (session: RepositoryProductionObservationSession) => {
  const destination = session.builderDestination;
  return destination !== undefined && isExistingRepositoryDestination(destination)
    ? {
        appId: destination.appId,
        repositoryId: destination.repository.repositoryId,
        repositoryFullName: `${destination.repository.owner}/${destination.repository.name}`,
      }
    : undefined;
};
const observationOwnerEpoch = (session: RepositoryProductionObservationSession) => ({
  adapterSessionId: session.adapterSessionId,
  adapterGeneration: session.adapterGeneration,
  cancellationRevision: session.cancellationRevision ?? 0,
  repository: observationRepository(session),
});

/** Resolve saved destinations for read-only native availability. */
export const createRepositoryProductionObservationResolver =
  (deps: {
    repositories: readonly ManagementProfile[];
    readSession: (
      owner: RepositoryProductionRequestOwner,
    ) => Promise<RepositoryProductionObservationSession>;
    store: Pick<RepositoryProductionStore, "read">;
    canObserveSavedSetup?: (
      owner: RepositoryProductionRequestOwner,
      scope: RepositoryProductionScope,
      row: RepositoryProductionRow,
    ) => Promise<boolean>;
  }) =>
  async (
    owner: RepositoryProductionRequestOwner,
  ): Promise<RepositoryProductionObservationSubject | undefined> => {
    const initial = await deps.readSession(owner);
    assertObservationSession(initial, owner);
    const epoch = observationOwnerEpoch(initial);
    const selected = observationRepository(initial);
    if (selected !== undefined && selected.appId !== owner.appId) {
      throw new HostedOperatorError("authorization_required");
    }
    const assertCurrentOwner = async () => {
      const current = await deps.readSession(owner);
      assertObservationSession(current, owner);
      if (!isDeepStrictEqual(observationOwnerEpoch(current), epoch)) {
        throw new HostedOperatorError("authorization_required");
      }
    };
    const profiles = deps.repositories.filter(
      (profile) =>
        profile.workspaceId === owner.ownerContext.authority.workspaceId &&
        (selected === undefined ||
          (profile.repositoryId === selected.repositoryId &&
            profile.repositoryFullName === selected.repositoryFullName)),
    );
    const saved = await Promise.all(
      profiles.map(async (profile) => {
        const scope = repositoryProductionScopeSchema.parse({
          authority: owner.ownerContext.authority,
          appId: owner.appId,
          repositoryId: profile.repositoryId,
          repositoryFullName: profile.repositoryFullName,
          projectId: profile.projectId,
          organizationId: profile.organization.id,
          publicOrigin: profile.publicOrigin,
          environment: "production",
        });
        const row = await deps.store.read(scope);
        await assertCurrentOwner();
        if (row !== undefined) {
          const savedSessionId = row.record.intent.sessionId;
          const savedOwner = row.record.ownerContext;
          const savedOwnerMatches =
            savedOwner === undefined ||
            (savedOwner.sessionId === savedSessionId &&
              isDeepStrictEqual(savedOwner.authority, owner.ownerContext.authority));
          if (!isDeepStrictEqual(row.record.scope, scope) || !savedOwnerMatches) {
            throw new HostedOperatorError("authorization_required");
          }
          if (savedSessionId !== owner.sessionId) {
            if (
              savedOwner === undefined ||
              row.operationRef !== repositoryProductionOperationRef(scope) ||
              (await deps.canObserveSavedSetup?.(owner, scope, row)) !== true
            ) {
              throw new HostedOperatorError("authorization_required");
            }
            await assertCurrentOwner();
          }
        }
        return { row, scope };
      }),
    );
    const candidates = saved.filter(({ row }) => row !== undefined);
    const eligible = candidates.length === 0 && selected !== undefined ? saved : candidates;
    await assertCurrentOwner();
    if (eligible.length !== 1) {
      return undefined;
    }
    const [{ row, scope }] = eligible;
    const subject: RepositoryProductionObservationSubject = { scope, assertCurrentOwner };
    if (row?.record.intent.entryPath !== undefined) {
      subject.entryPath = row.record.intent.entryPath;
    }
    return subject;
  };
export type RepositoryProductionCapture = Awaited<
  ReturnType<ReturnType<typeof createOperatorArtifactPublication>["readGeneratedRelease"]>
>;
export interface RepositoryProductionManagementSubject<Profile extends ManagementProfile> {
  assertCurrentOwner: () => Promise<void>;
  capture?: RepositoryProductionCapture;
  description?: AppDescription;
  publishedDescription?: boolean;
  intent: RepositoryProductionIntent;
  owner: RepositoryProductionRequestOwner;
  profile: Profile;
  scope: RepositoryProductionScope;
}
export interface ManagementResolverDependencies<Profile extends ManagementProfile> {
  repositories: readonly Profile[];
  readSession: (owner: RepositoryProductionRequestOwner) => Promise<void>;
  store: Pick<RepositoryProductionStore, "read">;
  resolveCurrent: (
    owner: RepositoryProductionRequestOwner,
  ) => Promise<RepositoryProductionManagementSubject<Profile>>;
  readCapture: (
    context: OperatorArtifactContext,
    storage: Extract<RepositoryProductionIntent["storage"], { kind: "postgres" }>,
    assertCurrentOwner: () => Promise<void>,
    owner: RepositoryProductionRequestOwner,
  ) => Promise<RepositoryProductionCapture>;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const routingUnavailable = (error: unknown) => {
  if (error instanceof RepositoryProductionDestinationRequiredError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
  return (
    message === "repository_production_source_unavailable" ||
    message === "repository_production_capture_unavailable"
  );
};

/** Fresh saved intent/approval authority shared by management and completion acknowledgement. */
export const assertRepositoryProductionManagementRecord = (
  owner: RepositoryProductionRequestOwner,
  scope: RepositoryProductionScope,
  row: RepositoryProductionRow,
): void => {
  const savedOwner = row.record.ownerContext;
  const changed = [
    owner.appId !== scope.appId,
    !isDeepStrictEqual(scope.authority, owner.ownerContext.authority),
    !isDeepStrictEqual(row.record.scope, scope),
    row.operationRef !== repositoryProductionOperationRef(scope),
    row.record.intent.sessionId !== owner.sessionId,
    savedOwner?.sessionId !== owner.sessionId,
    !isDeepStrictEqual(savedOwner?.authority, owner.ownerContext.authority),
  ].some(Boolean);
  if (changed) {
    throw new Error("repository_production_owner_changed");
  }
  if (
    row.record.approval?.planDigest !== repositoryProductionApprovalDigest(scope, row.record.intent)
  ) {
    throw new Error("repository_production_approval_required");
  }
};

/** Metadata-only proof; never loads immutable release content or performs setup effects. */
export const readRepositoryProductionManagementRecord = async (
  deps: Pick<ManagementResolverDependencies<ManagementProfile>, "readSession" | "store">,
  owner: RepositoryProductionRequestOwner,
  scope: RepositoryProductionScope,
): Promise<RepositoryProductionRow> => {
  await deps.readSession(owner);
  const row = await deps.store.read(scope);
  if (row === undefined) {
    throw new Error("repository_production_setup_required");
  }
  assertRepositoryProductionManagementRecord(owner, scope, row);
  await deps.readSession(owner);
  return row;
};

/** Saved app management retains approved effects; a new draft is only planning input. */
export const createRepositoryProductionManagementResolver =
  <Profile extends ManagementProfile>(deps: ManagementResolverDependencies<Profile>) =>
  async (
    owner: RepositoryProductionRequestOwner,
  ): Promise<RepositoryProductionManagementSubject<Profile>> => {
    await deps.readSession(owner);
    const assertCurrentOwner = async () => {
      await deps.readSession(owner);
    };
    const retained = await Promise.all(
      deps.repositories.map(async (profile) => {
        if (profile.workspaceId !== owner.ownerContext.authority.workspaceId) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Unconfigured workspace profiles have no owned setup candidate.
          return undefined;
        }
        const scope = repositoryProductionScopeSchema.parse({
          authority: owner.ownerContext.authority,
          appId: owner.appId,
          repositoryId: profile.repositoryId,
          repositoryFullName: profile.repositoryFullName,
          projectId: profile.projectId,
          organizationId: profile.organization.id,
          publicOrigin: profile.publicOrigin,
          environment: "production",
        });
        const row = await deps.store.read(scope);
        if (!row) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing setup is the optional store-read result.
          return undefined;
        }
        assertRepositoryProductionManagementRecord(owner, scope, row);
        return { profile, row, scope };
      }),
    );
    const candidates = retained.filter((candidate) => candidate !== undefined);
    await assertCurrentOwner();
    if (candidates.length === 0) {
      return await deps.resolveCurrent(owner);
    }
    if (candidates.length !== 1) {
      throw new Error("repository_production_state_unavailable");
    }
    const [{ profile, row, scope }] = candidates;
    const intent = structuredClone(row.record.intent);
    const subject: RepositoryProductionManagementSubject<Profile> = {
      assertCurrentOwner,
      intent,
      owner,
      profile,
      scope,
    };
    if (intent.storage.kind === "postgres") {
      const context = {
        authority: scope.authority,
        target: { appId: scope.appId, sessionId: intent.sessionId },
      };
      const capture = await deps.readCapture(context, intent.storage, assertCurrentOwner, owner);
      const { description } = capture;
      subject.capture = capture;
      if (description) {
        if (description.backend.kind !== "generated-postgres") {
          throw new Error("repository_production_capture_unavailable");
        }
        const mismatch = [
          description.app.id !== scope.appId,
          description.backend.release.id !== intent.storage.releaseId,
          description.backend.runtime.databaseEnvironment !== intent.storage.databaseEnvironment,
        ].some(Boolean);
        if (mismatch) {
          throw new Error("repository_production_capture_unavailable");
        }
        subject.description = description;
      }
    } else {
      try {
        const current = await deps.resolveCurrent(owner);
        const samePublishedScope =
          isDeepStrictEqual(current.scope, scope) &&
          current.intent.storage.kind === "none" &&
          current.publishedDescription === true;
        if (
          samePublishedScope &&
          current.description?.app.id === scope.appId &&
          current.description.backend.kind === "static"
        ) {
          subject.description = current.description;
        }
      } catch (error) {
        if (!routingUnavailable(error)) {
          throw error;
        }
      }
    }
    await assertCurrentOwner();
    return subject;
  };
