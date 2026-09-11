import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ObservedDependencyCache } from "../repository/dependency-cache";
import { hostedExecutionArtifactDigest } from "../sandbox/hosted-artifact";
import {
  assertProposalExecutionBindings,
  plannedProposalForExecution,
  resolveTargetExecutionEnvironment,
  targetExecutionBlockers,
} from "./target-execution";
import { APP_BUILDER_WORKFLOW_VERSION } from "./workflow-state";
import type {
  AppCreationProposal,
  AppBuilderWorkflowState,
  DependencyPreparationReceipt,
} from "./workflow-state";

const dependencyReceiptUnsigned: Omit<DependencyPreparationReceipt, "digest"> =
  {
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    cacheContentDigest: "3".repeat(64),
    cacheManifestDigest: "2".repeat(64),
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    dependencyLayout: {
      kind: "fixture" as const,
      roots: [],
      version: 1 as const,
      workspaceLinks: [],
    },
    eligibilityDigest: "d".repeat(64),
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    preparedByCallId: "dependency-call",
    sourceReceiptDigest: "f".repeat(64),
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    targetSha: "a".repeat(40),
    targetTree: "b".repeat(40),
    version: 2 as const,
    workspaceDigest: "c".repeat(64),
  };

const state = {
  appSpec: {
    acceptedByCallId: "call",
    appId: "expense-review",
    artifactPath: "prototype/expense-review/app-spec.md",
    artifactRevision: "a".repeat(64),
    content: "accepted",
    digest: "e".repeat(64),
  },
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
  dependencyReceipt: {
    ...dependencyReceiptUnsigned,
    digest: createHash("sha256")
      .update(JSON.stringify(dependencyReceiptUnsigned))
      .digest("hex"),
  },
  identityReceipt: {
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    digest: "1".repeat(64),
    eligibilityDigest: "d".repeat(64),
    identity: {
      appId: "expense-review",
      appSpecPath: "prototype/expense-review/app-spec.md",
      baseRoutes: ["/expense-review", "/expense-review/:path*"],
      contractPath: "apps/expense-review/app.contract.json",
      kernelSchemaPath: "apps/expense-review/schema/expense-review-schema.json",
      packageName: "@autograph/expense-review",
      projectName: "apps-expense-review",
      workspacePath: "apps/expense-review",
    },
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    resolvedByCallId: "identity-call",
    sourceReceiptDigest: "f".repeat(64),
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    version: 1,
    workspaceDigest: "c".repeat(64),
  },
  phase: "planned",
  preparedByCallId: "prepare-call",
  proposal: {
    appSpecDigest: "e".repeat(64),
    artifactRevision: "a".repeat(64),
    contractDigest: "2".repeat(64),
    dependencyCacheDigest: `sha256:${"2".repeat(64)}`,
    digest: "f".repeat(64),
    eligibilityDigest: "d".repeat(64),
    identityDigest: "1".repeat(64),
    imageDigest: `fixture@sha256:${"1".repeat(64)}`,
    plannedByCallId: "plan-call",
    sourceReceiptDigest: "f".repeat(64),
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    target: {} as AppCreationProposal["target"],
    version: 1,
    workspaceDigest: "c".repeat(64),
  },
  sourceReceipt: {
    adapter: "arrusted-development-v0",
    contractDigest: "e".repeat(64),
    digest: "f".repeat(64),
    eligibilityDigest: "d".repeat(64),
    releaseEnabled: false,
    sourceKind: "existing-repository",
    sourcePath: "/source",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    version: 3,
  },
  version: APP_BUILDER_WORKFLOW_VERSION,
  workspace: {
    adapter: "arrusted-development-v0",
    eligibilityDigest: "d".repeat(64),
    sourcePath: "/source",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    workspaceDigest: "c".repeat(64),
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
  },
} satisfies AppBuilderWorkflowState;

describe("target command readiness", () => {
  const cache = {
    contentDigest: "3".repeat(64),
    manifest: { target: { sha: "f".repeat(40), tree: "0".repeat(40) } },
    manifestDigest: "2".repeat(64),
  } as ObservedDependencyCache;

  it("uses the hosted execution artifact and inspected cache in Vercel Preview", () => {
    const environment = {
      EVE_HOSTED_ADAPTER: "1",
      EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    };
    expect(
      resolveTargetExecutionEnvironment({ environment, fixture: false })
    ).toMatchObject({
      backend: { blockers: [], kind: "vercel-preview" },
      cacheInspectable: true,
      imageDigest: undefined,
    });
    expect(
      resolveTargetExecutionEnvironment({
        cache,
        environment,
        fixture: false,
      })
    ).toMatchObject({
      backend: { blockers: [], kind: "vercel-preview" },
      cacheInspectable: true,
      imageDigest: hostedExecutionArtifactDigest(),
    });
  });

  it("does not infer hosted readiness for an unsupported Vercel binding", () => {
    expect(
      resolveTargetExecutionEnvironment({
        cache,
        environment: { VERCEL: "1", VERCEL_ENV: "preview" },
        fixture: false,
      })
    ).toMatchObject({
      backend: { kind: "unsupported-vercel" },
      cacheInspectable: false,
      imageDigest: undefined,
    });
  });

  it("preserves the configured local microsandbox binding", () => {
    const localImage = `ghcr.io/withautograph/app-builder@sha256:${"a".repeat(64)}`;
    expect(
      resolveTargetExecutionEnvironment({
        cache,
        environment: { APP_BUILDER_SANDBOX_IMAGE: localImage },
        fixture: false,
      })
    ).toMatchObject({
      backend: { blockers: [], kind: "local-microsandbox" },
      cacheInspectable: true,
      imageDigest: localImage,
    });
  });

  it("requires the exact planned proposal receipt", () => {
    expect(plannedProposalForExecution(state, state.proposal.digest)).toBe(
      state.proposal
    );
    expect(() => plannedProposalForExecution(state, "0".repeat(64))).toThrow(
      "proposal changed"
    );
    expect(() => assertProposalExecutionBindings(state)).toThrow(
      "durable execution bindings"
    );
  });

  it("denies target commands when the immutable toolchain proof is absent", () => {
    expect(
      targetExecutionBlockers({
        imageConfigured: false,
        toolchainReady: false,
      })
    ).toEqual([
      "No immutable sandbox image is configured.",
      "The sandbox execution environment or a required command is unavailable.",
    ]);
    expect(
      targetExecutionBlockers({ imageConfigured: true, toolchainReady: true })
    ).toEqual([]);
    expect(
      targetExecutionBlockers({
        capabilityBlockers: ["Hosted artifact is unavailable."],
        imageConfigured: false,
        toolchainReady: false,
      })
    ).toEqual([
      "Hosted artifact is unavailable.",
      "No immutable sandbox image is configured.",
      "The sandbox execution environment or a required command is unavailable.",
    ]);
  });
});
