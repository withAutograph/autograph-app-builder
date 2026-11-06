import { createHash } from "node:crypto";

import { z } from "zod";

import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  GITHUB_PUBLICATION_VERSION,
  REPOSITORY_RELEASE_GATE,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  githubPermissionsFor,
} from "./github-publication";
import type {
  DraftPullRequestProposal,
  FreshRepositoryProposal,
  GitHubOperation,
  GitHubPublicationAdapter,
  GitHubSourceResolutionAdapter,
  GitHubTargetSourceResolutionAdapter,
  GitHubMutationAcknowledgement,
  DraftPublicationReadBack,
  FreshRepositoryReadBack,
  GitHubDraftPullRequestContent,
  GitHubFreshRepositoryContent,
  GitHubRepositoryObservation,
} from "./github-publication";
import { safeSourcePath } from "./source-path";
import {
  issueGitHubTargetAccessProof,
  parseGitHubTargetAccessProof,
} from "./github-target-access-proof";
import type { GitHubTargetAccessProof } from "./github-target-access-proof";
import type { ExistingDraftObservation, ExistingDraftUpdateProposal } from "./github-draft-update";
import type {
  ExistingDraftInspectionRequest,
  OwnedDraftInspectionRecovery,
  ExistingDraftReconciliationProposal,
  ReconciliationContent,
} from "./github-draft-reconciliation";
import { historicalAppSourceObservationSchema } from "./historical-app-source";
import type { HistoricalAppSourceSelector } from "./historical-app-source";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const decimal = z.string().regex(/^[1-9]\d*$/u);
const mutationRejectionCode = z.enum([
  "branch-moved",
  "destination-owner",
  "github-file-write-failed",
  "invalid-publication-material",
  "pull-request-changed",
  "repository-identity-changed",
  "reviewed-path-changed",
]);

const permissionSnapshotSchema = z.strictObject({
  administration: z.enum(["none", "write"]),
  contents: z.enum(["read", "write"]),
  metadata: z.literal("read"),
  pullRequests: z.enum(["none", "write"]),
  variables: z.literal("read"),
  workflows: z.enum(["none", "write"]),
});

const installationSnapshotSchema = z.strictObject({
  accountId: decimal,
  accountLogin: z.string().min(1).max(100),
  accountType: z.enum(["Organization", "User"]),
  grantedPermissions: permissionSnapshotSchema,
  installationId: decimal,
  repositorySelection: z.enum(["all", "selected"]),
  selectedRepositoryIds: z.array(decimal),
});

const repositorySnapshotSchema = z.strictObject({
  defaultBranch: z.string().min(1).max(200),
  headSha: objectId,
  headTree: objectId,
  name: z.string().min(1).max(100),
  owner: z.string().min(1).max(100),
  repositoryId: decimal,
  repositoryVariableNames: z.array(z.string().min(1).max(255)),
  visibility: z.literal("private"),
});

const freshReadBackSchema = z.strictObject({
  idempotencyKey: digest,
  initialCommit: z.strictObject({
    parents: z.array(objectId),
    sha: objectId,
    tree: objectId,
  }),
  repository: repositorySnapshotSchema,
});

const branchSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("absent") }),
  z.strictObject({
    branchName: z.string().min(1).max(200),
    branchSha: objectId,
    branchTree: objectId,
    changedContentDigest: digest,
    idempotencyKey: digest,
    normalizedChangedPaths: z.array(z.string()),
    status: z.literal("present"),
  }),
]);

const pullRequestSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("absent") }),
  z.strictObject({
    baseBranch: z.string().min(1).max(200),
    baseRepositoryId: decimal,
    baseSha: objectId,
    changeSetDigest: digest,
    draft: z.boolean(),
    headBranch: z.string().min(1).max(200),
    headRepositoryId: decimal,
    headSha: objectId,
    idempotencyKey: digest,
    pullRequestId: decimal,
    pullRequestNumber: z.number().int().positive(),
    status: z.literal("present"),
  }),
]);

