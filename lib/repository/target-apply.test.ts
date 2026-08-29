import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  assertCurrentTargetApplyReceipt,
  executeProposalBoundApply,
  inspectApplyOverlay,
  OVERLAY_SNAPSHOT_SCRIPT,
  overlayChanges,
  overlaySnapshotCommand,
  sandboxApplyCommandExecutor,
  type OverlaySnapshot,
  type TargetApplyBinding,
  type TargetApplyCommandReceipt,
} from "./target-apply";
import type { TargetProposal } from "./target-planning";

const acceptedAppSpec = Buffer.from("# Accepted AppSpec\n");
const acceptedAppSpecDigest = createHash("sha256")
  .update(acceptedAppSpec)
  .digest("hex");
const executeFile = promisify(execFile);

const proposal: TargetProposal = {
  contract: {
    version: 1,
    appId: "expense-review",
    appSpec: {
      path: "prototype/expense-review/app-spec.md",
      sha256: acceptedAppSpecDigest,
    },
  },
  futurePath: "apps/expense-review/app.contract.json",
  plan: {
    source: {
      workspacePath: "apps/expense-review",
      runtime: "nextjs",
      packageName: "@autograph/expense-review",
      schema: { kind: "none" },
    },
    product: {
      owner: "Autograph App Builder proof",
      appSpec: {
        path: "prototype/expense-review/app-spec.md",
        sha256: acceptedAppSpecDigest,
      },
      optionalCapabilities: { integrations: [], hostedResources: [] },
    },
    topology: {
      configPath: "microfrontends.json",
      projectName: "apps-expense-review",
      packageName: "@autograph/expense-review",
      routes: ["/expense-review", "/expense-review/:path*"],
      currentDigest: "b".repeat(64),
      proposedDigest: "c".repeat(64),
    },
  },
  blockers: [],
  mutations: [],
};

const binding: TargetApplyBinding = {
  sourceSha: "1".repeat(40),
  sourceTree: "0".repeat(40),
  eligibilityDigest: "2".repeat(64),
  workspaceDigest: "3".repeat(64),
  appSpecDigest: acceptedAppSpecDigest,
  appSpecPath: proposal.contract.appSpec.path,
  artifactRevision: "4".repeat(64),
  dependencyReceiptDigest: "5".repeat(64),
  identityDigest: "6".repeat(64),
  imageDigest: `fixture@sha256:${"7".repeat(64)}`,
  dependencyCacheDigest: `sha256:${"8".repeat(64)}`,
  dependencyCacheContentDigest: "d".repeat(64),
  proposalDigest: "9".repeat(64),
};

const before: OverlaySnapshot = {
  treeDigest: "a".repeat(64),
  files: [
    {
      path: "microfrontends.json",
      mode: "644",
      digest: "b".repeat(64),
    },
  ],
};

const planning: OverlaySnapshot = {
  treeDigest: "9".repeat(64),
  files: [
    ...before.files,
    {
      path: "prototype/expense-review/app-spec.md",
      mode: "644",
      digest: acceptedAppSpecDigest,
    },
  ],
};

const priorAppSpec = Buffer.from("# Prior AppSpec\n");
const priorAppSpecDigest = createHash("sha256")
  .update(priorAppSpec)
  .digest("hex");
const preparedWithPriorAppSpec: OverlaySnapshot = {
  treeDigest: "8".repeat(64),
  files: [
    ...before.files,
    {
      path: "prototype/expense-review/app-spec.md",
      mode: "644",
      digest: priorAppSpecDigest,
    },
  ],
};

const after: OverlaySnapshot = {
  treeDigest: "c".repeat(64),
  files: [
    {
      path: "apps/expense-review/app.contract.json",
      mode: "644",
      digest: "d".repeat(64),
    },
    {
      path: "microfrontends.json",
      mode: "644",
      digest: "e".repeat(64),
    },
    {
      path: "prototype/expense-review/app-spec.md",
      mode: "644",
      digest: acceptedAppSpecDigest,
    },
  ],
};

function commandReceipt(): TargetApplyCommandReceipt {
  return {
    version: 1,
    appId: "expense-review",
    contractPath: "apps/expense-review/app.contract.json",
    workspacePath: "apps/expense-review",
    topology: {
      path: "microfrontends.json",
      oldDigest: "b".repeat(64),
      newDigest: "c".repeat(64),
    },
    mutations: ["apps/expense-review", "microfrontends.json"],
    recovered: false,
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
  };
}

