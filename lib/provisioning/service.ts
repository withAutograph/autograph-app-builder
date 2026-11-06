import { randomInt, randomUUID } from "node:crypto";

import type { VercelIntegrationConfig } from "../integrations/vercel-installation";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionResultSchema,
  vercelProvisionResultSchema,
} from "./contracts";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts";
import type { GitHubProvisioningConfig } from "./github-provider";
import { provisionGitHubRepository } from "./github-provider";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import { updateBuilderProvisionJournal } from "./journal";
import type {
  BuilderProvisionAuthority,
  BuilderProvisionJournalRow,
  BuilderProvisionJournalStore,
} from "./journal";
import { cloneStarterSource } from "./starter-source";
import type { StarterSource } from "./starter-source";
import { provisionVercelProject } from "./vercel-provider";

interface VercelCredential {
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
}

export interface BuilderProvisioningDependencies {
  /** Current saved-session owner/epoch, checked again by each provider write lease. */
  assertCurrent?: () => Promise<void>;
  /** Current saved-session owner/epoch, checked again by each provider write lease. */

  journal: BuilderProvisionJournalStore;
  githubInstallations: HostedGitHubInstallationStore;
  githubCredentials: GitHubUserCredentialStore;
  githubConfig: GitHubProvisioningConfig;
  /** Test-only seam; production always resolves the canonical clone. */
  loadStarterSource?: () => Promise<StarterSource>;
  vercelConfig: VercelIntegrationConfig;
  readVercelCredential: (input: {
    authority: BuilderProvisionAuthority;
    installationId: string;
  }) => Promise<VercelCredential | undefined>;
  deactivateVercelInstallation: (installationId: string, now: Date) => Promise<number>;
  fetch?: typeof fetch;
  now?: () => number;
  leaseId?: () => string;
}

const LEASE_MS = 15 * 60_000;
const LEASE_LOST = "provision-lease-lost";

function shouldRenewVercelInstallation(result: BuilderProvisionResponse["vercel"]) {
  return result.status === "failed" && result.code === "credential_unavailable";
}

function acquireProvisionLease(
  current: BuilderProvisionJournalRow["record"],
  operationName: "github" | "vercel",
  leaseId: string,
  now: () => number,
) {
  const operation = current.operations[operationName];
  const hasLease = operation.leaseId !== undefined && operation.leaseId !== "";
  const hasExpiry = operation.leaseExpiresAt !== undefined && operation.leaseExpiresAt !== "";
  if (hasLease && hasExpiry && Date.parse(operation.leaseExpiresAt) > now()) {
    return false;
  }
  operation.leaseId = leaseId;
  operation.leaseExpiresAt = new Date(now() + LEASE_MS).toISOString();
  return true;
}

function isExpiredLease(
  leaseId: string | undefined,
  expiresAt: string | undefined,
  attempted: boolean,
  now: number,
) {
  if (leaseId === undefined || leaseId === "" || expiresAt === undefined || expiresAt === "") {
    return false;
  }
  return Date.parse(expiresAt) <= now && !attempted;
}

function finalizeProvisionOperation(
  current: BuilderProvisionJournalRow["record"],
  operation: "github" | "vercel",
  result: BuilderProvisionResponse["github"] | BuilderProvisionResponse["vercel"],
  now: () => number,
  providerRetryAfterMs: number | undefined,
) {
  if (operation === "github") {
    current.response.github = githubProvisionResultSchema.parse(result);
  } else {
    current.response.vercel = vercelProvisionResultSchema.parse(result);
  }
  if (
    operation === "github" &&
    result.status === "succeeded" &&
    current.response.vercel.status === "skipped" &&
    current.response.vercel.code === "github_required"
  ) {
    current.response.vercel = { code: "provider_unavailable", retryable: true, status: "failed" };
    current.operations.vercel.attempted = false;
  }
  const state = current.operations[operation];
  state.attempted = true;
  state.attemptCount = (state.attemptCount ?? 0) + 1;
  state.outcomeKnown = result.status === "succeeded";
  if (result.status === "failed") {
    if (result.providerDiagnostic !== undefined) {
      state.lastProviderDiagnostic = result.providerDiagnostic;
    }
    state.failureDetail = result.code;
    const retryable = [
      "provider_unavailable",
      "provider_rate_limited",
      "source_unavailable",
    ].includes(result.code);
    if (retryable) {
      const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(state.attemptCount - 1, 4));
      state.nextRetryAt = new Date(
        now() +
          Math.max(
            Math.round(delay * (0.75 + randomInt(0, 501) / 1000)),
            providerRetryAfterMs ?? 0,
          ),
      ).toISOString();
    } else {
      delete state.nextRetryAt;
    }
  } else {
    delete state.failureDetail;
    delete state.nextRetryAt;
  }
  delete state.leaseId;
  delete state.leaseExpiresAt;
  return current;
}

