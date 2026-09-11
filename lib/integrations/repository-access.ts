import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  mergeHostedGitHubInstallationBindings,
  type HostedGitHubInstallationBinding,
  type HostedGitHubInstallationStore,
  type HostedGitHubTenantAuthority,
} from "../repository/postgres-github-installation-store";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);

const repositoryReferenceInputSchema = z
  .object({
    owner: repositoryPart,
    name: repositoryPart,
  })
  .strict();

export const repositoryReferenceSchema =
  repositoryReferenceInputSchema.transform((value) => ({
    ...value,
    fullName: `${value.owner}/${value.name}`,
  }));

const repositoryReferenceResultSchema = z
  .object({
    owner: repositoryPart,
    name: repositoryPart,
    fullName: z.string().min(3).max(201),
  })
  .strict()
  .refine((value) => value.fullName === `${value.owner}/${value.name}`, {
    message: "repository-full-name-mismatch",
  });

export type RepositoryReference = z.output<typeof repositoryReferenceSchema>;

export function parseRepositoryReference(value: string): RepositoryReference {
  const segments = value.trim().split("/");
  if (segments.length !== 2) throw new Error("repository-reference-invalid");
  return repositoryReferenceSchema.parse({
    owner: segments[0],
    name: segments[1],
  });
}

const readPermissionsSchema = z
  .object({
    metadata: z.literal("read"),
    contents: z.literal("read"),
    workflows: z.literal("none"),
    pullRequests: z.literal("none"),
    administration: z.literal("none"),
    variables: z.literal("read"),
  })
  .strict();

const installationReadBackSchema = z
  .object({
    installationId: decimal,
    accountId: decimal,
    accountLogin: z.string().min(1).max(100),
    accountType: z.enum(["Organization", "User"]),
    repositorySelection: z.enum(["all", "selected"]),
    selectedRepositoryIds: z.array(decimal).max(10_000),
    grantedPermissions: readPermissionsSchema,
  })
  .strict();

export const repositoryAccessSnapshotSchema = z
  .object({
    repositoryId: decimal,
    owner: repositoryPart,
    name: repositoryPart,
    archived: z.literal(false),
    visibility: z.literal("private"),
    defaultBranch: z.string().min(1).max(255),
    headSha: objectId,
    headTree: objectId,
    repositoryVariableNames: z.array(z.string().min(1).max(255)).max(1_000),
  })
  .strict();

export type RepositoryAccessSnapshot = z.infer<
  typeof repositoryAccessSnapshotSchema
>;

const scopeSchema = z
  .object({
    installationId: decimal,
    accountLogin: z.string().min(1).max(100),
    accountType: z.enum(["Organization", "User"]),
  })
  .strict();

export const repositoryAccessResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      repository: repositoryAccessSnapshotSchema,
      scope: scopeSchema,
      accessDigest: digest,
    })
    .strict(),
  z
    .object({
      status: z.literal("scope-selection-required"),
      repository: repositoryReferenceResultSchema,
      scopes: z.array(scopeSchema).min(2).max(100),
    })
    .strict(),
  z
    .object({
      status: z.literal("authorization-required"),
      action: z.enum(["connect", "update"]),
      repository: repositoryReferenceResultSchema,
      scopes: z.array(scopeSchema).max(100),
    })
    .strict(),
  z
    .object({
      status: z.literal("provider-unavailable"),
      repository: repositoryReferenceResultSchema,
    })
    .strict(),
]);

export type RepositoryAccessResult = z.infer<
  typeof repositoryAccessResultSchema
>;
export type ReadyRepositoryAccess = Extract<
  RepositoryAccessResult,
  { status: "ready" }
>;

export interface GitHubRepositoryAccessProvider {
  inspectInstallation(input: {
    operation: "resolve-existing-source";
    requestedPermissions: z.infer<typeof readPermissionsSchema>;
  }): Promise<unknown>;
  inspectRepositoryByName(input: {
    owner: string;
    name: string;
  }): Promise<unknown | undefined>;
}

export type GitHubRepositoryAccessProviderFactory = (input: {
  authority: HostedGitHubTenantAuthority;
  installation: HostedGitHubInstallationBinding;
}) => GitHubRepositoryAccessProvider | Promise<GitHubRepositoryAccessProvider>;