const draftReadBackSchema = z.strictObject({
  branch: branchSchema,
  changedPathsSinceBase: z.array(z.string()),
  idempotencyKey: digest,
  pullRequest: pullRequestSchema,
  repository: repositorySnapshotSchema,
});

const existingDraftSchema = z.strictObject({
  baseBranch: z.string().min(1),
  baseRepositoryId: decimal,
  draft: z.boolean(),
  headBranch: z.string().min(1),
  headRepositoryId: decimal,
  headSha: objectId,
  headTree: objectId,
  name: z.string().min(1),
  number: z.number().int().positive(),
  owner: z.string().min(1),
  pullRequestId: decimal,
  repositoryId: decimal,
  state: z.enum(["open", "closed"]),
  verifiedBuilderOrigin: z
    .strictObject({ appId: decimal, authorId: decimal, marker: digest })
    .optional(),
});

const acknowledgementSchema = z.discriminatedUnion("status", [
  z.strictObject({
    requestId: z.string().regex(/^[-A-Za-z0-9_]{1,128}$/u),
    status: z.literal("accepted"),
  }),
  z
    .strictObject({
      bytes: z.number().int().nonnegative().optional(),
      code: mutationRejectionCode,
      operation: z.literal("create-blob").optional(),
      path: z.string().refine(safeSourcePath).optional(),
      providerStatus: z.number().int().min(400).max(599).optional(),
      status: z.literal("rejected"),
    })
    .refine((value) => {
      if (value.code === "reviewed-path-changed") {
        return (
          value.path !== undefined && value.bytes === undefined && value.operation === undefined
        );
      }
      if (value.code === "github-file-write-failed") {
        return (
          value.path !== undefined && value.bytes !== undefined && value.operation === "create-blob"
        );
      }
      return value.path === undefined && value.bytes === undefined && value.operation === undefined;
    }),
]);

type RequestedPermissions = z.infer<typeof permissionSnapshotSchema>;

const targetAccessObservationSchema = z.strictObject({
  accountId: decimal,
  accountLogin: z.string().min(1).max(100),
  accountType: z.enum(["Organization", "User"]),
  installationId: decimal,
  permissions: permissionSnapshotSchema,
  repositoryId: decimal,
});

export interface GitHubTargetAccessProvider {
  inspectTargetAccess: (input: {
    operation: "resolve-existing-source" | "publish-draft-pull-request";
    repositoryId: string;
    requestedPermissions: RequestedPermissions;
  }) => Promise<z.input<typeof targetAccessObservationSchema>>;
}

/** Additive v3 path; existing v2 publication adapters retain their current contract. */
export const createGitHubTargetAccessAdapter = (
  provider: GitHubTargetAccessProvider,
  authority: z.input<typeof hostedTenantAuthoritySchema>,
) => ({
  async inspectTargetAccess(
    operation: "resolve-existing-source" | "publish-draft-pull-request",
    repositoryId: string,
  ): Promise<GitHubTargetAccessProof> {
    const requestedPermissions = githubPermissionsFor(operation);
    const observed = targetAccessObservationSchema.parse(
      await sanitizedProviderCall(
        async () =>
          await provider.inspectTargetAccess({ operation, repositoryId, requestedPermissions }),
        "verify the selected repository's GitHub installation access",
      ),
    );
    return issueGitHubTargetAccessProof({
      authority,
      installation: {
        accountId: observed.accountId,
        accountLogin: observed.accountLogin,
        accountType: observed.accountType,
        installationId: observed.installationId,
      },
      observed: {
        installationId: observed.installationId,
        permissions: observed.permissions,
        repositoryId: observed.repositoryId,
      },
      operation,
      repositoryId,
    });
  },
});

