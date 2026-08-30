import { randomUUID } from "node:crypto";

import type { VercelIntegrationConfig } from "../integrations/vercel-installation";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionResultSchema,
  vercelProvisionResultSchema,
  type BuilderProvisionRequest,
  type BuilderProvisionResponse,
} from "./contracts";
import type { GitHubProvisioningConfig } from "./github-provider";
import { provisionGitHubRepository } from "./github-provider";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import {
  updateBuilderProvisionJournal,
  type BuilderProvisionAuthority,
  type BuilderProvisionJournalStore,
} from "./journal";
import type { StarterSourceConfig } from "./starter-source";
import { loadStarterSource } from "./starter-source";
import { provisionVercelProject } from "./vercel-provider";

type VercelCredential = {
  binding: {
    installationId: string;
    scopeId: string;
    scopeType: "team" | "user";
    displayName: string;
    slug: string;
    plan: string;
    active: boolean;
    updatedAt: Date;
  };
  token: string;
};

export interface BuilderProvisioningDependencies {
  journal: BuilderProvisionJournalStore;
  githubInstallations: HostedGitHubInstallationStore;
  githubCredentials: GitHubUserCredentialStore;
  githubConfig: GitHubProvisioningConfig;
  starterConfig: StarterSourceConfig;
  vercelConfig: VercelIntegrationConfig;
  readVercelCredential(input: {
    authority: BuilderProvisionAuthority;
    installationId: string;
  }): Promise<VercelCredential | undefined>;
  deactivateVercelInstallation(
    installationId: string,
    now: Date,
  ): Promise<number>;
  fetch?: typeof fetch;
  now?: () => number;
  leaseId?: () => string;
}

const LEASE_MS = 15 * 60_000;

function sameIntent(
  request: BuilderProvisionRequest,
  stored: Omit<BuilderProvisionRequest, "operation">,
) {
  return (
    builderProvisionRequestDigest(request) ===
    builderProvisionRequestDigest({ ...stored, operation: request.operation })
  );
}