function buildProvisionDiagnostic(
  operation: "github" | "vercel",
  state: BuilderProvisionJournalRow["record"]["operations"]["github"],
  result: BuilderProvisionResponse["github"] | BuilderProvisionResponse["vercel"],
  expiredLease: boolean,
) {
  let code = "provider_outcome_unknown";
  if (!expiredLease) {
    if (state.failureDetail !== undefined && state.failureDetail !== "") {
      code = state.failureDetail;
    } else if (result.status === "failed") {
      code = result.code;
    }
  }
  let recoveryAction = "Review provider access or validation details, then retry this operation.";
  if (expiredLease) {
    recoveryAction =
      "The worker stopped during provisioning. Verify the provider resource and its Builder marker before retrying this operation.";
  } else if (state.nextRetryAt !== undefined && state.nextRetryAt !== "") {
    recoveryAction = "Builder will retry after the provider delay.";
  } else if (code === "reconciliation_uncertain") {
    recoveryAction = `Builder found an existing ${operation === "github" ? "repository" : "project"} at a previously attempted name but cannot prove that this request created it. Verify provider ownership and the requested source, then resume with a reviewed recovery action; Builder will not create another resource automatically.`;
  }
  const diagnostic: NonNullable<BuilderProvisionResponse["diagnostics"]>[number] = {
    code,
    operation,
    outcomeKnown: state.outcomeKnown ?? false,
    provider: operation,
    recoveryAction,
  };
  if (state.lastProviderDiagnostic !== undefined) {
    diagnostic.lastProviderDiagnostic = state.lastProviderDiagnostic;
  }
  if (state.nextRetryAt !== undefined && state.nextRetryAt !== "") {
    diagnostic.nextRetryAt = state.nextRetryAt;
  }
  return diagnostic;
}

