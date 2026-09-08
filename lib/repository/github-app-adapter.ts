import { createHash } from "node:crypto";

import { z } from "zod";

import {
  GITHUB_PUBLICATION_VERSION,
  REPOSITORY_RELEASE_GATE,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  githubPermissionsFor,
  type DraftPublicationReadBack,
  type DraftPullRequestProposal,
  type FreshRepositoryProposal,
  type GitHubMutationAcknowledgement,
  type GitHubOperation,
  type GitHubPublicationAdapter,
  type GitHubSourceResolutionAdapter,
  type GitHubDraftPullRequestContent,
  type GitHubFreshRepositoryContent,
  type GitHubRepositoryObservation,
} from "./github-publication";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const decimal = z.string().regex(/^[1-9]\d*$/u);
const safeProviderCode = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

const permissionSnapshotSchema = z
  .object({
    metadata: z.literal("read"),
    contents: z.enum(["read", "write"]),
    workflows: z.enum(["none", "write"]),
    pullRequests: z.enum(["none", "write"]),
    administration: z.enum(["none", "write"]),
    variables: z.literal("read"),
  })
  .strict();

const installationSnapshotSchema = z
  .object({
    installationId: decimal,
    accountId: decimal,
    accountLogin: z.string().min(1).max(100),
    accountType: z.enum(["Organization", "User"]),
    repositorySelection: z.enum(["all", "selected"]),
    selectedRepositoryIds: z.array(decimal),
    grantedPermissions: permissionSnapshotSchema,
  })
  .strict();

const repositorySnapshotSchema = z
  .object({
    repositoryId: decimal,
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    visibility: z.literal("private"),
    defaultBranch: z.string().min(1).max(200),
    headSha: objectId,
    headTree: objectId,
    repositoryVariableNames: z.array(z.string().min(1).max(255)),
  })
  .strict();

const freshReadBackSchema = z
  .object({
    idempotencyKey: digest,
    repository: repositorySnapshotSchema,
    initialCommit: z
      .object({
        sha: objectId,
        tree: objectId,
        parents: z.array(objectId),
      })
      .strict(),
  })
  .strict();

const branchSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z
    .object({
      status: z.literal("present"),
      branchName: z.string().min(1).max(200),
      branchSha: objectId,
      branchTree: objectId,
      normalizedChangedPaths: z.array(z.string()),
      changedContentDigest: digest,
      idempotencyKey: digest,
    })
    .strict(),
]);

const pullRequestSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z
    .object({
      status: z.literal("present"),
      pullRequestId: decimal,
      pullRequestNumber: z.number().int().positive().safe(),
      draft: z.boolean(),
      headRepositoryId: decimal,
      headBranch: z.string().min(1).max(200),
      headSha: objectId,
      baseRepositoryId: decimal,
      baseBranch: z.string().min(1).max(200),
      baseSha: objectId,
      changeSetDigest: digest,
      idempotencyKey: digest,
    })
    .strict(),
]);

const draftReadBackSchema = z
  .object({
    idempotencyKey: digest,
    repository: repositorySnapshotSchema,
    changedPathsSinceBase: z.array(z.string()),
    branch: branchSchema,
    pullRequest: pullRequestSchema,
  })
  .strict();

const acknowledgementSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      requestId: z.string().regex(/^[-A-Za-z0-9_]{1,128}$/u),
    })
    .strict(),
  z.object({ status: z.literal("rejected"), code: safeProviderCode }).strict(),
]);

type RequestedPermissions = z.infer<typeof permissionSnapshotSchema>;

export interface GitHubAppInstallationProvider {
  inspectInstallation(input: {
    operation: GitHubOperation;
    requestedPermissions: RequestedPermissions;
  }): Promise<unknown>;
  inspectRepository(input: {
    repositoryId: string;
    ref: string;
  }): Promise<unknown>;
  inspectDestination(input: { owner: string; name: string }): Promise<unknown>;
  inspectFreshRepositoryOutcome(
    proposal: FreshRepositoryProposal,
  ): Promise<unknown>;
  createPrivateFreshHistoryRepository(
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ): Promise<unknown>;
  inspectDraftPublication(proposal: DraftPullRequestProposal): Promise<unknown>;
  publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ): Promise<unknown>;
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function sanitizedProviderCall(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch {
    throw new Error("GitHub provider operation failed.");
  }
}

function parseProviderResponse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error("GitHub provider response was invalid.");
  }
  return result.data;
}