export interface GitHubAppInstallationProvider {
  inspectDestinationFiles?: (input: {
    repository: GitHubRepositoryObservation;
    paths: readonly string[];
  }) => Promise<readonly { digest: string; mode: "644" | "755"; path: string }[]>;
  readDestinationFile?: (input: {
    repository: GitHubRepositoryObservation;
    path: string;
  }) => Promise<{ bytes: Uint8Array; digest: string; mode: "644" | "755" } | null>;
  inspectHistoricalAppSource?: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    source: HistoricalAppSourceSelector;
  }) => Promise<z.input<typeof historicalAppSourceObservationSchema>>;
  inspectExistingDraft: (
    input: ExistingDraftInspectionRequest,
  ) => Promise<z.input<typeof existingDraftSchema>>;
  updateExistingDraft: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedDraftUpdate: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
  inspectAppliedDraftRepair?: (
    proposal: ExistingDraftUpdateProposal,
    resolvedTree: string,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
  reconcileExistingDraft: (
    proposal: ExistingDraftReconciliationProposal,
    content: ReconciliationContent,
    recovery?: OwnedDraftInspectionRecovery,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedDraftReconciliation: (
    proposal: ExistingDraftReconciliationProposal,
    observed: ExistingDraftObservation,
    recovery?: OwnedDraftInspectionRecovery,
  ) => Promise<boolean>;
  inspectInstallation: (input: {
    operation: GitHubOperation;
    requestedPermissions: RequestedPermissions;
  }) => Promise<z.input<typeof installationSnapshotSchema>>;
  inspectRepository: (input: {
    repositoryId: string;
    ref: string;
  }) => Promise<z.input<typeof repositorySnapshotSchema>>;
  inspectDestination: (input: {
    owner: string;
    name: string;
  }) => Promise<"absent" | z.input<typeof repositorySnapshotSchema>>;
  inspectFreshRepositoryOutcome: (
    proposal: FreshRepositoryProposal,
  ) => Promise<z.input<typeof freshReadBackSchema> | undefined>;
  createPrivateFreshHistoryRepository: (
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectDraftPublication: (
    proposal: DraftPullRequestProposal,
  ) => Promise<z.input<typeof draftReadBackSchema>>;
  publishDraftPullRequest: (
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ) => Promise<GitHubMutationAcknowledgement>;
}

type HashInput = Parameters<typeof JSON.stringify>[0];
type ProviderError = Error & { cause?: unknown };

const hash = (value: HashInput) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inspectSelectedRepositoryRevisionAction = "inspect the selected repository revision";

const providerStatus = z.looseObject({ status: z.number().int().min(400).max(599) });

function safeProviderStatus(error: ProviderError): number | undefined {
  const direct = providerStatus.safeParse(error);
  if (direct.success) {
    return direct.data.status;
  }
  const { cause } = error;
  const nested = providerStatus.safeParse(cause);
  return nested.success ? nested.data.status : undefined;
}

const safeProviderRecovery = (status: number | undefined): string => {
  if (status === 401) {
    return "Reconnect GitHub access, then retry.";
  }
  if (status === 403) {
    return "Check that the GitHub App installation has the required repository permission and that GitHub has not rate limited the request. Retry after access is restored.";
  }
  if (status === 404) {
    return "Check that the repository and PR still exist and that the GitHub App installation can access them. Reconnect or select the repository again if needed.";
  }
  if (status === 409 || status === 422) {
    return "The repository or PR may have changed. Reinspect its current state, rebuild and review the proposal, then retry.";
  }
  if (status === 429) {
    return "GitHub rate limited the request. Wait for the limit to reset, then retry.";
  }
  if (status !== undefined && status >= 500) {
    return "GitHub is unavailable. Retry after the service recovers; inspect the current state before repeating a write.";
  }
  return "Check GitHub availability and repository access. Inspect the current state before retrying a write.";
};

async function sanitizedProviderCall<T>(operation: () => Promise<T>, action: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = safeProviderStatus(error);
    const statusSuffix = status === undefined ? "" : ` (HTTP ${status})`;
    const recovery = safeProviderRecovery(status);
    throw new Error(`GitHub could not ${action}${statusSuffix}. ${recovery}`);
  }
}

function parseProviderResponse<T>(schema: z.ZodType<T>, input: T): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error("GitHub provider response was invalid.");
  }
  return result.data;
}

