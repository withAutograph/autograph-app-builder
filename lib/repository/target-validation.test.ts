import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import type { TargetApplyReceipt } from "./target-apply";
import {
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  validationOverlayRoot,
} from "./target-validation";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const apply: TargetApplyReceipt = {
  version: 2,
  sourceSha: "1".repeat(40),
  sourceTree: "0".repeat(40),
  sourceReceiptDigest: digest("1"),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: digest("4"),
  appSpecPath: "prototype/example/app-spec.md",
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  dependencyCacheContentDigest: digest("a"),
  proposalDigest: digest("b"),
  applyRoot: "/workspace/repository",
  planningTreeDigest: digest("c"),
  preparedTreeDigest: digest("d"),
  preTree: [],
  postTree: [],
  preTreeDigest: digest("e"),
  postTreeDigest: digest("f"),
  changes: [],
  changedContentDigest: digest("0"),
  command: {
    name: "create-app",
    exitCode: 0,
    stdoutDigest: digest("1"),
    stderrDigest: digest("2"),
  },
  appliedByCallId: "apply-call",
  status: "applied",
  targetReceipt: {
    version: 1,
    appId: "example",
    contractPath: "apps/example/app.contract.json",
    workspacePath: "apps/example",
    topology: {
      path: "microfrontends.json",
      oldDigest: digest("3"),
      newDigest: digest("4"),
    },
    mutations: ["apps/example", "microfrontends.json"],
    recovered: false,
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
  },
  digest: digest("5"),
};

function sandboxFixture() {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  return {
    run,
    sandbox: {
      id: "sandbox",
      run,
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession,
  };
}

describe("target validation", () => {
  it("runs repository commands without receipt or source preflight", async () => {
    const { sandbox } = sandboxFixture();
    const currentApply = { ...apply, digest: "current-worktree" };
    const attempt = createTargetValidationAttempt(
      currentApply,
      "validation-call",
    );
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    }));

    const result = await executeProposalBoundValidation({
      sandbox,
      executor: execute,
      apply: currentApply,
      attempt,
      appId: "example",
      dependencyLayout: {
        version: 1,
        kind: "fixture",
        roots: [],
        workspaceLinks: [],
      },
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports the actual repository command failure", async () => {
    const { sandbox } = sandboxFixture();
    const attempt = createTargetValidationAttempt(apply, "validation-call");

    const result = await executeProposalBoundValidation({
      sandbox,
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "repository command failed",
      }),
      apply,
      attempt,
      appId: "example",
      dependencyLayout: {
        version: 1,
        kind: "fixture",
        roots: [],
        workspaceLinks: [],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "command-failed" },
    });
  });

  it("uses a writable validation directory without binding it to an apply digest", () => {
    expect(validationOverlayRoot("any-current-value", "check-build")).toBe(
      "/workspace/.app-builder/validation/check-build/repository",
    );
  });
});