function repositoryObservation(
  snapshotInput: unknown,
  installationIdentityDigest: string,
): GitHubRepositoryObservation {
  const snapshot = parseProviderResponse(
    repositorySnapshotSchema,
    snapshotInput,
  );
  return createRepositoryObservation({
    repositoryId: snapshot.repositoryId,
    owner: snapshot.owner,
    name: snapshot.name,
    visibility: snapshot.visibility,
    defaultBranch: snapshot.defaultBranch,
    headSha: snapshot.headSha,
    headTree: snapshot.headTree,
    installationIdentityDigest,
    releaseGate: {
      name: REPOSITORY_RELEASE_GATE,
      configured: snapshot.repositoryVariableNames.includes(
        REPOSITORY_RELEASE_GATE,
      ),
    },
  });
}

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
      await sanitizedProviderCall(() =>
        provider.inspectInstallation({
          operation,
          requestedPermissions: expected,
        }),
      ),
    );
    if (
      JSON.stringify(snapshot.grantedPermissions) !== JSON.stringify(expected)
    ) {
      throw new Error(
        "GitHub installation permissions do not match the operation.",
      );
    }
    return createGitHubInstallationIdentity({
      operation,
      installationId: snapshot.installationId,
      accountId: snapshot.accountId,
      accountLogin: snapshot.accountLogin,
      accountType: snapshot.accountType,
      repositorySelection: snapshot.repositorySelection,
      selectedRepositoryIds: snapshot.selectedRepositoryIds,
    });
  }

  async function observationFor(
    operation: GitHubOperation,
    snapshotOperation: () => Promise<unknown>,
  ) {
    const identity = await inspectInstallation(operation);
    return repositoryObservation(
      await sanitizedProviderCall(snapshotOperation),
      identity.digest,
    );
  }

  return {
    inspectInstallation,
    async inspectRepository(input) {
      const { operation, repositoryId, ref } = input;
      return observationFor(operation, () =>
        provider.inspectRepository({ repositoryId, ref }),
      );
    },
    async inspectDestination(input) {
      const raw = await sanitizedProviderCall(() =>
        provider.inspectDestination(input),
      );
      if (raw === "absent") return "absent";
      const identity = await inspectInstallation("create-fresh-repository");
      return repositoryObservation(raw, identity.digest);
    },
    async inspectFreshRepositoryOutcome(proposal) {
      const raw = await sanitizedProviderCall(() =>
        provider.inspectFreshRepositoryOutcome(proposal),
      );
      if (raw === undefined) return undefined;
      const snapshot = parseProviderResponse(freshReadBackSchema, raw);
      if (snapshot.initialCommit.parents.length !== 0) {
        throw new Error("GitHub fresh-history read-back has commit parents.");
      }
      const identity = await inspectInstallation("create-fresh-repository");
      const unsigned = {
        version: GITHUB_PUBLICATION_VERSION,
        idempotencyKey: snapshot.idempotencyKey,
        repository: repositoryObservation(snapshot.repository, identity.digest),
        initialCommit: {
          sha: snapshot.initialCommit.sha,
          tree: snapshot.initialCommit.tree,
          parents: [] as const,
        },
      };
      return { ...unsigned, digest: hash(unsigned) };
    },
    async createPrivateFreshHistoryRepository(proposal, content) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(() =>
          provider.createPrivateFreshHistoryRepository(proposal, content),
        ),
      ) as GitHubMutationAcknowledgement;
    },
    async inspectDraftPublication(proposal) {
      const snapshot = parseProviderResponse(
        draftReadBackSchema,
        await sanitizedProviderCall(() =>
          provider.inspectDraftPublication(proposal),
        ),
      );
      const identity = await inspectInstallation("publish-draft-pull-request");
      const unsigned = {
        version: GITHUB_PUBLICATION_VERSION,
        idempotencyKey: snapshot.idempotencyKey,
        repository: repositoryObservation(snapshot.repository, identity.digest),
        changedPathsSinceBase: snapshot.changedPathsSinceBase,
        branch: snapshot.branch,
        pullRequest: snapshot.pullRequest,
      };
      return {
        ...unsigned,
        digest: hash(unsigned),
      } as DraftPublicationReadBack;
    },
    async publishDraftPullRequest(proposal, content) {
      return parseProviderResponse(
        acknowledgementSchema,
        await sanitizedProviderCall(() =>
          provider.publishDraftPullRequest(proposal, content),
        ),
      ) as GitHubMutationAcknowledgement;
    },
  };
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
    const expected = githubPermissionsFor(operation);
    const snapshot = parseProviderResponse(
      installationSnapshotSchema,
      await sanitizedProviderCall(() =>
        provider.inspectInstallation({
          operation,
          requestedPermissions: expected,
        }),
      ),
    );
    if (
      JSON.stringify(snapshot.grantedPermissions) !== JSON.stringify(expected)
    )
      throw new Error(
        "GitHub installation permissions do not match the operation.",
      );
    return createGitHubInstallationIdentity({
      operation,
      installationId: snapshot.installationId,
      accountId: snapshot.accountId,
      accountLogin: snapshot.accountLogin,
      accountType: snapshot.accountType,
      repositorySelection: snapshot.repositorySelection,
      selectedRepositoryIds: snapshot.selectedRepositoryIds,
    });
  }

  return {
    inspectInstallation,
    async inspectRepository({ operation, repositoryId, ref }) {
      const identity = await inspectInstallation(operation);
      return repositoryObservation(
        await sanitizedProviderCall(() =>
          provider.inspectRepository({ repositoryId, ref }),
        ),
        identity.digest,
      );
    },
  };
}