function repositoryObservation(
  snapshotInput: z.input<typeof repositorySnapshotSchema>,
  installationIdentityDigest: string,
): GitHubRepositoryObservation {
  const snapshot = parseProviderResponse(repositorySnapshotSchema, snapshotInput);
  return createRepositoryObservation({
    defaultBranch: snapshot.defaultBranch,
    headSha: snapshot.headSha,
    headTree: snapshot.headTree,
    installationIdentityDigest,
    name: snapshot.name,
    owner: snapshot.owner,
    releaseGate: {
      configured: snapshot.repositoryVariableNames.includes(REPOSITORY_RELEASE_GATE),
      name: REPOSITORY_RELEASE_GATE,
    },
    repositoryId: snapshot.repositoryId,
    visibility: snapshot.visibility,
  });
}

export const createGitHubTargetSourceResolutionAdapter = (
  provider: GitHubTargetAccessProvider & Pick<GitHubAppInstallationProvider, "inspectRepository">,
  authority: z.input<typeof hostedTenantAuthoritySchema>,
): GitHubTargetSourceResolutionAdapter => {
  const targetAccess = createGitHubTargetAccessAdapter(provider, authority);
  return {
    async inspectRepository({ proof, repositoryId, ref }) {
      parseGitHubTargetAccessProof(proof, authority);
      if (proof.operation !== "resolve-existing-source" || proof.repositoryId !== repositoryId) {
        throw new Error("github-target-access-proof-mismatch");
      }
      return repositoryObservation(
        await sanitizedProviderCall(
          async () => await provider.inspectRepository({ ref, repositoryId }),
          inspectSelectedRepositoryRevisionAction,
        ),
        proof.digest,
      );
    },
    async inspectTargetAccess(repositoryId) {
      return await targetAccess.inspectTargetAccess("resolve-existing-source", repositoryId);
    },
  };
};

/**
 * Validates an operation-scoped GitHub App provider without reading a token or
 * accepting caller-supplied permissions, endpoints, or provider payloads.
 */
