import { describe, expect, it } from "vitest";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  type AppCreationProposal,
  type AppBuilderWorkflowState,
} from "./workflow-state";
import {
  assertProposalExecutionBindings,
  plannedProposalForExecution,
  targetExecutionBlockers,
} from "./target-execution";

const state: AppBuilderWorkflowState = {
  version: APP_BUILDER_WORKFLOW_VERSION,
  phase: "planned",
  preparedByCallId: "prepare-call",
  artifacts: [
    {
      appId: "expense-review",
      path: "prototype/expense-review/app-spec.md",
      mediaType: "text/markdown",
      content: "accepted",
      digest: "e".repeat(64),
      revision: "a".repeat(64),
      sessionId: "sandbox",
      recordedByCallId: "artifact-call",
    },
  ],
  workspace: {
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
    sourcePath: "/source",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    workspaceDigest: "c".repeat(64),
    adapter: "arrusted-development-v0",
    eligibilityDigest: "d".repeat(64),
  },
  appSpec: {
    appId: "expense-review",
    artifactPath: "prototype/expense-review/app-spec.md",
    content: "accepted",
    digest: "e".repeat(64),
    acceptedByCallId: "call",
    artifactRevision: "a".repeat(64),
  },
  dependencyReceipt: {
    version: 1,
    sourceSha: "a".repeat(40),
    eligibilityDigest: "d".repeat(64),
    workspaceDigest: "c".repeat(64),
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    targetSha: "f".repeat(40),
    targetTree: "0".repeat(40),
    cacheManifestDigest: "2".repeat(64),
    cacheContentDigest: "3".repeat(64),
    preparedByCallId: "dependency-call",
    digest: "4".repeat(64),
  },
  identityReceipt: {
    version: 1,
    sourceSha: "a".repeat(40),
    eligibilityDigest: "d".repeat(64),
    workspaceDigest: "c".repeat(64),
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    identity: {
      appId: "expense-review",
      workspacePath: "apps/expense-review",
      packageName: "@autograph/expense-review",
      projectName: "apps-expense-review",
      baseRoutes: ["/expense-review", "/expense-review/:path*"],
      appSpecPath: "prototype/expense-review/app-spec.md",
      contractPath: "apps/expense-review/app.contract.json",
      kernelSchemaPath: "apps/expense-review/schema/expense-review-schema.json",
    },
    resolvedByCallId: "identity-call",
    digest: "1".repeat(64),
  },
  proposal: {
    version: 1,
    sourceSha: "a".repeat(40),
    eligibilityDigest: "d".repeat(64),
    workspaceDigest: "c".repeat(64),
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    identityDigest: "1".repeat(64),
    contractDigest: "2".repeat(64),
    target: {} as AppCreationProposal["target"],
    plannedByCallId: "plan-call",
    digest: "f".repeat(64),
  },
};

describe("target command readiness", () => {
  it("requires the exact planned proposal receipt", () => {
    expect(plannedProposalForExecution(state, state.proposal.digest)).toBe(
      state.proposal,
    );
    expect(() => plannedProposalForExecution(state, "0".repeat(64))).toThrow(
      "proposal changed",
    );
    expect(() => assertProposalExecutionBindings(state)).toThrow(
      "durable execution bindings",
    );
  });

  it("denies target commands when the immutable toolchain proof is absent", () => {
    expect(
      targetExecutionBlockers({
        imageConfigured: false,
        toolchainReady: false,
      }),
    ).toEqual([
      "No immutable sandbox image is configured.",
      "The sandbox does not prove the exact required Git, mise, and Bun toolchain.",
    ]);
    expect(
      targetExecutionBlockers({ imageConfigured: true, toolchainReady: true }),
    ).toEqual([]);
  });
});
