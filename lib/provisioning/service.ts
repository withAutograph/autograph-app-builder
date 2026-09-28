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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sameIntent(
  request: BuilderProvisionRequest,
  stored: Omit<BuilderProvisionRequest, "operation">,
) {
  return (
    builderProvisionRequestDigest(request) ===
    builderProvisionRequestDigest({ ...stored, operation: request.operation })
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
      const operation = current.operations[request.operation];
      if (
        operation.leaseId &&
        operation.leaseExpiresAt &&
        Date.parse(operation.leaseExpiresAt) > now()
      ) {
        return current;
      }
      operation.leaseId = leaseId;
      operation.leaseExpiresAt = new Date(now() + LEASE_MS).toISOString();
      return current;
    },
  });
  if (leased.record.operations[request.operation].leaseId !== leaseId) {
    return leased.record.response;
  }

  let leaseFailure: Error | undefined;
  const renewLease = async () => {
    if (leaseFailure) {
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

    let result: BuilderProvisionResponse[typeof request.operation];
    let providerRetryAfterMs: number | undefined;
    const recordRetryAfter = (milliseconds: number) => {
      providerRetryAfterMs = Math.max(providerRetryAfterMs ?? 0, milliseconds);
    };
    if (request.operation === "github") {
      const bindings = (await input.dependencies.githubInstallations.list?.(input.authority)) ?? [];
      const installation = bindings.find(
        (binding) =>
          binding.installationId === request.providers.githubInstallationId && binding.active,
      );
      if (installation) {
        try {
          const source = await (input.dependencies.loadStarterSource ?? cloneStarterSource)();
          const current = await input.dependencies.journal.read({
            authority: input.authority,
            requestId: request.requestId,
          });
          if (!current) {
            throw new Error("provision-journal-missing");
          }
          result = await provisionGitHubRepository({
            authority: input.authority,
            config: input.dependencies.githubConfig,
            credentialStore: input.dependencies.githubCredentials,
            fetch: input.dependencies.fetch,
            installation,
            now,
            persistAbsent: (candidate) => persist("absent", candidate),
            persistCandidate: (candidate) => persist("candidate", candidate),
            persistedAbsentCandidates: current.record.operations.github.absentCandidates,
            persistedCandidates: current.record.operations.github.candidates,
            private: request.repository.private,
            recordRetryAfter,
            renewLease,
            requestId: request.requestId,
            requestedName: request.repository.name,
            source,
          });
        } catch (error) {
          result = {
            code:
              error instanceof Error && error.message.includes("mismatch")
                ? "source_mismatch"
                : "source_unavailable",
            retryable: true,
            status: "failed",
          };
        }
      } else {
        result = {
          code: "installation_inactive",
          retryable: true,
          status: "failed",
        };
      }
    } else {
      const current = await input.dependencies.journal.read({
        authority: input.authority,
        requestId: request.requestId,
      });
      if (!current) {
        throw new Error("provision-journal-missing");
      }
      const { vercelInstallationId } = request.providers;
      if (vercelInstallationId === undefined) {
        throw new Error("vercel-installation-missing");
      }
      const credential = await input.dependencies.readVercelCredential({
        authority: input.authority,
        installationId: vercelInstallationId,
      });
      if (credential?.binding.active) {
        result = await provisionVercelProject({
          appId: current.record.response.appId,
          fetch: input.dependencies.fetch,
          github: current.record.response.github,
          githubSelected: request.providers.githubInstallationId !== undefined,
          installation: credential.binding,
          persistAbsent: (candidate) => persist("absent", candidate),
          persistCandidate: (candidate) => persist("candidate", candidate),
          persistedAbsentCandidates: current.record.operations.vercel.absentCandidates,
          persistedCandidates: current.record.operations.vercel.candidates,
          recordRetryAfter,
          renewLease,
          token: credential.token,
        });
        if (result.status === "failed" && result.code === "credential_unavailable") {
          await input.dependencies.deactivateVercelInstallation(
            credential.binding.installationId,
            new Date(now()),
          );
        }
      } else {
        result = {
          code: "installation_inactive",
          retryable: true,
          status: "failed",
        };
      }
    }

    const completed = await updateBuilderProvisionJournal({
      authority: input.authority,
      now,
      requestId: request.requestId,
      store: input.dependencies.journal,
      update(current) {
        if (current.operations[request.operation].leaseId !== leaseId) {
          throw new Error(LEASE_LOST);
        }
        if (request.operation === "github") {
          current.response.github = githubProvisionResultSchema.parse(result);
        } else {
          current.response.vercel = vercelProvisionResultSchema.parse(result);
        }
        if (
          request.operation === "github" &&
          result.status === "succeeded" &&
          current.response.vercel.status === "skipped" &&
          current.response.vercel.code === "github_required"
        ) {
          current.response.vercel = {
            code: "provider_unavailable",
            retryable: true,
            status: "failed",
          };
          current.operations.vercel.attempted = false;
        }
        current.operations[request.operation].attempted = true;
        current.operations[request.operation].attemptCount =
          (current.operations[request.operation].attemptCount ?? 0) + 1;
        current.operations[request.operation].outcomeKnown = result.status === "succeeded";
        if (result.status === "failed") {
          current.operations[request.operation].failureDetail = result.code;
          if (
            result.code === "provider_unavailable" ||
            result.code === "provider_rate_limited" ||
            result.code === "source_unavailable"
          ) {
            const attempts = current.operations[request.operation].attemptCount ?? 1;
            const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
            current.operations[request.operation].nextRetryAt = new Date(
              now() +
                Math.max(
                  Math.round(delay * (0.75 + randomInt(0, 501) / 1000)),
                  providerRetryAfterMs ?? 0,
                ),
            ).toISOString();
          } else {
            delete current.operations[request.operation].nextRetryAt;
          }
        } else {
          delete current.operations[request.operation].failureDetail;
          delete current.operations[request.operation].nextRetryAt;
        }
        delete current.operations[request.operation].leaseId;
        delete current.operations[request.operation].leaseExpiresAt;
        return current;
      },
    });
    return builderProvisionResponseSchema.parse(completed.record.response);
  } finally {
    clearInterval(renewal);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function projectBuilderProvisioning(row: BuilderProvisionJournalRow) {
  const diagnostics: NonNullable<BuilderProvisionResponse["diagnostics"]> = [];
  for (const operation of ["github", "vercel"] as const) {
    const state = row.record.operations[operation];
    const result = row.record.response[operation];
    const expiredLease =
      state.leaseId &&
      state.leaseExpiresAt &&
      Date.parse(state.leaseExpiresAt) <= Date.now() &&
      !state.attempted;
    if ((!state.attempted || result.status !== "failed") && !expiredLease) {
      continue;
    }
    let code = "provider_outcome_unknown";
    if (!expiredLease) {
      code = state.failureDetail ?? (result.status === "failed" ? result.code : code);
    }
    let recoveryAction = "Review provider access or validation details, then retry this operation.";
    if (expiredLease) {
      recoveryAction =
        "The worker stopped during provisioning. Verify the provider resource and its Builder marker before retrying this operation.";
    } else if (state.nextRetryAt) {
      recoveryAction = "Builder will retry after the provider delay.";
    }
    const diagnostic: (typeof diagnostics)[number] = {
      code,
      operation,
      outcomeKnown: state.outcomeKnown ?? false,
      provider: operation,
      recoveryAction,
    };
    if (state.nextRetryAt) {
      diagnostic.nextRetryAt = state.nextRetryAt;
    }
    diagnostics.push(diagnostic);
  }
  return builderProvisionResponseSchema.parse({ ...row.record.response, diagnostics });
}

// eslint-disable-next-line eslint/func-style -- Preserve the named public read contract.
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
    // oxlint-disable-next-line unicorn/no-useless-undefined -- the read contract distinguishes missing journals from a response.
    return undefined;
  }
  return projectBuilderProvisioning(row);
}
