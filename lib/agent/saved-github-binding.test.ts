/* oxlint-disable sonarjs/no-undefined-assignment, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- SAFETY: deliberately partial historical fixtures exercise only the closed recovery proof fields. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRepositoryObservation } from "../repository/github-publication";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { inspectExistingRepositorySnapshotReceipt } from "../repository/source-receipt";
import { recordRepositoryAccessReceipt } from "./repository-access-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { SourceWorkflowState } from "./source-state";
import { recoverSavedWorkflowGitHubBinding, SavedGitHubBindingError } from "./saved-github-binding";

const seal = <T extends object>(value: T) => ({
  ...value,
  digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
});
const sha = "1".repeat(40);
const tree = "2".repeat(40);
const installationIdentityDigest = "3".repeat(64);
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: sha,
  headTree: tree,
  installationIdentityDigest,
  name: "app",
  owner: "example",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "200",
  visibility: "private",
});
const githubSource: ImmutableGitHubSourceReceipt = seal({
  installationIdentityDigest,
  repository,
  resolvedByCallId: "original-call",
  resolvedRef: "refs/heads/main",
  resolvedSha: sha,
  resolvedTree: tree,
  version: 2,
});
const receipt = inspectExistingRepositorySnapshotReceipt({
  contents: {},
  contract: [],
  dirtyPaths: [],
  sourcePath: "/workspace",
  sourceSha: sha,
  sourceTree: tree,
});
const access = recordRepositoryAccessReceipt({
  access: {
    accessDigest: "4".repeat(64),
    repository: { ...repository, archived: false, repositoryVariableNames: [] },
    scope: { accountLogin: "example", accountType: "Organization", installationId: "10" },
    status: "ready",
  },
  confirmedByCallId: "original-call",
  current: undefined,
  sessionId: "original-session",
});
// Model a historical applied snapshot: all unrelated durable approvals and product fields are retained.
const workflow = {
  apply: { retained: true },
  approvals: { retained: true },
  phase: "applied",
  sourceReceipt: receipt,
  workspace: { sourceSha: sha, sourceTree: tree, workspaceId: "saved-provider" },
} as unknown as AppBuilderWorkflowState;
const source = { githubSource, phase: "reviewed", receipt } as SourceWorkflowState;
const input = {
  access,
  providerWorkspaceId: "saved-provider",
  sessionId: "original-session",
  source,
  stage: "prepare-workspace" as const,
  workflow,
};

describe("saved accepted GitHub binding recovery", () => {
  it("recovers the missing slot of an applied workflow from its original durable authority", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const recovered = recoverSavedWorkflowGitHubBinding(input);
    expect(recovered.recovered).toBe(true);
    expect(recovered.workflow).toEqual({ ...workflow, githubSource });
    expect(recovered.githubSource).toBe(githubSource);
    expect(workflow).not.toHaveProperty("githubSource");
    vi.restoreAllMocks();
  });
  it.each([
    { sessionId: "foreign-session" },
    { source: { phase: "empty", version: 3 } as SourceWorkflowState },
    { access: undefined },
    { providerWorkspaceId: "foreign-provider" },
    {
      access: recordRepositoryAccessReceipt({
        access: {
          accessDigest: "4".repeat(64),
          repository: { ...repository, archived: false, repositoryVariableNames: [] },
          scope: { accountLogin: "example", accountType: "Organization", installationId: "10" },
          status: "ready",
        },
        confirmedByCallId: "different-call",
        current: undefined,
        sessionId: "original-session",
      }),
    },
    {
      source: { ...source, receipt: { ...receipt, digest: "f".repeat(64) } } as SourceWorkflowState,
    },
  ])("blocks missing or foreign proof without changing accepted state", (replacement) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => recoverSavedWorkflowGitHubBinding({ ...input, ...replacement })).toThrow(
      SavedGitHubBindingError,
    );
    expect(workflow).not.toHaveProperty("githubSource");
    vi.restoreAllMocks();
  });
});