async function runProvisionProvider(input: {
  authority: BuilderProvisionAuthority;
  request: BuilderProvisionRequest;
  dependencies: BuilderProvisioningDependencies;
  now: () => number;
  reconcilePriorWrite: boolean;
  renewLease: () => Promise<void>;
  persist: (kind: "candidate" | "absent", candidate: string) => Promise<void>;
  recordRetryAfter: (milliseconds: number) => void;
}): Promise<BuilderProvisionResponse["github"] | BuilderProvisionResponse["vercel"]> {
  const {
    authority,
    request,
    dependencies,
    now,
    reconcilePriorWrite,
    renewLease,
    persist,
    recordRetryAfter,
  } = input;
  if (request.operation === "github") {
    const bindings = (await dependencies.githubInstallations.list?.(authority)) ?? [];
    const installation = bindings.find(
      (binding) =>
        binding.installationId === request.providers.githubInstallationId && binding.active,
    );
    if (installation === undefined) {
      return { code: "installation_inactive", retryable: true, status: "failed" };
    }
    try {
      const source = await (dependencies.loadStarterSource ?? cloneStarterSource)();
      const current = await dependencies.journal.read({ authority, requestId: request.requestId });
      if (current === undefined) {
        throw new Error("provision-journal-missing");
      }
      return await provisionGitHubRepository({
        authority,
        config: dependencies.githubConfig,
        credentialStore: dependencies.githubCredentials,
        fetch: dependencies.fetch,
        installation,
        now,
        persistAbsent: async (candidate) => {
          await persist("absent", candidate);
        },
        persistCandidate: async (candidate) => {
          await persist("candidate", candidate);
        },
        persistedAbsentCandidates: current.record.operations.github.absentCandidates,
        persistedCandidates: current.record.operations.github.candidates,
        private: request.repository.private,
        reconcilePriorWrite,
        recordRetryAfter,
        renewLease,
        requestId: request.requestId,
        requestedName: request.repository.name,
        source,
      });
    } catch (error) {
      return {
        code:
          error instanceof Error && error.message.includes("mismatch")
            ? "source_mismatch"
            : "source_unavailable",
        retryable: true,
        status: "failed",
      };
    }
  }

  const current = await dependencies.journal.read({ authority, requestId: request.requestId });
  if (current === undefined) {
    throw new Error("provision-journal-missing");
  }
  const { vercelInstallationId } = request.providers;
  if (vercelInstallationId === undefined) {
    throw new Error("vercel-installation-missing");
  }
  const credential = await dependencies.readVercelCredential({
    authority,
    installationId: vercelInstallationId,
  });
  if (credential?.binding.active !== true) {
    return { code: "installation_inactive", retryable: true, status: "failed" };
  }
  const result = await provisionVercelProject({
    appId: current.record.response.appId,
    deploymentAccess: current.record.request.deploymentAccess,
    fetch: dependencies.fetch,
    github: current.record.response.github,
    githubSelected: request.providers.githubInstallationId !== undefined,
    installation: credential.binding,
    persistAbsent: async (candidate) => {
      await persist("absent", candidate);
    },
    persistCandidate: async (candidate) => {
      await persist("candidate", candidate);
    },
    persistedAbsentCandidates: current.record.operations.vercel.absentCandidates,
    persistedCandidates: current.record.operations.vercel.candidates,
    reconcilePriorWrite,
    recordRetryAfter,
    renewLease,
    token: credential.token,
  });
  if (shouldRenewVercelInstallation(result)) {
    await dependencies.deactivateVercelInstallation(
      credential.binding.installationId,
      new Date(now()),
    );
  }
  return result;
}


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
    now: new Date(now()),
    request,
  });
  if (!sameIntent(request, reserved.record.request)) {
    throw new Error("provision-request-id-reused");
  }
  const existing = reserved.record.response[request.operation];
  if (existing.status === "succeeded") {
    return reserved.record.response;
  }

  const leaseId = (input.dependencies.leaseId ?? randomUUID)();
  const leased = await updateBuilderProvisionJournal({
    authority: input.authority,
    now,
    requestId: request.requestId,
    store: input.dependencies.journal,
    update(current) {
      acquireProvisionLease(current, request.operation, leaseId, now);
      return current;
    },
  });
  if (leased.record.operations[request.operation].leaseId !== leaseId) {
    return leased.record.response;
  }
  const priorOperation = leased.record.operations[request.operation];
  const reconcilePriorWrite =
    priorOperation.candidates.length > 0 && priorOperation.outcomeKnown !== true;

  let leaseFailure: Error | undefined;
  const renewLease = async () => {
    await input.dependencies.assertCurrent?.();
    if (leaseFailure !== undefined) {
      throw leaseFailure;
    }
    await updateBuilderProvisionJournal({
      authority: input.authority,
      now,
      requestId: request.requestId,
      store: input.dependencies.journal,
      update(current) {
        const operation = current.operations[request.operation];
        if (operation.leaseId !== leaseId) {
          throw new Error(LEASE_LOST);
        }
        operation.leaseExpiresAt = new Date(now() + LEASE_MS).toISOString();
        return current;
      },
    });
    await input.dependencies.assertCurrent?.();
  };
  const tick = async () => {
    try {
      await renewLease();
    } catch (error) {
      leaseFailure = error instanceof Error ? error : new Error("provision-lease-renewal-failed");
    }
  };
  const renewal = setInterval(() => {
    void tick();
  }, LEASE_MS / 3);
  renewal.unref?.();

  try {
    const persist = async (kind: "candidate" | "absent", candidate: string) => {
      await renewLease();
      await updateBuilderProvisionJournal({
        authority: input.authority,
        now,
        requestId: request.requestId,
        store: input.dependencies.journal,
        update(current) {
          if (current.operations[request.operation].leaseId !== leaseId) {
            throw new Error(LEASE_LOST);
          }
          const values =
            kind === "candidate"
              ? current.operations[request.operation].candidates
              : current.operations[request.operation].absentCandidates;
          if (!values.includes(candidate)) {
            values.push(candidate);
          }
          return current;
        },
      });
    };

    let providerRetryAfterMs: number | undefined;
    const recordRetryAfter = (milliseconds: number) => {
      providerRetryAfterMs = Math.max(providerRetryAfterMs ?? 0, milliseconds);
    };
    const result = await runProvisionProvider({
      authority: input.authority,
      dependencies: input.dependencies,
      now,
      persist,
      reconcilePriorWrite,
      recordRetryAfter,
      renewLease,
      request,
    });

    const completed = await updateBuilderProvisionJournal({
      authority: input.authority,
      now,
      requestId: request.requestId,
      store: input.dependencies.journal,
      update(current) {
        if (current.operations[request.operation].leaseId !== leaseId) {
          throw new Error(LEASE_LOST);
        }
        finalizeProvisionOperation(current, request.operation, result, now, providerRetryAfterMs);
        return current;
      },
    });
    return builderProvisionResponseSchema.parse(completed.record.response);
  } finally {
    clearInterval(renewal);
  }
}

export function projectBuilderProvisioning(row: BuilderProvisionJournalRow) {
  const diagnostics: NonNullable<BuilderProvisionResponse["diagnostics"]> = [];
  for (const operation of ["github", "vercel"] as const) {
    const state = row.record.operations[operation];
    const result = row.record.response[operation];
    const expiredLease = isExpiredLease(
      state.leaseId,
      state.leaseExpiresAt,
      state.attempted,
      Date.now(),
    );
    if ((!state.attempted || result.status !== "failed") && !expiredLease) {
      continue;
    }
    diagnostics.push(buildProvisionDiagnostic(operation, state, result, expiredLease));
  }
  return builderProvisionResponseSchema.parse({ ...row.record.response, diagnostics });
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
  if (!row) {
    return undefined;
  }
  return projectBuilderProvisioning(row);
}
