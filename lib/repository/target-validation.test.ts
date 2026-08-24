import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import type { OverlaySnapshot, TargetApplyReceipt } from "./target-apply";
import {
  appliedOverlayDriftFailure,
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  sandboxValidationCommandExecutor,
  type ValidationCommandExecutor,
  validationOverlayRoot,
} from "./target-validation";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const apply: TargetApplyReceipt = {
  version: 1,
  sourceSha: "1".repeat(40),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: digest("4"),
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  proposalDigest: digest("a"),
  applyRoot: `/workspace/.app-builder/apply/${digest("a")}/repository`,
  preTree: [],
  postTree: [
    { path: "apps/example/package.json", mode: "644", digest: digest("b") },
  ],
  preTreeDigest: digest("c"),
  postTreeDigest: digest("d"),
  changes: [
    {
      path: "apps/example/package.json",
      kind: "added",
      after: { mode: "644", digest: digest("b") },
    },
  ],
  changedContentDigest: digest("e"),
  command: {
    name: "create-app",
    exitCode: 0,
    stdoutDigest: digest("f"),
    stderrDigest: digest("0"),
  },
  appliedByCallId: "apply-call",
  status: "applied",
  targetReceipt: {
    version: 1,
    appId: "example",
    contractPath: "apps/example/app.contract.json",
    workspacePath: "apps/example",
    topology: {
      path: "apps/shell/microfrontends.json",
      oldDigest: digest("1"),
      newDigest: digest("2"),
    },
    mutations: ["apps/example", "apps/shell/microfrontends.json"],
    recovered: false,
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
  },
  digest: digest("f"),
};

function snapshot(treeDigest: string): OverlaySnapshot {
  return { treeDigest, files: apply.postTree };
}

function sandboxFixture() {
  const run = vi.fn(async (request: unknown) => {
    void request;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return {
    run,
    sandbox: { id: "sandbox", run } as unknown as SandboxSession,
  };
}

describe("proposal-bound target validation", () => {
  it("binds a pending attempt to the exact apply receipt and fixed commands", () => {
    const attempt = createTargetValidationAttempt(apply, "validation-call");
    expect(attempt).toMatchObject({
      status: "pending",
      applyDigest: apply.digest,
      appliedTreeDigest: apply.postTreeDigest,
      changedContentDigest: apply.changedContentDigest,
      startedByCallId: "validation-call",
    });
    expect(attempt.commands).toEqual([
      {
        name: "check",
        command: "mise run check",
        validationRoot: validationOverlayRoot(apply.digest, "check"),
      },
      {
        name: "test",
        command: "mise run test",
        validationRoot: validationOverlayRoot(apply.digest, "test"),
      },
    ]);
  });

  it("rejects an apply overlay root that is not bound to the proposal", () => {
    expect(() =>
      createTargetValidationAttempt(
        { ...apply, applyRoot: "/workspace/repository" },
        "validation-call",
      ),
    ).toThrow("apply overlay root is not proposal-bound");
  });

  it("runs each fixed command in an independent exact-tree overlay", async () => {
    const { run, sandbox } = sandboxFixture();
    const snapshots = [
      snapshot(apply.postTreeDigest),
      snapshot(apply.postTreeDigest),
    ];
    const executor = vi.fn(
      async ({ command }: Parameters<ValidationCommandExecutor>[0]) => ({
        exitCode: 0,
        stdout: `${command} passed`,
        stderr: "",
      }),
    );
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      snapshotter: async () => snapshots.shift()!,
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passing validation");
    expect(result.receipt.commands.map(({ command }) => command)).toEqual([
      "mise run check",
      "mise run test",
    ]);
    expect(
      result.receipt.commands.map(({ inputTreeDigest }) => inputTreeDigest),
    ).toEqual([apply.postTreeDigest, apply.postTreeDigest]);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0]?.[0].validationRoot).not.toBe(
      executor.mock.calls[1]?.[0].validationRoot,
    );
    expect(
      run.mock.calls
        .map(([request]) => (request as { command: string }).command)
        .filter((command) => command.startsWith("cp -R")),
    ).toEqual([
      `cp -R ${apply.applyRoot} ${validationOverlayRoot(apply.digest, "check")}`,
      `cp -R ${apply.applyRoot} ${validationOverlayRoot(apply.digest, "test")}`,
    ]);
  });

  it("records a command failure and does not dispatch later validation", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "failed",
    }));
    const snapshots = [snapshot(apply.postTreeDigest)];
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      snapshotter: async () => snapshots.shift()!,
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        status: "failed",
        reason: "command-failed",
        recoveryRequired: true,
        commands: [{ command: "mise run check", exitCode: 1 }],
      },
    });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a fixed command drifts protected workspace state", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    }));
    const verifyProtectedState = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValue(new Error("prepared source drifted"));
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      snapshotter: async () => snapshot(apply.postTreeDigest),
      verifyProtectedState,
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        reason: "protected-workspace-drift",
        recoveryRequired: true,
        commands: [],
      },
    });
    expect(executor).not.toHaveBeenCalled();
    expect(verifyProtectedState).toHaveBeenCalledTimes(2);
  });

  it("records materialization failure without dispatching a command", async () => {
    let calls = 0;
    const run = vi.fn(async (request: unknown) => {
      void request;
      calls += 1;
      return calls === 3
        ? { exitCode: 1, stdout: "", stderr: "copy failed" }
        : { exitCode: 0, stdout: "", stderr: "" };
    });
    const sandbox = { id: "sandbox", run } as unknown as SandboxSession;
    const executor = vi.fn();
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        reason: "materialization-failed",
        commands: [],
        recoveryRequired: true,
      },
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails before command execution when a copied input tree drifts", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi.fn();
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      snapshotter: async () => snapshot(digest("0")),
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "input-tree-mismatch", commands: [] },
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("can convert a terminal result into applied-overlay drift failure", async () => {
    const { sandbox } = sandboxFixture();
    const snapshots = [
      snapshot(apply.postTreeDigest),
      snapshot(apply.postTreeDigest),
    ];
    const attempt = createTargetValidationAttempt(apply, "validation-call");
    const result = await executeProposalBoundValidation({
      sandbox,
      executor: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      snapshotter: async () => snapshots.shift()!,
      apply,
      attempt,
      appId: "example",
    });
    expect(result.ok).toBe(true);
    const failure = appliedOverlayDriftFailure({
      attempt,
      receipt: result.receipt,
    });
    expect(failure).toMatchObject({
      status: "failed",
      reason: "applied-overlay-drift",
      recoveryRequired: true,
    });
  });

  it("rejects a pending attempt whose immutable apply binding changed", async () => {
    const { sandbox } = sandboxFixture();
    const attempt = createTargetValidationAttempt(apply, "validation-call");
    await expect(
      executeProposalBoundValidation({
        sandbox,
        executor: vi.fn(),
        apply: { ...apply, changedContentDigest: digest("0") },
        attempt,
        appId: "example",
      }),
    ).rejects.toThrow("no longer matches the exact apply receipt");
  });

  it("uses only the fixed command, cwd, timeout, and no environment", async () => {
    const { run, sandbox } = sandboxFixture();
    const root = validationOverlayRoot(apply.digest, "check");
    await sandboxValidationCommandExecutor()({
      sandbox,
      appId: "example",
      command: "mise run check",
      validationRoot: root,
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run check",
      workingDirectory: root,
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
  });
});
