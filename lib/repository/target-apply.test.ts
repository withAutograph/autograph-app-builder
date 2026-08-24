import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  executeProposalBoundApply,
  overlayChanges,
  sandboxApplyCommandExecutor,
  type OverlaySnapshot,
  type TargetApplyBinding,
  type TargetApplyCommandReceipt,
} from "./target-apply";
import type { TargetProposal } from "./target-planning";

const proposal: TargetProposal = {
  contract: {
    version: 1,
    appId: "expense-review",
    appSpec: {
      path: "prototype/expense-review/app-spec.md",
      sha256: "a".repeat(64),
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
        sha256: "a".repeat(64),
      },
      optionalCapabilities: { integrations: [], hostedResources: [] },
    },
    topology: {
      configPath: "apps/shell/microfrontends.json",
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
  eligibilityDigest: "2".repeat(64),
  workspaceDigest: "3".repeat(64),
  appSpecDigest: "a".repeat(64),
  artifactRevision: "4".repeat(64),
  dependencyReceiptDigest: "5".repeat(64),
  identityDigest: "6".repeat(64),
  imageDigest: `fixture@sha256:${"7".repeat(64)}`,
  dependencyCacheDigest: `sha256:${"8".repeat(64)}`,
  proposalDigest: "9".repeat(64),
};

const before: OverlaySnapshot = {
  treeDigest: "a".repeat(64),
  files: [
    {
      path: "apps/shell/microfrontends.json",
      mode: "644",
      digest: "b".repeat(64),
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
      path: "apps/shell/microfrontends.json",
      mode: "644",
      digest: "e".repeat(64),
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
      path: "apps/shell/microfrontends.json",
      oldDigest: "b".repeat(64),
      newDigest: "c".repeat(64),
    },
    mutations: ["apps/expense-review", "apps/shell/microfrontends.json"],
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
  const sandbox = {
    id: "sandbox",
    run,
    writeTextFile,
  } as unknown as SandboxSession;
  return { run, sandbox, writeTextFile };
}

describe("proposal-bound target apply", () => {
  it("records normalized pre/post overlay changes and a strict target receipt", async () => {
    const { sandbox, writeTextFile } = sandboxFixture();
    const snapshots = [before, after];
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
    expect(result.receipt.postTreeDigest).toBe(after.treeDigest);
    expect(result.receipt.preTree).toEqual(before.files);
    expect(result.receipt.postTree).toEqual(after.files);
    expect(result.receipt.changes.map(({ path }) => path)).toEqual([
      "apps/expense-review/app.contract.json",
      "apps/shell/microfrontends.json",
    ]);
    expect(result.receipt.targetReceipt).toEqual(commandReceipt());
    expect(writeTextFile).toHaveBeenCalledWith({
      path: `.app-builder/apply/${binding.proposalDigest}/proposal.json`,
      content: `${JSON.stringify(proposal, null, 2)}\n`,
    });
  });

  it("records command failure as recovery-required without claiming apply", async () => {
    const { sandbox } = sandboxFixture();
    const snapshots = [before, after];
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
    const snapshots = [before, after];
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
      command: `mise run create:app -- --proposal /workspace/.app-builder/apply/${binding.proposalDigest}/proposal.json`,
      workingDirectory: `/workspace/.app-builder/apply/${binding.proposalDigest}/repository`,
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
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