const READ_PERMISSIONS = readPermissionsSchema.parse({
  metadata: "read",
  contents: "read",
  workflows: "none",
  pullRequests: "none",
  administration: "none",
  variables: "read",
});

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function scope(binding: HostedGitHubInstallationBinding) {
  return scopeSchema.parse({
    installationId: binding.installationId,
    accountLogin: binding.accountLogin,
    accountType: binding.accountType,
  });
}

function exactInstallation(
  binding: HostedGitHubInstallationBinding,
  readBack: z.infer<typeof installationReadBackSchema>,
) {
  return (
    readBack.installationId === binding.installationId &&
    readBack.accountId === binding.accountId &&
    readBack.accountLogin === binding.accountLogin &&
    readBack.accountType === binding.accountType
  );
}

/**
 * Re-reads every tenant-owned GitHub installation and resolves repository
 * authority from provider state. Caller/model supplied ids can narrow an
 * already-proven choice but can never establish access.
 */
export async function classifyGitHubRepositoryAccess(input: {
  authority: HostedGitHubTenantAuthority;
  repository: string;
  selectedInstallationId?: string;
  installations: HostedGitHubInstallationStore;
  providerFactory: GitHubRepositoryAccessProviderFactory;
}): Promise<RepositoryAccessResult> {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const repository = parseRepositoryReference(input.repository);
  const selectedInstallationId = input.selectedInstallationId
    ? decimal.parse(input.selectedInstallationId)
    : undefined;
  const listed = (await input.installations.list?.(authority)) ?? [];
  const legacy = await input.installations.read(authority);
  const active = mergeHostedGitHubInstallationBindings(listed, legacy)
    .filter((binding) => binding.active)
    .filter(
      (binding) =>
        selectedInstallationId === undefined ||
        binding.installationId === selectedInstallationId,
    );
  const publicScopes = active.map(scope);
  if (active.length === 0) {
    const anyActive = mergeHostedGitHubInstallationBindings(
      listed,
      legacy,
    ).some((binding) => binding.active);
    return repositoryAccessResultSchema.parse({
      status: "authorization-required",
      action: anyActive ? "update" : "connect",
      repository,
      scopes: publicScopes,
    });
  }

  const matches: Array<{
    binding: HostedGitHubInstallationBinding;
    snapshot: RepositoryAccessSnapshot;
    installation: z.infer<typeof installationReadBackSchema>;
  }> = [];
  let providerFailures = 0;
  for (const binding of active) {
    try {
      const provider = await input.providerFactory({
        authority,
        installation: binding,
      });
      const installation = installationReadBackSchema.parse(
        await provider.inspectInstallation({
          operation: "resolve-existing-source",
          requestedPermissions: READ_PERMISSIONS,
        }),
      );
      if (!exactInstallation(binding, installation)) {
        providerFailures += 1;
        continue;
      }
      const candidate = await provider.inspectRepositoryByName(repository);
      if (candidate === undefined) continue;
      const snapshot = repositoryAccessSnapshotSchema.parse(candidate);
      if (
        snapshot.owner.toLowerCase() !== repository.owner.toLowerCase() ||
        snapshot.name.toLowerCase() !== repository.name.toLowerCase() ||
        (installation.repositorySelection === "selected" &&
          !installation.selectedRepositoryIds.includes(snapshot.repositoryId))
      ) {
        providerFailures += 1;
        continue;
      }
      matches.push({ binding, snapshot, installation });
    } catch {
      providerFailures += 1;
    }
  }

  if (matches.length > 1 && selectedInstallationId === undefined) {
    return repositoryAccessResultSchema.parse({
      status: "scope-selection-required",
      repository,
      scopes: matches.map(({ binding }) => scope(binding)),
    });
  }
  const match = matches[0];
  if (match) {
    const selectedScope = scope(match.binding);
    return repositoryAccessResultSchema.parse({
      status: "ready",
      repository: match.snapshot,
      scope: selectedScope,
      accessDigest: sha256({
        authority,
        repository: match.snapshot,
        scope: selectedScope,
        repositorySelection: match.installation.repositorySelection,
        selectedRepositoryIds: match.installation.selectedRepositoryIds,
        permissions: match.installation.grantedPermissions,
      }),
    });
  }
  if (providerFailures === active.length) {
    return repositoryAccessResultSchema.parse({
      status: "provider-unavailable",
      repository,
    });
  }
  return repositoryAccessResultSchema.parse({
    status: "authorization-required",
    action: "update",
    repository,
    scopes: publicScopes,
  });
}