export async function executeBuilderProvisioning(input: {
  authority: BuilderProvisionAuthority;
  request: unknown;
  dependencies: BuilderProvisioningDependencies;
}): Promise<BuilderProvisionResponse> {
  const request = builderProvisionRequestSchema.parse(input.request);
  const now = input.dependencies.now ?? Date.now;
  const reserved = await input.dependencies.journal.reserve({
    authority: input.authority,
    request,
    now: new Date(now()),
  });
  if (!sameIntent(request, reserved.record.request))
    throw new Error("provision-request-id-reused");
  const existing = reserved.record.response[request.operation];
  if (existing.status === "succeeded") return reserved.record.response;

  const leaseId = (input.dependencies.leaseId ?? randomUUID)();
  const leased = await updateBuilderProvisionJournal({
    store: input.dependencies.journal,
    authority: input.authority,
    requestId: request.requestId,
    now,
    update(current) {
      const operation = current.operations[request.operation];
      if (
        operation.leaseId &&
        operation.leaseExpiresAt &&
        Date.parse(operation.leaseExpiresAt) > now()
      )
        return current;
      operation.leaseId = leaseId;
      operation.leaseExpiresAt = new Date(now() + LEASE_MS).toISOString();
      return current;
    },
  });
  if (leased.record.operations[request.operation].leaseId !== leaseId)
    return leased.record.response;

  const persist = async (kind: "candidate" | "absent", candidate: string) => {
    await updateBuilderProvisionJournal({
      store: input.dependencies.journal,
      authority: input.authority,
      requestId: request.requestId,
      now,
      update(current) {
        const values =
          kind === "candidate"
            ? current.operations[request.operation].candidates
            : current.operations[request.operation].absentCandidates;
        if (!values.includes(candidate)) values.push(candidate);
        return current;
      },
    });
  };

  let result: BuilderProvisionResponse[typeof request.operation];
  if (request.operation === "github") {
    const bindings =
      (await input.dependencies.githubInstallations.list?.(input.authority)) ??
      [];
    const installation = bindings.find(
      (binding) =>
        binding.installationId === request.providers.githubInstallationId &&
        binding.active,
    );
    if (!installation) {
      result = {
        status: "failed",
        code: "installation_inactive",
        retryable: true,
      };
    } else {
      try {
        const source = await loadStarterSource({
          config: input.dependencies.starterConfig,
          fetch: input.dependencies.fetch,
        });
        const current = await input.dependencies.journal.read({
          authority: input.authority,
          requestId: request.requestId,
        });
        if (!current) throw new Error("provision-journal-missing");
        result = await provisionGitHubRepository({
          config: input.dependencies.githubConfig,
          authority: input.authority,
          installation,
          credentialStore: input.dependencies.githubCredentials,
          requestId: request.requestId,
          requestedName: request.repository.name,
          private: request.repository.private,
          source,
          persistedCandidates: current.record.operations.github.candidates,
          persistedAbsentCandidates:
            current.record.operations.github.absentCandidates,
          persistCandidate: (candidate) => persist("candidate", candidate),
          persistAbsent: (candidate) => persist("absent", candidate),
          fetch: input.dependencies.fetch,
          now,
        });
      } catch (error) {
        result = {
          status: "failed",
          code:
            error instanceof Error && error.message.includes("mismatch")
              ? "source_mismatch"
              : "source_unavailable",
          retryable: true,
        };
      }
    }
  } else {
    const current = await input.dependencies.journal.read({
      authority: input.authority,
      requestId: request.requestId,
    });
    if (!current) throw new Error("provision-journal-missing");
    const credential = await input.dependencies.readVercelCredential({
      authority: input.authority,
      installationId: request.providers.vercelInstallationId!,
    });
    if (!credential?.binding.active) {
      result = {
        status: "failed",
        code: "installation_inactive",
        retryable: true,
      };
    } else {
      result = await provisionVercelProject({
        installation: credential.binding,
        token: credential.token,
        appId: current.record.response.appId,
        github: current.record.response.github,
        githubSelected: request.providers.githubInstallationId !== undefined,
        persistedCandidates: current.record.operations.vercel.candidates,
        persistedAbsentCandidates:
          current.record.operations.vercel.absentCandidates,
        persistCandidate: (candidate) => persist("candidate", candidate),
        persistAbsent: (candidate) => persist("absent", candidate),
        fetch: input.dependencies.fetch,
      });
      if (
        result.status === "failed" &&
        result.code === "credential_unavailable"
      ) {
        await input.dependencies.deactivateVercelInstallation(
          credential.binding.installationId,
          new Date(now()),
        );
      }
    }
  }

  const completed = await updateBuilderProvisionJournal({
    store: input.dependencies.journal,
    authority: input.authority,
    requestId: request.requestId,
    now,
    update(current) {
      if (request.operation === "github")
        current.response.github = githubProvisionResultSchema.parse(result);
      else current.response.vercel = vercelProvisionResultSchema.parse(result);
      if (
        request.operation === "github" &&
        result.status === "succeeded" &&
        current.response.vercel.status === "skipped" &&
        current.response.vercel.code === "github_required"
      ) {
        current.response.vercel = {
          status: "failed",
          code: "provider_unavailable",
          retryable: true,
        };
        current.operations.vercel.attempted = false;
      }
      current.operations[request.operation].attempted = true;
      delete current.operations[request.operation].leaseId;
      delete current.operations[request.operation].leaseExpiresAt;
      return current;
    },
  });
  return builderProvisionResponseSchema.parse(completed.record.response);
}

export async function readBuilderProvisioning(input: {
  authority: BuilderProvisionAuthority;
  requestId: string;
  journal: BuilderProvisionJournalStore;
}) {
  const row = await input.journal.read({
    authority: input.authority,
    requestId: input.requestId,
  });
  return row?.record.response;
}
