import { describe, expect, it, vi } from "vitest";

import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
  inspectSourceBoundSandboxWorkspace,
  sanitizeSandboxCloneError,
} from "./arrusted-template";
import {
  inspectCanonicalTemplateSnapshotReceipt,
  inspectExistingRepositorySnapshotReceipt,
  inspectSourceOnlyTemplateSnapshotReceipt,
} from "./source-receipt";

describe("canonical Arrusted source preparation", () => {
  it("preserves long clone diagnostics after redacting credentials and URLs", () => {
    const token = "local-test-credential-value";
    const detail = `${"stage detail ".repeat(80)} token=${token} https://example.test/path`;
    const sanitized = sanitizeSandboxCloneError(detail, token);

    expect(sanitized).toContain("stage detail");
    expect(sanitized).toContain("token=[redacted]");
    expect(sanitized).toContain("[url]");
    expect(sanitized.length).toBeGreaterThan(512);
  });

  it("uses the provider-created starter checkout once", async () => {
    const sourceSha = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const commands: string[] = [];
    const written: string[] = [];
    const run = vi.fn(async ({ command }: { command: string }) => {
      await Promise.resolve();
      commands.push(command);
      return {
        exitCode: command.startsWith("test -L ") ? 1 : 0,
        stderr: "",
        stdout: command.includes("rev-parse")
          ? `${sourceSha}\n${sourceTree}\nhttps://github.com/withAutograph/arrusted-development.git\n`
          : "",
      };
    });
    const receipt = await acquireCanonicalArrustedTemplate({
      callId: "prepare",
      reader: { acquire: async () => await Promise.resolve({ token: "test-token" }) },
      sandbox: {
        id: "sandbox",
        readTextFile: async () => await Promise.resolve(null),
        run,
        writeTextFile: async ({ path }: { path: string }) => {
          await Promise.resolve();
          written.push(path);
        },
      } as never,
    });
    expect(receipt.sourceKind).toBe("fresh-template");
    expect(receipt.version).toBe(5);
    expect(receipt).toHaveProperty("provenance.sourceDigest");
    expect(receipt).not.toHaveProperty("provenance.readinessDigest");
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(written).toContain(".app-builder/prepare-intent.json");
  });

  it.each([4, 5])(
    "reuses the recorded V%s session workspace without legacy reinspection",
    async (version) => {
      const snapshot = {
        contents: {},
        contract: [],
        dirtyPaths: [],
        sourcePath: "/workspace/repository",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      };
      const receipt =
        version === 5
          ? inspectSourceOnlyTemplateSnapshotReceipt(snapshot)
          : inspectCanonicalTemplateSnapshotReceipt({
              readinessDigest: "c".repeat(64),
              snapshot: {
                contents: {},
                contract: [],
                dirtyPaths: [],
                sourcePath: "/workspace/repository",
                sourceSha: "a".repeat(40),
                sourceTree: "b".repeat(40),
              },
            });
      if (receipt.version !== 4 && receipt.version !== 5) {
        throw new Error("Expected cloned source fixture");
      }
      const workspace = {
        adapter: "arrusted-development-v0",
        eligibilityDigest: receipt.eligibilityDigest,
        sourcePath: "/workspace/repository",
        sourceSha: receipt.sourceSha,
        sourceTree: receipt.sourceTree,
        workspaceDigest: "d".repeat(64),
        workspaceId: "sandbox",
        workspacePath: "/workspace/repository",
      } as const;
      const run = vi.fn();

      await expect(
        inspectCanonicalArrustedSandboxWorkspace({
          receipt,
          sandbox: {
            id: "sandbox",
            // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
            readTextFile: vi.fn(async () => JSON.stringify(workspace)),
            run,
          } as never,
        }),
      ).resolves.toEqual(workspace);
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("connected GitHub workspace inspection", () => {
  const repository = "https://github.com/acme/private.git";
  const originalSha = "a".repeat(40);
  const originalTree = "b".repeat(40);
  const receipt = inspectExistingRepositorySnapshotReceipt({
    contents: {},
    contract: [],
    dirtyPaths: [],
    sourcePath: "/workspace/repository",
    sourceSha: originalSha,
    sourceTree: originalTree,
  });
  const originalWorkspace = {
    adapter: "arrusted-development-v0",
    eligibilityDigest: receipt.eligibilityDigest,
    sourcePath: receipt.sourcePath,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    workspaceDigest: "c".repeat(64),
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
  } as const;

  it.each([
    ["the selected revision", originalSha, originalTree],
    ["a newer revision", "d".repeat(40), "e".repeat(40)],
  ])(
    "uses the live checkout at %s despite an older diagnostic record",
    async (_name, sha, tree) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: "",
          stdout: `${sha}\n${tree}\n${repository}\n`,
        })
        .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
      const observed = await inspectSourceBoundSandboxWorkspace({
        expectedWorkspace: originalWorkspace,
        githubSource: { repository: { name: "private", owner: "acme" } } as never,
        receipt,
        sandbox: { id: "sandbox", run } as never,
      });
      expect(observed).toMatchObject({
        sourceSha: sha,
        sourceTree: tree,
        workspaceId: "sandbox",
      });
    },
  );

  it("rejects a checkout belonging to another repository", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${originalSha}\n${originalTree}\nhttps://github.com/acme/other.git\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(
      inspectSourceBoundSandboxWorkspace({
        expectedWorkspace: originalWorkspace,
        githubSource: { repository: { name: "private", owner: "acme" } } as never,
        receipt,
        sandbox: { id: "sandbox", run } as never,
      }),
    ).rejects.toThrow("does not match the selected GitHub source");
  });
});
