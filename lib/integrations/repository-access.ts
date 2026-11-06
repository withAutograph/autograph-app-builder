import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { mergeHostedGitHubInstallationBindings } from "../repository/postgres-github-installation-store";
import { createGitHubTargetAccessAdapter } from "../repository/github-app-adapter";
import type { GitHubTargetAccessProvider } from "../repository/github-app-adapter";
import { githubTargetAccessProofSchema } from "../repository/github-target-access-proof";
import type { GitHubTargetAccessProof } from "../repository/github-target-access-proof";
import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
  HostedGitHubTenantAuthority,
} from "../repository/postgres-github-installation-store";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);

const repositoryReferenceInputSchema = z.strictObject({
  name: repositoryPart,
  owner: repositoryPart,
});

export const repositoryReferenceSchema = repositoryReferenceInputSchema.transform((value) => ({
  ...value,
  fullName: `${value.owner}/${value.name}`,
}));

const repositoryReferenceResultSchema = z
  .strictObject({
    fullName: z.string().min(3).max(201),
    name: repositoryPart,
    owner: repositoryPart,
  })
  .refine((value) => value.fullName === `${value.owner}/${value.name}`, {
    message: "repository-full-name-mismatch",
  });

export type RepositoryReference = z.output<typeof repositoryReferenceSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseRepositoryReference(value: string): RepositoryReference {
  const reference = value.trim();
  const githubUrl =
    /^https:\/\/github\.com\/(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/iu.exec(reference);
  const segments = (githubUrl?.groups?.repository ?? reference).split("/");
  if (segments.length !== 2) {
    throw new Error("repository-reference-invalid");
  }
  return repositoryReferenceSchema.parse({
    name: segments[1],
    owner: segments[0],
  });
}

const readPermissionsSchema = z.strictObject({
  administration: z.literal("none"),
  contents: z.literal("read"),
  metadata: z.literal("read"),
  pullRequests: z.literal("none"),
  variables: z.literal("read"),
  workflows: z.literal("none"),
});

const installationReadBackSchema = z.strictObject({
  accountId: decimal,
  accountLogin: z.string().min(1).max(100),
  accountType: z.enum(["Organization", "User"]),
  grantedPermissions: readPermissionsSchema,
  installationId: decimal,
  repositorySelection: z.enum(["all", "selected"]),
  selectedRepositoryIds: z.array(decimal),
});

export const repositoryAccessSnapshotSchema = z.strictObject({
  archived: z.literal(false),
  defaultBranch: z.string().min(1).max(255),
  headSha: objectId,
  headTree: objectId,
  name: repositoryPart,
  owner: repositoryPart,
  repositoryId: decimal,
  repositoryVariableNames: z.array(z.string().min(1).max(255)),
  visibility: z.literal("private"),
});

export type RepositoryAccessSnapshot = z.infer<typeof repositoryAccessSnapshotSchema>;

const scopeSchema = z.strictObject({
  accountLogin: z.string().min(1).max(100),
  accountType: z.enum(["Organization", "User"]),
  installationId: decimal,
});

const STATUS_READY = "ready" as const;
const STATUS_SCOPE_SELECTION_REQUIRED = "scope-selection-required" as const;
const STATUS_AUTHORIZATION_REQUIRED = "authorization-required" as const;
const STATUS_PROVIDER_UNAVAILABLE = "provider-unavailable" as const;

export const repositoryAccessResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    accessDigest: digest,
    repository: repositoryAccessSnapshotSchema,
    scope: scopeSchema,
    status: z.literal("ready"),
    targetProof: githubTargetAccessProofSchema.optional(),
  }),
  z.strictObject({
    repository: repositoryReferenceResultSchema,
    scopes: z.array(scopeSchema).min(2),
    status: z.literal("scope-selection-required"),
  }),
  z.strictObject({
    action: z.enum(["connect", "update"]),
    repository: repositoryReferenceResultSchema,
    scopes: z.array(scopeSchema),
    status: z.literal("authorization-required"),
  }),
  z.strictObject({
    repository: repositoryReferenceResultSchema,
    status: z.literal(STATUS_PROVIDER_UNAVAILABLE),
  }),
]);

export type RepositoryAccessResult = z.infer<typeof repositoryAccessResultSchema>;
export type ReadyRepositoryAccess = Extract<RepositoryAccessResult, { status: "ready" }>;

type InstallationReadBack = z.infer<typeof installationReadBackSchema>;