export function createGitHubAppPublicationAdapter(
  provider: GitHubAppInstallationProvider,
): GitHubPublicationAdapter {
  async function inspectInstallation(operation: GitHubOperation) {
    const expected = githubPermissionsFor(operation);
    const snapshot = parseProviderResponse(
      installationSnapshotSchema,
      await sanitizedProviderCall(
        async () =>
          await provider.inspectInstallation({
            operation,
            requestedPermissions: expected,
          }),
        "inspect the GitHub App installation",
      ),
    );
    if (JSON.stringify(snapshot.grantedPermissions) !== JSON.stringify(expected)) {
      throw new Error("GitHub installation permissions do not match the operation.");
    }
    return createGitHubInstallationIdentity({
      accountId: snapshot.accountId,
      accountLogin: snapshot.accountLogin,
      accountType: snapshot.accountType,
      installationId: snapshot.installationId,
      operation,
      repositorySelection: snapshot.repositorySelection,
      selectedRepositoryIds: snapshot.selectedRepositoryIds,
    });
  }

  async function observationFor(
    operation: GitHubOperation,
    snapshotOperation: () => Promise<z.input<typeof repositorySnapshotSchema>>,
    action: string,
  ) {
    const identity = await inspectInstallation(operation);
    return repositoryObservation(
      await sanitizedProviderCall(snapshotOperation, action),
      identity.digest,
    );
  }

  const adapter: GitHubPublicationAdapter = {
    async createPrivateFreshHistoryRepository(proposal, content) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(
          async () => await provider.createPrivateFreshHistoryRepository(proposal, content),
          "create the private repository",
        ),
      );
    },
    async inspectAppliedDraftReconciliation(proposal, observed, recovery) {
      return z
        .boolean()
        .parse(
          await sanitizedProviderCall(
            async () =>
              await provider.inspectAppliedDraftReconciliation(proposal, observed, recovery),
            "verify whether the draft PR reconciliation was applied",
          ),
        );
    },
    async inspectAppliedDraftRepair(proposal, resolvedTree, observed) {
      const inspect = provider.inspectAppliedDraftRepair;
      if (inspect === undefined) {
        throw new Error(
          "The GitHub provider cannot verify an applied draft repair without source bytes.",
        );
      }
      return z
        .boolean()
        .parse(
          await sanitizedProviderCall(
            async () => await inspect.call(provider, proposal, resolvedTree, observed),
            "verify the exact published draft repair",
          ),
        );
    },
    async inspectAppliedDraftUpdate(proposal, content, observed) {
      return z
        .boolean()
        .parse(
          await sanitizedProviderCall(
            async () => await provider.inspectAppliedDraftUpdate(proposal, content, observed),
            "verify whether the draft PR update was applied",
          ),
        );
    },
    async inspectDestination(input) {
      const raw = await sanitizedProviderCall(
        async () => await provider.inspectDestination(input),
        "inspect the repository destination",
      );
      if (raw === "absent") {
        return "absent";
      }
      const identity = await inspectInstallation("create-fresh-repository");
      return repositoryObservation(raw, identity.digest);
    },
    async inspectDraftPublication(proposal): Promise<DraftPublicationReadBack> {
      const snapshot = parseProviderResponse(
        draftReadBackSchema,
        await sanitizedProviderCall(
          async () => await provider.inspectDraftPublication(proposal),
          "inspect the draft PR publication result",
        ),
      );
      const identity = await inspectInstallation("publish-draft-pull-request");
      const unsigned = {
        branch: snapshot.branch,
        changedPathsSinceBase: snapshot.changedPathsSinceBase,
        idempotencyKey: snapshot.idempotencyKey,
        pullRequest: snapshot.pullRequest,
        repository: repositoryObservation(snapshot.repository, identity.digest),
        version: GITHUB_PUBLICATION_VERSION,
      };
      return {
        ...unsigned,
        digest: hash(unsigned),
      };
    },
    async inspectExistingDraft(input) {
      return parseProviderResponse(
        existingDraftSchema,
        await sanitizedProviderCall(
          async () => await provider.inspectExistingDraft(input),
          "inspect the existing draft PR",
        ),
      );
    },
    async inspectFreshRepositoryOutcome(proposal): Promise<FreshRepositoryReadBack | undefined> {
      const raw = await sanitizedProviderCall(
        async () => await provider.inspectFreshRepositoryOutcome(proposal),
        "inspect the repository creation result",
      );
      if (raw === undefined) {
        return undefined;
      }
      const snapshot = parseProviderResponse(freshReadBackSchema, raw);
      if (snapshot.initialCommit.parents.length !== 0) {
        throw new Error("GitHub fresh-history read-back has commit parents.");
      }
      const identity = await inspectInstallation("create-fresh-repository");
      const unsigned = {
        idempotencyKey: snapshot.idempotencyKey,
        initialCommit: {
          parents: [] as const,
          sha: snapshot.initialCommit.sha,
          tree: snapshot.initialCommit.tree,
        },
        repository: repositoryObservation(snapshot.repository, identity.digest),
        version: GITHUB_PUBLICATION_VERSION,
      };
      return { ...unsigned, digest: hash(unsigned) };
    },
    inspectInstallation,
    async inspectRepository(input) {
      const { operation, repositoryId, ref } = input;
      return await observationFor(
        operation,
        async () => await provider.inspectRepository({ ref, repositoryId }),
        inspectSelectedRepositoryRevisionAction,
      );
    },
    async publishDraftPullRequest(proposal, content) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(
          async () => await provider.publishDraftPullRequest(proposal, content),
          "publish the draft PR",
        ),
      );
    },
    async reconcileExistingDraft(proposal, content, recovery) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(
          async () => await provider.reconcileExistingDraft(proposal, content, recovery),
          "update the existing draft PR",
        ),
      );
    },
    async updateExistingDraft(proposal, content) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(
          async () => await provider.updateExistingDraft(proposal, content),
          "update the existing draft PR",
        ),
      );
    },
  };
  const destinationFileSchema = z.object({
    digest,
    mode: z.enum(["644", "755"]),
    path: z.string().refine(safeSourcePath),
  });
  const { inspectDestinationFiles, readDestinationFile } = provider;
  if (inspectDestinationFiles !== undefined) {
    adapter.inspectDestinationFiles = async (input) => {
      const requestedPaths = new Set(input.paths);
      const files = parseProviderResponse(
        z.array(destinationFileSchema),
        await sanitizedProviderCall(
          async () => await inspectDestinationFiles(input),
          "inspect destination files",
        ),
      );
      if (
        new Set(files.map((file) => file.path)).size !== files.length ||
        files.some((file) => !requestedPaths.has(file.path))
      ) {
        throw new Error("Invalid GitHub destination file response.");
      }
      return files;
    };
  }
  if (readDestinationFile !== undefined) {
    adapter.readDestinationFile = async (input) => {
      const file = parseProviderResponse(
        z
          .object({ bytes: z.instanceof(Uint8Array), digest, mode: z.enum(["644", "755"]) })
          .nullable(),
        await sanitizedProviderCall(
          async () => await readDestinationFile(input),
          "read the destination file",
        ),
      );
      if (file !== null && createHash("sha256").update(file.bytes).digest("hex") !== file.digest) {
        throw new Error("Invalid GitHub destination file digest.");
      }
      return file;
    };
  }
  const { inspectHistoricalAppSource } = provider;
  if (inspectHistoricalAppSource !== undefined) {
    adapter.inspectHistoricalAppSource = async (input) =>
      historicalAppSourceObservationSchema.parse(
        await sanitizedProviderCall(
          async () => await inspectHistoricalAppSource(input),
          "inspect the historical App source",
        ),
      );
  }
  return adapter;
}

