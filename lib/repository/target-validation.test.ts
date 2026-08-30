import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import type { OverlaySnapshot, TargetApplyReceipt } from "./target-apply";
import {
  appliedOverlayDriftFailure,
  assertReusableTargetApplyReceipt,
  assertReusableTargetValidationReceipt,
  assertTargetValidationSourceBindings,
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  sandboxValidationCommandExecutor,
  TARGET_VALIDATION_RELAY_CALL_BUDGET,
  type TargetValidationReceipt,
  type ValidationCommandExecutor,
  validationOverlayRoot,
  verifyTargetValidationProtectedTrees,
} from "./target-validation";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const apply: TargetApplyReceipt = {
  version: 2,
  sourceSha: "1".repeat(40),
  sourceTree: "0".repeat(40),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: digest("4"),
  appSpecPath: "prototype/example/app-spec.md",
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  dependencyCacheContentDigest: digest("3"),
  proposalDigest: digest("a"),
  applyRoot: `/workspace/.app-builder/apply/${digest("a")}/repository`,
  planningTreeDigest: digest("b"),
  preparedTreeDigest: digest("3"),
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
      path: "microfrontends.json",
      oldDigest: digest("1"),
      newDigest: digest("2"),
    },
    mutations: ["apps/example", "microfrontends.json"],
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

const canonicalDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function reusableValidationReceipt(): TargetValidationReceipt {
  const attempt = createTargetValidationAttempt(apply, "validation-call");
  const unsigned = {
    version: 3 as const,
    appId: attempt.appId,
    testShards: attempt.testShards,
    appValidationSha256: attempt.appValidationSha256,
    sourceSha: attempt.sourceSha,
    sourceTree: attempt.sourceTree,
    eligibilityDigest: attempt.eligibilityDigest,
    workspaceDigest: attempt.workspaceDigest,
    appSpecDigest: attempt.appSpecDigest,
    appSpecPath: attempt.appSpecPath,
    artifactRevision: attempt.artifactRevision,
    dependencyReceiptDigest: attempt.dependencyReceiptDigest,
    identityDigest: attempt.identityDigest,
    imageDigest: attempt.imageDigest,
    dependencyCacheDigest: attempt.dependencyCacheDigest,
    dependencyCacheContentDigest: attempt.dependencyCacheContentDigest,
    proposalDigest: attempt.proposalDigest,
    applyDigest: attempt.applyDigest,
    appliedTreeDigest: attempt.appliedTreeDigest,
    changedContentDigest: attempt.changedContentDigest,
    status: "passed" as const,
    attemptDigest: attempt.digest,
    commands: attempt.commands.map((command) => ({
      ...command,
      inputTreeDigest: apply.postTreeDigest,
      exitCode: 0,
      stdoutDigest: digest("1"),
      stderrDigest: digest("2"),
    })),
    validatedByCallId: attempt.startedByCallId,
  };
  return { ...unsigned, digest: canonicalDigest(unsigned) };
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

async function withRealSandbox<T>(run: () => Promise<T>): Promise<T> {
  vi.stubEnv("APP_BUILDER_REAL_SANDBOX", "1");
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("proposal-bound target validation", () => {
  it("binds planning and prepared-source trees independently", () => {
    expect(() =>
      assertTargetValidationSourceBindings({
        apply,
        planningTreeDigest: apply.planningTreeDigest,
        preparedTreeDigest: apply.preparedTreeDigest,
      }),
    ).not.toThrow();
    expect(() =>
      assertTargetValidationSourceBindings({
        apply,
        planningTreeDigest: digest("0"),
        preparedTreeDigest: apply.preparedTreeDigest,
      }),
    ).toThrow(/planning overlay changed/u);
    expect(() =>
      assertTargetValidationSourceBindings({
        apply,
        planningTreeDigest: apply.planningTreeDigest,
        preparedTreeDigest: digest("0"),
      }),
    ).toThrow(/prepared source changed/u);
  });

  it.each([
    ["apply", assertReusableTargetApplyReceipt],
    ["validation", assertReusableTargetValidationReceipt],
  ] as const)(
    "rejects stale planning and prepared trees before reusing a %s receipt",
    (_name, assertReusable) => {
      const exact = {
        apply,
        validation: reusableValidationReceipt(),
        expectedAppSpecPath: apply.appSpecPath,
        appliedTreeDigest: apply.postTreeDigest,
        planningTreeDigest: apply.planningTreeDigest,
        preparedTreeDigest: apply.preparedTreeDigest,
      };
      expect(() => assertReusable(exact)).not.toThrow();
      expect(() =>
        assertReusable({ ...exact, planningTreeDigest: digest("0") }),
      ).toThrow(/planning overlay changed/u);
      expect(() =>
        assertReusable({ ...exact, preparedTreeDigest: digest("0") }),
      ).toThrow(/prepared source changed/u);
      expect(() =>
        assertReusable({
          ...exact,
          apply: { ...apply, appSpecPath: undefined } as never,
        }),
      ).toThrow(/canonical V2 target apply receipt/u);
      expect(() =>
        assertReusable({
          ...exact,
          apply: { ...apply, appSpecPath: "prototype/other/app-spec.md" },
        }),
      ).toThrow(/accepted AppSpec path changed/u);
    },
  );

  it("reuses a canonical validation receipt after a JSON round trip", () => {
    const roundTrippedApply = JSON.parse(
      JSON.stringify(apply),
    ) as TargetApplyReceipt;
    const validation = JSON.parse(
      JSON.stringify(reusableValidationReceipt()),
    ) as TargetValidationReceipt;
    expect(() =>
      assertReusableTargetValidationReceipt({
        apply: roundTrippedApply,
        validation,
        expectedAppSpecPath: roundTrippedApply.appSpecPath,
        appliedTreeDigest: roundTrippedApply.postTreeDigest,
        planningTreeDigest: roundTrippedApply.planningTreeDigest,
        preparedTreeDigest: roundTrippedApply.preparedTreeDigest,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "path-less historical V1",
      (receipt: Record<string, unknown>) => {
        receipt.version = 1;
        delete receipt.appSpecPath;
      },
    ],
    [
      "path-present wrong version",
      (receipt: Record<string, unknown>) => {
        receipt.version = 1;
      },
    ],
    [
      "tampered binding",
      (receipt: Record<string, unknown>) => {
        receipt.workspaceDigest = digest("0");
      },
    ],
    [
      "tampered app validation input",
      (receipt: Record<string, unknown>) => {
        receipt.testShards = ["1/2"];
      },
    ],
    [
      "tampered attempt digest",
      (receipt: Record<string, unknown>) => {
        receipt.attemptDigest = digest("0");
      },
    ],
    [
      "extra command key",
      (receipt: Record<string, unknown>) => {
        const commands = receipt.commands as Array<Record<string, unknown>>;
        if (commands[0] !== undefined) commands[0].unexpected = "authority";
      },
    ],
    [
      "tampered digest",
      (receipt: Record<string, unknown>) => {
        receipt.digest = digest("0");
      },
    ],
  ] as const)("rejects %s during validated-state reuse", (_name, mutate) => {
    const validation = structuredClone(reusableValidationReceipt()) as Record<
      string,
      unknown
    >;
    mutate(validation);
    if (_name !== "tampered digest") {
      delete validation.digest;
      validation.digest = canonicalDigest(validation);
    }
    expect(() =>
      assertReusableTargetValidationReceipt({
        apply,
        validation: validation as never,
        expectedAppSpecPath: apply.appSpecPath,
        appliedTreeDigest: apply.postTreeDigest,
        planningTreeDigest: apply.planningTreeDigest,
        preparedTreeDigest: apply.preparedTreeDigest,
      }),
    ).toThrow(/canonical V3 target validation receipt/u);
  });

  it("binds a pending attempt to the exact apply receipt and fixed commands", () => {
    const attempt = createTargetValidationAttempt(apply, "validation-call");
    expect(attempt).toMatchObject({
      status: "pending",
      appId: "example",
      testShards: ["1/1"],
      appValidationSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      applyDigest: apply.digest,
      appliedTreeDigest: apply.postTreeDigest,
      changedContentDigest: apply.changedContentDigest,
      startedByCallId: "validation-call",
    });
    expect(attempt.commands).toEqual([
      {
        name: "check-build",
        command: "mise run app:check-build example",
        validationRoot: validationOverlayRoot(apply.digest, "check-build"),
      },
      {
        name: "test",
        command: "mise run app:test example 1/1",
        validationRoot: validationOverlayRoot(apply.digest, "test"),
      },
    ]);
  });

  it("rejects historical or wrong-version runtime receipts at validation boundaries", async () => {
    const historical = { ...apply, version: 1 } as Record<string, unknown>;
    delete historical.appSpecPath;
    expect(() =>
      createTargetValidationAttempt(historical as never, "validation-call"),
    ).toThrow(/canonical V2 target apply receipt/u);
    const attempt = createTargetValidationAttempt(apply, "validation-call");
    await expect(
      executeProposalBoundValidation({
        sandbox: sandboxFixture().sandbox,
        executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        apply,
        attempt: { ...attempt, version: 1 } as never,
        appId: "example",
      }),
    ).rejects.toThrow(/canonical V3 target validation attempt/u);
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
    const result = await withRealSandbox(() =>
      executeProposalBoundValidation({
        sandbox,
        executor,
        snapshotter: async () => snapshots.shift()!,
        apply,
        attempt: createTargetValidationAttempt(apply, "validation-call"),
        appId: "example",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected passing validation");
    expect(result.receipt.commands.map(({ command }) => command)).toEqual([
      "mise run app:check-build example",
      "mise run app:test example 1/1",
    ]);
    expect(
      result.receipt.commands.map(({ inputTreeDigest }) => inputTreeDigest),
    ).toEqual([apply.postTreeDigest, apply.postTreeDigest]);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0]?.[0].validationRoot).not.toBe(
      executor.mock.calls[1]?.[0].validationRoot,
    );
    const copyCommands = run.mock.calls
      .map(([request]) => (request as { command: string }).command)
      .filter((command) => command.includes("cp -R"));
    expect(copyCommands).toHaveLength(2);
    for (const [index, name] of ["check-build", "test"].entries()) {
      const command = copyCommands[index]!;
      const validationRoot = validationOverlayRoot(
        apply.digest,
        name as "check-build" | "test",
      );
      expect(command).toContain(`test -L ${apply.applyRoot}/node_modules`);
      expect(command).toContain(`cp -R ${apply.applyRoot} ${validationRoot}`);
      expect(command).toContain(`test -L ${validationRoot}/node_modules`);
      expect(command).toContain(
        `/opt/app-builder/dependencies/${apply.dependencyCacheContentDigest}/node_modules`,
      );
      expect(command).toContain("readlink --");
    }
  });

  it("copies validation overlays with the Vercel workspace-materialized dependency root", async () => {
    const { run, sandbox } = sandboxFixture();
    const snapshots = [
      snapshot(apply.postTreeDigest),
      snapshot(apply.postTreeDigest),
    ];
    const result = await executeProposalBoundValidation({
      sandbox,
      executor: async () => ({ exitCode: 0, stdout: "passed", stderr: "" }),
      snapshotter: async () => snapshots.shift()!,
      apply,
      attempt: createTargetValidationAttempt(apply, "hosted-validation"),
      appId: "example",
      environment: { APP_BUILDER_REAL_SANDBOX: "1", VERCEL: "1" },
    });
    expect(result.ok).toBe(true);
    const copyCommands = run.mock.calls
      .map(([request]) => (request as { command: string }).command)
      .filter((command) => command.includes("cp -R"));
    expect(copyCommands).toHaveLength(2);
    for (const command of copyCommands) {
      expect(command).toContain(
        `/workspace/.app-builder/hosted-dependencies/${apply.dependencyCacheContentDigest}/node_modules`,
      );
      expect(command).not.toContain("/opt/app-builder/dependencies/");
    }
  });

  it("keeps the two-command protected validation below the relay ceiling", async () => {
    const { run, sandbox } = sandboxFixture();
    const relayCall = vi.fn();
    const snapshotter = vi.fn(async (_sandbox: SandboxSession, root = "") => {
      relayCall();
      return snapshot(
        root === "/workspace/repository"
          ? apply.preparedTreeDigest
          : root === "/workspace/planning"
            ? apply.planningTreeDigest
            : apply.postTreeDigest,
      );
    });
    const executor = vi.fn(async () => {
      relayCall();
      return { exitCode: 0, stdout: "passed", stderr: "" };
    });
    const verifyProtectedState = () =>
      verifyTargetValidationProtectedTrees({
        sandbox,
        apply,
        planningRoot: "/workspace/planning",
        preparedRoot: "/workspace/repository",
        assertWorkflowState: () => undefined,
        snapshotter,
      });
    const result = await executeProposalBoundValidation({
      sandbox,
      executor,
      snapshotter,
      verifyProtectedState,
      apply,
      attempt: createTargetValidationAttempt(apply, "validation-call"),
      appId: "example",
    });
    expect(result.ok).toBe(true);
    const relayCalls = run.mock.calls.length + relayCall.mock.calls.length;
    expect(relayCalls).toBe(TARGET_VALIDATION_RELAY_CALL_BUDGET);
    expect(relayCalls).toBeLessThan(128);
  });

  it("rejects stale workflow state before protected-tree inspection", async () => {
    const { sandbox } = sandboxFixture();
    const snapshotter = vi.fn(async () => snapshot(apply.postTreeDigest));
    await expect(
      verifyTargetValidationProtectedTrees({
        sandbox,
        apply,
        planningRoot: "/workspace/planning",
        preparedRoot: "/workspace/repository",
        assertWorkflowState: () => {
          throw new Error("stale workflow state");
        },
        snapshotter,
      }),
    ).rejects.toThrow("stale workflow state");
    expect(snapshotter).not.toHaveBeenCalled();
  });

  it.each([
    [
      "prepared",
      [
        snapshot(digest("0")),
        snapshot(apply.planningTreeDigest),
        snapshot(apply.postTreeDigest),
      ],
    ],
    [
      "planning",
      [
        snapshot(apply.preparedTreeDigest),
        snapshot(digest("0")),
        snapshot(apply.postTreeDigest),
      ],
    ],
    [
      "applied",
      [
        snapshot(apply.preparedTreeDigest),
        snapshot(apply.planningTreeDigest),
        snapshot(digest("0")),
      ],
    ],
  ] as const)(
    "rejects %s tree drift during protected validation",
    async (_name, snapshots) => {
      const { sandbox } = sandboxFixture();
      const remaining = [...snapshots];
      await expect(
        verifyTargetValidationProtectedTrees({
          sandbox,
          apply,
          planningRoot: "/workspace/planning",
          preparedRoot: "/workspace/repository",
          assertWorkflowState: () => undefined,
          snapshotter: async () => remaining.shift()!,
        }),
      ).rejects.toThrow(/changed/u);
    },
  );

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
        commands: [
          { command: "mise run app:check-build example", exitCode: 1 },
        ],
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

  it("rejects a validation app id that differs from the approved apply", async () => {
    const { sandbox } = sandboxFixture();
    await expect(
      executeProposalBoundValidation({
        sandbox,
        executor: vi.fn(),
        apply,
        attempt: createTargetValidationAttempt(apply, "validation-call"),
        appId: "other-app",
      }),
    ).rejects.toThrow("validation application id changed after approval");
  });

  it("uses only the fixed command, cwd, timeout, and no environment", async () => {
    const { run, sandbox } = sandboxFixture();
    const root = validationOverlayRoot(apply.digest, "check-build");
    await sandboxValidationCommandExecutor()({
      sandbox,
      appId: "example",
      command: "mise run app:check-build example",
      validationRoot: root,
    });
    expect(run).toHaveBeenCalledWith({
      command:
        "MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools app:check-build example",
      workingDirectory: root,
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
  });

  it("rejects non-canonical validation commands before sandbox execution", async () => {
    const { run, sandbox } = sandboxFixture();
    await expect(
      sandboxValidationCommandExecutor()({
        sandbox,
        appId: "example",
        command: "mise run app:test example 2/2",
        validationRoot: validationOverlayRoot(apply.digest, "test"),
      }),
    ).rejects.toThrow("target validation command was not canonical");
    expect(run).not.toHaveBeenCalled();
  });
});