const exactTargetBinding = (
  binding: HostedGitHubInstallationBinding,
  proof: GitHubTargetAccessProof,
) =>
  proof.installationId === binding.installationId &&
  proof.accountId === binding.accountId &&
  proof.accountLogin === binding.accountLogin &&
  proof.accountType === binding.accountType;

export interface GitHubRepositoryAccessProvider {
  inspectInstallation: (input: {
    operation: "resolve-existing-source";
    requestedPermissions: z.infer<typeof readPermissionsSchema>;
  }) => Promise<InstallationReadBack>;
  inspectRepositoryByName: (input: {
    owner: string;
    name: string;
  }) => Promise<RepositoryAccessSnapshot | undefined>;
  inspectTargetAccess?: GitHubTargetAccessProvider["inspectTargetAccess"];
}

export type GitHubRepositoryAccessProviderFactory = (input: {
  authority: HostedGitHubTenantAuthority;
  installation: HostedGitHubInstallationBinding;
}) => GitHubRepositoryAccessProvider | Promise<GitHubRepositoryAccessProvider>;

const READ_PERMISSIONS = readPermissionsSchema.parse({
  administration: "none",
  contents: "read",
  metadata: "read",
  pullRequests: "none",
  variables: "read",
  workflows: "none",
});

interface AccessDigestInput {
  authority: HostedGitHubTenantAuthority;
  permissions?: z.infer<typeof readPermissionsSchema>;
  proofDigest?: string;
  repository: RepositoryAccessSnapshot;
  repositorySelection?: "all" | "selected";
  scope: z.infer<typeof scopeSchema>;
  selectedRepositoryIds?: string[];
}