export type GitHubAppSourceResolutionProvider = Pick<
  GitHubAppInstallationProvider,
  "inspectInstallation" | "inspectRepository"
>;

/** The read-only subset used to bind one exact existing-repository source. */
export function createGitHubAppSourceResolutionAdapter(
  provider: GitHubAppSourceResolutionProvider,
): GitHubSourceResolutionAdapter {
  async function inspectInstallation(operation: GitHubOperation) {
    const requestedPermissions = githubPermissionsFor(operation);
    const snapshot = parseProviderResponse(
      installationSnapshotSchema,
      await sanitizedProviderCall(
        async () =>
          await provider.inspectInstallation({
            operation,
            requestedPermissions,
          }),
        "inspect the GitHub App installation",
      ),
    );
    if (JSON.stringify(snapshot.grantedPermissions) !== JSON.stringify(requestedPermissions)) {
      throw new Error("GitHub installation permissions do not match the operation.");
    }
    return createGitHubInstallationIdentity({
      accountId: snapshot.accountId,
      accountLogin: snapshot.accountLogin,
      accountType: snapshot.accountType,
      installationId: snapshot.installationId,
      operation,
      repositorySelection: snapshot.repositorySelection,
      selectedRepositoryIds: snapshot.selectedRepositoryIds,
    });
  }

  return {
    inspectInstallation,
    async inspectRepository({ operation, repositoryId, ref }) {
      const identity = await inspectInstallation(operation);
      return repositoryObservation(
        await sanitizedProviderCall(
          async () => await provider.inspectRepository({ ref, repositoryId }),
          inspectSelectedRepositoryRevisionAction,
        ),
        identity.digest,
      );
    },
  };
}
