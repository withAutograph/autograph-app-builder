import { describe, expect, it } from "vitest";

import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  plannedProposalForExecution,
  targetExecutionBlockers,
} from "./target-execution";

const state: AppBuilderWorkflowState = {
  version: 1,
  phase: "planned",
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
    content: "accepted",
    digest: "e".repeat(64),
    acceptedByCallId: "call",
  },
  proposal: {
    version: 1,
    appId: "expense-review",
    appSpec: {
      path: "prototype/expense-review/app-spec.md",
      sha256: "e".repeat(64),
    },
    sourceSha: "a".repeat(40),
    eligibilityDigest: "d".repeat(64),
    workspaceDigest: "c".repeat(64),
    commands: {
      planning: "mise run plan",
      apply: "mise run apply",
      preflight: "mise run preflight",
      validation: ["mise run check"],
    },
    mutations: [],
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
