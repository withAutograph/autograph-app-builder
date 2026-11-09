import type { HostedEveStore } from "../eve/hosted-store";
import { attachBuilderDestinationRecord, toDurableHostedSessionRecord } from "../eve/hosted-store";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { parseRepositoryReference } from "../integrations/repository-access";
import type { RepositoryAccessResult } from "../integrations/repository-access";
import type { BuilderDestinationEpoch } from "./builder-session-destination-contract";
import { existingRepositoryDestinationSchema } from "./builder-session-destination-contract";

/** Selecting a readable repository records intent, without provisioning or publishing anything. */
export const createExistingRepositoryDestinationSelector =
  (ports: {
    sessions: Pick<HostedEveStore, "getSession" | "attachBuilderDestination">;
    assertMember: (principal: HostedPrincipal) => Promise<void>;
    classify: (input: {
      repository: string;
      selectedInstallationId?: string;
    }) => Promise<RepositoryAccessResult>;
  }) =>
  async (input: {
    principal: HostedPrincipal;
    sessionId: string;
    expected: BuilderDestinationEpoch;
    repository: string;
    selectedInstallationId?: string;
  }) => {
    await ports.assertMember(input.principal);
    const stored = await ports.sessions.getSession(input.principal, input.sessionId);
    if (stored === null || ports.sessions.attachBuilderDestination === undefined) {
      throw new Error("This build is unavailable.");
    }
    const session = toDurableHostedSessionRecord(stored);
    if (session.appId === undefined) {
      throw new Error("Choose an app first.");
    }
    const repository = parseRepositoryReference(input.repository).fullName;
    const access = await ports.classify({
      repository,
      selectedInstallationId: input.selectedInstallationId,
    });
    if (access.status === "authorization-required") {
      const returnTo = `/builds/${encodeURIComponent(input.sessionId)}/destination?repository=${encodeURIComponent(repository)}`;
      return {
        status: "pending" as const,
        message: `Connect GitHub and grant access to ${repository}, then continue this saved build.`,
        connectionUrl: `/github/installations?returnTo=${encodeURIComponent(returnTo)}`,
      };
    }
    if (access.status === "scope-selection-required") {
      return {
        status: "pending" as const,
        message: "Choose the connected GitHub account for this repository.",
      };
    }
    if (access.status !== "ready") {
      return {
        status: "error" as const,
        message: "GitHub could not confirm repository access. Your build is saved; try again.",
      };
    }
    const destination = existingRepositoryDestinationSchema.parse({
      kind: "existing-repository",
      version: 1,
      appId: session.appId,
      repository: {
        repositoryId: access.repository.repositoryId,
        owner: access.repository.owner,
        name: access.repository.name,
        defaultBranch: access.repository.defaultBranch,
      },
      installationId: access.scope.installationId,
      confirmedByCallId: `destination:${input.sessionId}`,
    });
    // Validate the same owner epoch before the durable store's atomic recheck.
    attachBuilderDestinationRecord(session, {
      expected: input.expected,
      destination,
      nowEpochMs: Date.now(),
    });
    await ports.assertMember(input.principal);
    await ports.sessions.attachBuilderDestination({
      principal: input.principal,
      sessionId: input.sessionId,
      expected: input.expected,
      destination,
      nowEpochMs: Date.now(),
    });
    return {
      status: "ready" as const,
      message: `Delivery repository saved: ${repository}. Return to the build to continue.`,
    };
  };