const sha256 = (value: AccessDigestInput) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function scope(binding: HostedGitHubInstallationBinding) {
  return scopeSchema.parse({
    accountLogin: binding.accountLogin,
    accountType: binding.accountType,
    installationId: binding.installationId,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function classifyGitHubRepositoryAccess(input: {
  authority: HostedGitHubTenantAuthority;
  repository: string;
  selectedInstallationId?: string;
  installations: HostedGitHubInstallationStore;
  providerFactory: GitHubRepositoryAccessProviderFactory;
}): Promise<RepositoryAccessResult> {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const repository = parseRepositoryReference(input.repository);
  const selectedInstallationId =
    input.selectedInstallationId !== undefined && input.selectedInstallationId !== ""
      ? decimal.parse(input.selectedInstallationId)
      : undefined;
  const listed = (await input.installations.list?.(authority)) ?? [];
  const legacy = await input.installations.read(authority);
  const active = mergeHostedGitHubInstallationBindings(listed, legacy).filter(
    (binding) =>
      binding.active &&
      (selectedInstallationId === undefined || binding.installationId === selectedInstallationId),
  );
  const publicScopes = active.map(scope);
  if (active.length === 0) {
    const anyActive = mergeHostedGitHubInstallationBindings(listed, legacy).some(
      (binding) => binding.active,
    );
    return repositoryAccessResultSchema.parse({
      action: anyActive ? "update" : "connect",
      repository,
      scopes: publicScopes,
      status: STATUS_AUTHORIZATION_REQUIRED,
    });
  }

  const inspected = await Promise.all(
    active.map(async (binding) => {
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
          return { failure: true } as const;
        }
        const candidate = await provider.inspectRepositoryByName(repository);
        if (candidate === undefined) return { failure: false } as const;
        const snapshot = repositoryAccessSnapshotSchema.parse(candidate);
        if (
          snapshot.owner.toLowerCase() !== repository.owner.toLowerCase() ||
          snapshot.name.toLowerCase() !== repository.name.toLowerCase() ||
          (installation.repositorySelection === "selected" &&
            !installation.selectedRepositoryIds.includes(snapshot.repositoryId))
        ) {
          return { failure: true } as const;
        }
        return { failure: false, match: { binding, installation, snapshot } } as const;
      } catch {
        return { failure: true } as const;
      }
    }),
  );
  const providerFailures = inspected.filter((result) => result.failure).length;
  const matches = inspected.flatMap((result) => (result.match ? [result.match] : []));

  if (matches.length > 1 && selectedInstallationId === undefined) {
    return repositoryAccessResultSchema.parse({
      repository,
      scopes: matches.map(({ binding }) => scope(binding)),
      status: STATUS_SCOPE_SELECTION_REQUIRED,
    });
  }
  const [match] = matches;
  if (match !== undefined) {
    const selectedScope = scope(match.binding);
    return repositoryAccessResultSchema.parse({
      accessDigest: sha256({
        authority,
        permissions: match.installation.grantedPermissions,
        repository: match.snapshot,
        repositorySelection: match.installation.repositorySelection,
        scope: selectedScope,
        selectedRepositoryIds: match.installation.selectedRepositoryIds,
      }),
      repository: match.snapshot,
      scope: selectedScope,
      status: STATUS_READY,
    });
  }
  if (providerFailures === active.length) {
    return repositoryAccessResultSchema.parse({
      repository,
      status: "provider-unavailable",
    });
  }
  return repositoryAccessResultSchema.parse({
    action: "update",
    repository,
    scopes: publicScopes,
    status: STATUS_AUTHORIZATION_REQUIRED,
  });
}

/** Target-scoped path for providers that can verify one repository without an installation inventory. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function classifyGitHubRepositoryAccessWithTargetProof(input: {
  authority: HostedGitHubTenantAuthority;
  repository: string;
  selectedInstallationId?: string;
  installations: HostedGitHubInstallationStore;
  providerFactory: GitHubRepositoryAccessProviderFactory;
}): Promise<RepositoryAccessResult> {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const repository = parseRepositoryReference(input.repository);
  const selectedInstallationId =
    input.selectedInstallationId !== undefined && input.selectedInstallationId !== ""
      ? decimal.parse(input.selectedInstallationId)
      : undefined;
  const listed = (await input.installations.list?.(authority)) ?? [];
  const legacy = await input.installations.read(authority);
  const allActive = mergeHostedGitHubInstallationBindings(listed, legacy).filter(
    (binding) => binding.active,
  );
  const active = allActive.filter(
    (binding) =>
      selectedInstallationId === undefined || binding.installationId === selectedInstallationId,
  );
  if (active.length === 0) {
    return repositoryAccessResultSchema.parse({
      action: allActive.length > 0 ? "update" : "connect",
      repository,
      scopes: [],
      status: STATUS_AUTHORIZATION_REQUIRED,
    });
  }
  const inspected = await Promise.all(
    active.map(async (binding) => {
      try {
        const provider = await input.providerFactory({ authority, installation: binding });
        if (provider.inspectTargetAccess === undefined) {
          return { fallback: true } as const;
        }
        const candidate = await provider.inspectRepositoryByName(repository);
        if (candidate === undefined) return { failure: false } as const;
        const snapshot = repositoryAccessSnapshotSchema.parse(candidate);
        if (
          snapshot.owner.toLowerCase() !== repository.owner.toLowerCase() ||
          snapshot.name.toLowerCase() !== repository.name.toLowerCase()
        ) {
          return { failure: true } as const;
        }
        const proof = await createGitHubTargetAccessAdapter(
          { inspectTargetAccess: provider.inspectTargetAccess },
          authority,
        ).inspectTargetAccess("resolve-existing-source", snapshot.repositoryId);
        if (exactTargetBinding(binding, proof)) {
          const selectedScope = scope(binding);
          return {
            failure: false,
            match: repositoryAccessResultSchema.options[0].parse({
              accessDigest: sha256({
                authority,
                proofDigest: proof.digest,
                repository: snapshot,
                scope: selectedScope,
              }),
              repository: snapshot,
              scope: selectedScope,
              status: STATUS_READY,
              targetProof: proof,
            }),
          } as const;
        }
        return { failure: true } as const;
      } catch {
        return { failure: true } as const;
      }
    }),
  );
  if (inspected.some((result) => result.fallback === true)) {
    return await classifyGitHubRepositoryAccess(input);
  }
  const providerFailures = inspected.filter((result) => result.failure === true).length;
  const matches = inspected.flatMap((result) => (result.match === undefined ? [] : [result.match]));
  if (matches.length > 1 && selectedInstallationId === undefined) {
    return repositoryAccessResultSchema.parse({
      repository,
      scopes: matches.map((match) => match.scope),
      status: STATUS_SCOPE_SELECTION_REQUIRED,
    });
  }
  if (matches[0] !== undefined) {
    return matches[0];
  }
  if (providerFailures === active.length) {
    return repositoryAccessResultSchema.parse({ repository, status: STATUS_PROVIDER_UNAVAILABLE });
  }
  return repositoryAccessResultSchema.parse({
    action: "update",
    repository,
    scopes: active.map(scope),
    status: STATUS_AUTHORIZATION_REQUIRED,
  });
}
