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
    expect(calls.slice(0, 2)).toEqual([
      "repository/.config/app-specs/inventory.cue",
      "bun install",
    ]);
    expect(calls[2]).toContain("mise install --locked cue");
    expect(calls.slice(3)).toEqual([
      "mise run create:app inventory",
      "repository/apps/inventory/app/page.tsx",
    ]);
  });

  it.each(["recovered", "failed", "stale", "invalid"] as const)(
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
        executor: async () => {
          let exitCode = 0;
          let stderr = "";
          if (outcome === "failed") {
            exitCode = 1;
            stderr = "repository validation failed";
          } else if (outcome === "stale") {
            exitCode = 2;
            stderr = "stale iteration preimage";
          }
          return {
            exitCode,
            failedCommand: outcome === "stale" ? "verify current app file preimage" : undefined,
            stderr,
            stdout: outcome === "invalid" ? "not a receipt" : JSON.stringify(receipt),
          };
        },
        proposal,
        // SAFETY: This executor uses only the run, network, and write methods supplied by this test double.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        sandbox: sandbox as unknown as Parameters<
          ReturnType<typeof sandboxApplyCommandExecutor>
        >[0]["sandbox"],
        snapshotter: async () => ({ files: [], treeDigest: "e".repeat(64) }),
      });
      expect(writes).toEqual(
        outcome === "recovered" ? ["repository/apps/inventory/.config/app-spec.md"] : [],
      );
      if (outcome === "recovered") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.receipt.targetReceipt.recovered).toBe(true);
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.receipt).toMatchObject({
            reason:
              outcome === "failed" || outcome === "stale" ? "command-failed" : "invalid-receipt",
            recoveryRequired: true,
            status: "partial-failure",
          });
          if (outcome === "stale") {
            expect(result.receipt).toMatchObject({
              commandFailureKind: "stale-proposal",
              failedCommand: "verify current app file preimage",
              output: { stderr: "stale iteration preimage" },
            });
          }
        }
      }
    },
  );
  it.each(["create", "iterate"] as const)(
    "keeps accepted planning outside source during %s and preserves existing source specs",
    async (operation) => {
      const rootMarkdown = "# Existing source-owned spec\n";
      const rootCue = "package existing\n";
      const previousSnapshot = "# Existing app snapshot\n";
      const appPath = "apps/inventory/app/page.tsx";
      const appContent = "export default function Page() { return null; }";
      const snapshotPath = "repository/apps/inventory/.config/app-spec.md";
      const files = new Map([
        ["repository/.config/app-specs/inventory.md", rootMarkdown],
        ["repository/.config/app-specs/inventory.cue", rootCue],
        [snapshotPath, previousSnapshot],
      ]);
      const writes: string[] = [];
      const iterationChanges = [
        { path: appPath, after: { content: appContent, digest: sha256(appContent), mode: "644" } },
      ];
      const iterationProposal: TargetProposal = {
        ...proposal,
        operation: "iterate-existing-app",
        iteration: { changes: iterationChanges, digest: sha256(JSON.stringify(iterationChanges)) },
      };
      const sandbox = {
        readBinaryFile: vi.fn(async ({ path }: { path: string }) => {
          if (path.includes("prototype/")) return Buffer.from(content);
          const value = files.get(path);
          return value === undefined ? null : Buffer.from(value);
        }),
        removePath: vi.fn(async ({ path }: { path: string }) => {
          files.delete(path);
        }),
        run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) })),
        setNetworkPolicy: vi.fn(async () => {}),
        writeBinaryFile: vi.fn(
          async ({ path, content: bytes }: { path: string; content: Uint8Array }) => {
            writes.push(path);
            files.set(path, Buffer.from(bytes).toString("utf-8"));
          },
        ),
        writeTextFile: vi.fn(async ({ path, content: text }: { path: string; content: string }) => {
          writes.push(path);
          files.set(path, text);
        }),
      };
      const result = await executeProposalBoundApply({
        appliedByCallId: "apply-call",
        artifactRevision: "d".repeat(64),
        binding: {
          appSpecDigest: sha256(content),
          appSpecPath: proposal.contract.appSpec.path,
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
        },
        executor: sandboxApplyCommandExecutor(),
        proposal: operation === "create" ? proposal : iterationProposal,
        // SAFETY: This double provides the sandbox methods used by the apply executor and spec snapshot writer.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        sandbox: sandbox as unknown as Parameters<
          ReturnType<typeof sandboxApplyCommandExecutor>
        >[0]["sandbox"],
        snapshotter: async () => {
          const snapshot = [...files]
            .filter(([path]) => path.startsWith("repository/"))
            .map(([path, text]) => ({
              path: path.slice("repository/".length),
              mode: "644",
              digest: sha256(text),
            }));
          return { files: snapshot, treeDigest: sha256(JSON.stringify(snapshot)) };
        },
      });
      expect(result.ok).toBe(true);
      expect(files.get("repository/.config/app-specs/inventory.md")).toBe(rootMarkdown);
      expect(files.get("repository/.config/app-specs/inventory.cue")).toBe(rootCue);
      if (operation === "create") {
        expect(files.get(snapshotPath)).toBe(content);
        expect(writes).toContain(snapshotPath);
      } else {
        expect(files.get(snapshotPath)).toBe(previousSnapshot);
        expect(files.get(`repository/${appPath}`)).toBe(appContent);
        expect(writes.every((path) => path === `repository/${appPath}`)).toBe(true);
      }
      expect(writes.every((path) => path.startsWith("repository/apps/inventory/"))).toBe(true);
    },
  );
});
