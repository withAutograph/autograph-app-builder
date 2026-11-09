import type { AppDescription } from "../repository/app-description";
import { isDeepStrictEqual } from "node:util";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { RepositoryProductionStore } from "./repository-production-setup";
import {
  repositoryProductionOperationRef,
  repositoryProductionScopeSchema,
} from "./repository-production-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import { RepositoryProductionDestinationRequiredError } from "./repository-production-destination";

export interface ManagementProfile {
  workspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  projectId: string;
  organization: { id: string; name: string };
  publicOrigin: string;
}
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
        const savedOwner = row.record.ownerContext;
        const changed = [
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
          row.record.approval?.planDigest !==
          repositoryProductionApprovalDigest(scope, row.record.intent)
        ) {
          throw new Error("repository_production_approval_required");
        }
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