function sandboxFixture() {
  const run = vi.fn(async (input: unknown) => {
    void input;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const writeTextFile = vi.fn(async () => undefined);
  const writeBinaryFile = vi.fn(async () => undefined);
  const readBinaryFile = vi.fn(async ({ path }: { path: string }) =>
    path.startsWith(".app-builder/apply/") ? acceptedAppSpec : null,
  );
  const removePath = vi.fn(async () => undefined);
  const sandbox = {
    id: "sandbox",
    run,
    writeTextFile,
    writeBinaryFile,
    readBinaryFile,
    removePath,
  } as unknown as SandboxSession;
  return {
    run,
    sandbox,
    writeTextFile,
    writeBinaryFile,
    readBinaryFile,
    removePath,
  };
}

describe("proposal-bound target apply", () => {
  it.each([
    ["path-less historical V1", { ...binding, version: 1 }],
    ["path-present wrong version", { ...binding, version: 1 }],
  ] as const)("rejects a %s receipt-shaped runtime object", (_name, value) => {
    const candidate = { ...value } as Record<string, unknown>;
    if (_name.startsWith("path-less")) delete candidate.appSpecPath;
    expect(() => assertCurrentTargetApplyReceipt(candidate as never)).toThrow(
      /canonical V2 target apply receipt/u,
    );
  });
  it.each([
    ["missing", null],
    ["tampered", Buffer.from("# Drifted AppSpec\n")],
  ] as const)(
    "rejects and removes an overlay whose accepted AppSpec is %s",
    async (_case, observed) => {
      const { readBinaryFile, removePath, sandbox } = sandboxFixture();
      readBinaryFile.mockResolvedValueOnce(observed);
      await expect(
        executeProposalBoundApply({
          sandbox,
          executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          binding,
          artifactRevision: binding.artifactRevision,
          proposal,
          appliedByCallId: "apply-call",
        }),
      ).rejects.toThrow(/exact accepted AppSpec/u);
      expect(removePath).toHaveBeenCalledWith({
        path: `.app-builder/apply/${binding.proposalDigest}/repository`,
        recursive: true,
        force: true,
      });
    },
  );

  it("rejects a proposal that differs from the accepted AppSpec binding", async () => {
    const { sandbox } = sandboxFixture();
    await expect(
      executeProposalBoundApply({
        sandbox,
        executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        binding: { ...binding, appSpecDigest: "f".repeat(64) },
        artifactRevision: binding.artifactRevision,
        proposal,
        appliedByCallId: "apply-call",
      }),
    ).rejects.toThrow(/accepted AppSpec binding/u);
  });

  it("rejects a proposal whose accepted AppSpec path differs from its binding", async () => {
    const { sandbox } = sandboxFixture();
    await expect(
      executeProposalBoundApply({
        sandbox,
        executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        binding: { ...binding, appSpecPath: "prototype/other/app-spec.md" },
        artifactRevision: binding.artifactRevision,
        proposal,
        appliedByCallId: "apply-call",
      }),
    ).rejects.toThrow(/binding or path differs/u);
  });

  it.each([
    "planning-snapshot",
    "prepared-baseline-restore",
    "pre-command-snapshot",
    "accepted-appspec-staging",
  ] as const)(
    "removes the exact overlay and permits a clean retry after %s failure",
    async (failureStage) => {
      const fixture = sandboxFixture();
      const executor = vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify(commandReceipt()),
        stderr: "",
      }));
      let injectFailure = true;
      let snapshotCall = 0;
      fixture.readBinaryFile.mockImplementation(
        async ({ path }: { path: string }) => {
          if (
            injectFailure &&
            failureStage === "prepared-baseline-restore" &&
            path.startsWith("repository/")
          )
            throw new Error("injected prepared baseline failure");
          return path.startsWith(".app-builder/apply/")
            ? acceptedAppSpec
            : null;
        },
      );
      fixture.writeBinaryFile.mockImplementation(async () => {
        if (injectFailure && failureStage === "accepted-appspec-staging")
          throw new Error("injected AppSpec staging failure");
      });
      const snapshotter = vi.fn(async () => {
        const call = snapshotCall++;
        if (
          injectFailure &&
          ((failureStage === "planning-snapshot" && call === 0) ||
            (failureStage === "pre-command-snapshot" && call === 2))
        )
          throw new Error(`injected ${failureStage} failure`);
        return call === 0 ? planning : call < 3 ? before : after;
      });
      const execute = () =>
        executeProposalBoundApply({
          sandbox: fixture.sandbox,
          executor,
          snapshotter,
          binding,
          artifactRevision: binding.artifactRevision,
          proposal,
          appliedByCallId: "apply-call",
        });

      await expect(execute()).rejects.toThrow(/injected/u);
      expect(executor).not.toHaveBeenCalled();
      expect(fixture.removePath).toHaveBeenCalledWith({
        path: `.app-builder/apply/${binding.proposalDigest}/repository`,
        recursive: true,
        force: true,
      });

      injectFailure = false;
      snapshotCall = 0;
      const retry = await execute();
      expect(retry.ok).toBe(true);
      expect(executor).toHaveBeenCalledTimes(1);
    },
  );

  it("persists a recovery-required attempt when the post-command snapshot fails", async () => {
    const fixture = sandboxFixture();
    const snapshots = [planning, before, before];
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(commandReceipt()),
      stderr: "",
    }));
    const result = await executeProposalBoundApply({
      sandbox: fixture.sandbox,
      executor,
      snapshotter: async () => {
        const observed = snapshots.shift();
        if (observed === undefined)
          throw new Error("injected post-command snapshot failure");
        return observed;
      },
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        status: "partial-failure",
        reason: "post-snapshot-failed",
        recoveryRequired: true,
        postTree: null,
        postTreeDigest: null,
        changes: null,
        changedContentDigest: null,
        command: { exitCode: 0 },
      },
    });
    expect(fixture.removePath).not.toHaveBeenCalledWith({
      path: `.app-builder/apply/${binding.proposalDigest}/repository`,
      recursive: true,
      force: true,
    });
  });

  it("records normalized pre/post overlay changes and a strict target receipt", async () => {
    const { run, sandbox, writeTextFile, writeBinaryFile, removePath } =
      sandboxFixture();
    const snapshots = [planning, before, before, after];
    const result = await executeProposalBoundApply({
      sandbox,
      executor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(commandReceipt()),
        stderr: "",
      }),
      snapshotter: async () => snapshots.shift()!,
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful apply");
    expect(result.receipt.preTreeDigest).toBe(before.treeDigest);
    expect(result.receipt.planningTreeDigest).toBe(planning.treeDigest);
    expect(result.receipt.preparedTreeDigest).toBe(before.treeDigest);
    expect(result.receipt.postTreeDigest).toBe(after.treeDigest);
    expect(result.receipt.preTree).toEqual(before.files);
    expect(result.receipt.postTree).toEqual(after.files);
    expect(result.receipt.changes.map(({ path }) => path)).toEqual([
      "apps/expense-review/app.contract.json",
      "microfrontends.json",
      "prototype/expense-review/app-spec.md",
    ]);
    expect(result.receipt.targetReceipt).toEqual(commandReceipt());
    expect(writeTextFile).toHaveBeenCalledWith({
      path: `.app-builder/apply/${binding.proposalDigest}/proposal.json`,
      content: `${JSON.stringify(proposal, null, 2)}\n`,
    });
    const overlayCopy = run.mock.calls
      .map(([request]) => (request as { command: string }).command)
      .find((command) => command.includes("cp -R"))!;
    expect(overlayCopy).toContain("test -L");
    expect(overlayCopy).toContain(
      `/opt/app-builder/dependencies/${binding.dependencyCacheContentDigest}/node_modules`,
    );
    expect(overlayCopy).toContain("cp -R");
    expect(overlayCopy).toContain("readlink --");
    expect(removePath).toHaveBeenCalledWith({
      path: `.app-builder/apply/${binding.proposalDigest}/repository/prototype/expense-review/app-spec.md`,
      force: true,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith({
      path: `.app-builder/apply/${binding.proposalDigest}/repository/prototype/expense-review/app-spec.md`,
      content: acceptedAppSpec,
    });
  });

  it("binds the pristine prepared tree separately from injected planning config", async () => {
    const injectedConfig = {
      path: ".config/mise/config.app-builder.toml",
      mode: "644",
      digest: "f".repeat(64),
    };
    const prepared = before;
    const injectedBefore = {
      treeDigest: "1".repeat(64),
      files: [...before.files, injectedConfig],
    };
    const injectedPlanning = {
      treeDigest: "2".repeat(64),
      files: [
        ...injectedBefore.files,
        {
          path: proposal.contract.appSpec.path,
          mode: "644",
          digest: acceptedAppSpecDigest,
        },
      ],
    };
    const injectedAfter = {
      ...after,
      files: [...after.files, injectedConfig],
    };
    const snapshots = [
      injectedPlanning,
      prepared,
      injectedBefore,
      injectedAfter,
    ];
    const result = await executeProposalBoundApply({
      sandbox: sandboxFixture().sandbox,
      executor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(commandReceipt()),
        stderr: "",
      }),
      snapshotter: async () => snapshots.shift()!,
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful apply");
    expect(result.receipt.preparedTreeDigest).toBe(prepared.treeDigest);
    expect(result.receipt.preTreeDigest).toBe(injectedBefore.treeDigest);
    expect(result.receipt.preparedTreeDigest).not.toBe(
      result.receipt.preTreeDigest,
    );
  });

  it.each([
    ["different", priorAppSpec, preparedWithPriorAppSpec, true],
    ["identical", acceptedAppSpec, planning, false],
  ] as const)(
    "stages the accepted AppSpec over an %s prepared-source AppSpec",
    async (_case, preparedAppSpec, preparedSnapshot, expectAppSpecChange) => {
      const { readBinaryFile, sandbox, writeBinaryFile } = sandboxFixture();
      readBinaryFile
        .mockResolvedValueOnce(acceptedAppSpec)
        .mockResolvedValueOnce(preparedAppSpec);
      const snapshots = [planning, preparedSnapshot, preparedSnapshot, after];
      const result = await executeProposalBoundApply({
        sandbox,
        executor: async () => ({
          exitCode: 0,
          stdout: JSON.stringify(commandReceipt()),
          stderr: "",
        }),
        snapshotter: async () => snapshots.shift()!,
        binding,
        artifactRevision: binding.artifactRevision,
        proposal,
        appliedByCallId: "apply-call",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful apply");
      expect(
        result.receipt.changes.some(
          ({ path }) => path === "prototype/expense-review/app-spec.md",
        ),
      ).toBe(expectAppSpecChange);
      expect(writeBinaryFile).toHaveBeenNthCalledWith(1, {
        path: `.app-builder/apply/${binding.proposalDigest}/repository/prototype/expense-review/app-spec.md`,
        content: preparedAppSpec,
      });
      expect(writeBinaryFile).toHaveBeenNthCalledWith(2, {
        path: `.app-builder/apply/${binding.proposalDigest}/repository/prototype/expense-review/app-spec.md`,
        content: acceptedAppSpec,
      });
    },
  );

  it("records command failure as recovery-required without claiming apply", async () => {
    const { sandbox } = sandboxFixture();
    const snapshots = [planning, before, before, after];
    const result = await executeProposalBoundApply({
      sandbox,
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "failed",
      }),
      snapshotter: async () => snapshots.shift()!,
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        status: "partial-failure",
        reason: "command-failed",
        recoveryRequired: true,
        command: { exitCode: 1 },
      },
    });
  });

  it("fails closed when the command changes an unapproved path", async () => {
    const { sandbox } = sandboxFixture();
    const snapshots = [
      planning,
      before,
      before,
      {
        treeDigest: "f".repeat(64),
        files: [
          ...after.files,
          { path: "package.json", mode: "644", digest: "f".repeat(64) },
        ],
      },
    ];
    const result = await executeProposalBoundApply({
      sandbox,
      executor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(commandReceipt()),
        stderr: "",
      }),
      snapshotter: async () => snapshots.shift()!,
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "unexpected-path", recoveryRequired: true },
    });
  });

  it("fails closed when the target receipt is not bound to proposal topology", async () => {
    const { sandbox } = sandboxFixture();
    const snapshots = [planning, before, before, after];
    const receipt = commandReceipt();
    receipt.topology.newDigest = "f".repeat(64);
    const result = await executeProposalBoundApply({
      sandbox,
      executor: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(receipt),
        stderr: "",
      }),
      snapshotter: async () => snapshots.shift()!,
      binding,
      artifactRevision: binding.artifactRevision,
      proposal,
      appliedByCallId: "apply-call",
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "invalid-receipt", recoveryRequired: true },
    });
  });

  it("uses only the fixed apply command, cwd, and timeout", async () => {
    const { run, sandbox } = sandboxFixture();
    await sandboxApplyCommandExecutor()({
      sandbox,
      appId: "expense-review",
      applyRoot: `/workspace/.app-builder/apply/${binding.proposalDigest}/repository`,
      proposalPath: `/workspace/.app-builder/apply/${binding.proposalDigest}/proposal.json`,
      proposal,
    });
    expect(run).toHaveBeenCalledWith({
      command: `MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools create:app -- --proposal /workspace/.app-builder/apply/${binding.proposalDigest}/proposal.json`,
      workingDirectory: `/workspace/.app-builder/apply/${binding.proposalDigest}/repository`,
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
  });

  it("snapshots the overlay in one sandbox process without per-file commands", async () => {
    const firstDigest = createHash("sha256").update("first\n").digest("hex");
    const secondDigest = createHash("sha256").update("second\n").digest("hex");
    const skillPath = ".codex/skills/harness-engineering-rules/SKILL.md";
    const agentPath =
      ".codex/skills/harness-engineering-rules/agents/openai.yaml";
    const stdout =
      `644\t${firstDigest}\t${agentPath}\n` +
      `644\t${secondDigest}\t${skillPath}\n` +
      `644\t${firstDigest}\ta.txt\n` +
      `755\t${secondDigest}\tnested/z.sh\n`;
    const run = vi.fn(async (request: unknown) => {
      void request;
      return { exitCode: 0, stdout, stderr: "" };
    });
    const snapshot = await inspectApplyOverlay(
      { id: "sandbox", run } as unknown as SandboxSession,
      "/workspace/overlay",
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      command: overlaySnapshotCommand(),
      workingDirectory: "/workspace/overlay",
      abortSignal: expect.any(AbortSignal),
    });
    const command = (run.mock.calls[0]?.[0] as { command?: string } | undefined)
      ?.command;
    expect(command).toBeDefined();
    expect(command).toMatch(/^bun -e '/u);
    expect(command).not.toContain("find .");
    expect(command).not.toContain("sha256sum --");
    expect(command).not.toContain("stat --format");
    expect(snapshot.files).toEqual([
      { path: skillPath, mode: "644", digest: secondDigest },
      { path: agentPath, mode: "644", digest: firstDigest },
      { path: "a.txt", mode: "644", digest: firstDigest },
      { path: "nested/z.sh", mode: "755", digest: secondDigest },
    ]);
  });

  it("preserves regular-file snapshot semantics and prunes only root caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "target-apply-snapshot-"));
    try {
      await mkdir(join(root, "nested"));
      await mkdir(join(root, "node_modules"));
      await mkdir(join(root, ".scratch"));
      await writeFile(join(root, "a.txt"), "first\n");
      await writeFile(join(root, "nested", "z.sh"), "second\n");
      await chmod(join(root, "nested", "z.sh"), 0o755);
      await writeFile(join(root, "node_modules", "excluded"), "cache\n");
      await writeFile(join(root, ".scratch", "excluded"), "scratch\n");
      await symlink("a.txt", join(root, "ignored-link"));

      const result = await executeFile(
        process.execPath,
        ["-e", OVERLAY_SNAPSHOT_SCRIPT],
        { cwd: root },
      );

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `644\t${createHash("sha256").update("first\n").digest("hex")}\ta.txt\n` +
          `755\t${createHash("sha256").update("second\n").digest("hex")}\tnested/z.sh\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes added, modified, and deleted content", () => {
    expect(
      overlayChanges(
        {
          treeDigest: "0".repeat(64),
          files: [
            { path: "deleted", mode: "644", digest: "1".repeat(64) },
            { path: "modified", mode: "644", digest: "2".repeat(64) },
          ],
        },
        {
          treeDigest: "3".repeat(64),
          files: [
            { path: "added", mode: "644", digest: "4".repeat(64) },
            { path: "modified", mode: "755", digest: "2".repeat(64) },
          ],
        },
      ).map(({ path, kind }) => ({ path, kind })),
    ).toEqual([
      { path: "added", kind: "added" },
      { path: "deleted", kind: "deleted" },
      { path: "modified", kind: "modified" },
    ]);
  });
});
