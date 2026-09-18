// oxlint-disable eslint/require-await -- Promise-returning sandbox test doubles model asynchronous I/O.
import { describe, expect, it, vi } from "vitest";

import { sandboxApplyCommandExecutor, executeProposalBoundApply } from "./target-apply";

import type { TargetProposal } from "./target-planning";
import { withImplementationFiles } from "../agent/apply-implementation-files";
import { createHash } from "node:crypto";

const content = "# Accepted product snapshot\n";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const proposal: TargetProposal = {
  blockers: [],
  contract: {
    appId: "inventory",
    appSpec: { path: "prototype/inventory/app-spec.md", sha256: sha256(content) },
    version: 1,
  },
  mutations: [],
  plan: {
    product: { appSpec: { path: "prototype/inventory/app-spec.md", sha256: sha256(content) } },
    source: {
      packageName: "@autograph/inventory",
      runtime: "nextjs",
      schema: { kind: "none" },
      workspacePath: "apps/inventory",
    },
    topology: {
      configPath: "microfrontends.json",
      packageName: "@autograph/inventory",
      projectName: "apps-inventory",
      routes: ["/inventory", "/inventory/:path*"],
    },
  },
};
const receipt = {
  appId: "inventory",
  mutations: ["apps/inventory", "microfrontends.json"],
  omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
  recovered: true,
  topology: { newDigest: "b".repeat(64), oldDigest: "a".repeat(64), path: "microfrontends.json" },
  version: 1,
  workspacePath: "apps/inventory",
};

describe("direct app creation", () => {
  it("stages approved CUE before the direct command and implementation afterwards", async () => {
    const calls: string[] = [];
    const sandbox = {
      run: vi.fn(async ({ command }: { command: string }) => {
        calls.push(command);
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
      }),
      setNetworkPolicy: vi.fn(async () => {}),
      writeTextFile: vi.fn(async ({ path }: { path: string }) => {
        calls.push(path);
      }),
    };
    await withImplementationFiles(sandboxApplyCommandExecutor(), [
      { content: "package inventory", path: ".config/app-specs/inventory.cue" },
      { content: "export default null", path: "apps/inventory/app/page.tsx" },
    ])({
      appId: "inventory",
      applyRoot: "/workspace/repository",
      proposal,
      // SAFETY: The exercised executor uses only run, setNetworkPolicy, and writeTextFile supplied by this double.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      sandbox: sandbox as unknown as Parameters<
        ReturnType<typeof sandboxApplyCommandExecutor>
      >[0]["sandbox"],
    });
    expect(calls).toEqual([
      "repository/.config/app-specs/inventory.cue",
      "bun install",
      "mise run create:app inventory",
      "repository/apps/inventory/app/page.tsx",
    ]);
  });

  it.each(["recovered", "failed", "invalid"] as const)(
    "preserves %s command evidence",
    async (outcome) => {
      const writes: string[] = [];
      const sandbox = {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) =>
          path.includes("prototype/") ? Buffer.from(content) : null,
        ),
        removePath: vi.fn(async () => {}),
        run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
        writeBinaryFile: vi.fn(async ({ path }: { path: string }) => {
          writes.push(path);
        }),
      };
      const binding = {
        appSpecDigest: sha256(content),
        appSpecPath: "prototype/inventory/app-spec.md",
        artifactRevision: "f".repeat(64),
        dependencyCacheContentDigest: "c".repeat(64),
        dependencyCacheDigest: "test",
        dependencyReceiptDigest: "a".repeat(64),
        eligibilityDigest: "d".repeat(64),
        identityDigest: "b".repeat(64),
        imageDigest: "test",
        proposalDigest: "c".repeat(64),
        sourceReceiptDigest: "c".repeat(64),
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
        workspaceDigest: "e".repeat(64),
      };
      const result = await executeProposalBoundApply({
        appliedByCallId: "apply-call",
        artifactRevision: "d".repeat(64),
        binding,
        executor: async () => ({
          exitCode: outcome === "failed" ? 1 : 0,
          stderr: outcome === "failed" ? "repository validation failed" : "",
          stdout: outcome === "invalid" ? "not a receipt" : JSON.stringify(receipt),
        }),
        proposal,
        // SAFETY: This executor uses only the run, network, and write methods supplied by this test double.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        sandbox: sandbox as unknown as Parameters<
          ReturnType<typeof sandboxApplyCommandExecutor>
        >[0]["sandbox"],
        snapshotter: async () => ({ files: [], treeDigest: "e".repeat(64) }),
      });
      expect(writes).toEqual(["repository/.config/app-specs/inventory.md"]);
      if (outcome === "recovered") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.receipt.targetReceipt.recovered).toBe(true);
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.receipt).toMatchObject({
            reason: outcome === "failed" ? "command-failed" : "invalid-receipt",
            recoveryRequired: true,
            status: "partial-failure",
          });
        }
      }
    },
  );
});
